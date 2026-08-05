/* ==========================================================================
   js/editor/editor-inspector.js
   ---------------------------------------------------------------------------
   Right Inspector: 4 collapsible sections — Document, Selection, Properties,
   Future tools.

   Priority 3E: the Document section is real — it shows live document
   metadata once a PDF is loaded, instead of a placeholder note. Selection,
   Properties, and Future tools are unchanged and stay placeholders; they
   are out of scope for this phase (see docs/INTEGRATION_ROADMAP.md).

   No new state is owned here and no engine logic is duplicated — every
   value is read off events/APIs the engine already provides:
     - File name / file size / total pages / PDF version: the
       editor:documentLoaded payload (render-engine.js — fileSize/pdfVersion
       added to that same event this phase, see that file's header).
     - Current page: the editor:pageChange payload (viewport-manager.js).
     - Current page dimensions / orientation / rotation: RenderEngine
       .getPageInfo(page) — the same cached per-page lookup viewport-manager
       and the Fit Width/Fit Page zoom math already call; cheap, memoized.
     - Zoom percentage: the editor:zoomChange payload (zoom-manager.js),
       the same convention editor-statusbar.js and editor-toolbar.js
       already use for their own zoom displays.

   Priority 4B-1: Selection is no longer a static placeholder — it reacts
   to window.EditorObjects (Priority 4A), showing "Object type:
   <Capitalized type>" for whichever object is currently selected, or the
   original placeholder text when nothing is. Kept fully generic — no
   object-type name is hardcoded — so it needs no change when image/
   signature/shape/etc. objects ship later. No editing controls (out of
   scope this phase); that's still Properties' job once it exists.

   Extension point for a later phase: a real feature (e.g. text formatting)
   replaces the Properties placeholder with actual controls. The Document
   section itself only changes if document metadata itself changes (e.g.
   a future "document properties" edit feature).

   Priority 4B-2: that extension point is now used. Properties is reactive
   the same way Selection became reactive in 4B-1 — reacts to
   editor:objectsChanged, shows the original placeholder for anything
   other than a selected 'text' object, and otherwise renders Text/Font
   Family/Font Size/Bold/Italic/Underline/Text Color/Alignment controls
   wired directly to that object's `data` via EditorObjects.updateObject().
   Native form controls only — no new CSS file, no new inspector
   architecture; still the same sectionShell()/section-body pattern every
   other section already uses.

   Priority 4C: Properties' single `if (type !== 'text')` check becomes a
   small per-type dispatch (mirroring renderObjectContent()'s switch in
   editor-objects.js) so a selected 'image' object shows Width/Height/
   Keep Aspect Ratio too — same wiring convention, same
   updateObject()-only rule. Width/Height bind to `data.naturalWidth`/
   `data.naturalHeight` (the only width/height fields the schema puts in
   `data`), not the on-canvas box size. No Inspector redesign — the
   'text' branch is the exact same markup/behavior as before, just moved
   into its own function alongside the new 'image' one.

   Priority 4D: the dispatch gains one more branch for 'rectangle'/
   'ellipse'/'line', all routed to a single shared renderShapeProperties()
   (Fill Color/Stroke Color/Stroke Width, plus Radius for rectangle only,
   Fill omitted for line) — one function for the whole shape family
   rather than three near-duplicates, mirroring editor-objects.js's
   renderShapeContent() doing the same for rendering. Every control still
   goes through the same patchData()->updateObject() path as every other
   Properties control; no new wiring mechanism.
   ---------------------------------------------------------------------------
   Public surface: window.EditorInspector.init(rootEl)
   ========================================================================== */
