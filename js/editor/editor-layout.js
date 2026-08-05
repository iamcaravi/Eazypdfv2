/* ==========================================================================
   js/editor/editor-layout.js
   ---------------------------------------------------------------------------
   Orchestrates the shell: resizable Sidebar/Inspector panels, collapse
   toggles, and the responsive switch to overlay mode below 900px. Every
   other editor-*.js module talks to this one and to each other only through
   plain DOM CustomEvents on `window` (see EDITOR_ARCHITECTURE.md "Event Bus")
   — no module reaches into another module's internals.

   This file owns layout mechanics only. It has no knowledge of PDFs, pages,
   or any editing feature — that is the explicit boundary of this phase.
   ---------------------------------------------------------------------------
   Public surface: window.EditorLayout.init(rootEl)
   ========================================================================== */
(function () {
  const OVERLAY_BREAKPOINT = 900;

  function init(root) {
    root = root || document.querySelector('.editor-shell');
    if (!root) return;

    const body = root.querySelector('.editor-body');
    const sidebar = root.querySelector('.editor-sidebar');
    const inspector = root.querySelector('.editor-inspector');
    const sidebarHandle = root.querySelector('[data-resize="sidebar"]');
    const inspectorHandle = root.querySelector('[data-resize="inspector"]');
    const scrim = root.querySelector('.editor-scrim');

    setupResize(root, sidebarHandle, sidebar, '--editor-sidebar-w', '--editor-sidebar-min', '--editor-sidebar-max', false);
    setupResize(root, inspectorHandle, inspector, '--editor-inspector-w', '--editor-inspector-min', '--editor-inspector-max', true);
    setupOverlayMode(root, body, sidebar, inspector, scrim);
    setupPanelToggles(root, body, scrim);
    setupKeyboardShortcuts(root, sidebar, inspector);
  }

  /** The one place that decides what "toggle this panel" means: collapse
   *  it (desktop/tablet, panel stays in the flow at rail width) or slide
   *  it open/closed as an overlay (mobile, panel floats above the canvas).
   *  Both the sidebar/inspector's own head button AND the toolbar's View
   *  group call this — so behavior can never diverge between the two
   *  entry points the way it did before this was unified. */
  function togglePanel(root, selector) {
    const panel = root.querySelector(selector);
    const body = root.querySelector('.editor-body');
    const scrim = root.querySelector('.editor-scrim');
    if (!panel || !body) return;

    if (body.classList.contains('is-overlay')) {
      const isOpen = panel.classList.toggle('is-open');
      scrim && scrim.classList.toggle('is-visible', isOpen);
      if (isOpen) panel.querySelector('button, [tabindex]')?.focus();
      emit('editor:panelToggle', { panel: selector, collapsed: !isOpen, mode: 'overlay' });
    } else {
      const collapsed = panel.classList.toggle('is-collapsed');
      const btn = root.querySelector(`[data-collapse-target="${selector}"]`);
      btn && btn.setAttribute('aria-expanded', String(!collapsed));
      emit('editor:panelToggle', { panel: selector, collapsed, mode: 'collapse' });
    }
  }

  function setupPanelToggles(root, body, scrim) {
    root.querySelectorAll('[data-collapse-target]').forEach((btn) => {
      const targetSel = btn.getAttribute('data-collapse-target');
      btn.setAttribute('aria-expanded', 'true');
      btn.addEventListener('click', () => togglePanel(root, targetSel));
    });
    // The toolbar's View group dispatches this instead of clicking a button
    // directly, so it works correctly regardless of desktop/overlay mode.
    window.addEventListener('editor:requestPanelToggle', (e) => togglePanel(root, e.detail.panel));
    scrim && scrim.addEventListener('click', () => {
      root.querySelector('.editor-sidebar')?.classList.remove('is-open');
      root.querySelector('.editor-inspector')?.classList.remove('is-open');
      scrim.classList.remove('is-visible');
    });
  }

  /** Drag-to-resize a side panel. `invert` = handle is on the panel's left edge (inspector). */
  function setupResize(root, handle, panel, cssVar, cssMin, cssMax, invert) {
    if (!handle || !panel) return;
    let dragging = false, startX = 0, startW = 0;

    const min = parseInt(getComputedStyle(root).getPropertyValue(cssMin), 10) || 160;
    const max = parseInt(getComputedStyle(root).getPropertyValue(cssMax), 10) || 400;

    handle.setAttribute('tabindex', '0');
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', invert ? 'Resize inspector panel' : 'Resize sidebar panel');

    function onDown(e) {
      dragging = true;
      startX = e.clientX ?? (e.touches && e.touches[0].clientX);
      startW = panel.getBoundingClientRect().width;
      handle.classList.add('is-dragging');
      document.body.style.userSelect = 'none';
    }
    function onMove(e) {
      if (!dragging) return;
      const x = e.clientX ?? (e.touches && e.touches[0].clientX);
      const delta = invert ? startX - x : x - startX;
      const next = Math.min(max, Math.max(min, startW + delta));
      root.style.setProperty(cssVar, next + 'px');
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      document.body.style.userSelect = '';
    }

    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    handle.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);

    // Keyboard resize: Left/Right arrow while the handle is focused.
    handle.addEventListener('keydown', (e) => {
      const step = 16;
      const current = panel.getBoundingClientRect().width;
      let next = current;
      if (e.key === 'ArrowLeft') next = invert ? current + step : current - step;
      if (e.key === 'ArrowRight') next = invert ? current - step : current + step;
      if (next !== current) {
        e.preventDefault();
        root.style.setProperty(cssVar, Math.min(max, Math.max(min, next)) + 'px');
      }
    });
  }

  function setupCollapseToggles(root, sidebar, inspector) {
    root.querySelectorAll('[data-collapse-target]').forEach((btn) => {
      const targetSel = btn.getAttribute('data-collapse-target');
      const panel = root.querySelector(targetSel);
      if (!panel) return;
      btn.setAttribute('aria-expanded', 'true');
      btn.addEventListener('click', () => {
        const collapsed = panel.classList.toggle('is-collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
        emit('editor:panelToggle', { panel: targetSel, collapsed });
      });
    });
  }

  /** Below OVERLAY_BREAKPOINT, sidebar/inspector become slide-over panels
   *  instead of permanently squeezing the canvas. This function only
   *  switches the mode flag and resets state on breakpoint crossings —
   *  see togglePanel() for what a toggle actually does in each mode. */
  function setupOverlayMode(root, body, sidebar, inspector, scrim) {
    function applyMode() {
      const overlay = window.innerWidth < OVERLAY_BREAKPOINT;
      body.classList.toggle('is-overlay', overlay);
      if (!overlay) {
        sidebar && sidebar.classList.remove('is-open');
        inspector && inspector.classList.remove('is-open');
        scrim && scrim.classList.remove('is-visible');
      } else {
        sidebar && sidebar.classList.remove('is-collapsed');
        inspector && inspector.classList.remove('is-collapsed');
      }
    }
    applyMode();
    window.addEventListener('resize', debounce(applyMode, 120));
  }

  function setupKeyboardShortcuts(root, sidebar, inspector) {
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Priority 3G: only swallow the keystroke (stop it from reaching
      // navigation-manager.js's window-level Escape-to-close listener,
      // added this phase) when a mobile overlay panel was actually open to
      // collapse — otherwise Escape falls through to close the whole
      // workspace, same "innermost thing first" convention a real desktop
      // app follows. Without stopPropagation() here, both handlers would
      // fire on the same keystroke: this one collapses the overlay, then
      // navigation-manager.js's checks the now-already-collapsed state and
      // closes the entire workspace too — one Escape press doing two
      // things instead of one.
      const hadOpenPanel = !!root.querySelector('.editor-sidebar.is-open, .editor-inspector.is-open');
      if (!hadOpenPanel) return;
      sidebar && sidebar.classList.remove('is-open');
      inspector && inspector.classList.remove('is-open');
      root.querySelector('.editor-scrim')?.classList.remove('is-visible');
      e.stopPropagation();
    });
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  window.EditorLayout = { init };
})();
