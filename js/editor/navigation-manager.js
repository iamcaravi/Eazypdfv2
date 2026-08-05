/* ==========================================================================
   js/editor/navigation-manager.js
   ---------------------------------------------------------------------------
   Keyboard navigation only. Every shortcut here calls a method that already
   exists on another module (ViewportManager.scrollToPage, ZoomManager.zoomIn)
   rather than reimplementing scrolling or zoom logic — this file is thin by
   design, it's just the keyboard-to-module mapping.
   ---------------------------------------------------------------------------
   Public surface: window.NavigationManager.init(root)
   Shortcuts: Page Up / Page Down / Home / End / Ctrl+Plus / Ctrl+Minus / Escape
   (Space+drag and middle-mouse pan live in viewport-manager.js, next to the
   wheel-zoom listener they share a lot of "is this gesture active" state
   with — kept together rather than split across two files.)

   Priority 3G: Escape closes the whole fullscreen workspace — a standard,
   expected shortcut for any fullscreen document viewer that this shell
   didn't have (editor-layout.js's own Escape handler only collapses the
   mobile sidebar/inspector overlays, a different, narrower case). This
   module has no knowledge of panel/overlay DOM (that's index.html's
   TOOLS.edit, the host page, not this engine) — so, consistent with every
   other cross-boundary signal in this shell, it only dispatches an
   `editor:requestClose` CustomEvent; the host decides what "close" means.
   Deliberately does not fire when a mobile sidebar/inspector overlay is
   still open — that Escape press is spent collapsing the overlay first
   (editor-layout.js), same as a real desktop app's "innermost thing first"
   Escape convention.
   ========================================================================== */
(function () {
  let root = null;
  let getPageCount = () => 0;

  function init(rootEl, opts) {
    root = rootEl;
    if (opts && opts.getPageCount) getPageCount = opts.getPageCount;

    window.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (isTypingTarget(e.target)) return;

    // Priority 3G — handled before the "no document loaded" early return
    // below, on purpose: Escape should close the workspace whether or not
    // a PDF is currently open (e.g. the user opened Edit PDF, is looking at
    // the empty state, and just wants out) — every other shortcut in this
    // file is page-navigation/zoom, which only makes sense once a document
    // exists, so those stay gated behind `total`.
    //
    // `root.isConnected` guard: this listener is attached to `window` once,
    // the first time the editor shell is built, and is never torn down —
    // the shell itself gets detached (not destroyed) into a holding area
    // when the panel closes and re-attached on the next open (see
    // closePanel()/TOOLS.edit in index.html), so it keeps existing and
    // keeps listening even while completely hidden. Without this check,
    // pressing Escape while any *other* tool's panel was open (e.g. Merge
    // PDF), or with no panel open at all, would still dispatch
    // `editor:requestClose` and incorrectly close whatever panel — if any —
    // actually was open, since index.html's closePanel() isn't aware of
    // which tool asked. `isConnected` is only true while this shell is the
    // one actually mounted inside the live #panel.
    if (e.key === 'Escape' && root && root.isConnected && !hasOpenOverlayPanel()) {
      window.dispatchEvent(new CustomEvent('editor:requestClose'));
      return;
    }

    const total = getPageCount();
    if (!total) return;

    const current = window.ViewportManager ? window.ViewportManager.getCurrentPage() : 1;

    switch (true) {
      case e.key === 'PageDown':
        e.preventDefault();
        window.ViewportManager.scrollToPage(Math.min(total, current + 1));
        break;
      case e.key === 'PageUp':
        e.preventDefault();
        window.ViewportManager.scrollToPage(Math.max(1, current - 1));
        break;
      case e.key === 'Home':
        e.preventDefault();
        window.ViewportManager.scrollToPage(1);
        break;
      case e.key === 'End':
        e.preventDefault();
        window.ViewportManager.scrollToPage(total);
        break;
      case e.ctrlKey && (e.key === '+' || e.key === '='):
        e.preventDefault();
        window.ZoomManager.zoomIn();
        break;
      case e.ctrlKey && e.key === '-':
        e.preventDefault();
        window.ZoomManager.zoomOut();
        break;
      default:
        break;
    }
  }

  /** True while a mobile sidebar/inspector overlay is open — in that case
   *  Escape is spent collapsing it first (editor-layout.js's own handler),
   *  same "innermost thing first" convention a real desktop app follows;
   *  see file header. */
  function hasOpenOverlayPanel() {
    if (!root) return false;
    const body = root.querySelector('.editor-body');
    if (!body || !body.classList.contains('is-overlay')) return false;
    return !!root.querySelector('.editor-sidebar.is-open, .editor-inspector.is-open');
  }

  function isTypingTarget(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  function destroy() {
    window.removeEventListener('keydown', onKeydown);
  }

  window.NavigationManager = { init, destroy };
})();
