/* ==========================================================================
   js/editor/editor-statusbar.js
   ---------------------------------------------------------------------------
   Bottom Status Bar: Zoom % / Page number / Document size / Selection status
   / Ready indicator. This module owns no state of its own — it only listens
   for the CustomEvents other modules already emit (editor:zoomChange,
   editor:pageChange, editor:canvasStateChange) and reflects them. This is
   the clearest proof point that the shell's modules are properly decoupled:
   the status bar never imports or calls into sidebar/toolbar/canvas code.

   Priority 3F bug fix: a failed document load produced an error message the
   user could never actually read. Sequence, unchanged since Phase 6.0A:
   RenderEngine.loadDocument() dispatches `editor:documentError` synchronously
   before rethrowing -> loading-manager.js turns that into
   `editor:progressText` ("Error: ...") -> this file wrote it into `sizeEl`.
   But the rethrow then unwinds into editor-canvas.js's own catch block,
   which calls `setState('empty')` -> dispatches `editor:canvasStateChange`
   -> this file's own listener below unconditionally reset the same `sizeEl`
   back to "No document", clobbering the error text it had just written,
   all within the same synchronous tick. Net effect: the message was never
   visible for even one frame. Root cause was this file overwriting its own
   just-written error text, not the event order itself (that order — error
   event before the state-change event — is correct and unchanged here).
   Fix: remember that an error is currently displayed and let exactly one
   subsequent "no document" state change pass without clobbering it; a
   later real event (a fresh load attempt's own progressText, or another
   explicit state change) still updates `sizeEl` normally after that.
   ---------------------------------------------------------------------------
   Public surface: window.EditorStatusbar.init(rootEl)
   ========================================================================== */
(function () {
  function init(root) {
    const t = window.I18N ? window.I18N.t : (k) => k;
    const bar = root.querySelector('.editor-statusbar');
    if (!bar) return;

    const zoomEl = bar.querySelector('[data-status="zoom"]');
    const pageEl = bar.querySelector('[data-status="page"]');
    const sizeEl = bar.querySelector('[data-status="size"]');
    const selectionEl = bar.querySelector('[data-status="selection"]');

    // Priority 3F — see file header. Set true the moment an error is
    // displayed; consumed (and cleared) by the very next canvasStateChange
    // so it only protects that one immediate clobber, not future ones.
    let sizeHoldsError = false;

    window.addEventListener('editor:zoomChange', (e) => {
      if (zoomEl) zoomEl.textContent = t('editor.statusZoom', { pct: Math.round(e.detail.zoom * 100) });
    });
    window.addEventListener('editor:pageChange', (e) => {
      if (pageEl) pageEl.textContent = t('editor.statusPage', { page: e.detail.page, pageCount: e.detail.pageCount });
    });
    window.addEventListener('editor:documentError', () => {
      sizeHoldsError = true;
    });
    window.addEventListener('editor:canvasStateChange', (e) => {
      if (selectionEl) selectionEl.textContent = t('editor.statusNoSelection');
      if (e.detail.state !== 'page' && sizeEl) {
        if (sizeHoldsError) { sizeHoldsError = false; return; }
        sizeEl.textContent = t('editor.statusNoDocument');
      }
    });
    window.addEventListener('editor:progressText', (e) => {
      if (sizeEl) sizeEl.textContent = e.detail.text;
    });
  }

  window.EditorStatusbar = { init };
})();
