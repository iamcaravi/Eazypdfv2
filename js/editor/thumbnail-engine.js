/* ==========================================================================
   js/editor/thumbnail-engine.js
   ---------------------------------------------------------------------------
   Fills in real page thumbnails for the sidebar built by editor-sidebar.js
   (Editor Architecture phase). Deliberately does NOT modify
   editor-sidebar.js's own selection/keyboard-nav logic — it only replaces
   each `.editor-thumb-page` placeholder <div> with a <canvas> once that
   thumbnail scrolls near the sidebar's viewport, using its own
   IntersectionObserver scoped to the thumbnail list (separate from
   viewport-manager's observer on the main canvas — a 300-page sidebar
   doesn't need to eagerly render 300 thumbnails any more than the main
   canvas needs to eagerly render 300 full pages).

   Thumbnails render at a small fixed width (150px) regardless of the main
   canvas's zoom level — they're a navigation aid, not a preview of the
   current zoom.

   Priority 3D fixes (sidebar/thumbnail scope only):
   - Aspect-ratio squish: `.editor-thumb-page`'s CSS default (0.77, see
     editor-workspace.css) was written for the placeholder div and never
     corrected once a real, correctly-proportioned canvas replaced it — so
     any landscape or non-0.77 page rendered into a box shaped for a
     different ratio, stretching it. Same root cause already fixed for the
     main canvas in Priority 3B (viewport-manager.js sets
     `wrap.style.aspectRatio` per page); applied here the same way, per
     thumbnail, from real page dimensions already available via
     RenderEngine.getPageInfo().
   - Lazy-load retry: `placeholder.dataset.rendered` was set to `'true'`
     before the render attempt (intentional — prevents a double-render if
     the same thumbnail re-intersects while the first attempt is still in
     flight) but was never cleared if that attempt failed, so a thumbnail
     that failed once could never be retried even if scrolled away and
     back. Now cleared on failure only, so the debounce-while-in-flight
     behavior is unchanged but a later re-intersection can retry.
   ---------------------------------------------------------------------------
   Public surface:
     ThumbnailEngine.init(root, numPages)
     ThumbnailEngine.destroy()
   ========================================================================== */
(function () {
  const THUMB_WIDTH = 150;
  let observer = null;

  function init(root, numPages) {
    destroy();
    const list = root.querySelector('.editor-thumb-list');
    if (!list) return;

    observer = new IntersectionObserver(onIntersect, {
      root: list,
      rootMargin: '200px 0px 200px 0px',
      threshold: 0
    });
    list.querySelectorAll('.editor-thumb').forEach((el) => observer.observe(el));
  }

  async function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target;
      const pageNumber = Number(wrap.dataset.page);
      const placeholder = wrap.querySelector('.editor-thumb-page');
      if (!placeholder || placeholder.dataset.rendered) continue;
      placeholder.dataset.rendered = 'true'; // mark immediately — avoids double-render on rapid re-intersection
      renderThumb(pageNumber, placeholder);
    }
  }

  async function renderThumb(pageNumber, placeholderEl) {
    try {
      const info = await window.RenderEngine.getPageInfo(pageNumber);
      const scale = THUMB_WIDTH / info.width;
      const canvas = document.createElement('canvas');
      canvas.className = 'editor-thumb-page';
      // Correct the box shape per-thumbnail from the real page dimensions —
      // same fix as viewport-manager.js's wrap.style.aspectRatio (Priority
      // 3B), otherwise every thumbnail is squeezed into the CSS default's
      // fixed 0.77 ratio regardless of the actual page's proportions.
      canvas.style.aspectRatio = `${info.width} / ${info.height}`;
      const task = await window.RenderEngine.renderPage(pageNumber, canvas, scale);
      await task.promise;
      placeholderEl.replaceWith(canvas);
    } catch (err) {
      if (err && err.name !== 'RenderingCancelledException') console.error(`Thumbnail render failed for page ${pageNumber}:`, err);
      // Allow a later re-intersection (e.g. scroll away and back) to retry —
      // without this, a single failed attempt permanently blanked this
      // thumbnail for the rest of the session, since onIntersect skips
      // anything already marked rendered.
      delete placeholderEl.dataset.rendered;
    }
  }

  function destroy() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  window.ThumbnailEngine = { init, destroy };
})();