(function () {
  const EMPTY = '—';

  const OTHER_SECTIONS = [
    { id: 'future', title: 'Future tools', open: false, placeholder: 'Reserved for upcoming editing tools (text, drawing, signatures).' }
  ];

  const SELECTION_PLACEHOLDER = 'Nothing selected. Selection details will appear here once an object is selected.';
  const PROPERTIES_PLACEHOLDER = 'Properties for the selected object will appear here.';
  const FONT_FAMILIES = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana'];

  const DOC_FIELDS = [
    { key: 'fileName', label: 'File name' },
    { key: 'fileSize', label: 'File size' },
    { key: 'totalPages', label: 'Total pages' },
    { key: 'currentPage', label: 'Current page' },
    { key: 'pageDimensions', label: 'Page dimensions' },
    { key: 'orientation', label: 'Orientation' },
    { key: 'pdfVersion', label: 'PDF version' },
    { key: 'rotation', label: 'Rotation' },
    { key: 'zoom', label: 'Zoom' }
  ];

  function init(root) {
    const inspector = root.querySelector('.editor-inspector');
    if (!inspector) return;

    inspector.appendChild(renderDocumentSection());
    inspector.appendChild(renderSelectionSection());
    inspector.appendChild(renderPropertiesSection());
    OTHER_SECTIONS.forEach((s) => inspector.appendChild(renderPlaceholderSection(s)));
  }

  function sectionShell(id, title, open) {
    const section = document.createElement('div');
    section.className = 'editor-inspector-section' + (open ? ' is-open' : '');
    section.dataset.section = id;

    const headId = `inspector-head-${id}`;
    const bodyId = `inspector-body-${id}`;

    section.innerHTML = `
      <button type="button" class="editor-inspector-section-head" id="${headId}" aria-expanded="${open}" aria-controls="${bodyId}">
        <span class="editor-inspector-section-title">${title}</span>
        <svg class="editor-inspector-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="editor-inspector-section-body" id="${bodyId}" role="region" aria-labelledby="${headId}"></div>`;

    section.querySelector('.editor-inspector-section-head').addEventListener('click', () => {
      const isOpen = section.classList.toggle('is-open');
      section.querySelector('.editor-inspector-section-head').setAttribute('aria-expanded', String(isOpen));
    });

    return section;
  }

  function renderPlaceholderSection(s) {
    const section = sectionShell(s.id, s.title, s.open);
    section.querySelector('.editor-inspector-section-body').innerHTML =
      `<div class="editor-inspector-placeholder">${s.placeholder}</div>`;
    return section;
  }

  /** Priority 4B-1: Selection section becomes reactive. Stays generic for
   *  every current and future object type — shows only "Object type:
   *  <Capitalized type>", never a hardcoded type name. No editing
   *  controls here (out of scope this phase); Properties remains the
   *  placeholder for those once they exist.
   *  Listens to editor:objectsChanged rather than
   *  editor:objectSelectionChange: the latter's payload carries only
   *  selectedIds (not type), and objectsChanged is the one event
   *  guaranteed to fire on every relevant mutation, including an object
   *  being removed out from under an active selection — see
   *  editor-objects.js's own file header for why that event exists. */
  function renderSelectionSection() {
    const section = sectionShell('selection', 'Selection', true);
    const body = section.querySelector('.editor-inspector-section-body');
    body.innerHTML = `<div class="editor-inspector-placeholder">${SELECTION_PLACEHOLDER}</div>`;

    function refresh() {
      if (!window.EditorObjects) return;
      const selected = window.EditorObjects.getAllObjects().find((o) => o.selected);
      if (!selected) {
        body.innerHTML = `<div class="editor-inspector-placeholder">${SELECTION_PLACEHOLDER}</div>`;
        return;
      }
      body.innerHTML = `<div class="editor-inspector-doc-info">
        <div class="editor-inspector-row">
          <span class="editor-inspector-row-label">Object type</span>
          <span class="editor-inspector-row-value">${capitalize(selected.type)}</span>
        </div>
      </div>`;
    }

    window.addEventListener('editor:objectsChanged', refresh);
    return section;
  }

  function capitalize(s) {
    return (typeof s === 'string' && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /** Priority 4B-2: Properties section becomes reactive — this is the
   *  exact extension point the 4B-1 revision note earmarked ("Properties
   *  remains the placeholder for those [editing controls] once they
   *  exist"). Only wires the data model per the approved scope: every
   *  control patches `object.data` through the existing
   *  EditorObjects.updateObject() choke point, nothing more.
   *  Native form controls only (select/checkbox/color/number/textarea) —
   *  deliberately avoids adding any new CSS beyond editor-objects.css
   *  (this phase's stated CSS scope): checked/native widget states need
   *  no custom styling, and layout reuses the existing
   *  .editor-inspector-doc-info/.editor-inspector-row classes.
   *  Uses 'change' (not 'input') on text-like fields so a full rebuild on
   *  the next editor:objectsChanged never happens mid-keystroke — only
   *  after the field is committed (blur/Enter), by which point focus has
   *  already moved on regardless.
   *
   *  Priority 4C: refresh() dispatches per selected type — the same
   *  shape as renderObjectContent()'s switch in editor-objects.js,
   *  applied here instead of to rendering. 'text' -> renderTextProperties()
   *  (the original 4B-2 markup, unchanged, just extracted into its own
   *  function); 'image' -> renderImageProperties() (new); anything else,
   *  or no selection, falls through to the original placeholder.
   *
   *  Priority 4D: 'rectangle'/'ellipse'/'line' all dispatch to one more
   *  shared function, renderShapeProperties() — not three near-duplicate
   *  branches, mirroring renderShapeContent()'s single-function approach
   *  in editor-objects.js for the same family of types. */
  function renderPropertiesSection() {
    const section = sectionShell('properties', 'Properties', false);
    const body = section.querySelector('.editor-inspector-section-body');
    body.innerHTML = `<div class="editor-inspector-placeholder">${PROPERTIES_PLACEHOLDER}</div>`;

    function patchData(selected, patch) {
      window.EditorObjects.updateObject(selected.id, { data: Object.assign({}, selected.data, patch) });
    }

    function refresh() {
      if (!window.EditorObjects) return;
      const selected = window.EditorObjects.getAllObjects().find((o) => o.selected);
      if (selected && selected.type === 'text') { renderTextProperties(selected); return; }
      if (selected && selected.type === 'image') { renderImageProperties(selected); return; }
      if (selected && (selected.type === 'rectangle' || selected.type === 'ellipse' || selected.type === 'line')) { renderShapeProperties(selected); return; }
      body.innerHTML = `<div class="editor-inspector-placeholder">${PROPERTIES_PLACEHOLDER}</div>`;
    }

    function renderTextProperties(selected) {
      const d = selected.data || {};
      body.innerHTML = `
        <div class="editor-inspector-doc-info">
          <div class="editor-inspector-row"><span class="editor-inspector-row-label">Text</span></div>
          <textarea data-prop="text" rows="2" style="width:100%;">${escapeHtml(d.text || 'Text')}</textarea>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Font Family</span>
            <select data-prop="fontFamily">${FONT_FAMILIES.map((f) =>
              `<option value="${f}"${(d.fontFamily || 'Arial') === f ? ' selected' : ''}>${f}</option>`).join('')}</select>
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Font Size</span>
            <input data-prop="fontSize" type="number" min="6" max="200" value="${d.fontSize || 16}">
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Bold</span>
            <input data-prop="bold" type="checkbox" ${d.bold ? 'checked' : ''}>
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Italic</span>
            <input data-prop="italic" type="checkbox" ${d.italic ? 'checked' : ''}>
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Underline</span>
            <input data-prop="underline" type="checkbox" ${d.underline ? 'checked' : ''}>
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Text Color</span>
            <input data-prop="color" type="color" value="${d.color || '#000000'}">
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Alignment</span>
            <select data-prop="align">${['left', 'center', 'right'].map((a) =>
              `<option value="${a}"${(d.align || 'left') === a ? ' selected' : ''}>${capitalize(a)}</option>`).join('')}</select>
          </div>
        </div>`;

      body.querySelector('[data-prop="text"]').addEventListener('change', (e) => patchData(selected, { text: e.target.value || 'Text' }));
      body.querySelector('[data-prop="fontFamily"]').addEventListener('change', (e) => patchData(selected, { fontFamily: e.target.value }));
      body.querySelector('[data-prop="fontSize"]').addEventListener('change', (e) => {
        const n = Number(e.target.value);
        patchData(selected, { fontSize: Number.isFinite(n) && n > 0 ? n : 16 });
      });
      body.querySelector('[data-prop="bold"]').addEventListener('change', (e) => patchData(selected, { bold: e.target.checked }));
      body.querySelector('[data-prop="italic"]').addEventListener('change', (e) => patchData(selected, { italic: e.target.checked }));
      body.querySelector('[data-prop="underline"]').addEventListener('change', (e) => patchData(selected, { underline: e.target.checked }));
      body.querySelector('[data-prop="color"]').addEventListener('change', (e) => patchData(selected, { color: e.target.value }));
      body.querySelector('[data-prop="align"]').addEventListener('change', (e) => patchData(selected, { align: e.target.value }));
    }

    /** Priority 4C: Width/Height here bind to `data.naturalWidth`/
     *  `data.naturalHeight` — the image's intrinsic pixel dimensions,
     *  the only width/height fields the approved schema puts inside
     *  `data` — not the object's on-canvas box size (`wPct`/`hPct`,
     *  which live outside `data` and are driven by drag/resize). Editing
     *  these does not resize the box; it only updates the recorded
     *  intrinsic dimensions, per "every control must ... update
     *  object.data." */
    function renderImageProperties(selected) {
      const d = selected.data || {};
      body.innerHTML = `
        <div class="editor-inspector-doc-info">
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Width</span>
            <input data-prop="naturalWidth" type="number" min="1" value="${d.naturalWidth || ''}">
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Height</span>
            <input data-prop="naturalHeight" type="number" min="1" value="${d.naturalHeight || ''}">
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Keep Aspect Ratio</span>
            <input data-prop="keepAspectRatio" type="checkbox" ${d.keepAspectRatio !== false ? 'checked' : ''}>
          </div>
        </div>`;

      body.querySelector('[data-prop="naturalWidth"]').addEventListener('change', (e) => {
        const n = Number(e.target.value);
        patchData(selected, { naturalWidth: Number.isFinite(n) && n > 0 ? n : d.naturalWidth });
      });
      body.querySelector('[data-prop="naturalHeight"]').addEventListener('change', (e) => {
        const n = Number(e.target.value);
        patchData(selected, { naturalHeight: Number.isFinite(n) && n > 0 ? n : d.naturalHeight });
      });
      body.querySelector('[data-prop="keepAspectRatio"]').addEventListener('change', (e) => patchData(selected, { keepAspectRatio: e.target.checked }));
    }

    /** Priority 4D: one shared renderer for rectangle/ellipse/line —
     *  matches editor-objects.js's renderShapeContent() using one
     *  function instead of three near-duplicates, for the same reason.
     *  Fill Color is omitted for 'line' (no fill concept for a line);
     *  Radius is shown only for 'rectangle'. Every control still patches
     *  `object.data` through the same updateObject()-only path as every
     *  other Properties control. */
    function renderShapeProperties(selected) {
      const d = selected.data || {};
      const showFill = selected.type !== 'line';
      const showRadius = selected.type === 'rectangle';
      body.innerHTML = `
        <div class="editor-inspector-doc-info">
          ${showFill ? `<div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Fill Color</span>
            <input data-prop="fill" type="color" value="${d.fill || '#ffffff'}">
          </div>` : ''}
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Stroke Color</span>
            <input data-prop="stroke" type="color" value="${d.stroke || '#000000'}">
          </div>
          <div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Stroke Width</span>
            <input data-prop="strokeWidth" type="number" min="0" max="50" value="${d.strokeWidth != null ? d.strokeWidth : 2}">
          </div>
          ${showRadius ? `<div class="editor-inspector-row">
            <span class="editor-inspector-row-label">Radius</span>
            <input data-prop="radius" type="number" min="0" max="50" value="${d.radius || 0}">
          </div>` : ''}
        </div>`;

      if (showFill) body.querySelector('[data-prop="fill"]').addEventListener('change', (e) => patchData(selected, { fill: e.target.value }));
      body.querySelector('[data-prop="stroke"]').addEventListener('change', (e) => patchData(selected, { stroke: e.target.value }));
      body.querySelector('[data-prop="strokeWidth"]').addEventListener('change', (e) => {
        const n = Number(e.target.value);
        patchData(selected, { strokeWidth: Number.isFinite(n) && n >= 0 ? n : 2 });
      });
      if (showRadius) body.querySelector('[data-prop="radius"]').addEventListener('change', (e) => {
        const n = Number(e.target.value);
        patchData(selected, { radius: Number.isFinite(n) && n >= 0 ? n : 0 });
      });
    }

    window.addEventListener('editor:objectsChanged', refresh);
    return section;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderDocumentSection() {
    const section = sectionShell('document', 'Document', true);
    const body = section.querySelector('.editor-inspector-section-body');

    body.innerHTML = `<div class="editor-inspector-doc-info">${
      DOC_FIELDS.map((f) => `
        <div class="editor-inspector-row">
          <span class="editor-inspector-row-label">${f.label}</span>
          <span class="editor-inspector-row-value" data-doc-field="${f.key}">${EMPTY}</span>
        </div>`).join('')
    }</div>`;

    const fieldEls = {};
    DOC_FIELDS.forEach((f) => { fieldEls[f.key] = body.querySelector(`[data-doc-field="${f.key}"]`); });
    function setField(key, value) { if (fieldEls[key]) fieldEls[key].textContent = value; }

    // Zoom has a meaningful value even with no document open (the shell
    // defaults to 100%) — reflect it immediately rather than waiting for
    // a document to load, matching editor-toolbar.js's own zoom display.
    setField('zoom', window.ZoomManager ? `${window.ZoomManager.getPercent()}%` : EMPTY);

    window.addEventListener('editor:documentLoaded', (e) => {
      const { fileName, fileSize, numPages, pdfVersion } = e.detail;
      setField('fileName', fileName || 'Untitled');
      setField('fileSize', formatBytes(fileSize));
      setField('totalPages', String(numPages));
      setField('pdfVersion', pdfVersion ? `PDF ${pdfVersion}` : 'Not available');
    });

    window.addEventListener('editor:documentError', () => {
      DOC_FIELDS.forEach((f) => { if (f.key !== 'zoom') setField(f.key, EMPTY); });
    });

    window.addEventListener('editor:pageChange', async (e) => {
      const { page, pageCount } = e.detail;
      setField('currentPage', pageCount ? String(page) : EMPTY);
      if (!pageCount) {
        setField('pageDimensions', EMPTY);
        setField('orientation', EMPTY);
        setField('rotation', EMPTY);
        return;
      }
      try {
        const info = await window.RenderEngine.getPageInfo(page);
        setField('pageDimensions', `${Math.round(info.width)} × ${Math.round(info.height)} pt`);
        setField('orientation', info.width > info.height ? 'Landscape' : 'Portrait');
        setField('rotation', `${info.rotation || 0}°`);
      } catch (_) {
        setField('pageDimensions', EMPTY);
        setField('orientation', EMPTY);
        setField('rotation', EMPTY);
      }
    });

    window.addEventListener('editor:zoomChange', (e) => {
      setField('zoom', `${Math.round(e.detail.zoom * 100)}%`);
    });

    return section;
  }

  // index.html already defines a global fmtSize() used across every other
  // tool's result UI — reused here rather than duplicated (see fmtSize in
  // index.html's own <script>). The standalone preview harness
  // (editor-preview.html) doesn't load index.html's script, so this falls
  // back to the same thresholds/rounding, verified to match, for that
  // harness only.
  function formatBytes(bytes) {
    if (typeof window.fmtSize === 'function') return window.fmtSize(bytes || 0);
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  window.EditorInspector = { init };
})();
