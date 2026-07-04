# Multi-Source Playback Fallback Design v9

**Date:** 2026-07-04  
**Status:** approved

---

## 一、目标

任一音源失败 → 遍历全平台 → 最大可播率。延迟 ≤ 1s。音质透明对比。壁纸模式输出独立 Wallpaper Engine 包。

### v9 相对于 v8 的增量

| 改进 | 说明 |
|------|------|
| 多搜索策略 | 单一查询无匹配时，渐进简化查询词重搜（最多 3 轮） |
| **音质透明对比** | 换源时显示双方音质（如"无损 FLAC → 320k MP3"），bitrate 入缓存 |
| **Wallpaper Engine 集成** | 独立 Web 壁纸包（`project.json` + WebGL 视觉），通过本地 API 拿实时音频数据 |

---

## 二、核心设计

### 2.1 消除双重拉取

```
旧: playQueueAt → URL失败 → /resolve → 拿到URL → playQueueAt(idx) → 又拉一次URL ✗
新: playQueueAt → URL失败 → /resolve → 拿到URL → playQueueAt(idx, {preResolvedUrl}) → 跳过 ✓
```

### 2.2 二级缓存：映射 vs URL 分离

音乐平台 URL 有效期很短（5-10分钟），但"这首歌在QQ能找到"这个映射长期有效。

```
缓存架构:
  mappingCache  key → {provider, song}      TTL: 2h  命中→直接取URL，跳过搜索
  urlCache      key → {url, level, trial}    TTL: 10min 命中→直接播放

流程:
  请求进来 → mappingCache命中? 
    → 是: 用缓存的provider+song直接取URL(跳过搜索) → urlCache暂存
    → 否: 全平台搜索 → 匹配 → 取URL → 写入两个缓存
```

**收益:** 同一首歌第二次播放时，跳过搜索阶段（3次 HTTP → 1次 HTTP），延迟 ~200ms。

### 2.3 多搜索策略

不同平台对同一首歌的歌名写法可能不同（"日落大道 (Live)" vs "日落大道"、"Beauty and a Beat (feat. Nicki Minaj)" vs "Beauty and a Beat"）。单查询词搜不到就全平台失败。

**渐进式搜索链**：查询词从精确到宽泛，每轮在所有非熔断平台并行搜索：

```
Round 1: name + artist          (最精确: "日落大道 梁博")
Round 2: cleanName + artist     (去括号: "日落大道 梁博")  
Round 3: name                   (仅歌名: "日落大道")
```

- 每轮搜索后立即检查所有平台的合并结果是否有匹配。
- 第一轮命中即停止，不触发后续轮次。
- 所有轮次的结果合并去重后进入 URL 获取阶段。
- 每首歌最多 3 轮搜索请求（而非 1 轮），但仅在前面轮次无匹配时才触发，常态下延迟不变。

### 2.4 并行搜索 + 按优先级取 URL

搜索并行发出。URL 按优先级串行取，第一完整可播立即返回。

### 2.5 试听兜底

全平台只有试听 → 返回最佳试听 URL → 而非"不可播"。

### 2.6 熔断器

连续失败 ≥3 → 30s 熔断 → 半开探测 → 恢复/继续。

### 2.7 并发去重

`pendingResolves` Map 确保同一首歌并发只发一次请求。

### 2.8 客户端降级

`/api/resolve-song-url` 不可用时（网络错误、500），自动降级到客户端逻辑：简单尝试一个备用平台（保留旧版行为）。

### 2.9 增强匹配

简繁归一 · feat./ft./& 展开 · Cover: 前缀剥离 · 标点空白归一。

### 2.10 音质透明对比

换源后用户应知道实际音质变化，而非只看到"已切换平台"。

**数据流增强**：
- `runPlatformUrl` 返回 `br`（实际码率）、`level`（等级）、`quality`（标签）
- URL 缓存存储完整音质信息
- API 响应包含 `quality: { level, label, br }`
- 前端通知对比双方音质

**示例**：
```
请求: lossless → 原平台: 网易云 无损 FLAC (841k)
换源后: QQ 音乐 极高 HQ (297k)
通知: "已自动切换音源 → QQ 音乐  无损 FLAC → 极高 HQ"
```

---

## 三、API: `POST /api/resolve-song-url`

Request/Response 格式同 v6，增加 `fromCache` 字段区分命中类型：

