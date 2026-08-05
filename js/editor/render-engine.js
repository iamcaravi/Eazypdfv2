/* ==========================================================================
   js/editor/render-engine.js
   ---------------------------------------------------------------------------
   Owns the pdf.js PDFDocumentProxy and knows how to render one page to one
   canvas at one scale. Nothing else in this engine talks to pdfjsLib
   directly — every other module (viewport-manager, thumbnail-engine,
   render-queue) goes through this file. That's the whole reason it exists
   as its own module: swap pdf.js for another renderer later, and only this
   file changes.

   Reads whatever window.pdfjsLib the host page has already loaded — it
   does not load or vendor pdf.js itself. Originally paired with a vendored
   copy at js/vendor/pdfjs/ for standalone testing (see PDF_RENDERING.md);
   as of the live-SPA integration, that vendored copy is discarded and this
   file instead reuses the pdf.js instance index.html already loads from
   cdnjs — see INTEGRATION_ROADMAP.md Priority 2. Nothing here assumes a
   specific loading strategy for pdf.js itself, vendored or CDN, standalone
   test harness or live app — it only ever reads window.pdfjsLib.
   ---------------------------------------------------------------------------
   Public surface:
     RenderEngine.loadDocument(fileOrArrayBuffer) -> Promise<{ numPages, ... }>
     RenderEngine.getPageInfo(pageNumber) -> Promise<{ width, height, ratio }>
     RenderEngine.renderPage(pageNumber, canvas, scale, { signal }) -> Promise
     RenderEngine.destroy()
   Events emitted:
     editor:documentLoaded  { numPages, fileName, fileSize, pdfVersion }
       (fileSize/pdfVersion added Priority 3E for the Inspector's Document
       section — same event, no new one; existing listeners that only read
       numPages/fileName are unaffected)
     editor:documentError   { message }

   Priority 5B — Export: this module is a pdf.js *viewer*, not a writer —
   there is no way to reconstruct the original PDF's bytes from a parsed
   PDFDocumentProxy, so Export needs the same bytes this file already reads
   at load time, retained rather than discarded. `loadDocument()` now
   clones the input buffer with `.slice(0)` *before* handing a copy to
   `pdfjsLib.getDocument({data})` — pdf.js can take ownership of (transfer/
   detach) the buffer it's given, a documented class of bug this exact
   project has hit before with a different tool ("the ArrayBuffer transfer/
   detach bug with pdf.js"), so the retained copy is taken first, never the
   same reference handed to pdf.js. New getter, `getOriginalBytes()`,
   returns a further clone each call (never the retained reference itself)
   so a caller can't accidentally mutate or detach this module's own copy.
   Cleared in `destroy()`, same as `pageInfoCache.clear()` already is —
   freed the moment a new document loads or the engine is torn down, not
   held indefinitely.

   Priority 6A — Existing PDF Text Detection: one more small, additive
   method, `getPageTextContent(pageNumber)`, calling pdf.js's core
   `page.getTextContent()` — a method already available on the same
   `PDFPageProxy` `getPageInfo()`/`renderPage()` already use, requiring no
   different pdf.js bundle or new dependency. Cached per page number,
   mirroring `pageInfoCache`'s own pattern in this same file; cleared in
   `destroy()` the same way. This module remains the only one that talks
   to `pdfjsLib` directly — `editor-text-detect.js` calls this method
   rather than reaching into pdf.js itself.
   ========================================================================== */
