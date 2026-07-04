# Multi-Source Playback Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance auto-fallback to try ALL music platforms (Netease/QQ/KuGou/Qishui) before skipping a song, with multi-search strategy, quality transparency, and Wallpaper Engine SSE integration.

**Architecture:** New server-side `POST /api/resolve-song-url` endpoint with two-tier cache, circuit breaker, concurrent dedup, and multi-round progressive search. Frontend `playQueueAt` gets `preResolvedUrl` channel eliminating double URL fetch. Wallpaper data pushed via SSE long-lived connection instead of polling.

**Tech Stack:** Node.js HTTP server (native), vanilla JS frontend, Electron, Wallpaper Engine web wallpaper format

## Global Constraints

- Zero new npm dependencies (Node native HTTP for SSE, crypto for cache keys)
- No `latest.yml` uploads for `v1.1.1`
- Default install path: `D:\Viberadio`
- Visual quality: black/glass/stage/music-visualization direction
- Chinese communication, direct and practical tone
- Do not push to GitHub unless explicitly asked
- Wallpaper Engine: output independent web wallpaper package, do NOT use Wallpaper Engine as Electron container

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server.js` | New helpers (match, cache, circuit breaker, search strategies) + `/api/resolve-song-url` + `/api/wallpaper/stream` + `/api/wallpaper/push` |
| `public/index.html` | `playQueueAt` preResolvedUrl skip block, rewritten `tryAutoPlaybackFallback` + `applyFallbackResult` + `clientSideFallback`, `pushWallpaperAudioState`, delete deprecated functions |
| `wallpaper-engine/project.json` (new) | Wallpaper Engine manifest |
| `wallpaper-engine/index.html` (new) | WebGL wallpaper with SSE listener |
| `wallpaper-engine/audio-bridge.js` (new) | SSE EventSource connection |

---

### Task 1: Insert server-side helpers and global state (server.js)

**Files:**
- Modify: `D:\Desktop\Viberadio-1.1.1\server.js` — insert after existing quality candidate constants (~line 3286, after QISHUI_QUALITY_CANDIDATES block)

**Interfaces:**
- Produces: `providerCircuitBreaker`, `fallbackMappingCache`, `fallbackUrlCache`, `pendingResolves`, `MAPPING_CACHE_TTL`, `URL_CACHE_TTL`, `CIRCUIT_BREAKER_THRESHOLD`, `CIRCUIT_BREAKER_COOLDOWN`, cleanup `setInterval`, `isCircuitBroken(provider)`, `recordCircuitSuccess(provider)`, `recordCircuitFailure(provider)`, `normalizeMatchText(text)`, `artistNameParts(song)`, `isSameTitleArtist(source, candidate)`, `cleanSongName(name)`, `buildSearchQueries(name, artist)`, `buildFallbackProviderOrder(excludeProvider)`, `runPlatformSearch(provider, query, limit)`, `runPlatformUrl(provider, song, qualityPreference)`, `makeCacheKey(name, artist)`, `resolveSongUrl(body)`, `doResolveSongUrl(name, artist, body, cacheKey)`

- [ ] **Step 1: Insert global state and cache cleanup after QISHUI_QUALITY_CANDIDATES (after line 3286)**

Read lines 3280-3290 of server.js to confirm the insertion point, then insert:

```js
// ====================================================================
//  Multi-Source Fallback — 全局状态
// ====================================================================
var providerCircuitBreaker = {
  netease: { failures: 0, brokenUntil: 0 },
  qq:      { failures: 0, brokenUntil: 0 },
  kg:      { failures: 0, brokenUntil: 0 },
  qs:      { failures: 0, brokenUntil: 0 },
};
var fallbackMappingCache = new Map(); // key → {resolvedBy, song, expiresAt}  TTL: 2h
var fallbackUrlCache     = new Map(); // key → {resolvedBy, url, song, level, quality, br, trial, expiresAt}  TTL: 10min
var pendingResolves = new Map();      // key → Promise (concurrent dedup)

var MAPPING_CACHE_TTL = 2 * 60 * 60 * 1000;  // 2h
var URL_CACHE_TTL     = 10 * 60 * 1000;       // 10min
var CIRCUIT_BREAKER_THRESHOLD = 3;
var CIRCUIT_BREAKER_COOLDOWN  = 30000;        // 30s

setInterval(function() {
  var now = Date.now();
  fallbackMappingCache.forEach(function(v, k) { if (v.expiresAt <= now) fallbackMappingCache.delete(k); });
  fallbackUrlCache.forEach(function(v, k)     { if (v.expiresAt <= now) fallbackUrlCache.delete(k); });
}, 5 * 60 * 1000);

// ====================================================================
//  Multi-Source Fallback — 熔断器
// ====================================================================
function isCircuitBroken(provider) {
  var cb = providerCircuitBreaker[provider];
  if (!cb || cb.brokenUntil === 0) return false;
  if (Date.now() > cb.brokenUntil) { cb.brokenUntil = 0; cb.failures = 0; return false; }
  return true;
}
function recordCircuitSuccess(provider) {
  var cb = providerCircuitBreaker[provider];
  if (cb) { cb.failures = 0; cb.brokenUntil = 0; }
}
function recordCircuitFailure(provider) {
  var cb = providerCircuitBreaker[provider];
  if (!cb) return;
  cb.failures++;
  if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) cb.brokenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN;
}

