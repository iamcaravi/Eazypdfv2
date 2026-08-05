/* ==========================================================================
   js/editor/viewport-manager.js
   ---------------------------------------------------------------------------
   Owns the main canvas's scrollable content: one wrapper + <canvas> per PDF
   page, stacked vertically inside .editor-canvas (continuous-scroll mode,
   the standard PDF-viewer UX). This is the module IntersectionObserver
   lives in — pages only get a RenderQueue.request() when they enter the
   observer's rootMargin (a screen or so ahead of the visible area), which
   is what makes "render only visible pages" and "lazy page rendering" true
   for a 300-page document instead of rendering everything on load.

   Reuses the existing `.editor-canvas-page` class from
   css/editor-workspace.css (Editor Architecture phase) for every page
   wrapper — one class, N instances, same as how `.editor-thumb` already
   works in editor-sidebar.js. No new per-page CSS was needed; see
   PDF_RENDERING.md for the two small additions that *were* needed
   (`.editor-canvas-pages`, `.is-rendering`).
   ---------------------------------------------------------------------------
   Public surface:
     ViewportManager.init(root)
     ViewportManager.mountDocument(numPages)
     ViewportManager.scrollToPage(pageNumber, { smooth })
     ViewportManager.getCurrentPage() -> number
     ViewportManager.rerenderAtCurrentScale()
     ViewportManager.destroy()
   Events emitted:
     editor:pageChange { page, pageCount }   (existing statusbar contract, unchanged)
   ========================================================================== */