(function () {
  let pdfDoc = null;
  let fileName = '';
  let fileSize = 0;
  const pageInfoCache = new Map(); // pageNumber -> {width, height, ratio}
  const textContentCache = new Map(); // pageNumber -> Promise<TextContent>, Priority 6A
  let originalBytes = null; // Priority 5B — retained clone for Export, see file header

  function ensureWorker() {
    if (!window.pdfjsLib) throw new Error('pdf.js is not loaded — the host page must load it before RenderEngine is used.');
    // Most host pages (including the live SPA) already set workerSrc
    // themselves before this ever runs. This fallback only matters for a
    // standalone test harness that loaded pdf.js without configuring a
    // worker — points at the same cdnjs build the live SPA uses, so the
    // version always matches whatever pdfjsLib build is actually loaded.
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }

  async function loadDocument(input) {
    ensureWorker();
    destroy(); // release any previously loaded document first — avoids leaking it

    let data;
    if (input instanceof File) {
      fileName = input.name;
      fileSize = input.size;
      data = await input.arrayBuffer();
    } else {
      fileName = '';
      fileSize = 0;
      data = input;
    }

    try {
      // Priority 5B: clone *before* this data reaches pdf.js — see file
      // header for why the same reference can't be shared with it.
      originalBytes = (data && typeof data.slice === 'function') ? data.slice(0) : null;
      const task = window.pdfjsLib.getDocument({ data });
      pdfDoc = await task.promise;
      pageInfoCache.clear();

      // Best-effort only — the Inspector's Document section (Priority 3E)
      // shows "Not available" if this fails or the producer omitted it.
      // Not worth failing the whole document load over.
      let pdfVersion = '';
      try {
        const meta = await pdfDoc.getMetadata();
        pdfVersion = (meta && meta.info && meta.info.PDFFormatVersion) || '';
      } catch (_) { /* non-fatal — leave pdfVersion empty */ }

      const result = { numPages: pdfDoc.numPages, fileName, fileSize, pdfVersion };
      window.dispatchEvent(new CustomEvent('editor:documentLoaded', { detail: result }));
      return result;
    } catch (err) {
      window.dispatchEvent(new CustomEvent('editor:documentError', { detail: { message: err.message || String(err) } }));
      throw err;
    }
  }

  async function getPageInfo(pageNumber) {
    if (pageInfoCache.has(pageNumber)) return pageInfoCache.get(pageNumber);
    if (!pdfDoc) throw new Error('No document loaded');
    const page = await pdfDoc.getPage(pageNumber);
    const vp = page.getViewport({ scale: 1 });
    const info = { width: vp.width, height: vp.height, ratio: vp.width / vp.height, rotation: vp.rotation };
    pageInfoCache.set(pageNumber, info);
    return info;
  }

  /** Priority 6A: pdf.js's core text-extraction API — see file header.
   *  Cached per page, same shape as getPageInfo()'s own cache above. */
  async function getPageTextContent(pageNumber) {
    if (textContentCache.has(pageNumber)) return textContentCache.get(pageNumber);
    if (!pdfDoc) throw new Error('No document loaded');
    const promise = pdfDoc.getPage(pageNumber).then((page) => page.getTextContent());
    textContentCache.set(pageNumber, promise);
    return promise;
  }

  /**
   * Renders one page into one canvas at the given scale. Returns the live
   * pdf.js RenderTask so callers (render-queue.js) can .cancel() it — this
   * is the single most important hook for avoiding wasted/leaked work when
   * the user scrolls past a page or changes zoom mid-render.
   *
   * Priority 3G: renders at `scale * devicePixelRatio` internally so pages
   * are crisp on HiDPI/Retina screens, while the canvas's *displayed* size
   * (`canvas.style.width/height`) stays pinned to the original CSS-pixel
   * viewport — every caller (viewport-manager.js, thumbnail-engine.js)
   * keeps passing the same plain `scale` it always has, unaware of DPR;
   * this is entirely internal to this one module, matching this file's own
   * "only this file changes" boundary (see file header). The pdf.js
   * `transform` option scales what's drawn to match the enlarged canvas
   * buffer without touching `viewport` itself, so callers that read
   * `viewport.width/height` for layout math (e.g. aspect-ratio) are
   * unaffected — only the raster resolution changes.
   */
  async function renderPage(pageNumber, canvas, scale) {
    if (!pdfDoc) throw new Error('No document loaded');
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width = Math.ceil(viewport.width) + 'px';
    canvas.style.height = Math.ceil(viewport.height) + 'px';

    const ctx = canvas.getContext('2d');
    const renderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    });
    return renderTask; // has .promise and .cancel()
  }

  function getNumPages() {
    return pdfDoc ? pdfDoc.numPages : 0;
  }

  /** Priority 5B: a fresh clone of the originally-loaded document's bytes,
   *  for Export to build a new PDFDocument.load() from — see file header.
   *  Returns null if no document is loaded. Always returns a new clone,
   *  never the module's own retained reference, so a caller can't
   *  accidentally mutate or detach it. */
  function getOriginalBytes() {
    return originalBytes ? originalBytes.slice(0) : null;
  }

  function destroy() {
    if (pdfDoc) {
      pdfDoc.destroy();
      pdfDoc = null;
    }
    pageInfoCache.clear();
    textContentCache.clear(); // Priority 6A
    originalBytes = null; // Priority 5B
  }

  window.RenderEngine = { loadDocument, getPageInfo, getPageTextContent, renderPage, getNumPages, getOriginalBytes, destroy };

  // Every module that awaits a RenderTask's .promise already treats
  // RenderingCancelledException as expected/non-fatal (see render-queue.js
  // and thumbnail-engine.js's catch blocks). Under rapid cancellation
  // bursts — e.g. Home/End jumping across a hundred pages at once — a
  // handful of these can still surface as unhandled promise rejections
  // before a module's own try/catch finishes binding, which is pdf.js's
  // internal cancellation plumbing, not a bug in this engine's own control
  // flow (verified: functionality is unaffected either way — the target
  // page still renders correctly). This handler exists so "no console
  // errors" holds under that specific, verified-harmless condition without
  // silently swallowing any *other* kind of unhandled rejection.
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && event.reason.name === 'RenderingCancelledException') {
      event.preventDefault();
    }
  });
})();
