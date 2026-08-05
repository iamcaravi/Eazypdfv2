/* ==========================================================================
   js/editor/editor-sidebar.js
   ---------------------------------------------------------------------------
   Left Sidebar: page thumbnail list. Renders one tile per page, tracks the
   "current page" highlight, and supports Up/Down arrow-key navigation.

   Phase 6.0A addition: clicking/selecting a thumbnail now also scrolls the
   main canvas to that page (via ViewportManager, if present — this module
   still works standalone without it, same as before real rendering existed).
   setCurrentPage() is the other half of that sync: when the user scrolls
   the canvas directly instead of clicking a thumbnail, viewport-manager.js
   calls this to update the sidebar highlight *without* re-dispatching
   editor:pageChange (select() does that; this doesn't — avoids the two
   modules bouncing the same event back and forth).

   Real thumbnail pixels come from thumbnail-engine.js, which replaces each
   `.editor-thumb-page` placeholder with a rendered <canvas> lazily — this
   file never talks to pdf.js directly, exactly as planned back when that
   placeholder was first built.

   Priority 3D addition — multi-page selection, foundation only: Ctrl/Cmd+
   click toggles a page into a selection set; Shift+click selects the
   contiguous range from the last-clicked page to the one clicked.
   Deliberately does not touch `currentPage`/navigation for either — a
   selection is a separate concept from "which page the main canvas is
   showing," same distinction the shell already draws elsewhere (see
   editor-inspector.js's separate Selection section, still a placeholder;
   this doesn't wire into it — that's explicitly a later phase's job).
   A plain click still behaves exactly as before: selects+navigates to
   that one page and clears any multi-selection. Selection state is
   exposed via getSelectedPages()/clearSelection() and broadcast on
   `editor:thumbSelectionChange`, following the same window-CustomEvent
   bus every other editor module already uses — nothing currently listens
   for it; that's the "foundation," not a feature.
   ---------------------------------------------------------------------------
   Public surface: window.EditorSidebar.init(rootEl, { pageCount })
                   window.EditorSidebar.setCurrentPage(n)
                   window.EditorSidebar.getSelectedPages() -> number[]
                   window.EditorSidebar.clearSelection()
   Events emitted: editor:thumbSelectionChange { pages: number[] }
   ========================================================================== */
