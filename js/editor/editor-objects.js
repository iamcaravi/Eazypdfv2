/* ==========================================================================
   js/editor/editor-objects.js
   ---------------------------------------------------------------------------
   Owns the editable-object model for Edit PDF: text/image/rectangle/
   ellipse/line boxes placed on top of the rendered PDF pages, plus their
   selection, drag-to-move, corner-handle resize, and delete.

   This file did not exist before — editor-toolbar.js and editor-
   inspector.js already called into `window.EditorObjects` extensively
   (beginPlacement/getAllObjects/updateObject) with a fully-specified
   contract inferred from those call sites; this implements exactly that
   contract rather than inventing a new one, so no other editor-*.js file
   needed to change.

   Object schema: { id, type, page, xPct, yPct, wPct, hPct, selected, data }
   xPct/yPct/wPct/hPct are percentages (0-100) of the page's own box, top-
   left anchored — matches editor-toolbar.js's own image-placement comment
   ("wPct/hPct are percentages of the page's width/height respectively").
   `data` holds per-type fields exactly as editor-inspector.js's Properties
   panel and editor-toolbar.js's beginPlacement() calls already define them
   (text: text/fontFamily/fontSize/bold/italic/underline/color/align;
   image: src/naturalWidth/naturalHeight/keepAspectRatio; rectangle/
   ellipse/line: fill/stroke/strokeWidth/radius).

   Single-selection model: at most one object has `selected:true` at a
   time, matching editor-inspector.js's own `.find(o => o.selected)` usage.
   ---------------------------------------------------------------------------
   Public surface:
     EditorObjects.init(rootEl)
     EditorObjects.beginPlacement(type, { data, wPct, hPct })
     EditorObjects.getAllObjects() -> array (live objects, not a clone)
     EditorObjects.updateObject(id, patch)
     EditorObjects.deleteObject(id)
     EditorObjects.getState() -> JSON-safe deep clone (for EditorHistory)
     EditorObjects.restoreState(snapshot) -> replaces all objects + re-renders
   Events emitted:
     editor:objectAdded      { object }
     editor:objectsChanged   fires on ANY change, including selection-only
                              (existing contract editor-inspector.js relies on)
     editor:objectsCommitted { before } fires only for real mutations (add/
                              delete/move/resize/property edit/restore) —
                              NOT for selection-only changes. EditorHistory
                              listens to this one, not objectsChanged, so
                              selecting an object never creates an undo step.
   ========================================================================== */
