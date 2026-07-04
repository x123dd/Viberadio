# Task 8 Report: Final Whole-Branch Review Fixes

**Date:** 2026-07-04

---

## Fix 1 (CRITICAL): `playNext()` replaced with `nextTrack` in preResolvedUrl onended handler

**File:** `D:\Desktop\XHeartMusic-1.1.1\public\index.html`  
**Line:** 18655-18656

**Before:**
```js
if (playMode === 'single') setTimeout(function() { playQueueAt(currentIdx, { autoRepeat: true }); }, 0);
else if (playMode === 'list-order' || playMode === 'shuffle') playNext();
```

**After:**
```js
if (playMode === 'single') setTimeout(function() { playQueueAt(currentIdx, { autoRepeat: true }); }, 0);
else setTimeout(nextTrack, 0);
```

**Rationale:** `playNext()` increments the index without skipping failed items, inconsistent with the normal playback path which uses `nextTrack()`. The dead `list-order` branch was removed (valid playModes are `['loop', 'shuffle', 'single']`).

---

## Fix 2 (IMPORTANT): `artistNameParts` fallback in `clientSideFallback` query construction

**File:** `D:\Desktop\XHeartMusic-1.1.1\public\index.html`  
**Line:** 18460

**Before:**
```js
var query = [song.name || song.title || '', song.artist || ''].filter(Boolean).join(' ').trim();
```

**After:**
```js
var query = [song.name || song.title || '', song.artist || (artistNameParts(song)[0] || '')].filter(Boolean).join(' ').trim();
```

**Rationale:** When `song.artist` is absent but `song.artists` array is populated, the fallback search query was missing artist info. `artistNameParts()` extracts artist names from both `song.artist` string and `song.artists` array.

---

## Fix 3 (IMPORTANT): `res.flushHeaders()` after SSE writeHead

**File:** `D:\Desktop\XHeartMusic-1.1.1\server.js`  
**Line:** 5347

**Before:**
```js
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'X-Accel-Buffering': 'no',
});

var heartbeat = setInterval(function() {
```

**After:**
```js
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'X-Accel-Buffering': 'no',
});
res.flushHeaders();

var heartbeat = setInterval(function() {
```

**Rationale:** Without `flushHeaders()`, Node.js may buffer the SSE response headers, causing the client to wait before receiving the `text/event-stream` response. This ensures headers are sent immediately so the client can begin processing the event stream.

---

## Fix 4 (IMPORTANT): Added `'` (LEFT SINGLE QUOTATION MARK, U+2018) to `normalizeMatchText` regex

**File:** `D:\Desktop\XHeartMusic-1.1.1\server.js`  
**Line:** 3340

**Before:**
```js
.replace(/[\s·・\-—_.,，。:：;；'"!！?？'""/\\|&@#$%^*()（）【】\[\]{}<>~`+=]+/g, ' ')
```

**After:**
```js
.replace(/[\s·・\-—_.,，。:：;；'""!！?？'""/\\|&@#$%^*()（）【】\[\]{}<>~`+=]+/g, ' ')
```

**Rationale:** The character class already contained `'` (U+2019, right single quote), `"` (U+201C, left double quote), and `"` (U+201D, right double quote), but was missing `'` (U+2018, left single quotation mark). Added between `"` and `"`.

**File:** `D:\Desktop\XHeartMusic-1.1.1\public\index.html`  
**Line:** 18325

**Before:**
```js
.replace(/[\s·・\-—_.,，。:：'"“”‘’/\\|]+/g, '');
```

**After:**
```js
.replace(/[\s·・\-—_.,，。:：'"“”‘‘’/\\|]+/g, '');
```

**Note:** The frontend regex already contained both `'` (U+2018) and `'` (U+2019). The additional `'` is a harmless duplicate. Added for consistency with the server-side fix.

---

## Verification Results

| Check | Result |
|---|---|
| Server syntax (`node --check`) | PASS (no output) |
| Frontend script syntax | PASS (5/5 scripts OK) |

---