```json
// 缓存命中 (mapping)
{ "ok": true, "resolvedBy": "qq", "url": "...", "song": {...},
  "quality": {"level":"lossless","label":"无损 FLAC","br":841000}, "fromCache": "mapping" }
// 缓存命中 (url)
{ "ok": true, "resolvedBy": "qq", "url": "...", "song": {...},
  "quality": {"level":"exhigh","label":"320k MP3","br":320000}, "fromCache": "url" }
// 全新解析 (首轮匹配)
{ "ok": true, "resolvedBy": "qq", "url": "...", "song": {...},
  "quality": {"level":"lossless","label":"无损 FLAC","br":861000}, "fromCache": false,
  "details": [{"provider":"qq","searchStrategy":"q1","matched":true}] }
// 全新解析 (第二轮回退匹配)
{ "ok": true, "resolvedBy": "qq", "url": "...", "song": {...},
  "quality": {"level":"exhigh","label":"320k MP3","br":297000}, "fromCache": false,
  "details": [
    {"provider":"qq","searchStrategy":"q1","matched":false},
    {"provider":"qq","searchStrategy":"q2","matched":true}
  ] }
// 试听兜底
{ "ok": true, "resolvedBy": "netease", "url": "...", "song": {...},
  "quality": {"level":"standard","label":"标准","br":128000}, "trial": true, "fromCache": false }
// 全部失败
{ "ok": false, "tried": [...], "details": [...] }
```

换源优先级同 v8。

---

## 四、服务端实现 (server.js)

### 4.1 全局状态

```js
// 熔断器
var providerCircuitBreaker = {
  netease: { failures: 0, brokenUntil: 0 },
  qq:      { failures: 0, brokenUntil: 0 },
  kg:      { failures: 0, brokenUntil: 0 },
  qs:      { failures: 0, brokenUntil: 0 },
};
// 二级缓存
var fallbackMappingCache = new Map(); // key → {provider, song, expiresAt}  TTL: 2h
var fallbackUrlCache     = new Map(); // key → {url, level, quality, br, trial, expiresAt}  TTL: 10min
// 并发去重
var pendingResolves = new Map();

var MAPPING_CACHE_TTL = 2 * 60 * 60 * 1000;  // 2h
var URL_CACHE_TTL     = 10 * 60 * 1000;       // 10min
var CIRCUIT_BREAKER_THRESHOLD = 3;
var CIRCUIT_BREAKER_COOLDOWN  = 30000;

setInterval(function() {
  var now = Date.now();
  fallbackMappingCache.forEach(function(v, k) { if (v.expiresAt <= now) fallbackMappingCache.delete(k); });
  fallbackUrlCache.forEach(function(v, k)     { if (v.expiresAt <= now) fallbackUrlCache.delete(k); });
}, 5 * 60 * 1000);
```

### 4.2 熔断器（同 v6）

```js
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
```

### 4.3 文本匹配（同 v6）

```js
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
```

### 4.4 平台分派

```js
function buildFallbackProviderOrder(excludeProvider) {
  var FULL_ORDER = ['netease', 'qq', 'kg', 'qs'];
  return FULL_ORDER.filter(function(p) { return p !== excludeProvider; });
}

function cleanSongName(name) {
  return String(name || '').replace(/[（(【\[].*?[）)】\]]/g, '').replace(/\s+/g, ' ').trim();
}

function buildSearchQueries(name, artist) {
  var clean = cleanSongName(name);
  var queries = [];
  var add = function(q) { if (q && queries.indexOf(q) === -1) queries.push(q); };

  // Round 1: full query
  add([name, artist].filter(Boolean).join(' ').trim());

  // Round 2: cleaned name + artist (去除括号如 "日落大道 (Live)" → "日落大道")
  if (clean && clean !== name) {
    add([clean, artist].filter(Boolean).join(' ').trim());
  }

  // Round 3: name only (最宽泛)
  add(name);
  if (clean && clean !== name) add(clean);

  return queries;
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
    url = raw.url || ''; trial = !!raw.trial; level = raw.level || ''; quality = raw.quality || '';
    br = raw.br || 0;
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
    url = raw.url || ''; trial = !!raw.trial; level = raw.level || ''; quality = raw.quality || '';
    br = raw.br || 0;
  }

  return { url: url, trial: trial, level: level, quality: quality, br: br };
}
```