(function () {
  const MIN_PCT = 2;
  const HANDLES = ['nw', 'ne', 'sw', 'se'];

  let root = null;
  let pagesEl = null;
  let objects = [];
  let nextId = 1;
  let pendingPlacement = null; // { type, data, wPct, hPct }
  const elById = new Map(); // id -> DOM element
  const pageInfoCache = new Map(); // pageNumber -> {width,height} in PDF points, for image aspect-lock math

  function init(rootEl) {
    root = rootEl;
    pagesEl = root.querySelector('.editor-canvas-pages') || root.querySelector('.editor-canvas');
    objects = [];
    nextId = 1;
    pendingPlacement = null;
    elById.clear();
    pageInfoCache.clear();

    const canvasEl = root.querySelector('.editor-canvas');

    canvasEl.addEventListener('click', onCanvasClick);

    window.addEventListener('keydown', onKeyDown);

    // A fresh document invalidates every existing object (pages/positions
    // no longer correspond to anything) and any pending placement.
    window.addEventListener('editor:documentLoaded', () => {
      objects = [];
      nextId = 1;
      pendingPlacement = null;
      elById.clear();
      pageInfoCache.clear();
      setCrosshair(false);
    });
  }

  function onCanvasClick(e) {
    // Clicks on an existing object are handled (and stopPropagation'd) by
    // that object's own mousedown handler below — this only ever sees
    // clicks on empty page area or, mid-placement, the page itself.
    const wrap = e.target.closest('.editor-canvas-page');
    if (pendingPlacement) {
      if (!wrap) return;
      placeAt(wrap, e.clientX, e.clientY);
      return;
    }
    if (!e.target.closest('.editor-object')) deselectAll();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && pendingPlacement) {
      pendingPlacement = null;
      setCrosshair(false);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
      const active = document.activeElement;
      if (active && active.isContentEditable) return; // editing text — let the key edit it
      const selected = objects.find((o) => o.selected);
      if (selected) { e.preventDefault(); deleteObject(selected.id); }
    }
  }

  function setCrosshair(on) {
    const canvasEl = root && root.querySelector('.editor-canvas');
    if (canvasEl) canvasEl.style.cursor = on ? 'crosshair' : '';
  }

  // --- Placement ------------------------------------------------------------

  function beginPlacement(type, opts) {
    opts = opts || {};
    const defaults = defaultBoxFor(type);
    pendingPlacement = {
      type,
      data: opts.data || {},
      wPct: opts.wPct != null ? opts.wPct : defaults.wPct,
      hPct: opts.hPct != null ? opts.hPct : defaults.hPct
    };
    deselectAll();
    setCrosshair(true);
  }

  function defaultBoxFor(type) {
    if (type === 'text') return { wPct: 22, hPct: 6 };
    return { wPct: 25, hPct: 15 }; // image (usually overridden by caller), rectangle/ellipse/line
  }

  function placeAt(wrapEl, clientX, clientY) {
    const { type, data, wPct, hPct } = pendingPlacement;
    const rect = wrapEl.getBoundingClientRect();
    const cxPct = ((clientX - rect.left) / rect.width) * 100;
    const cyPct = ((clientY - rect.top) / rect.height) * 100;
    const xPct = clamp(cxPct - wPct / 2, 0, Math.max(0, 100 - wPct));
    const yPct = clamp(cyPct - hPct / 2, 0, Math.max(0, 100 - hPct));
    const page = Number(wrapEl.dataset.page);

    pendingPlacement = null;
    setCrosshair(false);

    addObject({ type, page, xPct, yPct, wPct, hPct, data });
  }

  // --- CRUD -------------------------------------------------------------

  function addObject({ type, page, xPct, yPct, wPct, hPct, data }) {
    const before = getState();
    const obj = { id: 'obj' + (nextId++), type, page, xPct, yPct, wPct, hPct, selected: true, data: Object.assign({}, data) };
    objects.forEach((o) => { o.selected = false; });
    objects.push(obj);
    mountObjectEl(obj);
    syncSelectionDom();
    window.dispatchEvent(new CustomEvent('editor:objectAdded', { detail: { object: obj } }));
    commit(before);
    return obj;
  }

  function updateObject(id, patch) {
    const obj = objects.find((o) => o.id === id);
    if (!obj) return;
    const before = getState();
    Object.assign(obj, patch);
    if (patch.data) obj.data = Object.assign({}, obj.data, patch.data);
    renderObjectContent(obj);
    renderObjectBox(obj);
    commit(before);
  }

  function deleteObject(id) {
    const idx = objects.findIndex((o) => o.id === id);
    if (idx === -1) return;
    const before = getState();
    const el = elById.get(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    elById.delete(id);
    objects.splice(idx, 1);
    commit(before);
  }

  function selectObject(id) {
    let changed = false;
    objects.forEach((o) => {
      const shouldBeSelected = o.id === id;
      if (o.selected !== shouldBeSelected) changed = true;
      o.selected = shouldBeSelected;
    });
    if (changed) { syncSelectionDom(); window.dispatchEvent(new CustomEvent('editor:objectsChanged')); }
  }

  function deselectAll() {
    let changed = false;
    objects.forEach((o) => { if (o.selected) changed = true; o.selected = false; });
    if (changed) { syncSelectionDom(); window.dispatchEvent(new CustomEvent('editor:objectsChanged')); }
  }

  function syncSelectionDom() {
    objects.forEach((o) => {
      const el = elById.get(o.id);
      if (el) el.classList.toggle('is-selected', !!o.selected);
    });
  }

  /** Fires the two events every real mutation needs: the general-purpose
   *  one editor-inspector.js already listens to, and the commit-only one
   *  EditorHistory listens to (see file header). */
  function commit(before) {
    window.dispatchEvent(new CustomEvent('editor:objectsChanged'));
    window.dispatchEvent(new CustomEvent('editor:objectsCommitted', { detail: { before } }));
  }

  // --- Rendering ----------------------------------------------------------

  function getPageWrapper(pageNumber) {
    return pagesEl && pagesEl.querySelector(`.editor-canvas-page[data-page="${pageNumber}"]`);
  }

  function mountObjectEl(obj) {
    const wrap = getPageWrapper(obj.page);
    if (!wrap) return; // page not mounted (shouldn't happen — all wrappers exist up front)
    const el = document.createElement('div');
    el.className = 'editor-object';
    el.dataset.id = obj.id;
    el.dataset.type = obj.type;
    HANDLES.forEach((h) => {
      const handle = document.createElement('span');
      handle.className = 'editor-object-handle editor-object-handle-' + h;
      handle.addEventListener('mousedown', (e) => startDrag(e, obj, 'resize', h));
      el.appendChild(handle);
    });
    const content = document.createElement('div');
    content.className = 'editor-object-content';
    el.appendChild(content);

    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.editor-object-handle')) return; // handles wire their own
      if (e.target.isContentEditable) return; // mid text-edit — let the click place the caret
      startDrag(e, obj, 'move');
    });
    if (obj.type === 'text') {
      // Bound to `el`, not `content`: content is pointer-events:none (see
      // css/editor-objects.css) so drag/move on the wrapper works without
      // the rendered content intercepting it — which also means content
      // itself never receives any DOM events, dblclick included.
      el.addEventListener('dblclick', (e) => startTextEdit(e, obj));
    }

    elById.set(obj.id, el);
    wrap.appendChild(el);
    renderObjectContent(obj);
    renderObjectBox(obj);
  }

  function renderObjectBox(obj) {
    const el = elById.get(obj.id);
    if (!el) return;
    el.style.left = obj.xPct + '%';
    el.style.top = obj.yPct + '%';
    el.style.width = obj.wPct + '%';
    el.style.height = obj.hPct + '%';
  }

  function renderObjectContent(obj) {
    const el = elById.get(obj.id);
    if (!el) return;
    const content = el.querySelector('.editor-object-content');
    const d = obj.data || {};
    if (obj.type === 'text') {
      content.innerHTML = '';
      const inner = document.createElement('div');
      inner.className = 'eo-text-inner';
      inner.textContent = d.text != null ? d.text : 'Text';
      inner.style.fontFamily = d.fontFamily || 'Arial';
      inner.style.fontSize = (d.fontSize || 16) + 'px';
      inner.style.fontWeight = d.bold ? '700' : '400';
      inner.style.fontStyle = d.italic ? 'italic' : 'normal';
      inner.style.textDecoration = d.underline ? 'underline' : 'none';
      inner.style.color = d.color || '#000000';
      inner.style.textAlign = d.align || 'left';
      content.appendChild(inner);
    } else if (obj.type === 'image') {
      content.innerHTML = '';
      const img = document.createElement('img');
      img.src = d.src || '';
      img.draggable = false;
      img.addEventListener('load', () => {
        if (!d.naturalWidth || !d.naturalHeight) updateObject(obj.id, { data: { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } });
      });
      content.appendChild(img);
    } else if (obj.type === 'rectangle' || obj.type === 'ellipse') {
      content.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'eo-shape-box';
      box.style.background = d.fill || '#ffffff';
      box.style.border = `${d.strokeWidth != null ? d.strokeWidth : 2}px solid ${d.stroke || '#000000'}`;
      box.style.borderRadius = obj.type === 'ellipse' ? '50%' : ((d.radius || 0) + 'px');
      content.appendChild(box);
    } else if (obj.type === 'line') {
      content.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
        <line x1="0" y1="0" x2="100" y2="100" stroke="${d.stroke || '#000000'}" stroke-width="${d.strokeWidth != null ? d.strokeWidth : 2}" vector-effect="non-scaling-stroke" />
      </svg>`;
    }
  }

  // --- Drag / resize --------------------------------------------------------

  async function getPageAspect(pageNumber) {
    if (pageInfoCache.has(pageNumber)) return pageInfoCache.get(pageNumber);
    if (!window.RenderEngine) return 1;
    try {
      const info = await window.RenderEngine.getPageInfo(pageNumber);
      const aspect = info.width / info.height;
      pageInfoCache.set(pageNumber, aspect);
      return aspect;
    } catch (_) { return 1; }
  }

  function startDrag(e, obj, mode, handle) {
    e.preventDefault();
    e.stopPropagation();
    selectObject(obj.id);
    const wrap = getPageWrapper(obj.page);
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const start = { xPct: obj.xPct, yPct: obj.yPct, wPct: obj.wPct, hPct: obj.hPct };
    const before = getState();
    const lockAspect = obj.type === 'image' && obj.data && obj.data.keepAspectRatio !== false;
    let pageAspect = 1, imageAspect = 1;
    if (lockAspect) {
      imageAspect = (obj.data.naturalWidth && obj.data.naturalHeight) ? obj.data.naturalWidth / obj.data.naturalHeight : 1;
      getPageAspect(obj.page).then((a) => { pageAspect = a; });
    }

    function onMove(ev) {
      const dxPct = ((ev.clientX - startX) / rect.width) * 100;
      const dyPct = ((ev.clientY - startY) / rect.height) * 100;
      if (mode === 'move') {
        obj.xPct = clamp(start.xPct + dxPct, 0, Math.max(0, 100 - obj.wPct));
        obj.yPct = clamp(start.yPct + dyPct, 0, Math.max(0, 100 - obj.hPct));
      } else {
        applyResize(obj, start, handle, dxPct, dyPct, lockAspect ? (imageAspect / pageAspect) : null);
      }
      renderObjectBox(obj);
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // A plain click (no actual movement — including the mousedown that's
      // part of every dblclick-to-edit sequence) must not push a no-op
      // undo step: compare against `start` rather than committing
      // unconditionally.
      const moved = obj.xPct !== start.xPct || obj.yPct !== start.yPct || obj.wPct !== start.wPct || obj.hPct !== start.hPct;
      if (moved) commit(before);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** hAspectFactor, when set, is hPct/wPct's required ratio (accounting for
   *  the page's own aspect so the image's true visual aspect is preserved
   *  even though wPct/hPct are percentages of two different absolute
   *  lengths — same correction editor-toolbar.js's handlePickedImage()
   *  already applies once at initial placement). */
  function applyResize(obj, start, handle, dxPct, dyPct, hAspectFactor) {
    let w = start.wPct, h = start.hPct, x = start.xPct, y = start.yPct;
    const east = handle === 'ne' || handle === 'se';
    const south = handle === 'sw' || handle === 'se';
    if (east) w = start.wPct + dxPct; else { w = start.wPct - dxPct; x = start.xPct + dxPct; }
    if (south) h = start.hPct + dyPct; else { h = start.hPct - dyPct; y = start.yPct + dyPct; }
    w = Math.max(MIN_PCT, w);
    h = Math.max(MIN_PCT, h);
    if (hAspectFactor) {
      h = w * hAspectFactor;
      if (!south) y = start.yPct + start.hPct - h;
    }
    if (!east) x = start.xPct + start.wPct - w;
    obj.xPct = clamp(x, 0, 100);
    obj.yPct = clamp(y, 0, 100);
    obj.wPct = w;
    obj.hPct = h;
  }

  // --- Text editing ---------------------------------------------------------

  function startTextEdit(e, obj) {
    e.stopPropagation();
    const el = elById.get(obj.id);
    const inner = el && el.querySelector('.eo-text-inner');
    if (!inner) return;
    const before = getState();
    inner.contentEditable = 'true';
    inner.focus();
    document.execCommand && document.execCommand('selectAll', false, null);

    function finish() {
      inner.contentEditable = 'false';
      inner.removeEventListener('blur', finish);
      inner.removeEventListener('keydown', onKey);
      const text = inner.textContent || '';
      if (text !== (obj.data.text || '')) {
        obj.data = Object.assign({}, obj.data, { text });
        commit(before);
      }
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { inner.textContent = obj.data.text || ''; inner.blur(); }
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); inner.blur(); }
    }
    inner.addEventListener('blur', finish);
    inner.addEventListener('keydown', onKey);
  }

  // --- History support --------------------------------------------------

  function getState() {
    return objects.map((o) => ({ id: o.id, type: o.type, page: o.page, xPct: o.xPct, yPct: o.yPct, wPct: o.wPct, hPct: o.hPct, selected: o.selected, data: Object.assign({}, o.data) }));
  }

  function restoreState(snapshot) {
    elById.forEach((el) => { if (el.parentNode) el.parentNode.removeChild(el); });
    elById.clear();
    objects = (snapshot || []).map((o) => Object.assign({}, o, { data: Object.assign({}, o.data) }));
    let maxN = 0;
    objects.forEach((o) => { const n = parseInt(String(o.id).replace('obj', ''), 10); if (n > maxN) maxN = n; });
    nextId = maxN + 1;
    objects.forEach((o) => mountObjectEl(o));
    syncSelectionDom();
    window.dispatchEvent(new CustomEvent('editor:objectsChanged'));
  }

  function getAllObjects() { return objects; }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  window.EditorObjects = {
    init, beginPlacement, getAllObjects, updateObject, deleteObject,
    getState, restoreState
  };
})();
