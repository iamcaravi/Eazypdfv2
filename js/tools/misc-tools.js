/* ================= TOOL IMPLEMENTATIONS ================= */
const TOOLS = {};

/* ---- ABOUT ---- */
TOOLS.about = function(){
  openPanel(`
    <div class="panel-head"><h3>About YOYOPDF</h3><div class="panel-head-actions"><button class="panel-close" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">YOYOPDF is a free, browser-based PDF toolkit — merge, split, compress, convert, sign, and more, all without installing anything or creating an account.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">Every tool runs entirely on your own device using client-side JavaScript. Your files are never uploaded to a server, which means they stay private and the tools keep working even if you lose your connection mid-task.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">Have a feature request or found a bug? Use the Contact link in the footer.</p>
    </div>`);
};

/* ---- EDIT ----------------------------------------------------------------
   Priority 3 (small milestone): mounts the existing editor shell — built
   and QA'd in editor-preview.html, files unchanged here — inside the live
   TOOLS.edit panel. Reuses, unmodified:
     js/editor/render-engine.js, render-queue.js, page-cache.js,
     zoom-manager.js, loading-manager.js, viewport-manager.js,
     thumbnail-engine.js, navigation-manager.js  (Rendering Engine,
       already integrated as of Priority 2)
     js/editor/editor-layout.js, editor-sidebar.js, editor-toolbar.js,
     editor-canvas.js, editor-inspector.js, editor-statusbar.js  (Shell —
       new to this milestone)
     css/editor-workspace.css, css/pdf-viewer.css  (Shell CSS — new to
       this milestone, loaded as-is)
   The shell markup below is copied verbatim from editor-preview.html's
   `.editor-shell` block (minus that file's own demo-only harness bar).
   The init sequence below is copied verbatim from editor-preview.html's
   own inline script. No shell module's logic is changed by any of this.

   The shell is built ONCE and kept alive in a detached holding element
   between opens (see editorHoldingArea / closePanel()) rather than
   rebuilt every time the panel opens — several shell modules register
   window-level listeners (NavigationManager's keydown handler,
   EditorLayout's resize handler) with no corresponding teardown, so
   re-running their init() on every open would silently stack duplicate
   listeners. Reusing the same instance keeps exactly one of each,
   satisfying "close/reopen works correctly" without touching those
   modules to add destroy() methods they don't currently have. */
let editorAssetsLoadPromise = null;
function loadEditorAssets(){
  if (editorAssetsLoadPromise) return editorAssetsLoadPromise;

  // ?v=2: same stale-cache issue js/app.js hit earlier (browsers keep
  // serving an old cached copy of an unversioned <link>/<script> src
  // indefinitely, even across page loads, once one visit has cached it) -
  // these editor stylesheets had no cache-busting param at all, so an
  // edit to any of them (like the --font-body fix below) would silently
  // never reach a browser that had already visited once.
  ["css/editor-workspace.css", "css/pdf-viewer.css", "css/editor-panel.css", "css/editor-inspector.css", "css/editor-viewer-polish.css", "css/editor-objects.css"].forEach(href=>{
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href + "?v=2";
    document.head.appendChild(l);
  });

  const files = [
    // Rendering Engine (Priority 2 — unchanged)
    "js/editor/render-engine.js",
    "js/editor/render-queue.js",
    "js/editor/page-cache.js",
    "js/editor/zoom-manager.js",
    "js/editor/loading-manager.js",
    "js/editor/viewport-manager.js",
    "js/editor/thumbnail-engine.js",
    "js/editor/navigation-manager.js",
    // Shell (this milestone)
    "js/editor/editor-layout.js",
    "js/editor/editor-sidebar.js",
    "js/editor/editor-toolbar.js",
    "js/editor/editor-canvas.js",
    "js/editor/editor-inspector.js",
    "js/editor/editor-statusbar.js",
    // Editing engine (Phase 3 — previously referenced everywhere by name
    // but never actually written; see editor-objects.js's own file header)
    "js/editor/editor-objects.js",
    "js/editor/editor-history.js",
    "js/editor/editor-export.js",
  ];
  editorAssetsLoadPromise = files.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  })), Promise.resolve());
  return editorAssetsLoadPromise;
}