(function () {
  // 0, 0.05, 0.10 ... 1.0 — see setupObserver() for why finer than the
  // previous [0, 0.5, 1].
  const THRESHOLD_STEPS = Array.from({ length: 21 }, (_, i) => Math.min(1, i / 20));

  let root, canvasEl, pagesEl;
  let preloadObserver = null;
  let visibilityObserver = null;
  let pageWrappers = [];
  let currentPage = 1;
  let numPages = 0;
  let panState = null; // { startX, startY, scrollLeft, scrollTop } while dragging
  let spaceHeld = false;

  // pageNumber -> last known intersectionRatio, for every page currently
  // intersecting at all. Kept persistently (not just read off the current
  // IntersectionObserver callback's `entries`, which only ever contains
  // the pages whose state *changed* since the last callback) so "which
  // page is most visible" is computed across the true, full set of
  // currently-visible pages — see root-cause analysis (Priority 3B).
  const visibilityRatios = new Map();

  // True while a programmatic scroll (thumbnail click, keyboard nav,
  // Home/End) is in flight. scrollToPage() already sets currentPage
  // synchronously and correctly the moment it's called; suppressing the
  // observer's own currentPage updates until that scroll settles stops a
  // mid-animation intersection reading from overwriting it with a page
  // the view is only transiently passing through.
  let suppressObserverSync = false;
  let suppressObserverTimer = null;

  // Bumped on every mountDocument() call so the async real-dimension pass
  // below can tell if a *newer* document replaced this one while it was
  // still fetching page sizes, and abandon writing to now-stale wrappers.
  let docGeneration = 0;

  function init(rootEl) {
    root = rootEl;
    canvasEl = root.querySelector('.editor-canvas');
    setupPan();
    setupWheelZoom();
  }

  /**
   * Root cause (Priority 3B): the frozen file's `.editor-canvas-page` rule
   * hardcodes width:min(620px,100%) + aspect-ratio:0.77 for its single
   * portrait demo placeholder. Every real wrapper inherited that same
   * fixed portrait shape by default — fine for most pages, wrong for
   * landscape or otherwise-proportioned ones, and exactly what the
   * IntersectionObserver measures visibility against.
   *
   * Two approaches were tried and rejected by this milestone's own testing
   * before this one:
   *   1. Strip the default entirely (aspect-ratio:auto) — left wrappers
   *      with no intrinsic size until their canvas actually rendered,
   *      so every not-yet-rendered page in the 1200px preload margin
   *      collapsed/reflowed as it rendered, dragging scroll position out
   *      from under whatever the user had just navigated to.
   *   2. Keep the 0.77 placeholder, correct each wrapper's real ratio
   *      asynchronously right after mount — still broken: if the user
   *      scrolled/clicked before every *earlier* page's real ratio had
   *      resolved, those earlier pages shrinking afterward (landscape
   *      pages are shorter than the 0.77 default) reflowed everything
   *      below them, again dragging the current scroll position away
   *      from the page it was supposed to be showing.
   *
   * This is the fix that holds up: fetch every page's real dimensions
   * (RenderEngine.getPageInfo — cheap page metadata, not a render, ~66ms
   * for 300 pages in parallel, negligible next to the document load
   * itself) BEFORE building a single wrapper, so every one is correctly
   * sized from its very first frame. No default-then-correct step means
   * nothing can reflow out from under a scroll position that hasn't
   * happened yet.
   */
  async function mountDocument(count) {
    destroyObserver();
    // A stale cached bitmap or in-flight render from whatever document was
    // previously mounted must not leak into this one — PageCache and
    // RenderQueue are keyed only by page-number+scale, with no notion of
    // *which document* a page number belongs to. Without this, loading a
    // new document whose page N happens to share a page number (and
    // scale) with the previous document's page N could silently reuse
    // that old, wrong-sized bitmap — discovered via this milestone's own
    // regression testing (loading several documents in sequence, exactly
    // as a real session would) and confirmed by direct measurement: an
    // early page's wrapper rendered at the *previous* document's
    // dimensions, throwing off every subsequent page's cumulative scroll
    // offset by exactly that discrepancy.
    window.RenderQueue && window.RenderQueue.cancelAll();
    window.PageCache && window.PageCache.clear();
    docGeneration++;
    const generation = docGeneration;

    const infos = await Promise.all(
      Array.from({ length: count }, (_, i) => window.RenderEngine.getPageInfo(i + 1).catch(() => null))
    );
    if (generation !== docGeneration) return; // superseded by a newer document while fetching

    numPages = count;
    currentPage = 1;
    visibilityRatios.clear();
    suppressObserverSync = false;
    clearTimeout(suppressObserverTimer);

    // Build (or reuse) the pages container inside .editor-canvas, alongside
    // the existing empty/loading state elements from editor-canvas.js —
    // untouched, still there, just hidden by the state machine's CSS.
    pagesEl = canvasEl.querySelector('.editor-canvas-pages');
    if (!pagesEl) {
      pagesEl = document.createElement('div');
      pagesEl.className = 'editor-canvas-pages';
      canvasEl.appendChild(pagesEl);
    }
    pagesEl.innerHTML = '';
    pageWrappers = [];

    for (let n = 1; n <= count; n++) {
      const wrap = document.createElement('div');
      wrap.className = 'editor-canvas-page';
      wrap.dataset.page = String(n);
      wrap.setAttribute('role', 'img');
      wrap.setAttribute('aria-label', `Page ${n} of ${count}`);
      const info = infos[n - 1];
      if (info && info.width && info.height) wrap.style.aspectRatio = `${info.width} / ${info.height}`;
      const canvas = document.createElement('canvas');
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      wrap.appendChild(canvas);
      wrap.appendChild(spinner);
      pagesEl.appendChild(wrap);
      pageWrappers.push(wrap);
    }

    setupObserver();
    window.dispatchEvent(new CustomEvent('editor:pageChange', { detail: { page: 1, pageCount: count } }));
  }

  function setupObserver() {
    // IMPORTANT: percentage-based rootMargin (e.g. "100%") is ambiguous
    // enough across browsers with a non-viewport `root` that it was
    // observed causing every page to register as intersecting immediately
    // — the opposite of lazy rendering. Fixed pixel margins are
    // unambiguous per spec and verified correct (see PDF_RENDERING.md
    // §"Lazy rendering verification" for the before/after measurement).
    const preloadPx = 1200; // roughly 1.5 screens of pages, pre-rendered ahead of scroll
    preloadObserver = new IntersectionObserver(onPreloadIntersect, {
      root: canvasEl,
      rootMargin: `${preloadPx}px 0px ${preloadPx}px 0px`,
      threshold: 0
    });

    // Root-cause fix (Priority 3B): this used to be the *same* observer as
    // preloadObserver above. Its ratios are measured against the root
    // *expanded* by rootMargin — inside a 2400px-tall band, several nearby
    // pages can all read ratio ~1.0 at once, so "most visible" was really
    // just an arbitrary near-tie-break, not a measure of what's actually
    // on screen. A second observer with zero margin measures real,
    // on-screen visibility only, decoupled from the preload distance.
    visibilityObserver = new IntersectionObserver(onVisibilityIntersect, {
      root: canvasEl,
      rootMargin: '0px',
      // Finer steps than the original [0, 0.5, 1] — with mixed page
      // heights (or several short pages at once) the "most visible" page
      // can change well before crossing a 50% boundary; more callback
      // points keep visibilityRatios accurate throughout a scroll instead
      // of only at its coarse midpoint/end.
      threshold: THRESHOLD_STEPS
    });

    pageWrappers.forEach((w) => { preloadObserver.observe(w); visibilityObserver.observe(w); });
  }

  function destroyObserver() {
    if (preloadObserver) { preloadObserver.disconnect(); preloadObserver = null; }
    if (visibilityObserver) { visibilityObserver.disconnect(); visibilityObserver = null; }
  }

  /** Drives lazy rendering / memory release only — unrelated to "which
   *  page is current" as of this milestone (see visibilityObserver). */
  function onPreloadIntersect(entries) {
    for (const entry of entries) {
      const pageNumber = Number(entry.target.dataset.page);
      if (entry.isIntersecting) {
        renderWrapper(entry.target, pageNumber);
      } else {
        // Left the render margin entirely — cancel if it never finished,
        // freeing the slot for pages the user is actually scrolling toward.
        window.RenderQueue && window.RenderQueue.cancel(pageNumber);
        releaseCanvasMemory(entry.target);
      }
    }
  }

  /** Drives "which page is current" only — real, zero-margin visibility. */
  function onVisibilityIntersect(entries) {
    for (const entry of entries) {
      const pageNumber = Number(entry.target.dataset.page);
      if (entry.isIntersecting) {
        // Persist this page's ratio regardless of whether it ends up being
        // the max this callback — a later callback for a *different* page
        // needs every currently-visible page's last-known ratio to compare
        // against, not just whichever pages happened to change just now.
        visibilityRatios.set(pageNumber, entry.intersectionRatio);
      } else {
        visibilityRatios.delete(pageNumber);
      }
    }

    // A programmatic navigation (thumbnail click / keyboard) already set
    // currentPage synchronously and correctly in scrollToPage() — don't
    // let a mid-transition intersection reading fight it.
    if (suppressObserverSync) return;

    // `>=` rather than `>`: Map iteration is insertion order (ascending
    // page number as pages (re)enter view), so on a tie this keeps the
    // higher-numbered page — the one the view actually scrolled *to*.
    let mostVisible = null, mostRatio = 0;
    for (const [pageNumber, ratio] of visibilityRatios) {
      if (ratio >= mostRatio) { mostRatio = ratio; mostVisible = pageNumber; }
    }
    if (mostVisible && mostVisible !== currentPage) {
      currentPage = mostVisible;
      window.EditorSidebar && window.EditorSidebar.setCurrentPage(currentPage);
      window.dispatchEvent(new CustomEvent('editor:pageChange', { detail: { page: currentPage, pageCount: numPages } }));
    }
  }

  /**
   * A page's DOM <canvas> keeps its full-resolution pixel buffer alive in
   * browser memory for as long as it exists, independent of PageCache's own
   * 24-entry eviction (which only bounds PageCache's *separate* ImageBitmap
   * copies, not the live canvases). Without this, scrolling end-to-end
   * through a 300-page document would leave all 300 canvases holding their
   * rendered pixels simultaneously — hundreds of MB with no ceiling. Once a
   * page's wrapper has fully left the render margin, zero its canvas's
   * dimensions to release that backing store; the cheap PageCache copy (if
   * still within its own 24-entry window) or a fresh RenderQueue request
   * restores it instantly if the user scrolls back.
   */
  function releaseCanvasMemory(wrapEl) {
    const canvas = wrapEl.querySelector('canvas');
    if (canvas && canvas.dataset.rendered === 'true') {
      canvas.width = 0;
      canvas.height = 0;
      delete canvas.dataset.rendered;
    }
  }

  async function renderWrapper(wrapEl, pageNumber) {
    const scale = window.ZoomManager.getScale();
    const canvas = wrapEl.querySelector('canvas');

    const cached = window.PageCache.get(pageNumber, scale);
    if (cached) {
      canvas.width = cached.width; canvas.height = cached.height;
      canvas.getContext('2d').drawImage(cached, 0, 0);
      canvas.dataset.rendered = 'true';
      return;
    }

    window.LoadingManager.markPageLoading(wrapEl);
    try {
      await window.RenderQueue.request(pageNumber, canvas, scale, priorityFor(pageNumber));
      // Under rapid scrolling, this exact page can leave the observer's
      // margin (see releaseCanvasMemory, which zeroes canvas.width/height)
      // in the gap between the render above finishing and this line
      // running. That's an abandoned render, not a failure — a fresh
      // RenderQueue request re-renders it correctly if scrolled back to;
      // without this check, PageCache.set() below throws trying to
      // snapshot a zero-size canvas.
      if (canvas.width === 0 || canvas.height === 0) return;
      canvas.dataset.rendered = 'true';
      await window.PageCache.set(pageNumber, scale, canvas);
    } catch (err) {
      console.error(`Failed to render page ${pageNumber}:`, err);
    } finally {
      window.LoadingManager.markPageLoaded(wrapEl);
    }
  }

  function priorityFor(pageNumber) {
    // Pages closer to the current page render first — keeps the visible
    // viewport sharp even when many pages entered the observer's margin
    // at once (e.g. after a fast scroll or a zoom change).
    return -Math.abs(pageNumber - currentPage);
  }

  function rerenderAtCurrentScale() {
    pageWrappers.forEach((w) => {
      const rect = w.getBoundingClientRect();
      const canvasRect = canvasEl.getBoundingClientRect();
      const isNearViewport = rect.bottom > canvasRect.top - canvasRect.height && rect.top < canvasRect.bottom + canvasRect.height;
      if (isNearViewport) renderWrapper(w, Number(w.dataset.page));
    });
  }

  function scrollToPage(pageNumber, { smooth = true } = {}) {
    const wrap = pageWrappers[pageNumber - 1];
    if (!wrap) return;

    // Single source of truth for "where the user asked to go" — set
    // immediately rather than waiting for the IntersectionObserver to
    // agree. This is the fix for thumbnail-click / keyboard nav landing on
    // the wrong page: previously this info only ever arrived asynchronously
    // via onIntersect, which — especially mid-scroll — could report a
    // different page than the one actually requested.
    if (pageNumber !== currentPage) {
      currentPage = pageNumber;
      window.EditorSidebar && window.EditorSidebar.setCurrentPage(currentPage);
      window.dispatchEvent(new CustomEvent('editor:pageChange', { detail: { page: currentPage, pageCount: numPages } }));
    }

    // Suppress the observer's own currentPage updates until this (possibly
    // animated) scroll actually settles, so a mid-transition intersection
    // reading can't overwrite the correct page just set above with
    // whatever the view is only transiently passing through.
    suppressObserverSync = true;
    clearTimeout(suppressObserverTimer);
    const clearSuppress = () => {
      suppressObserverSync = false;
      canvasEl.removeEventListener('scrollend', clearSuppress);
    };
    canvasEl.addEventListener('scrollend', clearSuppress, { once: true });
    // Fallback for browsers without `scrollend`, or if the target was
    // already fully in view and no scroll (hence no scrollend) fires at
    // all. Generous on purpose: a long-distance smooth scroll (jumping
    // many pages, e.g. Home/End on a large document, or a distant
    // thumbnail click) can measurably take upward of 800ms to actually
    // settle — a shorter fallback here would win the race against the
    // real scrollend event and re-enable the observer mid-animation,
    // which is exactly the bug this suppression exists to prevent. This
    // timeout should rarely fire in practice; scrollend is the real signal.
    suppressObserverTimer = setTimeout(clearSuppress, smooth ? 2000 : 50);

    wrap.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }

  function getCurrentPage() { return currentPage; }

  // --- Space+drag pan and middle-mouse pan ---
  function setupPan() {
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTypingTarget(e.target)) { spaceHeld = true; canvasEl.style.cursor = 'grab'; } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceHeld = false; canvasEl.style.cursor = ''; } });

    canvasEl.addEventListener('mousedown', (e) => {
      const isMiddle = e.button === 1;
      const isSpaceDrag = e.button === 0 && spaceHeld;
      if (!isMiddle && !isSpaceDrag) return;
      e.preventDefault();
      panState = { startX: e.clientX, startY: e.clientY, scrollLeft: canvasEl.scrollLeft, scrollTop: canvasEl.scrollTop };
      canvasEl.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!panState) return;
      canvasEl.scrollLeft = panState.scrollLeft - (e.clientX - panState.startX);
      canvasEl.scrollTop = panState.scrollTop - (e.clientY - panState.startY);
    });
    window.addEventListener('mouseup', () => {
      if (!panState) return;
      panState = null;
      canvasEl.style.cursor = spaceHeld ? 'grab' : '';
    });
    canvasEl.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); }); // stop middle-click autoscroll icon
  }

  function isTypingTarget(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  // --- Ctrl+wheel zoom ---
  function setupWheelZoom() {
    canvasEl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      window.ZoomManager.handleWheelDelta(e.deltaY);
    }, { passive: false });
  }

  function destroy() {
    destroyObserver();
    window.RenderQueue && window.RenderQueue.cancelAll();
    window.PageCache && window.PageCache.clear();
    if (pagesEl) pagesEl.innerHTML = '';
    pageWrappers = [];
    visibilityRatios.clear();
    suppressObserverSync = false;
    clearTimeout(suppressObserverTimer);
    docGeneration++;
  }

  window.ViewportManager = { init, mountDocument, scrollToPage, getCurrentPage, rerenderAtCurrentScale, destroy };
})();