### 4.5 主函数（二级缓存 + 并发去重）

```js
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

  // 1. URL cache hit → immediate return (fastest path, ~0ms)
  var urlCached = fallbackUrlCache.get(cacheKey);
  if (urlCached && urlCached.expiresAt > Date.now()) {
    return {
      ok: true, resolvedBy: urlCached.resolvedBy, url: urlCached.url,
      song: urlCached.song, quality: { level: urlCached.level, label: urlCached.quality, br: urlCached.br },
      trial: !!urlCached.trial, fromCache: 'url'
    };
  }

  // 2. 并发去重
  var pending = pendingResolves.get(cacheKey);
  if (pending) return pending;

  var resolvePromise = doResolveSongUrl(name, artist, body, cacheKey);
  pendingResolves.set(cacheKey, resolvePromise);
  try { return await resolvePromise; }
  finally { pendingResolves.delete(cacheKey); }
}

async function doResolveSongUrl(name, artist, body, cacheKey) {
  // 3. Mapping cache hit → skip search, fetch URL directly
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

  // 4. Multi-round search — progressive query simplification
  var allProviders = buildFallbackProviderOrder(body.excludeProvider);
  var brokenList = allProviders.filter(function(p) { return isCircuitBroken(p); });
  var providers = allProviders.filter(function(p) { return !isCircuitBroken(p); });
  if (!providers.length) {
    return { ok: false, tried: allProviders, circuitBroken: brokenList,
      reason: 'all_providers_circuit_broken', details: [] };
  }

  var queries = buildSearchQueries(name, artist);
  var allMatches = {}; // provider → song (deduped across rounds)
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
      if (allMatches[provider]) continue; // already matched this provider in earlier round

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

    // Stop rounds if we have at least one match
    if (Object.keys(allMatches).length > 0) break;
  }

  // Record providers that never matched
  providers.forEach(function(p) {
    if (!allMatches[p]) {
      details.push({ provider: p, searchStrategy: 'none', matched: false, error: 'no_match_after_all_rounds' });
    }
  });

  // 5. Sequential URL fetch by priority (respecting original provider order)
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
          // Write both caches
          fallbackMappingCache.set(cacheKey, {
            resolvedBy: prv, song: match,
            expiresAt: Date.now() + MAPPING_CACHE_TTL
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
    } catch (e) { /* URL fetch failed, try next provider */ }
    recordCircuitFailure(prv);
  }

  // 6. Trial fallback
  if (bestTrial) {
    fallbackMappingCache.set(cacheKey, {
      resolvedBy: bestTrial.resolvedBy, song: bestTrial.song,
      expiresAt: Date.now() + MAPPING_CACHE_TTL
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

### 4.6 路由

```js
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

---

## 五、前端实现 (public/index.html)

### 5.1 playQueueAt — preResolvedUrl 通道

在 `markPlayPhase('source-url')` 之前插入。结构与正常音频初始化路径完全一致，区别仅在于 `audio.src` 直接使用 `opts.preResolvedUrl` 而非从 API 获取。

```js
// --- pre-resolved URL from auto-fallback (skip source-url phase) ---
if (opts.preResolvedUrl) {
  markPlayPhase('pre-resolved-audio');
  if (token !== trackSwitchToken) return;

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
```

### 5.2 tryAutoPlaybackFallback — 含客户端降级

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
    // --- 客户端降级: /resolve 不可用时走旧版单平台换源 ---
    if (token !== trackSwitchToken) return true;
    console.warn('[AutoFallback] server resolve failed, falling back to client-side:', e.message);
    return await clientSideFallback(song, idx, token);
  }
}