/* Builds the shell markup once — identical structure to editor-preview.html's
   `.editor-shell`, so every editor-*.js selector (`.editor-toolbar`,
   `.editor-sidebar`, `.editor-canvas`, `.editor-inspector`, `.editor-statusbar`,
   the two resize handles, the scrim) finds exactly what it already expects. */
function buildEditorShell(){
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="editor-shell" data-state="empty">
      <div class="editor-toolbar" role="toolbar" aria-label="Editor toolbar"></div>
      <div class="editor-body">
        <aside class="editor-sidebar" aria-label="Page thumbnails">
          <div class="editor-sidebar-head">
            <span class="editor-sidebar-head-title">Pages (<span data-page-count>0</span>)</span>
            <button type="button" class="btn-icon" data-collapse-target=".editor-sidebar" aria-label="Collapse page panel">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <div class="editor-thumb-list" role="list" aria-label="Page thumbnail list"></div>
          <div class="editor-thumb-rail" aria-hidden="true"></div>
        </aside>
        <div class="editor-resize-handle" data-resize="sidebar"></div>
        <!-- Phase 12: was <main> - this app already has exactly one page-
             level main landmark (index.html's own #main-content, present
             on every route including this one, since edit-pdf.html is
             generated from that same template). A second <main> here made
             every route with the editor open fail axe's landmark-no-
             duplicate-main check. This region is still identified via its
             own aria-label; only the redundant landmark role changes. -->
        <div class="editor-canvas" data-state="empty" role="region" aria-label="Document canvas">
          <div class="editor-canvas-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5" stroke-linejoin="round"/></svg>
            <div>No document open yet.<br>Use File → Open PDF above.</div>
            <div class="editor-canvas-empty-error" data-canvas-empty-error role="alert" hidden></div>
          </div>
          <div class="editor-canvas-loading">
            <span class="spinner" aria-hidden="true"></span>
            <div>Loading document…</div>
          </div>
          <div class="editor-canvas-page" role="img" aria-label="Placeholder document page"></div>
        </div>
        <div class="editor-resize-handle" data-resize="inspector"></div>
        <aside class="editor-inspector" aria-label="Inspector"></aside>
        <div class="editor-scrim"></div>
      </div>
      <div class="editor-statusbar" role="status" aria-label="Document status">
        <span class="editor-statusbar-item" data-status="zoom">Zoom: 100%</span>
        <span class="editor-statusbar-item" data-status="page">No document</span>
        <span class="editor-statusbar-item" data-status="size" data-optional="true">No document</span>
        <span class="editor-statusbar-item" data-status="selection" data-optional="true">No selection</span>
        <span class="editor-statusbar-spacer"></span>
        <span class="editor-statusbar-item editor-statusbar-ready"><span class="editor-statusbar-dot" aria-hidden="true"></span>Ready</span>
      </div>
    </div>`;
  return wrap.firstElementChild;
}

/* Same init sequence as editor-preview.html's own harness script — every
   call below is that file's, unchanged; only the DOM root differs. */
function initEditorShell(shell){
  const canvasEl = shell.querySelector('.editor-canvas');

  ZoomManager.init(
    () => { const r = canvasEl.getBoundingClientRect(); return { width: r.width, height: r.height }; },
    () => window.__currentPageNativeSize || { width: 612, height: 792 }
  );
  ViewportManager.init(shell);
  LoadingManager.init(shell);
  // EditorObjects before NavigationManager: both register a `window`
  // keydown listener for Escape, and listeners on the same target fire
  // in registration order. EditorObjects needs to see Escape first so it
  // can stopPropagation() when it cancels a pending object placement -
  // otherwise NavigationManager's own (correct, by design) "Escape closes
  // the whole workspace" handler fires first and closes the editor out
  // from under an in-progress placement instead of just canceling it.
  EditorObjects.init(shell);
  NavigationManager.init(shell, { getPageCount: () => window.RenderEngine.getNumPages() });

  EditorToolbar.init(shell);
  EditorInspector.init(shell);
  EditorCanvas.init(shell);
  EditorStatusbar.init(shell);
  EditorLayout.init(shell);
  EditorHistory.init();
  EditorExport.init();

  window.addEventListener('editor:pageChange', async (e) => {
    try { window.__currentPageNativeSize = await window.RenderEngine.getPageInfo(e.detail.page); } catch (_) {}
  });

  // Not part of the reused shell modules — this milestone's own, minimal
  // addition, since the shell is normally hosted full-page with no host
  // chrome around it and has no close action of its own here. The YOYOPDF
  // logo in the header is the only "go home" affordance across the whole
  // app now, so this only needs its own close action, not a second home
  // button.
  const toolbar = shell.querySelector('.editor-toolbar');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'editor-toolbar-close';
  closeBtn.setAttribute('aria-label', 'Close editor');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', ()=>closePanel());
  toolbar.appendChild(closeBtn);

  // Priority 3G: navigation-manager.js dispatches this on Escape (when no
  // mobile sidebar/inspector overlay is open) — same event-bus pattern as
  // 'editor:requestPanelToggle' already used elsewhere in this shell.
  // initEditorShell() only runs once (see the `!window.__editorShellEl`
  // guard in TOOLS.edit below), so this listener is registered exactly
  // once too — never stacks a duplicate on subsequent opens.
  window.addEventListener('editor:requestClose', closePanel);
}

TOOLS.edit = function(){
  openPanel(`<div class="panel-body" id="editWorkspaceMount"></div>`);
  panel.classList.add("panel-fullscreen");
  overlay.classList.add("panel-fullscreen");

  const mount = document.getElementById("editWorkspaceMount");
  mount.innerHTML = `<p style="margin:0;padding:20px;color:var(--ink-soft);font-size:.9rem">Loading editor…</p>`;

  loadEditorAssets()
    .then(()=>{
      mount.innerHTML = "";
      if (!window.__editorShellEl){
        window.__editorShellEl = buildEditorShell();
        mount.appendChild(window.__editorShellEl);
        initEditorShell(window.__editorShellEl);
      } else {
        mount.appendChild(window.__editorShellEl);
      }
      // No second upload: reuse whatever file AppSession already holds (e.g. from
      // the Hero quick-start) through the editor's own existing loader API.
      if(AppSession.currentFile && window.EditorCanvas && typeof window.EditorCanvas.loadFile === "function"){
        window.EditorCanvas.loadFile(AppSession.currentFile);
      }
    })
    .catch(err=>{
      // escapeAttr() before innerHTML, same as every other e.message ->
      // innerHTML site in the app - this one was the sole exception.
      const msg = (err && err.message) ? err.message : String(err);
      mount.innerHTML = `<p style="margin:0;padding:20px;color:var(--ink-soft);font-size:.9rem">Could not load the editor: ${escapeAttr(msg)}</p>`;
    });
};

/* ---- DONATE ---- */
TOOLS.donate = function(){
  const qrSrc = document.querySelector(".donate-qr-wrap img")?.getAttribute("src") || "";
  openPanel(`
    <div class="panel-head"><h3>❤️ Support YOYOPDF</h3><div class="panel-head-actions"><button class="panel-close" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body donate-modal-body">
      <p class="donate-modal-desc">YOYOPDF runs completely in your browser and all tools are free. If it saves you time, consider supporting development with a small UPI donation.</p>
      <div class="donate-modal-card">
        <div class="donate-modal-qr-wrap">
          <img src="${qrSrc}" alt="Donate QR code" class="donate-modal-qr">
        </div>
        <div class="upi-logos">
          <span class="upi-badge"><span class="dot" style="background:#4285F4"></span>Google Pay</span>
          <span class="upi-badge"><span class="dot" style="background:#5F259F"></span>PhonePe</span>
          <span class="upi-badge"><span class="dot" style="background:#00BAF2"></span>Paytm</span>
          <span class="upi-badge"><span class="dot" style="background:var(--brand-grad)"></span>BHIM UPI</span>
        </div>
        <p class="upi-caption">Scan with any UPI app</p>
      </div>
    </div>`);
};

/* ---- DOCS ---- */
TOOLS.docs = function(){
  openPanel(`
    <div class="panel-head"><h3>Docs</h3><div class="panel-head-actions"><button class="panel-close" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6"><strong style="color:var(--ink)">How YOYOPDF works.</strong> Pick a tool from the header, the left-side dock, or the tools grid on the homepage. Drop in a file (or click to browse), adjust that tool's options if it has any, then download the result — every step runs locally in your browser, so nothing is ever uploaded.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">Page-based tools (Reorder, Delete, Extract, Add Blank Page, Organize) show every page as a thumbnail: click to select, drag to reorder, or use the small rotate/delete controls on a thumbnail directly. A page-range field (e.g. <code>1,3,5-8</code>) is also available wherever you need to select many pages at once.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">Nothing here requires an account or a subscription. If a tool doesn't behave the way you expect, the <button type="button" class="link-btn" data-open="contact" style="background:none;border:none;padding:0;color:var(--red);cursor:pointer;font:inherit;text-decoration:underline">Contact</button> page reaches us directly.</p>
    </div>`);
};

/* ---- PRIVACY ---- */
TOOLS.privacy = function(){
  openPanel(`
    <div class="panel-head"><h3>Privacy Policy</h3><div class="panel-head-actions"><button class="panel-close" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6"><strong style="color:var(--ink)">Your files never leave your device.</strong> Every PDF and image tool on YOYOPDF runs in your browser using JavaScript — nothing is uploaded, stored, or transmitted to any server.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">We don't use tracking cookies or sell personal data. The trust badges shown on this site describe how the tools actually work — none of them are counters or visitor trackers. If you use the Contact form, the information you type is sent directly to our email via your own mail client — we don't store it elsewhere.</p>
    </div>`);
};

/* ---- TERMS ---- */
TOOLS.terms = function(){
  openPanel(`
    <div class="panel-head"><h3>Terms of Use</h3><div class="panel-head-actions"><button class="panel-close" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">YOYOPDF is provided free of charge, "as is," with no warranty of any kind. While every tool is tested, you're responsible for keeping backups of important files before processing them.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">You may use YOYOPDF for personal or commercial work. Please don't attempt to disrupt the service, scrape it at scale, or use it for unlawful purposes.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">These terms may be updated occasionally as new tools are added. Continued use of the site after changes means you accept the updated terms.</p>
    </div>`);
};

/* ---- CONTACT US ---- */
TOOLS.contact = function(){
  openPanel(`
    <div class="panel-head"><h3>Contact Us</h3><div class="panel-head-actions"><button class="panel-close" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.88rem">Got a question, bug report, or idea for a new tool? Send it over — this opens your email app with everything filled in, addressed straight to us.</p>
      <div class="row">
        <div class="field"><label for="cFirst">First name</label><input type="text" id="cFirst"></div>
        <div class="field"><label for="cLast">Last name</label><input type="text" id="cLast"></div>
      </div>
      <div class="field"><label for="cEmail">Your email</label><input type="text" id="cEmail" placeholder="you@example.com"></div>
      <div class="field"><label for="cMessage">Message</label><textarea id="cMessage" placeholder="How can we help?"></textarea></div>
      <button class="btn" id="go">Send Message</button>
      <div id="out"></div>
    </div>`);
  document.getElementById("go").addEventListener("click", ()=>{
    const first = document.getElementById("cFirst").value.trim();
    const last = document.getElementById("cLast").value.trim();
    const email = document.getElementById("cEmail").value.trim();
    const message = document.getElementById("cMessage").value.trim();
    if(!message){ toast("Please write a message first"); return; }
    const subject = encodeURIComponent(`YOYOPDF contact form — ${first} ${last}`.trim());
    const body = encodeURIComponent(`Name: ${first} ${last}\nEmail: ${email}\n\n${message}`);
    window.location.href = `mailto:ca.ravimishra5@gmail.com?subject=${subject}&body=${body}`;
    const out = document.getElementById("out");
    out.innerHTML = `<div class="status">Your email app should now open with this message ready to send. If nothing opened, you can email us directly at <strong>ca.ravimishra5@gmail.com</strong>.</div>`;
  });
};
