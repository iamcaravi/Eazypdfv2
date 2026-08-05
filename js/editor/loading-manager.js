/* ==========================================================================
   js/editor/loading-manager.js
   ---------------------------------------------------------------------------
   Owns loading UI only — no rendering logic itself. Listens to the events
   render-engine.js and render-queue.js already emit and reflects them:
   a per-page spinner overlay while that page's render is in flight, and
   the shell's existing `.editor-canvas[data-state]` machine for the
   document-level empty/loading/page states (reuses editor-canvas.js's
   state machine from the Editor Architecture phase — does not duplicate
   it).
   ---------------------------------------------------------------------------
   Public surface:
     LoadingManager.init(root)
     LoadingManager.markPageLoading(pageNumber)
     LoadingManager.markPageLoaded(pageNumber)
   Events emitted:
     editor:progressText { text }  (statusbar-consumable, see PDF_RENDERING.md)
   ========================================================================== */
(function () {
  let root = null;

  function init(rootEl) {
    root = rootEl;

    window.addEventListener('editor:documentLoaded', (e) => {
      // Priority 3G root-cause fix: this used to also set
      // `canvas.dataset.state = 'page'` right here — but `editor:documentLoaded`
      // fires the instant pdf.js finishes parsing the document, which is
      // *before* editor-canvas.js's own loadFile() has awaited
      // ViewportManager.mountDocument() (real per-page dimension fetches +
      // building the page wrappers) and ThumbnailEngine.init(). Flipping to
      // the 'page' state here raced ahead of that: editor-workspace.css hides
      // the loading spinner the instant data-state="page" is set, so on any
      // document large/slow enough for mountDocument() to take a visible
      // moment, the user saw the spinner vanish and the canvas go blank
      // before real pages appeared. editor-canvas.js's own loadFile() already
      // calls EditorCanvas.setState('page') itself, correctly, only after
      // mounting actually finishes — that call is the single source of
      // truth for this transition; this listener no longer duplicates it.
      window.dispatchEvent(new CustomEvent('editor:progressText', {
        detail: { text: `${e.detail.numPages} pages loaded` }
      }));
    });

    window.addEventListener('editor:documentError', (e) => {
      window.dispatchEvent(new CustomEvent('editor:progressText', { detail: { text: `Error: ${e.detail.message}` } }));
    });

    window.addEventListener('editor:renderProgress', (e) => {
      const { rendered, total, pending } = e.detail;
      const text = pending > 0 ? `Rendering… ${rendered}/${total}` : 'Ready';
      window.dispatchEvent(new CustomEvent('editor:progressText', { detail: { text } }));
    });
  }

  function markPageLoading(pageWrapperEl) {
    pageWrapperEl.classList.add('is-rendering');
  }
  function markPageLoaded(pageWrapperEl) {
    pageWrapperEl.classList.remove('is-rendering');
  }

  window.LoadingManager = { init, markPageLoading, markPageLoaded };
})();