// 应用服务端换源结果
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

  // 音质对比: 显示双方实际音质等级
  var qInfo = resolved.quality || {};
  var qualityNote = qInfo.label || qInfo.level || '';
  if (qualityNote && qualityNote !== '标准' && qualityNote !== 'standard') {
    qualityNote = ' · ' + qualityNote;
  } else {
    qualityNote = '';
  }

  var trialMsg = '';
  if (resolved.trial) {
    trialMsg = '试听片段' + (qualityNote ? ' · ' + qualityNote : '');
    showSourceFallbackNotice('试听兜底', (song.name || '当前歌曲') + ' — ' + targetLabel + ' ' + trialMsg);
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

// 客户端降级: 简单尝试一个备用平台（保留旧版行为，确保新端点挂了也不比旧版差）
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
  } catch (e2) { /* 降级也失败 */ }

  skipFailedQueueItem(idx, token, '全部换源方式均失败，正在播放下一首。');
  return true;
}
```

### 5.3 删除

| 删除项 | 原因 |
|--------|------|
| `alternatePlaybackProvider` | → `buildFallbackProviderOrder` (server) |
| `searchAlternatePlatformSong` | → `resolveSongUrl` (server) |
| `fallbackDepth` 相关全部 | `preResolvedUrl` 无递归 |

保留: `normalizeMatchText` / `artistNameParts` / `isSameTitleArtist`。

### 5.4 音质信息传递

换源后 `preResolvedLevel` / `preResolvedQuality` 传递给 `playQueueAt`。在 `playQueueAt` 的 `preResolvedUrl` 通道内，如果存在这些字段，跳过 source-url API 调用的同时仍记录音质信息用于 UI 显示：

```js
if (opts.preResolvedUrl) {
  // ... 现有 preResolvedUrl 逻辑 ...
  // 记录换源音质信息
  if (opts.preResolvedLevel) currentPlaybackQualityLevel = opts.preResolvedLevel;
  if (opts.preResolvedQuality) currentPlaybackQualityLabel = opts.preResolvedQuality;
  // ...
}
```

---

## 六、延迟路径对比

| 场景 | 路径 | 延迟 |
|------|------|------|
| **URL缓存命中** | 请求 → urlCache.get → 返回 | ~0ms |
| **映射缓存命中** | 请求 → mappingCache.get → 取URL(1次HTTP) → 返回 | ~200ms |
| **全新解析 (q1命中)** | 请求 → 并行搜索(3次HTTP) → 取URL(1-N次HTTP) → 返回 | ~500-1200ms |
| **全新解析 (需q2回退)** | q1无匹配 → q2并行搜索(3次HTTP) → 取URL → 返回 | ~800-1800ms |
| **全新解析 (需q3回退)** | q1+q2无匹配 → q3并行搜索 → 取URL → 返回 | ~1100-2400ms |
| **客户端降级** | /resolve超时 → 客户端搜索(1次HTTP) → 匹配 → playQueueAt | ~800ms |

---

## 七、改动清单

### 多源换源

| 文件 | 增 | 删 | 说明 |
|------|----|-----|------|
| `server.js` | ~320 行 | 0 | buildSearchQueries、cleanSongName、二级缓存（含br）、熔断器、match函数、runPlatform*（含br）、resolveSongUrl（含多轮搜索）、路由 |
| `public/index.html` | ~200 行 | ~60 行 | preResolvedUrl通道+音质记录、重写fallback+音质对比、客户端降级、pushWallpaperAudioState、删废弃函数 |

### Wallpaper Engine

| 文件 | 类型 | 说明 |
|------|------|------|
| `server.js` | +~60 行 | SSE `/api/wallpaper/stream` + `/api/wallpaper/push` + 广播 + 心跳 |
| `wallpaper-engine/project.json` | 新文件 | WE 清单 |
| `wallpaper-engine/index.html` | 新文件 | WebGL 壁纸渲染 (~200行) |
| `wallpaper-engine/audio-bridge.js` | 新文件 | 本地 API 通信 (~30行) |

---

## 八、验证清单

| # | 场景 | 预期 |
|---|------|------|
| 1 | 正常可播 | 不触发换源 |
| 2 | NEC失败→QQ命中（首轮q1） | 自动切QQ，`details[0].searchStrategy: "q1"` |
| 3 | 歌名含括号（如"日落大道 (Live)"），q1无匹配→q2命中 | q2搜索命中，`details` 含 q1 失败 + q2 成功 |
| 4 | 再次播放同一首歌 | URL缓存命中，`fromCache: 'url'`，~0ms |
| 5 | URL缓存过期但映射有效 | 映射命中，直接取URL，`fromCache: 'mapping'`，~200ms |
| 6 | NEC→QQ失败→酷狗命中 | 自动切酷狗 |
| 7 | 全平台无可播 | "全部平台无版本"，跳下一首 |
| 8 | 全平台仅试听 | 试听兜底，"试听兜底"通知 |
| 9 | `/resolve` 服务端500/超时 | 客户端降级，"客户端降级换源"通知 |
| 10 | 客户端降级也失败 | "全部换源方式均失败"，跳下一首 |
| 11 | 熔断触发 | 连续3次失败 → 30s熔断 |
| 12 | 并发去重 | 同歌并发 → 仅一次请求 |
| 13 | 搜索轮次提前终止 | 任一平台匹配即停止后续轮次 |
| 14 | 音质对比通知 | 换源通知含实际音质标签（如"无损 FLAC"） |
| 15 | `node --check server.js` | 无错误 |
| 16 | 前端语法检查 | 无错误 |

---

## 九、Wallpaper Engine 集成

### 9.1 目标

将 Viberadio 的 3D 音乐可视化输出为独立的 Wallpaper Engine Web 壁纸包。用户通过 Steam Workshop 订阅后，桌面背景实时显示当前播放歌曲的粒子视觉效果。

### 9.2 架构

```
Viberadio Electron App (localhost:38080)
  ├── server.js  ← 新增 /api/wallpaper/state
  ├── public/index.html  ← 主界面 + 音频分析
  └── public/wallpaper.html  ← 现有 2D 壁纸（保留，用于内置壁纸模式）