// ====================================================================
//  Multi-Source Fallback — 文本匹配
// ====================================================================
function normalizeMatchText(text) {
  return String(text || '').toLowerCase()
    .replace(/^(cover|翻唱)\s*[：:]\s*/i, '')
    .replace(/[（(【\[](.+?)[）)】\]]/g, ' $1 ')
    .replace(/feat\.\s|ft\.\s|featuring\s/gi, ' ')
    .replace(/[\s·・\-—_.,，。:：;；'"!！?？'""/\\|&@#$%^*()（）【】\[\]{}<>~`+=]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function artistNameParts(song) {
  var parts = [];
  if (Array.isArray(song.artists)) {
    song.artists.forEach(function(a) { if (a && a.name) parts.push(normalizeMatchText(a.name)); });
  }
  if (song.artist) {
    String(song.artist).split(/\s*[/,、&]\s*|\s+feat\.?\s+|\s+ft\.?\s+/i).forEach(function(n) {
      var t = normalizeMatchText(n); if (t) parts.push(t);
    });
  }
  return parts.filter(Boolean);
}
function isSameTitleArtist(source, candidate) {
  if (!source || !candidate) return false;
  if (normalizeMatchText(source.name || source.title) !== normalizeMatchText(candidate.name || candidate.title)) return false;
  var a = artistNameParts(source), b = artistNameParts(candidate);
  if (!a.length || !b.length) return false;
  return a.some(function(n) { return b.indexOf(n) >= 0; });
}

// ====================================================================
//  Multi-Source Fallback — 搜索策略
// ====================================================================
function cleanSongName(name) {
  return String(name || '').replace(/[（(【\[].*?[）)】\]]/g, '').replace(/\s+/g, ' ').trim();
}
function buildSearchQueries(name, artist) {
  var clean = cleanSongName(name);
  var queries = [];
  var add = function(q) { if (q && queries.indexOf(q) === -1) queries.push(q); };
  add([name, artist].filter(Boolean).join(' ').trim());
  if (clean && clean !== name) add([clean, artist].filter(Boolean).join(' ').trim());
  add(name);
  if (clean && clean !== name) add(clean);
  return queries;
}

// ====================================================================
//  Multi-Source Fallback — 平台分派
// ====================================================================
function buildFallbackProviderOrder(excludeProvider) {
  var FULL_ORDER = ['netease', 'qq', 'kg', 'qs'];
  return FULL_ORDER.filter(function(p) { return p !== excludeProvider; });
}
async function runPlatformSearch(provider, query, limit) {
  if (provider === 'qq') return await handleQQSearch(query, limit);
  if (provider === 'kg') return await kugouSearch(query, limit);
  if (provider === 'qs') return await qishuiSearch(query, limit);
  return await handleSearch(query, limit);
}
async function runPlatformUrl(provider, song, qualityPreference) {
  var raw, url, trial, level, quality, br;
  if (provider === 'qq') {
    raw = await handleQQSongUrl(song.mid || song.songmid || '', song.mediaMid || song.media_mid || '', qualityPreference);
    url = raw.url || ''; trial = !!raw.trial; level = raw.level || ''; quality = raw.quality || ''; br = raw.br || 0;
  } else if (provider === 'kg') {
    raw = await kugouSongUrl(song.hash || song.id || '', song.album_id || song.albumId || '', qualityPreference);
    url = raw.url || ''; trial = false;
    level = (raw.quality && raw.quality.level) || ''; quality = (raw.quality && raw.quality.label) || '';
    br = (raw.quality && raw.quality.br) || 0;
  } else if (provider === 'qs') {
    raw = await qishuiSongUrl(song.id || '', qualityPreference);
    url = raw.url || ''; trial = false;
    level = (raw.quality && raw.quality.level) || ''; quality = (raw.quality && raw.quality.label) || '';
    br = (raw.quality && raw.quality.br) || 0;
  } else {
    var loginInfo = await getLoginInfo();
    raw = await handleSongUrl(song.id, loginInfo, qualityPreference);
    url = raw.url || ''; trial = !!raw.trial; level = raw.level || ''; quality = raw.quality || ''; br = raw.br || 0;
  }
  return { url: url, trial: trial, level: level, quality: quality, br: br };
}
```

- [ ] **Step 2: Run syntax check**

```bash
node --check "D:\Desktop\Viberadio-1.1.1\server.js"
```
Expected: no output (no errors)

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add multi-source fallback helpers and global state"
```

---

### Task 2: Insert resolveSongUrl and route (server.js)

**Files:**
- Modify: `D:\Desktop\Viberadio-1.1.1\server.js` — insert after the helpers from Task 1, and route before `/api/cover` (~line 5019)

**Interfaces:**
- Consumes: All helpers from Task 1, `crypto` (already required at line 51)
- Produces: `POST /api/resolve-song-url` route

- [ ] **Step 1: Insert resolveSongUrl + doResolveSongUrl after Task 1's code block**

```js
// ====================================================================
//  Multi-Source Fallback — 主函数
// ====================================================================
function makeCacheKey(name, artist) {
  return crypto.createHash('md5').update(
    normalizeMatchText(name) + '|' + normalizeMatchText(artist)
  ).digest('hex');
}

async function resolveSongUrl(body) {
  var name = String(body.name || '').trim();
  var artist = String(body.artist || '').trim();
  if (!name) return { ok: false, reason: 'missing_name' };

  var cacheKey = makeCacheKey(name, artist);

  // URL cache hit → immediate return (~0ms)
  var urlCached = fallbackUrlCache.get(cacheKey);
  if (urlCached && urlCached.expiresAt > Date.now()) {
    return {
      ok: true, resolvedBy: urlCached.resolvedBy, url: urlCached.url,
      song: urlCached.song, quality: { level: urlCached.level, label: urlCached.quality, br: urlCached.br },
      trial: !!urlCached.trial, fromCache: 'url'
    };
  }

  // Concurrent dedup
  var pending = pendingResolves.get(cacheKey);
  if (pending) return pending;

  var resolvePromise = doResolveSongUrl(name, artist, body, cacheKey);
  pendingResolves.set(cacheKey, resolvePromise);
  try { return await resolvePromise; }
  finally { pendingResolves.delete(cacheKey); }
}

async function doResolveSongUrl(name, artist, body, cacheKey) {
  // Mapping cache hit → skip search, fetch URL directly
  var mappingCached = fallbackMappingCache.get(cacheKey);
  if (mappingCached && mappingCached.expiresAt > Date.now()) {
    var mp = mappingCached;
    try {
      var urlData = await runPlatformUrl(mp.resolvedBy, mp.song, body.quality);
      if (urlData && urlData.url) {
        recordCircuitSuccess(mp.resolvedBy);
        fallbackUrlCache.set(cacheKey, {
          resolvedBy: mp.resolvedBy, url: urlData.url, song: mp.song,
          level: urlData.level, quality: urlData.quality, br: urlData.br, trial: !!urlData.trial,
          expiresAt: Date.now() + URL_CACHE_TTL
        });
        return {
          ok: true, resolvedBy: mp.resolvedBy, url: urlData.url,
          song: mp.song, quality: { level: urlData.level, label: urlData.quality, br: urlData.br },
          trial: !!urlData.trial, fromCache: 'mapping'
        };
      }
      recordCircuitFailure(mp.resolvedBy);
      fallbackMappingCache.delete(cacheKey);
    } catch (e) {
      recordCircuitFailure(mp.resolvedBy);
      fallbackMappingCache.delete(cacheKey);
    }
  }

  // Multi-round search — progressive query simplification
  var allProviders = buildFallbackProviderOrder(body.excludeProvider);
  var brokenList = allProviders.filter(function(p) { return isCircuitBroken(p); });
  var providers = allProviders.filter(function(p) { return !isCircuitBroken(p); });
  if (!providers.length) {
    return { ok: false, tried: allProviders, circuitBroken: brokenList,
      reason: 'all_providers_circuit_broken', details: [] };
  }

  var queries = buildSearchQueries(name, artist);
  var allMatches = {}; // provider → song
  var details = [];

  // Round-by-round: stop as soon as any platform matches
  for (var qi = 0; qi < queries.length; qi++) {
    var query = queries[qi];
    var roundLabel = 'q' + (qi + 1);

    var searchResults = await Promise.allSettled(
      providers.map(function(p) { return runPlatformSearch(p, query, 8); })
    );

    for (var i = 0; i < searchResults.length; i++) {
      var provider = providers[i];
      if (allMatches[provider]) continue;

      var result = searchResults[i];
      if (result.status !== 'fulfilled') {
        recordCircuitFailure(provider);
        details.push({ provider: provider, searchStrategy: roundLabel, matched: false, error: 'search_failed' });
        continue;
      }

      var songs = result.value || [];
      var match = songs.find(function(s) { return isSameTitleArtist({name: name, artist: artist}, s); });
      if (match) {
        allMatches[provider] = match;
        details.push({ provider: provider, searchStrategy: roundLabel, matched: true });
      }
    }

    if (Object.keys(allMatches).length > 0) break;
  }

  // Record providers that never matched
  providers.forEach(function(p) {
    if (!allMatches[p]) {
      details.push({ provider: p, searchStrategy: 'none', matched: false, error: 'no_match_after_all_rounds' });
    }
  });

  // Sequential URL fetch by priority
  var bestTrial = null;
  var priorityOrder = providers.filter(function(p) { return allMatches[p]; });

  for (var j = 0; j < priorityOrder.length; j++) {
    var prv = priorityOrder[j];
    var match = allMatches[prv];

    try {
      var urlData = await runPlatformUrl(prv, match, body.quality);
      if (urlData && urlData.url) {
        recordCircuitSuccess(prv);
        if (!urlData.trial) {
          fallbackMappingCache.set(cacheKey, {
            resolvedBy: prv, song: match, expiresAt: Date.now() + MAPPING_CACHE_TTL
          });
          fallbackUrlCache.set(cacheKey, {
            resolvedBy: prv, url: urlData.url, song: match,
            level: urlData.level, quality: urlData.quality, br: urlData.br, trial: false,
            expiresAt: Date.now() + URL_CACHE_TTL
          });
          return { ok: true, resolvedBy: prv, url: urlData.url,
            song: match, quality: { level: urlData.level, label: urlData.quality, br: urlData.br },
            trial: false, fromCache: false, details: details };
        }
        if (!bestTrial) {
          bestTrial = { resolvedBy: prv, url: urlData.url, song: match,
            level: urlData.level, quality: urlData.quality, br: urlData.br, trial: true };
        }
        continue;
      }
    } catch (e) { /* URL fetch failed, try next */ }
    recordCircuitFailure(prv);
  }

  // Trial fallback
  if (bestTrial) {
    fallbackMappingCache.set(cacheKey, {
      resolvedBy: bestTrial.resolvedBy, song: bestTrial.song, expiresAt: Date.now() + MAPPING_CACHE_TTL
    });
    fallbackUrlCache.set(cacheKey, {
      resolvedBy: bestTrial.resolvedBy, url: bestTrial.url, song: bestTrial.song,
      level: bestTrial.level, quality: bestTrial.quality, br: bestTrial.br, trial: true,
      expiresAt: Date.now() + URL_CACHE_TTL
    });
    return { ok: true, resolvedBy: bestTrial.resolvedBy, url: bestTrial.url,
      song: bestTrial.song, quality: { level: bestTrial.level, label: bestTrial.quality, br: bestTrial.br },
      trial: true, fromCache: false, details: details };
  }

  return { ok: false, tried: providers, circuitBroken: brokenList,
    reason: 'all_providers_exhausted', details: details };
}
```

- [ ] **Step 2: Insert route before `/api/cover` (before line 5019)**

At the position just before `if (pn === '/api/cover')` (approximately line 4988 in original file, will shift after Task 1 insertions):

```js
  // ---------- Multi-Source Fallback ----------
  if (pn === '/api/resolve-song-url' && req.method === 'POST') {
    try {
      var resolveBody = await readRequestBody(req);
      sendJSON(res, await resolveSongUrl(resolveBody));
    } catch (err) {
      console.error('[ResolveSongUrl]', err);
      sendJSON(res, { ok: false, error: err.message }, 500);
    }
    return;
  }
```

- [ ] **Step 3: Run syntax check**

```bash
node --check "D:\Desktop\Viberadio-1.1.1\server.js"
```
Expected: no output (no errors)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add /api/resolve-song-url with multi-search and two-tier cache"
```

---

### Task 3: Add preResolvedUrl channel to playQueueAt (public/index.html)

**Files:**
- Modify: `D:\Desktop\Viberadio-1.1.1\public\index.html` — insert before `markPlayPhase('source-url')` block (~line 18583)

**Interfaces:**
- Consumes: `opts.preResolvedUrl`, `opts.preResolvedLevel`, `opts.preResolvedQuality` (new opts fields)
- Works with: existing `audio`, `token`, `trackSwitchToken`, `markPlayPhase`, `bindPlaybackProgressEvents`, `applyVolumeToAudio`, `updatePlaybackProgressUi`, `finalizeListenSession`, `playMode`, `currentIdx`, `skipFailedQueueItem`, `handleControlPlayState`, `hideLoading`, `showLoading`, `audioDuration`, `ensureLyricSanity`, `startPlaybackProgressTimer`, `scheduleBeatAnalysisIfNeeded`, `scheduleQueueBeatPrefetch`, `fetchLyricForCurrent`, `initPodcastDjModeForCurrent`, `updateNowPlayingSong`, `firstPlayDone`, `tweenParticleAlpha`, `uniforms.uAlpha`, `safeFirePlaybackStep`, `forcePlaybackControlsInteractive`

- [ ] **Step 1: Find insertion point**

Read lines 18578-18585 of index.html to confirm the location just before `markPlayPhase('source-url')`:

```js
  markPlayPhase('source-url');
```

- [ ] **Step 2: Insert preResolvedUrl skip block before that line**

```js
  // --- pre-resolved URL from auto-fallback (skip source-url phase) ---
  if (opts.preResolvedUrl) {
    markPlayPhase('pre-resolved-audio');
    if (token !== trackSwitchToken) return;

    // Record fallback quality for UI
    if (opts.preResolvedLevel) currentPlaybackQualityLevel = opts.preResolvedLevel;
    if (opts.preResolvedQuality) currentPlaybackQualityLabel = opts.preResolvedQuality;

    if (!audio) { audio = new Audio(); audio.crossOrigin = 'anonymous'; }
    else { audioFadeSerial++; clearAudioFadeTimers(); audio.pause(); }
    bindPlaybackProgressEvents(audio);
    applyVolumeToAudio();
    audio.src = '/api/audio?url=' + encodeURIComponent(opts.preResolvedUrl);
    updatePlaybackProgressUi();

    audio.onended = function() {
      if (token !== trackSwitchToken) return;
      finalizeListenSession(true);
      if (playMode === 'single') setTimeout(function() { playQueueAt(currentIdx, { autoRepeat: true }); }, 0);
      else if (playMode === 'list-order' || playMode === 'shuffle') playNext();
    };
    audio.onerror = function() {
      if (token !== trackSwitchToken) return;
      skipFailedQueueItem(idx, token, '预解析音频加载失败，正在播放下一首。');
    };

    handleControlPlayState();
    hideLoading(); showLoading();
    audio.play().then(function() {
      hideLoading(); forcePlaybackControlsInteractive();
      if (token === trackSwitchToken) {
        audioDuration = audio.duration || 0;
        ensureLyricSanity(audioDuration);
        startPlaybackProgressTimer();
        if (opts.startTime > 0) audio.currentTime = opts.startTime;
      }
    }).catch(function(e) {
      hideLoading(); forcePlaybackControlsInteractive();
      if (token !== trackSwitchToken) return;
      showSourceFallbackNotice('播放失败', e.message || '浏览器拒绝了自动播放。');
    });

    scheduleBeatAnalysisIfNeeded();
    scheduleQueueBeatPrefetch(idx, 1200);
    fetchLyricForCurrent();
    initPodcastDjModeForCurrent();
    updateNowPlayingSong(song);
    if (firstVisualPlay) { firstPlayDone = true; tweenParticleAlpha(uniforms.uAlpha.value || 0, 1.0, 220); }
    safeFirePlaybackStep('playStateListeners');
    safeFirePlaybackStep('trackChangeListeners');
    return;
  }

  markPlayPhase('source-url');
```

- [ ] **Step 3: Run frontend syntax check**

```bash
node -e "const fs = require('fs'); const html = fs.readFileSync('D:\\Desktop\\Viberadio-1.1.1\\public\\index.html','utf8'); const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || []; scripts.forEach((s,i) => { const code = s.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,''); try { new Function(code); } catch(e) { if (!/unexpected/.test(e.message)) console.log('Script ' + i + ' OK'); } }); console.log('Done');"
```
Expected: no error output

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add preResolvedUrl skip channel in playQueueAt"
```

---

### Task 4: Rewrite tryAutoPlaybackFallback + new helpers (public/index.html)

**Files:**
- Modify: `D:\Desktop\Viberadio-1.1.1\public\index.html` — replace `tryAutoPlaybackFallback` (~line 18399) and delete `alternatePlaybackProvider` (~line 18347) and `searchAlternatePlatformSong` (~line 18353)

**Interfaces:**
- Consumes: `apiJson`, `songProviderKey`, `playbackProviderLabel`, `cloneSong`, `hydrateCustomCover`, `playQueue`, `playQueueAt`, `showSourceFallbackNotice`, `skipFailedQueueItem`, `closeSourceFallbackNotice`, `safeRenderQueuePanel`, `safeShelfRebuild`, `miniQueueOpen`, `normalizePlaybackQuality`, `playbackQuality`, `isSameTitleArtist`, `normalizeMatchText`, `artistNameParts`, `trackSwitchToken`, `currentIdx`
- Produces: `tryAutoPlaybackFallback(song, data, idx, token, opts)`, `applyFallbackResult(resolved, song, idx, token)`, `clientSideFallback(song, idx, token)`
- Deletes: `alternatePlaybackProvider`, `searchAlternatePlatformSong`, `fallbackDepth` logic

- [ ] **Step 1: Delete alternatePlaybackProvider function (lines 18347-18352)**

Replace:
```js
function alternatePlaybackProvider(song) {
  var key = songProviderKey(song);
  if (key === 'kg') return 'netease';
  if (key === 'qq') return 'netease';
  return 'qq';
}
```
With nothing (delete the function).

- [ ] **Step 2: Delete searchAlternatePlatformSong function (lines 18353-18369)**

Replace:
```js
async function searchAlternatePlatformSong(song) {
  var target = alternatePlaybackProvider(song);
  var artist = artistNameParts(song)[0] || '';
  var query = [song.name || song.title || '', song.artist || artist].filter(Boolean).join(' ').trim();
  if (!query) return null;
  var url = target === 'qq'
    ? '/api/qq/search?keywords=' + encodeURIComponent(query) + '&limit=8'
    : target === 'kg'
      ? '/api/kg/search?keywords=' + encodeURIComponent(query) + '&limit=8'
      : '/api/search?keywords=' + encodeURIComponent(query) + '&limit=12';
  var data = await apiJson(url);
  var list = data && (data.songs || data.result || []);
  for (var i = 0; i < list.length; i++) {
    if (isSameTitleArtist(song, list[i])) return cloneSong(list[i]);
  }
  return null;
}
```
With nothing (delete the function).

- [ ] **Step 3: Replace tryAutoPlaybackFallback function (lines 18399-18431)**

Replace the entire function with:

```js
async function tryAutoPlaybackFallback(song, data, idx, token, opts) {
  opts = opts || {};
  if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') return false;

  var restriction = (data && data.restriction) || {};
  var category = (data && data.reason) || restriction.category || '';
  var fromLabel = playbackProviderLabel(song);
  var excludeKey = songProviderKey(song);

  try {
    showSourceFallbackNotice('正在自动换源', fromLabel + ' 暂不可播，正在查找其他平台...');

    var resolved = await apiJson('/api/resolve-song-url', {
      method: 'POST',
      body: JSON.stringify({
        name: song.name || song.title || '',
        artist: song.artist || '',
        excludeProvider: excludeKey,
        quality: normalizePlaybackQuality(playbackQuality)
      }),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 8000
    });

    if (token !== trackSwitchToken) return true;

    if (!resolved.ok) {
      if (category === 'login_required') return false;
      skipFailedQueueItem(idx, token, '全部平台都没有找到可播版本。');
      return true;
    }

    return await applyFallbackResult(resolved, song, idx, token);
  } catch (e) {
    // Client-side fallback: /resolve unavailable → try old single-platform approach
    if (token !== trackSwitchToken) return true;
    console.warn('[AutoFallback] server resolve failed, falling back to client-side:', e.message);
    return await clientSideFallback(song, idx, token);
  }
}

// Apply server-side fallback result
async function applyFallbackResult(resolved, song, idx, token) {
  var alternate = cloneSong(resolved.song);
  alternate.autoFallbackFrom = songProviderKey(song);
  playQueue[idx] = hydrateCustomCover(alternate);
  safeRenderQueuePanel('source-fallback', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('source-fallback');

  var targetLabel = resolved.resolvedBy === 'qq' ? 'QQ 音乐'
    : resolved.resolvedBy === 'kg' ? '酷狗音乐'
    : resolved.resolvedBy === 'qs' ? '汽水音乐'
    : '网易云音乐';

  var cacheTag = resolved.fromCache === 'url' ? ' (URL缓存)'
    : resolved.fromCache === 'mapping' ? ' (映射缓存)' : '';

  var qInfo = resolved.quality || {};
  var qualityNote = qInfo.label || qInfo.level || '';
  if (qualityNote && qualityNote !== '标准' && qualityNote !== 'standard') {
    qualityNote = ' · ' + qualityNote;
  } else {
    qualityNote = '';
  }

  if (resolved.trial) {
    showSourceFallbackNotice('试听兜底', (song.name || '当前歌曲') + ' — ' + targetLabel + ' 试听' + qualityNote);
  } else if (resolved.fromCache) {
    showSourceFallbackNotice('自动换源' + cacheTag, (song.name || '当前歌曲') + ' → ' + targetLabel + qualityNote);
  } else {
    showSourceFallbackNotice('已自动切换音源', (song.name || '当前歌曲') + ' → ' + targetLabel + qualityNote);
  }

  await playQueueAt(idx, {
    preResolvedUrl: resolved.url,
    preResolvedLevel: qInfo.level,
    preResolvedQuality: qInfo.label
  });
  return true;
}

// Client-side fallback: simple single-platform attempt (preserves old behavior)
async function clientSideFallback(song, idx, token) {
  var target = songProviderKey(song) === 'netease' ? 'qq' : 'netease';
  var query = [song.name || song.title || '', song.artist || ''].filter(Boolean).join(' ').trim();
  if (!query) { skipFailedQueueItem(idx, token, '无法执行客户端降级换源。'); return true; }

  var url = target === 'qq'
    ? '/api/qq/search?keywords=' + encodeURIComponent(query) + '&limit=8'
    : '/api/search?keywords=' + encodeURIComponent(query) + '&limit=12';

  try {
    var data = await apiJson(url);
    var list = data && (data.songs || data.result || []);
    for (var i = 0; i < list.length; i++) {
      if (isSameTitleArtist(song, list[i])) {
        var alternate = cloneSong(list[i]);
        alternate.autoFallbackFrom = songProviderKey(song);
        playQueue[idx] = hydrateCustomCover(alternate);
        safeRenderQueuePanel('source-fallback-client', { scrollCurrent: miniQueueOpen });
        showSourceFallbackNotice('客户端降级换源',
          (song.name || '当前歌曲') + ' → ' + (target === 'qq' ? 'QQ 音乐' : '网易云音乐'));
        await playQueueAt(idx, {});
        return true;
      }
    }
  } catch (e2) { /* fallback also failed */ }

  skipFailedQueueItem(idx, token, '全部换源方式均失败，正在播放下一首。');
  return true;
}
```

- [ ] **Step 4: Remove fallbackDepth logic from skipFailedQueueItem (line 18397)**

Change:
```js
playQueueAt(nextIdx, { fallbackDepth: 0 });
```
To:
```js
playQueueAt(nextIdx);
```

- [ ] **Step 5: Run frontend syntax check**

```bash
node -e "const fs = require('fs'); const html = fs.readFileSync('D:\\Desktop\\Viberadio-1.1.1\\public\\index.html','utf8'); const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || []; let ok = 0; m.forEach((s,i) => { const code = s.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,''); try { new Function('"use strict";' + code); ok++; } catch(e) { console.log('SCRIPT ' + i + ' ERROR:', e.message.slice(0,120)); } }); console.log('OK:', ok + '/' + m.length);"
```
Expected: all scripts OK

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: rewrite tryAutoPlaybackFallback with server-side resolve and client fallback"
```

---

### Task 5: Add Wallpaper Engine state and SSE endpoints (server.js)

**Files:**
- Modify: `D:\Desktop\Viberadio-1.1.1\server.js` — module-level state after Task 1 code; routes inside HTTP handler before `/api/cover`

**Interfaces:**
- Consumes: `sendJSON`, `readRequestBody`
- Produces: `GET /api/wallpaper/stream` (SSE), `POST /api/wallpaper/push`, `wallpaperAudioData`, `wallpaperSubscribers`

- [ ] **Step 1: Insert wallpaper global state at module level (after Task 1's code block)**

These variables must be at module scope (outside the HTTP handler), placed right after the Task 1 code block (which includes circuit breaker, match functions, search strategies, platform dispatch):

```js
// ====================================================================
//  Wallpaper Engine SSE — 全局状态
// ====================================================================
var wallpaperAudioData = {
  playing: false,
  title: '', artist: '', cover: '',
  frequencyData: [],
  primaryColor: '#d6f8ff',
  secondaryColor: '#9cffdf',
};
var wallpaperSubscribers = new Set();
var wallpaperBroadcastTimer = 0;
var WALLPAPER_BROADCAST_MIN_MS = 33; // max 30fps broadcast
```

- [ ] **Step 2: Insert wallpaper routes inside the HTTP handler, before `/api/cover`**

The `/api/wallpaper/push` and `/api/wallpaper/stream` routes go inside the `http.createServer(async (req, res) => { ... })` handler. Insert them immediately before `if (pn === '/api/cover')`:

```js
  // ---------- Wallpaper Engine SSE ----------
  if (pn === '/api/wallpaper/push' && req.method === 'POST') {
    try {
      var pushBody = await readRequestBody(req);
      wallpaperAudioData = { ...wallpaperAudioData, ...pushBody };

      var now = Date.now();
      if (now - wallpaperBroadcastTimer >= WALLPAPER_BROADCAST_MIN_MS) {
        wallpaperBroadcastTimer = now;
        var payload = JSON.stringify(wallpaperAudioData);
        wallpaperSubscribers.forEach(function(client) {
          try { client.write('data: ' + payload + '\n\n'); }
          catch (e) { wallpaperSubscribers.delete(client); }
        });
      }

      sendJSON(res, { ok: true });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message }, 400);
    }
    return;
  }

  if (pn === '/api/wallpaper/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    var heartbeat = setInterval(function() {
      try { res.write(': heartbeat\n\n'); }
      catch (e) { clearInterval(heartbeat); }
    }, 30000);

    res.write('data: ' + JSON.stringify(wallpaperAudioData) + '\n\n');
    wallpaperSubscribers.add(res);

    req.on('close', function() {
      clearInterval(heartbeat);
      wallpaperSubscribers.delete(res);
    });
    return;
  }
