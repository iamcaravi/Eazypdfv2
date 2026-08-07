/* ==========================================================================
   js/editor/editor-toolbar.js
   ---------------------------------------------------------------------------
   Top Toolbar: File / View / Zoom / Page / Selection / Future-tools groups.

   Phase 6.0A: File > Open is no longer reserved — it's this phase's one
   real File action (a native file picker feeding EditorCanvas.loadFile()).
   Save/Print stay reserved+disabled (still later-phase editing/export
   features). Zoom now fully delegates to ZoomManager as the single source
   of truth — this file no longer tracks its own zoom number, it just
   renders ZoomManager's state and calls its methods, exactly like
   editor-statusbar.js already does for the same event.

   Priority 3C: adds the Page group (First / Previous / page number / Next /
   Last) and an Actual Size (100%) zoom button. Both delegate to the existing
   modules exactly like the pre-existing zoom buttons already did — Page nav
   calls window.ViewportManager.scrollToPage(), Actual Size calls
   window.ZoomManager.setZoom(100). No new state is owned here: page number
   and page count are read off the editor:pageChange payload the same way
   editor-statusbar.js already does; this file's local copies exist only to
   drive button disabled/enabled state and the input's displayed value.

   Priority 4B-1: the 'future' group's Text button is no longer reserved —
   it's a real action now (arms EditorObjects.beginPlacement('text', ...),
   the click-to-place entry point Priority 4A already built). Draw/Sign
   stay disabled via their own per-button `reserved:true`, the same
   pattern the File group already uses for Save/Print inside a
   non-reserved group — no new disabling mechanism introduced.

   Priority 4B-2: the Text button's beginPlacement() defaults are updated
   to the finalized text schema (bold/italic/underline/align replace the
   4B-1 fontWeight/fontStyle placeholders, which were seeded but never
   rendered from until this phase) — still just the `data` payload handed
   to the same beginPlacement() entry point, no new mechanism here.

   Priority 4C: image objects (js/editor/editor-objects.js) don't get a
   toolbar button this phase. No Image entry exists anywhere in ICONS/
   GROUPS today — not even a reserved placeholder the way Draw/Sign
   already are — so there's nothing to "activate," and adding a new
   button outright would be inventing toolbar UI this phase's scope
   explicitly excludes ("do NOT redesign the toolbar").
   Documented insertion point for a future phase: a new button in the
   'future' group (icon key 'image', alongside 'text'/'draw'/'sign'),
   whose action would — reusing exactly the mechanisms already proven
   out for Text —
     1. open a hidden `<input type="file" accept="image/*">` (same
        pattern as the File > Open button already uses),
     2. on change, read the file (FileReader or URL.createObjectURL) and
        load it into an Image() to measure naturalWidth/naturalHeight,
     3. compute an aspect-correct default wPct/hPct from those dimensions
        and the current page's pixel box (window.RenderEngine
        .getPageInfo(currentPage), the same lookup editor-inspector.js's
        Document section already calls) — placeObjectAt() already
        supports overriding wPct/hPct via `defaults`, unchanged,
     4. call window.EditorObjects.beginPlacement('image', { data: { src,
        naturalWidth, naturalHeight, keepAspectRatio: true }, wPct, hPct }).
   No code added here — editor-objects.js's rendering/resize/Inspector
   support for 'image' objects is fully functional today via direct
   beginPlacement() calls; only the button UI itself is deferred.

   Priority 4D: shape objects (rectangle/ellipse/line, js/editor/editor-
   objects.js) don't get a toolbar button either, for the same reason as
   Image — no reserved placeholder exists for "shape" specifically.
   Draw and Sign are unrelated tools (freehand drawing, signatures), not
   shapes; reusing either would misuse a placeholder reserved for a
   different feature, not "reuse" one, so neither is touched.
   Documented insertion point for a future phase: a small shape picker
   (three buttons or one button with a type selector — Rectangle/Ellipse/
   Line) in the 'future' group, whose action would — reusing exactly the
   Text/Image pattern already proven out —
     call window.EditorObjects.beginPlacement('rectangle' | 'ellipse' |
     'line', { data: { fill: '#ffffff', stroke: '#000000', strokeWidth: 2,
     radius: 0 } }) — `radius` only meaningful for 'rectangle', harmless
     as an unused key in `data` for the other two.
   No code added here — editor-objects.js's rendering/resize/Inspector
   support for all three shape types is fully functional today via direct
   beginPlacement() calls; only the button UI itself is deferred.

   Priority 4E: the 'future' group's Image button is no longer just a
   documented insertion point — it's wired up, following the exact plan
   the 4C revision note above already laid out: a hidden
   `<input type="file" accept="image/*">` (same pattern as File > Open),
   read via `window.loadImage()` (index.html's existing helper, already
   used by TOOLS.imgcompress/imgresize/etc. — not reimplemented), an
   aspect-correct default box size derived from RenderEngine.getPageInfo()
   of the current page, then a single `beginPlacement('image', ...)` call
   — identical mechanism to the Text button, no new interaction system.

   `window.loadImage()` (and its own callers elsewhere in index.html)
   never revokes the `URL.createObjectURL()` it creates — confirmed by
   reading every call site. That's an acceptable, long-lived pre-existing
   pattern for those tools (the blob is used once, briefly, while its
   panel is open). It is NOT acceptable here unmodified: an image
   *object*'s `data.src` is that same blob URL, kept and displayed for as
   long as the object exists — intentionally never revoked while the
   object is alive (a future export step will need to `fetch()` it) — but
   Priority 4E's own `beginPlacement()` step introduces a real gap of its
   own: the URL is created the moment a file is *picked*, before the user
   has actually clicked a page to place it. If that placement is later
   abandoned (Escape, or picking a different tool/file before placing),
   the object claiming that URL never gets created and nothing else in
   this codebase would ever revoke it.
   Handled locally, without touching editor-objects.js: one closure
   variable, `pendingImageUrl`, tracks a blob URL created but not yet
   confirmed placed. It's cleared (ownership handed to the object, no
   revoke) the moment a matching `editor:objectAdded` fires; revoked if
   Escape is pressed while it's still outstanding (mirrors
   editor-objects.js's own Escape-cancels-pending-placement rule, without
   needing to read its private state — pendingImageUrl is only ever
   non-null while a placement is genuinely pending); and revoked if
   superseded by picking another image, or another tool's placement,
   before ever being placed. Cancelling the native file-picker dialog
   itself creates no URL at all (guarded before any decode/measure work
   even starts), so it is a true no-op — nothing created, nothing to
   clean up, no error.

   Priority 4F: the 'future' group's shape picker is wired up — three
   separate buttons (Rectangle/Ellipse/Line), not a type-selector control,
   matching the exact pattern Text/Image already use (one icon = one type
   = one direct beginPlacement() call). Each calls
   window.EditorObjects.beginPlacement(type, { data: { fill: '#ffffff',
   stroke: '#000000', strokeWidth: 2, radius: 0 } }) — exactly the payload
   the 4D revision note above already specified; `radius` is harmless as
   an unused key in `data` for ellipse/line. No wPct/hPct override, same
   as Text — shapes have no intrinsic aspect ratio to preserve (unlike
   Image), so placeObjectAt()'s own default box size applies unchanged.
   No RenderEngine/loadImage/blob-URL work needed — shapes carry no
   external resource, so there's no equivalent of 4E's pending-URL
   lifecycle to manage. Each of the three actions still calls
   revokePendingImageUrl() first, same supersede guard 4E gave text-tool:
   arming any new placement — shape included — correctly cleans up an
   image that was picked but never placed. Draw/Sign remain untouched,
   reserved+disabled, per 4D's own note that they're unrelated features.

   Priority 5A: a new `Edit` group (Undo/Redo) is added — the same
   additive mechanism Priority 3C already used once to add the `Page`
   group to this same GROUPS array, not a toolbar redesign. Both buttons
   start disabled via the existing per-button `reserved:true` flag (purely
   reusing "start disabled," not "unbuilt feature" — editor-history.js's
   own initial editor:historyChange dispatch, fired at the end of its
   init(), corrects their real enabled/disabled state within the same
   shell-init sequence, before any user interaction is possible) and are
   kept in sync afterward via one more `editor:historyChange` listener,
   the same pattern already used for `editor:pageChange` driving the Page
   group's own button states. Clicking either just calls
   window.EditorHistory.undo()/redo() — no new mechanism, no new state
   owned here.

   Priority 5B: the File group's Save button is no longer just a reserved
   placeholder — it's this phase's Export action, exactly matching what
   this file's own Phase 6.0A comment already said it would eventually be
   ("Save/Print stay reserved+disabled — still later-phase editing/export
   features"). Clicking it delegates straight to
   window.EditorExport.exportCurrentDocument() — same one-line delegation
   shape as Undo/Redo. Disabled state reuses the exact same pageState /
   editor:pageChange listener the Page group already has (one more line,
   no new event, no new state) rather than adding a second document-loaded
   tracker. Print stays reserved — out of scope, unrelated feature.

   Selection remains reserved+disabled, unchanged from the Editor
   Architecture phase — still not this phase's job.
   ---------------------------------------------------------------------------
   Public surface: window.EditorToolbar.init(rootEl)
   Listens for: editor:zoomChange, editor:documentLoaded, editor:pageChange
                (updates its own zoom display / doc title / page controls,
                and now also the Save button's disabled state — doesn't
                own that state), editor:objectAdded (Priority 4E, clears
                pendingImageUrl once its blob URL is confirmed adopted by
                a placed object), editor:historyChange (Priority 5A,
                toggles Undo/Redo button disabled state)
   ========================================================================== */