wallpaper-engine/  ← 新增独立目录，打包为 Wallpaper Engine 壁纸
  ├── project.json       # Wallpaper Engine 清单
  ├── index.html         # WebGL 壁纸入口
  └── audio-bridge.js    # 与 Viberadio 本地服务器通信
```

数据流（SSE 推送，无轮询开销）：
```
主窗口 rAF → POST /api/wallpaper/push (20fps, 仅当 wallpaperMode 开启)
                  ↓
           server.js 内存缓存 → 广播给所有 SSE 订阅者
                  ↓
Wallpaper Engine 壁纸 ← EventSource SSE 长连接 ← 即时收到更新
```

### 9.3 project.json

```json
{
  "title": "Viberadio Visual Wallpaper",
  "description": "3D audio-reactive particle visualizer. Requires Viberadio running locally.",
  "type": "web",
  "file": "index.html",
  "general": {
    "supportsaudioprocessing": false
  },
  "preview": "preview.png"
}
```

### 9.4 服务端: SSE 实时推送

用 SSE 替代 HTTP polling，一个长连接替代每秒 20 次请求。Node 原生支持，零额外依赖。

```js
// server.js 新增 — 全局状态 + SSE 订阅者管理
var wallpaperAudioData = {
  playing: false,
  title: '', artist: '', cover: '',
  frequencyData: [],       // Uint8Array → 普通数组, 64 bins
  primaryColor: '#d6f8ff',
  secondaryColor: '#9cffdf',
};

var wallpaperSubscribers = new Set(); // SSE 客户端连接
var wallpaperBroadcastTimer = 0;
var WALLPAPER_BROADCAST_MIN_MS = 33; // 最高 30fps 广播，防止突发