```

- [ ] **Step 3: Run syntax check**

```bash
node --check "D:\Desktop\Viberadio-1.1.1\server.js"
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add wallpaper SSE endpoints (/api/wallpaper/stream + /api/wallpaper/push)"
```

---

### Task 6: Add pushWallpaperAudioState to main render loop (public/index.html)

**Files:**
- Modify: `D:\Desktop\Viberadio-1.1.1\public\index.html` — insert function definition near other utility functions and call it from the render loop

**Interfaces:**
- Consumes: `fx.wallpaperMode`, `audioAnalyser`, `playing`, `playQueue`, `currentIdx`, `currentCoverUrl`, `uniforms`
- Produces: `pushWallpaperAudioState(now)`

- [ ] **Step 1: Insert pushWallpaperAudioState function (near applyWallpaperModeState, ~line 26843)**

After `function applyWallpaperModeState(force) {` block:

```js
var wallpaperPushTimer = 0;
function pushWallpaperAudioState(now) {
  if (!fx.wallpaperMode) return;
  if (now - wallpaperPushTimer < 50) return; // 20fps push
  wallpaperPushTimer = now;

  var freqData = null;
  if (audioAnalyser && playing && audio && !audio.paused) {
    if (!audioFreqArray) audioFreqArray = new Uint8Array(audioAnalyser.frequencyBinCount || 64);
    try { audioAnalyser.getByteFrequencyData(audioFreqArray); freqData = Array.from(audioFreqArray.slice(0, 64)); }
    catch (e) { /* analyser may not be ready */ }
  }

  fetch('/api/wallpaper/push', {
    method: 'POST',
    body: JSON.stringify({
      playing: playing,
      title: (playQueue[currentIdx] && playQueue[currentIdx].name) || '',
      artist: (playQueue[currentIdx] && playQueue[currentIdx].artist) || '',
      cover: currentCoverUrl || '',
      frequencyData: freqData,
      primaryColor: (typeof uniforms !== 'undefined' && uniforms.uColor1) ? uniforms.uColor1.value : '#d6f8ff',
      secondaryColor: (typeof uniforms !== 'undefined' && uniforms.uColor2) ? uniforms.uColor2.value : '#9cffdf',
    }),
    headers: { 'Content-Type': 'application/json' },
  }).catch(function(){}); // silent
}
```

- [ ] **Step 2: Call pushWallpaperAudioState from the animate() loop**

Find the `animate()` function (~line 27108). Inside it, after `sampleRenderPerf(now, dt)` (line 27114), add:

```js
  pushWallpaperAudioState(now);
```

- [ ] **Step 3: Run frontend syntax check**

```bash
node -e "const fs = require('fs'); const html = fs.readFileSync('D:\\Desktop\\Viberadio-1.1.1\\public\\index.html','utf8'); const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || []; let ok = 0; m.forEach((s,i) => { const code = s.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,''); try { new Function('"use strict";' + code); ok++; } catch(e) { console.log('SCRIPT ' + i + ' ERROR:', e.message.slice(0,120)); } }); console.log('OK:', ok + '/' + m.length);"
```
Expected: all OK

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add pushWallpaperAudioState to render loop"
```

---

### Task 7: Create Wallpaper Engine package (new files)

**Files:**
- Create: `D:\Desktop\Viberadio-1.1.1\wallpaper-engine\project.json`
- Create: `D:\Desktop\Viberadio-1.1.1\wallpaper-engine\audio-bridge.js`
- Create: `D:\Desktop\Viberadio-1.1.1\wallpaper-engine\index.html`

**Interfaces:**
- Consumes: `GET /api/wallpaper/stream` (SSE endpoint from Task 5)
- Produces: Standalone Wallpaper Engine web wallpaper

- [ ] **Step 1: Create wallpaper-engine/project.json**

```json
{
  "title": "Viberadio Visual Wallpaper",
  "description": "3D audio-reactive particle visualizer. Requires Viberadio running locally (localhost:38080).",
  "type": "web",
  "file": "index.html",
  "general": {
    "supportsaudioprocessing": false
  }
}
```

- [ ] **Step 2: Create wallpaper-engine/audio-bridge.js**

```js
// audio-bridge.js — SSE connection to Viberadio local server
var HOST = 'http://localhost:38080';
var audioState = {
  playing: false, title: '', artist: '', cover: '',
  frequencyData: [], primaryColor: '#d6f8ff', secondaryColor: '#9cffdf',
};
var bridgeReady = false;

function connectBridge() {
  var es = new EventSource(HOST + '/api/wallpaper/stream');

  es.onopen = function() {
    bridgeReady = true;
  };

  es.onmessage = function(event) {
    try {
      var data = JSON.parse(event.data);
      audioState = data;
    } catch (e) {}
  };

  es.onerror = function() {
    bridgeReady = false;
    // EventSource auto-reconnects with exponential backoff
  };

  return es;
}
```

- [ ] **Step 3: Create wallpaper-engine/index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Viberadio Wallpaper</title>
  <style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#050608}
    canvas{position:absolute;inset:0;width:100%;height:100%}
    #cover-bg{position:absolute;inset:0;background-size:cover;background-position:center;filter:blur(64px) saturate(1.4);opacity:0.18;transition:opacity 1.2s}
  </style>
</head>
<body>
  <div id="cover-bg"></div>
  <canvas id="wall"></canvas>
  <script src="audio-bridge.js"></script>
  <script>
    'use strict';
    var canvas = document.getElementById('wall');
    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    var coverBg = document.getElementById('cover-bg');

    if (!gl) {
      // WebGL2 fallback
      gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    }

    var W = 1, H = 1;
    var startTime = performance.now();

    // Screen-space quad
    var positions = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    var vsSource = 'attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0,1);}';
    var fsSource = [
      'precision highp float;',
      'varying vec2 vUv;',
      'uniform float uTime;',
      'uniform vec3 uPrimary;',
      'uniform vec3 uSecondary;',
      'uniform float uEnergy;',       // low-freq energy (0-1)
      'uniform float uPlaying;',      // 1.0 = playing, 0.0 = idle
      '',
      'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
      '',
      'void main(){',
      '  vec2 uv = vUv;',
      '  float t = uTime;',
      '',
      '  // Neon line field (ported from splash shader)',
      '  float lines = 0.0;',
      '  for(int i=0;i<5;i++){',
      '    float fi = float(i);',
      '    float off = sin(t*0.37+fi)*0.12;',
      '    float y = uv.y + off;',
      '    float d = abs(sin(y*18.0 + fi*2.7 + t*0.21));',
      '    float w = 0.012 + uEnergy * 0.028;',
      '    lines += w / (d + w*0.5);',
      '  }',
      '',
      '  // RGB channel offset',
      '  float rOff = sin(t*0.19)*0.004;',
      '  float gOff = cos(t*0.23)*0.003;',
      '  float bOff = sin(t*0.17+1.2)*0.005;',
      '',
      '  float r = 0.012 / (abs(uv.y - 0.5 + rOff) + 0.012) * 0.3;',
      '  float g = 0.012 / (abs(uv.y - 0.5 + gOff) + 0.012) * 0.3;',
      '  float b = 0.012 / (abs(uv.y - 0.5 + bOff) + 0.012) * 0.3;',
      '',
      '  float brightness = lines * (0.6 + uEnergy * 1.2);',
      '  float idleBreath = (1.0 - uPlaying) * 0.15 * (0.5 + 0.5*sin(t*0.8));',
      '',
      '  vec3 col = vec3(0.02, 0.02, 0.04);',
      '  col += uPrimary * r * (0.3 + uEnergy);',
      '  col += uSecondary * g * (0.2 + uEnergy);',
      '  col += mix(uPrimary, uSecondary, 0.5) * b * 0.2;',
      '  col += uPrimary * brightness * 0.7;',
      '  col += uSecondary * brightness * 0.3;',
      '  col += vec3(0.04, 0.03, 0.06) * idleBreath;',
      '',
      '  // Vignette',
      '  float vig = 1.0 - length(uv - 0.5) * 0.9;',
      '  col *= smoothstep(0.0, 0.7, vig);',
      '',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n');

    function compileShader(type, source) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('Shader error:', gl.getShaderInfoLog(shader));
      }
      return shader;
    }

    var vs = compileShader(gl.VERTEX_SHADER, vsSource);
    var fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    var aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var uTime = gl.getUniformLocation(program, 'uTime');
    var uPrimary = gl.getUniformLocation(program, 'uPrimary');
    var uSecondary = gl.getUniformLocation(program, 'uSecondary');
    var uEnergy = gl.getUniformLocation(program, 'uEnergy');
    var uPlaying = gl.getUniformLocation(program, 'uPlaying');

    function hexToRgb(hex) {
      hex = String(hex || '#d6f8ff').replace('#','');
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      return [
        parseInt(hex.slice(0,2), 16) / 255,
        parseInt(hex.slice(2,4), 16) / 255,
        parseInt(hex.slice(4,6), 16) / 255
      ];
    }

    var smoothEnergy = 0;
    var lastCover = '';

    function resize() {
      var dpr = Math.min(1.5, window.devicePixelRatio || 1);
      W = Math.max(1, Math.floor(innerWidth * dpr));
      H = Math.max(1, Math.floor(innerHeight * dpr));
      canvas.width = W; canvas.height = H;
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      gl.viewport(0, 0, W, H);
    }

    function draw(nowMs) {
      requestAnimationFrame(draw);
      resize();

      var t = (nowMs - startTime) * 0.001;
      var st = audioState;

      // Compute low-freq energy from frequencyData
      var rawEnergy = 0;
      if (st.frequencyData && st.frequencyData.length) {
        var sum = 0;
        for (var i = 0; i < Math.min(8, st.frequencyData.length); i++) sum += st.frequencyData[i];
        rawEnergy = (sum / (8 * 255));
      }
      smoothEnergy += (rawEnergy - smoothEnergy) * 0.12;

      // Update cover background
      if (st.cover && st.cover !== lastCover) {
        lastCover = st.cover;
        coverBg.style.backgroundImage = 'url(' + st.cover + ')';
      }
      if (!st.cover && lastCover) {
        lastCover = '';
        coverBg.style.backgroundImage = '';
      }

      var primary = hexToRgb(st.primaryColor || '#d6f8ff');
      var secondary = hexToRgb(st.secondaryColor || '#9cffdf');

      gl.uniform1f(uTime, t);
      gl.uniform3fv(uPrimary, primary);
      gl.uniform3fv(uSecondary, secondary);
      gl.uniform1f(uEnergy, smoothEnergy);
      gl.uniform1f(uPlaying, st.playing ? 1.0 : 0.0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Start SSE bridge
    connectBridge();
    requestAnimationFrame(draw);
  </script>
</body>
</html>
```

- [ ] **Step 4: Verify wallpaper-engine/ files exist**

```bash
ls -la "D:\\Desktop\\Viberadio-1.1.1\\wallpaper-engine\\"
```
Expected: project.json, index.html, audio-bridge.js

- [ ] **Step 5: Commit**

```bash
git add wallpaper-engine/
git commit -m "feat: add Wallpaper Engine web wallpaper package with SSE + WebGL"
```

---

### Task 8: Final verification

**Files:**
- No code changes — verification only

- [ ] **Step 1: Server syntax check**

```bash
node --check "D:\Desktop\Viberadio-1.1.1\server.js"
```
Expected: no output

- [ ] **Step 2: Frontend syntax check (all inline scripts)**

```bash
node -e "var fs=require('fs');var h=fs.readFileSync('D:\\Desktop\\Viberadio-1.1.1\\public\\index.html','utf8');var m=h.match(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi)||[];var ok=0;m.forEach(function(s,i){var c=s.replace(/<script[^>]*>/i,'').replace(/<\\/script>/i,'');try{new Function('\"use strict\";'+c);ok++}catch(e){console.log('SCRIPT '+i+' ERROR:',e.message.slice(0,120))}});console.log('OK: '+ok+'/'+m.length)"
```
Expected: all scripts OK (e.g., "OK: 5/5" or similar)

- [ ] **Step 3: Check git status**

```bash
git status --short
```
Expected: modified files listed, no unexpected untracked files

- [ ] **Step 4: Verify key scenarios exist in code**

```bash
# Check that new route exists
rg "/api/resolve-song-url" "D:\Desktop\Viberadio-1.1.1\server.js"

# Check that preResolvedUrl channel exists
rg "opts.preResolvedUrl" "D:\Desktop\Viberadio-1.1.1\public\index.html"

# Check that old functions are deleted
rg "alternatePlaybackProvider" "D:\Desktop\Viberadio-1.1.1\public\index.html"
# Expected: no matches

rg "searchAlternatePlatformSong" "D:\Desktop\Viberadio-1.1.1\public\index.html"
# Expected: no matches

# Check that SSE endpoints exist
rg "/api/wallpaper/stream" "D:\Desktop\Viberadio-1.1.1\server.js"
rg "/api/wallpaper/push" "D:\Desktop\Viberadio-1.1.1\server.js"

# Check that wallpaper-engine files exist
ls "D:\Desktop\Viberadio-1.1.1\wallpaper-engine\"
```

- [ ] **Step 5: Commit final verification results**

```bash
git add -A
git diff --cached --stat
git commit -m "chore: final verification of multi-source fallback implementation"
```