(function () {
  const ICONS = {
    open: '<path d="M4 4h11l5 5v11H4z"/><path d="M14 4v6h6" stroke-linejoin="round"/>',
    undo: '<path d="M9 14l-4-4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10h9a5 5 0 0 1 0 10h-1" stroke-linecap="round" stroke-linejoin="round"/>',
    redo: '<path d="M15 14l4-4-4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 10h-9a5 5 0 0 0 0 10h1" stroke-linecap="round" stroke-linejoin="round"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h8V4M8 20v-6h8v6" stroke-linejoin="round"/>',
    print: '<rect x="6" y="9" width="12" height="7" rx="1"/><path d="M7 9V4h10v5M7 16v4h10v-4"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16"/>',
    inspector: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/>',
    grid: '<path d="M4 4h16v16H4z"/><path d="M4 10h16M4 16h16M10 4v16M16 4v16"/>',
    zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M8 11h6M21 21l-4.3-4.3" stroke-linecap="round"/>',
    zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6M21 21l-4.3-4.3" stroke-linecap="round"/>',
    fitWidth: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M8 12h8" stroke-linecap="round"/>',
    fitPage: '<rect x="5" y="3" width="14" height="18" rx="1"/>',
    actualSize: '<rect x="4" y="4" width="16" height="16" rx="1"/><rect x="9" y="9" width="6" height="6" rx="0.5"/>',
    firstPage: '<path d="M7 5v14" stroke-linecap="round"/><path d="M17 6l-6 6 6 6" stroke-linejoin="round" stroke-linecap="round"/>',
    prevPage: '<path d="M15 5l-7 7 7 7" stroke-linejoin="round" stroke-linecap="round"/>',
    nextPage: '<path d="M9 5l7 7-7 7" stroke-linejoin="round" stroke-linecap="round"/>',
    lastPage: '<path d="M17 5v14" stroke-linecap="round"/><path d="M7 6l6 6-6 6" stroke-linejoin="round" stroke-linecap="round"/>',
    select: '<path d="M4 4l7 16 2-7 7-2z" stroke-linejoin="round"/>',
    lasso: '<path d="M12 4c-4 0-7 2.5-7 6s3 5 3 8c0 1.5 1.5 2 2.5 1M12 4c4 0 7 2.5 7 6s-3 5-3 8"/>',
    align: '<path d="M4 6h16M4 12h10M4 18h13" stroke-linecap="round"/>',
    text: '<path d="M5 6h14M12 6v14" stroke-linecap="round"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5-4 4-3-3-5 5" stroke-linecap="round" stroke-linejoin="round"/>',
    rectangle: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
    line: '<path d="M5 19L19 5" stroke-linecap="round"/>',
    draw: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
    sign: '<path d="M4 18c3-6 5 4 8-2s5 4 8-2" stroke-linecap="round"/>',
    highlight: '<path d="M4 20h16" stroke-linecap="round"/><path d="M6 16l9-9 3 3-9 9H6z" stroke-linejoin="round"/>',
    whiteout: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 8h8v8H8z" fill="currentColor" stroke="none"/>'
  };

  const GROUPS = [
    { id: 'file', label: 'File', buttons: [
      { icon: 'open', title: 'Open PDF', action: 'open' },
      { icon: 'save', title: 'Save', action: 'export', reserved: true },
      { icon: 'print', title: 'Print', reserved: true }
    ]},
    { id: 'edit', label: 'Edit', buttons: [
      { icon: 'undo', title: 'Undo', action: 'undo', reserved: true },
      { icon: 'redo', title: 'Redo', action: 'redo', reserved: true }
    ]},
    { id: 'view', label: 'View', buttons: [
      { icon: 'sidebar', title: 'Toggle page panel', action: 'toggle-sidebar' },
      { icon: 'inspector', title: 'Toggle inspector', action: 'toggle-inspector' },
      { icon: 'grid', title: 'Toggle background grid', action: 'toggle-grid' }
    ]},
    { id: 'zoom', label: 'Zoom', custom: 'zoom' },
    { id: 'page', label: 'Page', custom: 'page' },
    { id: 'selection', label: 'Selection', reserved: true, buttons: [
      { icon: 'select', title: 'Select' }, { icon: 'lasso', title: 'Lasso select' }, { icon: 'align', title: 'Align' }
    ]},
    { id: 'future', label: 'Tools', buttons: [
      { icon: 'text', title: 'Text', action: 'text-tool' },
      { icon: 'image', title: 'Image', action: 'image-tool' },
      { icon: 'rectangle', title: 'Rectangle', action: 'rectangle-tool' },
      { icon: 'ellipse', title: 'Ellipse', action: 'ellipse-tool' },
      { icon: 'line', title: 'Line', action: 'line-tool' },
      { icon: 'draw', title: 'Draw', action: 'draw-tool' },
      { icon: 'highlight', title: 'Highlight', action: 'highlight-tool' },
      { icon: 'whiteout', title: 'Whiteout', action: 'whiteout-tool' },
      { icon: 'sign', title: 'Sign', action: 'sign-tool' }
    ]}
  ];

  function init(root) {
    const toolbar = root.querySelector('.editor-toolbar');
    if (!toolbar) return;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/pdf';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) window.EditorCanvas.loadFile(fileInput.files[0]);
      fileInput.value = '';
    });
    toolbar.appendChild(fileInput);

    // Priority 4E — Image tool. Separate input from the PDF one above:
    // different `accept`, different handler, no shared state between them.
    const imageInput = document.createElement('input');
    imageInput.type = 'file';
    imageInput.accept = 'image/*';
    imageInput.style.display = 'none';
    imageInput.addEventListener('change', () => {
      const file = imageInput.files[0];
      imageInput.value = ''; // reset regardless, same as the PDF input above
      if (!file) return; // cancelled the OS dialog — true no-op, nothing created yet
      handlePickedImage(file);
    });
    toolbar.appendChild(imageInput);

    // Tracks a blob URL created for an image that's been picked but not
    // yet confirmed placed as an object — see file header (Priority 4E)
    // for the full leak-prevention rationale.
    let pendingImageUrl = null;

    function revokePendingImageUrl() {
      if (pendingImageUrl) { URL.revokeObjectURL(pendingImageUrl); pendingImageUrl = null; }
    }

    // Reuses index.html's existing loadImage() helper (already used by
    // TOOLS.imgcompress/imgresize/etc.) when present; falls back to the
    // same createObjectURL+Image() logic for editor-preview.html, which
    // never loads index.html — same fallback convention editor-inspector.js
    // already uses for its own formatBytes()/fmtSize() lookup.
    function loadImageFile(file) {
      if (typeof window.loadImage === 'function') return window.loadImage(file);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }

    function clampBoxPct(v) { return Math.min(90, Math.max(5, v)); }

    /** Shared by handlePickedImage() and openSignaturePad(): the page's own
     *  aspect ratio has to be factored in because wPct/hPct are percentages
     *  of the page's width/height respectively (not equal to each other in
     *  pixels), the same math startResize()'s image branch already applies
     *  on resize — this just establishes a correct starting box instead of
     *  a coincidentally-correct one. Falls back to the uncorrected default
     *  wPct/defaultHPct if no page info is available yet. */
    async function aspectCorrectedBox(naturalWidth, naturalHeight, wPct, defaultHPct) {
      let hPct = defaultHPct;
      if (naturalWidth && naturalHeight && pageState.total > 0 && window.RenderEngine) {
        try {
          const info = await window.RenderEngine.getPageInfo(pageState.current);
          if (info && info.width && info.height) {
            const pageAspect = info.width / info.height;
            const imageAspect = naturalWidth / naturalHeight;
            hPct = clampBoxPct(wPct * pageAspect / imageAspect);
          }
        } catch (_) { /* fall back to defaultHPct — see doc comment above */ }
      }
      return { wPct, hPct };
    }

    async function handlePickedImage(file) {
      // Superseding an image that was picked but never placed — revoke its
      // URL now rather than leaving it orphaned indefinitely.
      revokePendingImageUrl();

      let img;
      try {
        img = await loadImageFile(file);
      } catch (err) {
        console.error('Could not read image file:', err);
        return; // nothing was created — no object, no armed placement, no leak
      }

      const url = img.src; // the blob URL loadImageFile() just created
      pendingImageUrl = url;
      const naturalWidth = img.naturalWidth || img.width;
      const naturalHeight = img.naturalHeight || img.height;
      const { wPct, hPct } = await aspectCorrectedBox(naturalWidth, naturalHeight, 30, 20);

      if (!window.EditorObjects) { revokePendingImageUrl(); return; }
      window.EditorObjects.beginPlacement('image', {
        data: { src: url, naturalWidth, naturalHeight, keepAspectRatio: true },
        wPct, hPct
      });
    }

    /** Trims a canvas down to the bounding box of its non-transparent
     *  pixels (a small alpha-threshold pixel scan) so a signature drawn in
     *  one corner of the pad doesn't get placed as a mostly-empty box. */
    function trimTransparentCanvas(canvas) {
      const ctx = canvas.getContext('2d');
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 10) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return canvas; // nothing drawn
      const pad = 6;
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
      const w = maxX - minX + 1, h = maxY - minY + 1;
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      out.getContext('2d').drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
      return out;
    }

    /** Sign tool: a lightweight self-contained pad (own overlay, own
     *  markup) rather than reusing index.html's modal system — this file
     *  stays standalone-testable in editor-preview.html the same way
     *  every other editor-*.js module already is (see e.g. render-
     *  engine.js's own file header on that same constraint). On "Use
     *  Signature", the drawn ink is trimmed, exported as a transparent
     *  PNG, and armed via beginPlacement('image', ...) — reusing the
     *  entire existing image object type/rendering/export pipeline
     *  rather than inventing a `signature` object type with its own. */
    function openSignaturePad() {
      const overlay = document.createElement('div');
      overlay.className = 'editor-sign-overlay';
      overlay.innerHTML = `
        <div class="editor-sign-modal">
          <div class="editor-sign-modal-head">
            <span>Draw your signature</span>
            <button type="button" class="editor-sign-close" aria-label="Cancel">✕</button>
          </div>
          <canvas class="editor-sign-canvas" width="480" height="180"></canvas>
          <div class="editor-sign-modal-actions">
            <button type="button" class="editor-sign-clear">Clear</button>
            <button type="button" class="editor-sign-done">Use Signature</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const canvas = overlay.querySelector('.editor-sign-canvas');
      const ctx = canvas.getContext('2d');
      ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a2e';
      let drawing = false, hasInk = false;

      function pointFromEvent(e) {
        const r = canvas.getBoundingClientRect();
        const t = e.touches && e.touches[0];
        const cx = (t ? t.clientX : e.clientX) - r.left;
        const cy = (t ? t.clientY : e.clientY) - r.top;
        return { x: cx * (canvas.width / r.width), y: cy * (canvas.height / r.height) };
      }
      function start(e) { e.preventDefault(); drawing = true; const p = pointFromEvent(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
      function move(e) { if (!drawing) return; e.preventDefault(); const p = pointFromEvent(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasInk = true; }
      function end() { drawing = false; }
      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', move, { passive: false });
      canvas.addEventListener('touchend', end);

      function close() {
        window.removeEventListener('mouseup', end);
        overlay.remove();
      }
      overlay.querySelector('.editor-sign-close').addEventListener('click', close);
      overlay.querySelector('.editor-sign-clear').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; });
      overlay.querySelector('.editor-sign-done').addEventListener('click', async () => {
        if (!hasInk) { close(); return; }
        const trimmed = trimTransparentCanvas(canvas);
        const blob = await new Promise((resolve) => trimmed.toBlob(resolve, 'image/png'));
        close();
        if (!blob || !window.EditorObjects) return;
        const url = URL.createObjectURL(blob);
        pendingImageUrl = url; // same leak-prevention lifecycle as a picked image file
        const { wPct, hPct } = await aspectCorrectedBox(trimmed.width, trimmed.height, 30, 12);
        window.EditorObjects.beginPlacement('image', {
          data: { src: url, naturalWidth: trimmed.width, naturalHeight: trimmed.height, keepAspectRatio: true },
          wPct, hPct
        });
      });
    }

    // Confirms a pending image URL was actually adopted by a placed object
    // (ownership now belongs to that object's whole lifetime, so it's no
    // longer this module's job to revoke it — a future export step will
    // need to fetch() this same URL).
    window.addEventListener('editor:objectAdded', (e) => {
      const obj = e.detail && e.detail.object;
      if (pendingImageUrl && obj && obj.type === 'image' && obj.data && obj.data.src === pendingImageUrl) {
        pendingImageUrl = null;
      }
    });

    // Mirrors editor-objects.js's own "Escape cancels a pending placement"
    // rule without reading its private state: pendingImageUrl is only ever
    // non-null while an image placement genuinely hasn't landed yet, so
    // reacting to the same keystroke here is always correct, never a false
    // cancel of an already-placed object.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') revokePendingImageUrl();
    });

    // Page group's local view of editor:pageChange — read-only mirror, not
    // owned state (see file header). pageControls is set once the 'page'
    // custom group below is built.
    const pageState = { current: 1, total: 0 };
    let pageControls = null;

    GROUPS.forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'editor-toolbar-group';
      groupEl.dataset.group = group.id;
      if (group.reserved) groupEl.dataset.reserved = 'true';

      const label = document.createElement('span');
      label.className = 'editor-toolbar-label';
      label.textContent = group.label;
      groupEl.appendChild(label);

      if (group.custom === 'zoom') {
        groupEl.appendChild(iconButton('zoomOut', 'Zoom out', () => window.ZoomManager.zoomOut()));
        const val = document.createElement('span');
        val.className = 'editor-zoom-value';
        val.dataset.zoomValue = 'true';
        val.textContent = '100%';
        groupEl.appendChild(val);
        groupEl.appendChild(iconButton('zoomIn', 'Zoom in', () => window.ZoomManager.zoomIn()));
        groupEl.appendChild(iconButton('actualSize', 'Actual size (100%)', () => window.ZoomManager.setZoom(100)));
        groupEl.appendChild(iconButton('fitWidth', 'Fit width', () => window.ZoomManager.fitWidth()));
        groupEl.appendChild(iconButton('fitPage', 'Fit page', () => window.ZoomManager.fitPage()));
      } else if (group.custom === 'page') {
        const firstBtn = iconButton('firstPage', 'First page', () => window.ViewportManager.scrollToPage(1), true);
        const prevBtn = iconButton('prevPage', 'Previous page', () => window.ViewportManager.scrollToPage(Math.max(1, pageState.current - 1)), true);

        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.className = 'editor-page-input';
        input.setAttribute('aria-label', 'Current page');
        input.value = '1';
        input.disabled = true;
        input.addEventListener('change', () => commitPageInput(input));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });

        const total = document.createElement('span');
        total.className = 'editor-page-total';
        total.dataset.pageTotal = 'true';
        total.textContent = '/ 0';

        const nextBtn = iconButton('nextPage', 'Next page', () => window.ViewportManager.scrollToPage(Math.min(pageState.total, pageState.current + 1)), true);
        const lastBtn = iconButton('lastPage', 'Last page', () => window.ViewportManager.scrollToPage(pageState.total), true);

        [firstBtn, prevBtn, input, total, nextBtn, lastBtn].forEach((el) => groupEl.appendChild(el));
        pageControls = { firstBtn, prevBtn, input, total, nextBtn, lastBtn };
      } else {
        group.buttons.forEach((btn) => {
          const disabled = group.reserved || btn.reserved;
          groupEl.appendChild(iconButton(btn.icon, btn.title, () => handleAction(btn.action), disabled));
        });
      }
      toolbar.appendChild(groupEl);
    });

    const spacer = document.createElement('div');
    spacer.className = 'editor-toolbar-spacer';
    toolbar.appendChild(spacer);

    // Priority 5A — same pattern as pageControls above: find the buttons
    // this GROUPS entry already created, keep read-only references to
    // drive their disabled state from editor:historyChange.
    const editGroupEl = toolbar.querySelector('.editor-toolbar-group[data-group="edit"]');
    const undoBtn = editGroupEl ? Array.from(editGroupEl.querySelectorAll('button')).find((b) => b.title === 'Undo') : null;
    const redoBtn = editGroupEl ? Array.from(editGroupEl.querySelectorAll('button')).find((b) => b.title === 'Redo') : null;
    window.addEventListener('editor:historyChange', (e) => {
      if (undoBtn) undoBtn.disabled = !e.detail.canUndo;
      if (redoBtn) redoBtn.disabled = !e.detail.canRedo;
    });

    // Priority 5B — same reference-capture pattern as Undo/Redo above.
    const fileGroupEl = toolbar.querySelector('.editor-toolbar-group[data-group="file"]');
    const saveBtn = fileGroupEl ? Array.from(fileGroupEl.querySelectorAll('button')).find((b) => b.title === 'Save') : null;

    const docTitle = document.createElement('span');
    docTitle.className = 'editor-doc-title';
    docTitle.textContent = 'No document loaded';
    docTitle.dataset.docTitle = 'true';
    toolbar.appendChild(docTitle);

    window.addEventListener('editor:zoomChange', (e) => {
      toolbar.querySelectorAll('[data-zoom-value]').forEach((el) => { el.textContent = Math.round(e.detail.zoom * 100) + '%'; });
    });
    window.addEventListener('editor:documentLoaded', (e) => {
      docTitle.textContent = `${e.detail.fileName || 'Untitled'} (${e.detail.numPages} page${e.detail.numPages === 1 ? '' : 's'})`;
    });
    // Same event editor-statusbar.js already listens to for its "Page X of
    // Y" text — this just also drives the Page group's button/input state.
    window.addEventListener('editor:pageChange', (e) => {
      pageState.current = e.detail.page;
      pageState.total = e.detail.pageCount;
      const hasDoc = pageState.total > 0;
      if (saveBtn) saveBtn.disabled = !hasDoc; // Priority 5B — reuses this same event, no new tracker
      if (!pageControls) return;
      const { firstBtn, prevBtn, input, total, nextBtn, lastBtn } = pageControls;
      if (document.activeElement !== input) input.value = String(pageState.current);
      total.textContent = `/ ${pageState.total}`;
      input.disabled = !hasDoc;
      firstBtn.disabled = !hasDoc || pageState.current <= 1;
      prevBtn.disabled = !hasDoc || pageState.current <= 1;
      nextBtn.disabled = !hasDoc || pageState.current >= pageState.total;
      lastBtn.disabled = !hasDoc || pageState.current >= pageState.total;
    });

    function commitPageInput(input) {
      const n = Math.trunc(Number(input.value));
      if (Number.isFinite(n) && pageState.total > 0) {
        window.ViewportManager.scrollToPage(Math.min(pageState.total, Math.max(1, n)));
      } else {
        input.value = String(pageState.current); // invalid entry — revert, don't touch ViewportManager
      }
    }

    function iconButton(iconKey, title, onClick, disabled) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-icon';
      b.title = title;
      b.setAttribute('aria-label', title);
      if (disabled) b.disabled = true;
      b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false">${ICONS[iconKey] || ''}</svg>`;
      // Always attach the listener, even when starting disabled: a native
      // `disabled` button already blocks click events on its own, and the
      // Page group's buttons flip `disabled` off later (once a document is
      // mounted) without ever being re-created — they need the listener in
      // place from the start for that to work.
      b.addEventListener('click', onClick);
      return b;
    }

    function handleAction(action) {
      if (action === 'open') fileInput.click();
      if (action === 'toggle-sidebar') window.dispatchEvent(new CustomEvent('editor:requestPanelToggle', { detail: { panel: '.editor-sidebar' } }));
      if (action === 'toggle-inspector') window.dispatchEvent(new CustomEvent('editor:requestPanelToggle', { detail: { panel: '.editor-inspector' } }));
      if (action === 'toggle-grid') root.querySelector('.editor-canvas')?.classList.toggle('no-grid');
      if (action === 'text-tool' && window.EditorObjects) {
        revokePendingImageUrl(); // an image was picked but never placed — arming a different placement supersedes it
        window.EditorObjects.beginPlacement('text', {
          data: { text: 'Text', fontFamily: 'Arial', fontSize: 16, bold: false, italic: false, underline: false, color: '#000000', align: 'left' }
        });
      }
      if (action === 'image-tool') imageInput.click();
      if (action === 'rectangle-tool' && window.EditorObjects) {
        revokePendingImageUrl(); // an image was picked but never placed — arming a different placement supersedes it
        window.EditorObjects.beginPlacement('rectangle', { data: { fill: '#ffffff', stroke: '#000000', strokeWidth: 2, radius: 0 } });
      }
      if (action === 'ellipse-tool' && window.EditorObjects) {
        revokePendingImageUrl();
        window.EditorObjects.beginPlacement('ellipse', { data: { fill: '#ffffff', stroke: '#000000', strokeWidth: 2, radius: 0 } });
      }
      if (action === 'line-tool' && window.EditorObjects) {
        revokePendingImageUrl();
        window.EditorObjects.beginPlacement('line', { data: { fill: '#ffffff', stroke: '#000000', strokeWidth: 2, radius: 0 } });
      }
      if (action === 'draw-tool' && window.EditorObjects) {
        revokePendingImageUrl();
        window.EditorObjects.beginPlacement('draw', { data: { stroke: '#e8291b', strokeWidth: 2 } });
      }
      if (action === 'highlight-tool' && window.EditorObjects) {
        revokePendingImageUrl();
        window.EditorObjects.beginPlacement('highlight', { data: { fill: '#ffeb3b', opacity: 0.4 } });
      }
      if (action === 'whiteout-tool' && window.EditorObjects) {
        revokePendingImageUrl();
        window.EditorObjects.beginPlacement('whiteout', { data: { color: '#ffffff' } });
      }
      if (action === 'sign-tool') { revokePendingImageUrl(); openSignaturePad(); }
      if (action === 'undo' && window.EditorHistory) window.EditorHistory.undo();
      if (action === 'redo' && window.EditorHistory) window.EditorHistory.redo();
      if (action === 'export' && window.EditorExport) window.EditorExport.exportCurrentDocument();
    }
  }

  window.EditorToolbar = { init };
})();