(function () {
  let listEl = null, railEl = null, currentPage = 0, totalPages = 0;
  // Priority 3D — multi-page selection foundation, separate from
  // currentPage/navigation (see file header).
  let selectedPages = new Set();
  let selectionAnchor = null;

  function init(root, opts) {
    opts = opts || {};
    totalPages = opts.pageCount || 0;
    const sidebar = root.querySelector('.editor-sidebar');
    if (!sidebar) return;

    listEl = sidebar.querySelector('.editor-thumb-list');
    railEl = sidebar.querySelector('.editor-thumb-rail');
    const countBadge = sidebar.querySelector('[data-page-count]');
    currentPage = totalPages > 0 ? 1 : 0;

    // Safe to call init() again for a newly-opened document in the same
    // session — clear whatever the previous document left behind first,
    // otherwise a second Open would append duplicate thumbnails on top.
    listEl.innerHTML = '';
    railEl.innerHTML = '';
    // A selection made in a previous document must not silently apply to
    // this one's page numbers.
    selectedPages = new Set();
    selectionAnchor = null;

    if (countBadge) countBadge.textContent = String(totalPages);

    for (let i = 1; i <= totalPages; i++) {
      listEl.appendChild(renderThumb(i));
      railEl.appendChild(renderRailDot(i));
    }

    function renderThumb(n) {
      const el = document.createElement('div');
      el.className = 'editor-thumb' + (n === currentPage ? ' is-current' : '');
      el.setAttribute('role', 'listitem');
      el.setAttribute('tabindex', n === currentPage ? '0' : '-1');
      el.setAttribute('aria-label', `Page ${n} of ${totalPages}`);
      el.setAttribute('aria-current', n === currentPage ? 'true' : 'false');
      el.setAttribute('aria-selected', 'false');
      el.dataset.page = String(n);
      el.innerHTML = `<div class="editor-thumb-page" aria-hidden="true"></div><div class="editor-thumb-num">${n}</div>`;
      el.addEventListener('click', (e) => {
        if (e.shiftKey) { e.preventDefault(); selectRange(n); }
        else if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSelection(n); }
        else { select(n); }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n); }
        if (e.key === 'ArrowDown') { e.preventDefault(); focusThumb(Math.min(totalPages, n + 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); focusThumb(Math.max(1, n - 1)); }
      });
      return el;
    }

    function renderRailDot(n) {
      const dot = document.createElement('span');
      dot.className = 'editor-thumb-rail-dot' + (n === currentPage ? ' is-current' : '');
      dot.dataset.page = String(n);
      return dot;
    }

    function select(n) {
      // A plain click is single-page intent — matches how the rest of the
      // shell already treats "select" vs. modifier-click as different
      // actions (e.g. resize handles vs. their keyboard equivalent).
      selectionAnchor = n;
      if (selectedPages.size) { selectedPages.clear(); applySelectionHighlight(); broadcastSelection(); }
      applyHighlight(n);
      if (window.ViewportManager) {
        // ViewportManager.scrollToPage() is the single source of truth for
        // programmatic navigation as of Priority 3B — it sets currentPage
        // and dispatches editor:pageChange itself, synchronously and
        // correctly. Dispatching it again here too was previously creating
        // a race between this thumbnail-click intent and whatever the
        // (formerly less accurate) scroll/intersection tracking reported.
        window.ViewportManager.scrollToPage(n);
      } else {
        // Standalone fallback (no ViewportManager present) — unchanged.
        window.dispatchEvent(new CustomEvent('editor:pageChange', { detail: { page: n, pageCount: totalPages } }));
      }
    }

    function focusThumb(n) {
      const el = listEl.querySelector(`.editor-thumb[data-page="${n}"]`);
      if (el) { select(n); el.focus(); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }

    if (totalPages > 0) applyHighlight(currentPage);
  }

  function applyHighlight(n) {
    currentPage = n;
    if (!listEl) return;
    listEl.querySelectorAll('.editor-thumb').forEach((el) => {
      const isCur = Number(el.dataset.page) === n;
      el.classList.toggle('is-current', isCur);
      el.setAttribute('aria-current', String(isCur));
      el.setAttribute('tabindex', isCur ? '0' : '-1');
    });
    railEl.querySelectorAll('.editor-thumb-rail-dot').forEach((el) => {
      el.classList.toggle('is-current', Number(el.dataset.page) === n);
    });
  }

  /** Called by viewport-manager.js when scrolling (not clicking) changes the
   *  current page — updates the highlight only, does not re-dispatch
   *  editor:pageChange (the scroll observer already did). */
  function setCurrentPage(n) {
    if (n === currentPage) return;
    applyHighlight(n);
    const el = listEl && listEl.querySelector(`.editor-thumb[data-page="${n}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // --- Priority 3D: multi-page selection (foundation only, see file header) ---

  /** Ctrl/Cmd+click a thumbnail — adds/removes just that one page, doesn't
   *  touch currentPage or the main canvas. */
  function toggleSelection(n) {
    if (selectedPages.has(n)) selectedPages.delete(n); else selectedPages.add(n);
    selectionAnchor = n;
    applySelectionHighlight();
    broadcastSelection();
  }

  /** Shift+click a thumbnail — selects the contiguous run between the last
   *  clicked/toggled page (or currentPage, if nothing has been clicked yet
   *  this session) and the one just clicked. Matches the anchor behavior
   *  used by every other shift-click range selection (file pickers, mail
   *  clients, etc.) — an unsurprising default rather than a new pattern
   *  invented for this shell. */
  function selectRange(n) {
    const anchor = selectionAnchor != null ? selectionAnchor : currentPage;
    const from = Math.min(anchor, n), to = Math.max(anchor, n);
    for (let i = from; i <= to; i++) selectedPages.add(i);
    applySelectionHighlight();
    broadcastSelection();
  }

  function applySelectionHighlight() {
    if (!listEl) return;
    listEl.querySelectorAll('.editor-thumb').forEach((el) => {
      const isSel = selectedPages.has(Number(el.dataset.page));
      el.classList.toggle('is-selected', isSel);
      el.setAttribute('aria-selected', String(isSel));
    });
  }

  function broadcastSelection() {
    window.dispatchEvent(new CustomEvent('editor:thumbSelectionChange', {
      detail: { pages: Array.from(selectedPages).sort((a, b) => a - b) }
    }));
  }

  function getSelectedPages() {
    return Array.from(selectedPages).sort((a, b) => a - b);
  }

  function clearSelection() {
    if (!selectedPages.size) return;
    selectedPages.clear();
    applySelectionHighlight();
    broadcastSelection();
  }

  window.EditorSidebar = { init, setCurrentPage, getSelectedPages, clearSelection };
})();
