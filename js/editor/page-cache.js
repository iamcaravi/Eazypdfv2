/* ==========================================================================
   js/editor/page-cache.js
   ---------------------------------------------------------------------------
   Caches rendered page bitmaps so scrolling back to a page you already
   rendered at the current zoom is instant (draw from cache) instead of
   asking pdf.js to render it again. Keyed by `${page}@${scale}` — changing
   zoom naturally misses the cache and re-renders, which is correct (a
   cached 100%-zoom bitmap is the wrong size to reuse at 200%).

   Capped at MAX_ENTRIES with simple LRU eviction (oldest-accessed first) so
   a 300-page document doesn't keep 300 full-resolution canvases in memory
   at once — this is the module directly responsible for "no memory leaks"
   on large documents.
   ---------------------------------------------------------------------------
   Public surface:
     PageCache.get(page, scale) -> ImageBitmap|HTMLCanvasElement|null
     PageCache.set(page, scale, sourceCanvas)
     PageCache.has(page, scale) -> boolean
     PageCache.clear()
   ========================================================================== */
(function () {
  const MAX_ENTRIES = 24; // ~ a couple of screens' worth of pages at once
  const store = new Map(); // key -> { bitmap, lastAccess }

  function key(page, scale) {
    return `${page}@${scale.toFixed(2)}`;
  }

  function get(page, scale) {
    const k = key(page, scale);
    const entry = store.get(k);
    if (!entry) return null;
    entry.lastAccess = performance.now();
    return entry.bitmap;
  }

  function has(page, scale) {
    return store.has(key(page, scale));
  }

  /** Stores a *copy* of the canvas's pixels (an ImageBitmap where supported)
   *  so the source <canvas> can be safely reused/GC'd without corrupting
   *  the cached copy. Falls back to cloning onto an OffscreenCanvas /
   *  regular canvas where ImageBitmap isn't available. */
  async function set(page, scale, sourceCanvas) {
    const k = key(page, scale);
    let bitmap;
    if ('createImageBitmap' in window) {
      bitmap = await createImageBitmap(sourceCanvas);
    } else {
      const clone = document.createElement('canvas');
      clone.width = sourceCanvas.width;
      clone.height = sourceCanvas.height;
      clone.getContext('2d').drawImage(sourceCanvas, 0, 0);
      bitmap = clone;
    }

    evictIfNeeded();
    store.set(k, { bitmap, lastAccess: performance.now() });
  }

  function evictIfNeeded() {
    while (store.size >= MAX_ENTRIES) {
      let oldestKey = null, oldestTime = Infinity;
      for (const [k, v] of store) {
        if (v.lastAccess < oldestTime) { oldestTime = v.lastAccess; oldestKey = k; }
      }
      if (!oldestKey) break;
      const entry = store.get(oldestKey);
      if (entry.bitmap.close) entry.bitmap.close(); // release ImageBitmap memory explicitly
      store.delete(oldestKey);
    }
  }

  function clear() {
    store.forEach((v) => { if (v.bitmap.close) v.bitmap.close(); });
    store.clear();
  }

  window.PageCache = { get, set, has, clear };
})();