// POST /api/wallpaper/push — 主窗口推送音频数据
if (pn === '/api/wallpaper/push' && req.method === 'POST') {
  try {
    var pushBody = await readRequestBody(req);
    wallpaperAudioData = { ...wallpaperAudioData, ...pushBody };

    // 限频广播给所有 SSE 订阅者
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

// GET /api/wallpaper/stream — SSE 端点，壁纸长连接
if (pn === '/api/wallpaper/stream' && req.method === 'GET') {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',   // 禁用 nginx 缓冲
  });

  // 心跳保持连接 (每 30s 一个注释帧，防止代理断开)
  var heartbeat = setInterval(function() {
    try { res.write(': heartbeat\n\n'); }
    catch (e) { clearInterval(heartbeat); }
  }, 30000);

  // 发送当前状态
  res.write('data: ' + JSON.stringify(wallpaperAudioData) + '\n\n');
  wallpaperSubscribers.add(res);

  req.on('close', function() {
    clearInterval(heartbeat);
    wallpaperSubscribers.delete(res);
  });
  return;
}
```

### 9.5 主窗口推送 (public/index.html)

在现有的 `requestAnimationFrame` 渲染循环中增加推送逻辑（约每 50ms 推送一次，节省带宽）：

```js
var wallpaperPushTimer = 0;
function pushWallpaperAudioState(now) {
  if (!fx.wallpaperMode) return;
  if (now - wallpaperPushTimer < 50) return; // 20fps 推送，足够壁纸渲染
  wallpaperPushTimer = now;

  var freqData = null, waveData = null;
  if (audioAnalyser) {
    if (!audioFreqArray) audioFreqArray = new Uint8Array(audioAnalyser.frequencyBinCount || 64);
    audioAnalyser.getByteFrequencyData(audioFreqArray);
    freqData = Array.from(audioFreqArray.slice(0, 64));
  }

  fetch('/api/wallpaper/push', {
    method: 'POST',
    body: JSON.stringify({
      playing: playing,
      title: (playQueue[currentIdx] && playQueue[currentIdx].name) || '',
      artist: (playQueue[currentIdx] && playQueue[currentIdx].artist) || '',
      cover: currentCoverUrl || '',
      frequencyData: freqData,
      primaryColor: uniforms.uColor1 ? uniforms.uColor1.value : '#d6f8ff',
      secondaryColor: uniforms.uColor2 ? uniforms.uColor2.value : '#9cffdf',
    }),
    headers: { 'Content-Type': 'application/json' },
  }).catch(function(){}); // 静默失败，不影响主播放
}
```

### 9.6 壁纸端 (wallpaper-engine/index.html + audio-bridge.js)

**audio-bridge.js** — SSE 长连接，零轮询开销，浏览器原生自愈重连：

```js
// audio-bridge.js — 无需任何依赖
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
    console.log('[Wallpaper] SSE connected');
  };

  es.onmessage = function(event) {
    try {
      var data = JSON.parse(event.data);
      audioState = data;
    } catch (e) {}
  };

  es.onerror = function() {
    bridgeReady = false;
    // EventSource 自动重连（指数退避），无需手动处理
    // 断连期间壁纸渲染循环使用上次收到的数据 + 呼吸动画
  };

  return es;
}
```

**index.html** — WebGL 渲染循环（移植主窗口 splash shader）：

```
- WebGL 全屏 quad + fragment shader（霓虹线场 + RGB 偏移 + 距离场高光）
- 粒子系统响应 audioState.frequencyData 低频能量 (bins 0-7)
- 封面图：CSS 模糊背景层 + WebGL 径向辉光叠加
- audioState.playing === true: 粒子活跃，颜色响应频谱
- audioState.playing === false: 缓慢呼吸动画，粒子降低到 20% 密度
- bridgeReady === false: 使用上次缓存状态，粒子降至呼吸态
- 颜色：shader 内使用 audioState.primaryColor / secondaryColor 注入为 uniform
```

### 9.7 SSE vs Polling 对比

| 维度 | 旧 polling 方案 | 新 SSE 方案 |
|------|----------------|------------|
| 请求数 | 20 req/s (1,200/min) | 1 个长连接 |
| 延迟 | 0-50ms (取决于轮询相位) | 即时推送 |
| 带宽 | HTTP headers 开销 × 1200/min | 仅数据帧，无重复 headers |
| 依赖 | 零 | 零（Node 原生 HTTP） |
| 重连 | 需手动实现 | EventSource 内置指数退避 |
| 心跳 | 不需要（轮询本身就是心跳） | 30s 注释帧防代理断开 |
| CPU | JSON parse 20次/s | JSON parse ~20次/s（相同） |

### 9.8 打包与发布

```bash
# 构建 Wallpaper Engine 壁纸包
cd wallpaper-engine
# 直接复制文件夹到 Wallpaper Engine 的 projects 目录
# 或打包为 zip 发布到 Steam Workshop
```

Wallpaper Engine 加载路径：
1. 打开 Wallpaper Engine → 选择"从文件安装" → 浏览到 `wallpaper-engine/` 目录
2. 或复制到 `C:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\projects\myprojects\viberadio\`

### 9.9 改动清单（壁纸部分）

| 文件 | 增 | 说明 |
|------|----|------|
| `server.js` | ~60 行 | SSE 端点 `/api/wallpaper/stream` + push 路由 + 广播管理 + 心跳 |
| `public/index.html` | ~25 行 | `pushWallpaperAudioState` 推送函数（20fps） |
| `wallpaper-engine/project.json` | 新文件 | Wallpaper Engine 清单 |
| `wallpaper-engine/index.html` | 新文件 | WebGL 壁纸渲染（~200 行） |
| `wallpaper-engine/audio-bridge.js` | 新文件 | SSE EventSource 连接（~35 行） |
