/* ---- HEADER & FOOTER ---- */
// headerFooterAnchor() moved to js/core/pdf-canvas-widgets.js (Phase 12):
// TOOLS.pagenumbers (pdf-page-tools-1.js, "page1" runtime profile) also
// calls it for its own preview/export anchor math, but "page1" never loads
// this file ("page2") - clicking Add Page Numbers threw a real, silent
// `ReferenceError: headerFooterAnchor is not defined` (caught by
// withToolOperation, logged to the console, but the button just stayed
// stuck on "Numbering pages..." forever with no visible error - found via
// the new page-operations.spec.js coverage this phase added). Both
// "page1" and "page2" already load pdf-canvas-widgets.js, so that's where
// this now lives - same fix shape as Phase 11's statusEl()/setStatus()/
// resultBox() move to pdf-processing-utils.js for the equivalent
// image-tools.js/"image"-profile gap.
TOOLS.headerfooter = function(){
  let file=null, pdoc=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Header & Footer</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="headerfooterBody">
      <div class="tool-hero" id="hfHero">
        <h2 class="tool-hero-title">Add Header & Footer</h2>
        <p class="tool-hero-desc">Add repeating text to the top and/or bottom of every page - see it before you download.</p>
      </div>
      <div class="tool-upload-wrap" id="hfUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="hfPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="hfWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="hfStage">
            <canvas id="hfCanvas"></canvas>
          </div>
          <div class="mono" id="hfReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;">Preview of page 1 - every page gets the same header/footer.</div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Header & Footer</h3>
          <div id="hfFileSlot"></div>
          <div class="field"><label for="htext">Header text (optional)</label><input type="text" id="htext"></div>
          <div class="field"><label for="halign">Header alignment</label>
            <select id="halign"><option value="left" selected>Left</option><option value="center">Center</option><option value="right">Right</option></select>
          </div>
          <div class="field"><label for="ftext">Footer text (optional)</label><input type="text" id="ftext"></div>
          <div class="field"><label for="falign">Footer alignment</label>
            <select id="falign"><option value="left" selected>Left</option><option value="center">Center</option><option value="right">Right</option></select>
          </div>
          <div class="field"><label for="hfsize">Font size</label><input type="number" id="hfsize" value="9" min="6" max="24"></div>
          <div class="field"><label for="hfpages">Pages (optional)</label><input type="text" id="hfpages" placeholder="e.g. 1,3-5 - leave blank for all pages"></div>
          <div class="split-error" id="hfError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">Add Header & Footer</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("hfHero");
  const uploadWrap = document.getElementById("hfUploadWrap");
  const privacyHint = document.getElementById("hfPrivacyHint");
  const workspace = document.getElementById("hfWorkspace");
  const fileSlot = document.getElementById("hfFileSlot");
  const body = document.getElementById("headerfooterBody");
  const canvas = document.getElementById("hfCanvas");
  const readout = document.getElementById("hfReadout");
  const errorBox = document.getElementById("hfError");
  const goBtn = document.getElementById("go");
  let dispScale = 1, pageBgImageData = null, page1Size = {width:612,height:792};
  const MARGIN_X = 30, HEADER_Y_FROM_TOP = 25, FOOTER_Y = 15;

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function currentSettings(){
    return {
      headerText: document.getElementById("htext").value,
      footerText: document.getElementById("ftext").value,
      headerAlign: document.getElementById("halign").value,
      footerAlign: document.getElementById("falign").value,
      fontSize: Math.max(6, parseInt(document.getElementById("hfsize").value) || 9),
    };
  }
  function validate(){
    if(!file){ goBtn.disabled = true; return; }
    const pagesRaw = document.getElementById("hfpages").value.trim();
    if(pagesRaw && pdoc && !parsePageList(pagesRaw, pdoc.numPages)){
      showError(`Enter page numbers between 1 and ${pdoc.numPages}, e.g. 1,3-5.`);
      goBtn.disabled = true;
      return;
    }
    showError(null);
    goBtn.disabled = false;
  }
  function redrawPreview(){
    if(!pageBgImageData) return;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(pageBgImageData, 0, 0);
    const {headerText, footerText, headerAlign, footerAlign, fontSize} = currentSettings();
    const scaledSize = fontSize * dispScale;
    ctx.font = `${scaledSize}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = "rgb(77,77,77)";
    ctx.textBaseline = "alphabetic";
    // pdf-lib's drawText y is the text BASELINE directly, in PDF points
    // (origin bottom-left, y-up) - export draws the header baseline at
    // height-HEADER_Y_FROM_TOP and the footer baseline at FOOTER_Y. To
    // place the SAME baseline on this top-down canvas: canvasY = (pageHeight
    // - pdfBaselineY) * dispScale. For the header that simplifies to
    // HEADER_Y_FROM_TOP*dispScale; for the footer, to canvas.height -
    // FOOTER_Y*dispScale. No extra offset belongs here - the PDF y IS the
    // baseline already, unlike a CSS/canvas top-aligned box.
    const h = winAnsiSafe(headerText);
    if(h.trim()){
      const tw = ctx.measureText(h).width / dispScale;
      const x = headerFooterAnchor(headerAlign, page1Size.width, tw, MARGIN_X) * dispScale;
      const y = HEADER_Y_FROM_TOP * dispScale;
      ctx.fillText(h, x, y);
    }
    const f = winAnsiSafe(footerText);
    if(f.trim()){
      const tw = ctx.measureText(f).width / dispScale;
      const x = headerFooterAnchor(footerAlign, page1Size.width, tw, MARGIN_X) * dispScale;
      const y = canvas.height - FOOTER_Y * dispScale;
      ctx.fillText(f, x, y);
    }
  }
  ["htext","ftext","halign","falign","hfsize"].forEach(id=>{
    document.getElementById(id).addEventListener("input", redrawPreview);
  });
  document.getElementById("hfpages").addEventListener("input", validate);

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; pdoc=null; pageBgImageData=null;
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    validate();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    const loadedPdoc = await loadPdfJsSafe({data:bytes.slice(0)});
    if(myToken !== loadToken) return;
    pdoc = loadedPdoc;
    const page1 = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    page1Size = {width:vp1.width, height:vp1.height};
    const maxW = 700;
    dispScale = Math.min(1, maxW/vp1.width);
    showWorkspace();
    try{
      const rendered = await renderPdfPageCanvas(pdoc, 1, dispScale);
      if(myToken !== loadToken) return;
      canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext("2d").drawImage(rendered, 0, 0);
      pageBgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
      redrawPreview();
    }catch(e){
      readout.textContent = "Couldn't render a preview, but the header/footer will still apply correctly on download.";
    }
    validate();
  });

  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const {headerText, footerText, headerAlign, footerAlign, fontSize} = currentSettings();
    const h = winAnsiSafe(headerText);
    const f = winAnsiSafe(footerText);
    const pagesRaw = document.getElementById("hfpages").value.trim();
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, doc.getPageCount()) : null;
    setStatus("Applying header & footer...");
    doc.getPages().forEach((p,i)=>{
      if(targetIndices && !targetIndices.includes(i)) return;
      const {width, height} = p.getSize();
      if(h.trim()){
        const tw = font.widthOfTextAtSize(h, fontSize);
        p.drawText(h, {x:headerFooterAnchor(headerAlign, width, tw, MARGIN_X), y:height-HEADER_Y_FROM_TOP, size:fontSize, font, color:rgb(0.3,0.3,0.3)});
      }
      if(f.trim()){
        const tw = font.widthOfTextAtSize(f, fontSize);
        p.drawText(f, {x:headerFooterAnchor(footerAlign, width, tw, MARGIN_X), y:FOOTER_Y, size:fontSize, font, color:rgb(0.3,0.3,0.3)});
      }
    });
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "header_footer", "pdf");
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  }));
};

/* ---- CROP PDF ----
   iLovePDF-style workflow: every page renders in one compact, vertically
   scrolling document viewport (not just page 1), the user draws the
   crop box directly with a single click-drag-release (no pre-existing
   handles to fight with first), and the right-hand controls panel never
   moves. See docs/none - design brief lived in chat only.

   Coordinate system: the crop rectangle is stored as page-relative
   FRACTIONS (x0/y0/x1/y1, each 0..1, origin top-left) rather than CSS or
   canvas pixels. Every .crop-page wrapper's on-screen box IS the page at
   whatever zoom/DPR happens to be active (width set in JS, height
   follows via CSS aspect-ratio from the page's real point dimensions),
   so a fraction of that box's own getBoundingClientRect() is already
   resolution- and zoom-independent - no separate canvas-pixel/zoom/DPR
   conversion step is needed the way raw canvas coordinates would require.
   At crop time those fractions are multiplied by each target page's own
   width/height in points (from pdf-lib) and flipped for the PDF's
   bottom-left origin, matching pdf-lib's setCropBox(). Applying the same
   fractions to every page (not the same absolute point margins, as the
   old single-canvas version did) is also what makes "All pages" behave
   correctly on documents that mix page sizes, with no special-case
   warning needed. */
TOOLS.crop = function(){
  let file=null, fileBytesCache=null, loadToken=0;
  let numPages=0;
  let pagesMeta=[]; // {index, widthPt, heightPt, wrapEl, canvasEl, layerEl, rectEl, rendered, rendering}
  let normRect=null; // {x0,y0,x1,y1} 0..1, or null = no crop drawn yet (full page)
  let activePageIndex=0;   // which page currently hosts the interactive rect
  let currentPageIndex=0;  // which page is most in view (drives indicator + "Current page" scope)
  let zoom=1;
  let docObserver=null;
  let fallbackScanHandler=null;
  let activePdoc=null; // the pdf.js document currently backing pagesMeta - see resetDocState()
  const MIN_SIZE=0.02;

  openPanel(`
    <div class="panel-head"><h3>Crop PDF</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="cropBody">
      <div class="tool-hero" id="cropHero">
        <h2 class="tool-hero-title">Crop PDF</h2>
        <p class="tool-hero-desc">Scroll through every page, then click and drag to draw the area you want to keep.</p>
      </div>
      <div class="tool-upload-wrap" id="cropUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="cropPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace crop-app-workspace" id="cropWorkspace" style="display:none">
        <div class="tool-main-pane crop-main-pane">
          <div class="crop-zoom">
            <button type="button" class="crop-zoom-btn" id="cropZoomOut" aria-label="Zoom out">−</button>
            <span class="crop-zoom-level" id="cropZoomLevel">100%</span>
            <button type="button" class="crop-zoom-btn" id="cropZoomIn" aria-label="Zoom in">+</button>
          </div>
          <div class="crop-document-viewport" id="cropDocViewport">
            <div class="crop-document" id="cropDocument"></div>
          </div>
          <div class="crop-page-indicator" id="cropPageIndicator">Page 1 / 1</div>
        </div>
        <aside class="tool-side-panel crop-side-panel">
          <h3 class="tool-side-panel-title">Crop PDF</h3>
          <div id="cropFileSlot"></div>
          <div class="crop-instruction-card">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>
            <div>
              <strong>Click and drag to select the area you want to keep.</strong>
              <p>Resize the selection with its corner/edge handles, or drag inside it to move it.</p>
            </div>
          </div>
          <div class="crop-scope">
            <span class="tool-side-panel-section-label">Pages</span>
            <label class="crop-scope-option"><input type="radio" name="cropScope" value="all" checked> All pages</label>
            <label class="crop-scope-option"><input type="radio" name="cropScope" value="current"> Current page</label>
          </div>
          <div class="split-error" id="cropError" hidden></div>
          <div class="crop-side-actions">
            <button class="btn secondary" id="resetCrop" type="button">Reset Selection</button>
            <button class="btn tool-toolbar-primary" id="go" disabled>Crop PDF →</button>
          </div>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("cropHero");
  const uploadWrap = document.getElementById("cropUploadWrap");
  const privacyHint = document.getElementById("cropPrivacyHint");
  const workspace = document.getElementById("cropWorkspace");
  const fileSlot = document.getElementById("cropFileSlot");
  const body = document.getElementById("cropBody");
  const errorBox = document.getElementById("cropError");
  const goBtn = document.getElementById("go");
  const resetBtn = document.getElementById("resetCrop");
  const docViewport = document.getElementById("cropDocViewport");
  const docEl = document.getElementById("cropDocument");
  const pageIndicator = document.getElementById("cropPageIndicator");
  const zoomInBtn = document.getElementById("cropZoomIn");
  const zoomOutBtn = document.getElementById("cropZoomOut");
  const zoomLevelEl = document.getElementById("cropZoomLevel");

  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function updateGoState(){ goBtn.disabled = !file; }

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
    motionEnter([document.querySelector(".crop-side-panel")], {fromY:10, duration:MOTION.fast});
  }

  // Clears the rendered page list/observer/selection - used both when
  // starting a fresh build (old pages torn down first) and when the file
  // itself is removed. Deliberately does NOT touch fileBytesCache: the
  // in-progress build path sets that just before calling buildDocument(),
  // and buildDocument() calls this same function on the way in.
  function resetDocState(){
    if(docObserver){ docObserver.disconnect(); docObserver=null; }
    if(fallbackScanHandler){ docViewport.removeEventListener("scroll", fallbackScanHandler); fallbackScanHandler=null; }
    // Releases the previous document's worker-side pdf.js resources (page
    // caches, decoded image data) immediately rather than waiting on GC to
    // notice the proxy is unreachable - same pattern Sign PDF already uses
    // for its own pdoc. Was previously missing here: every re-upload (or
    // remove) left the prior document's pdf.js-worker-side state alive for
    // the rest of the tab's life.
    if(activePdoc){ try{ activePdoc.destroy(); }catch(e){} activePdoc=null; }
    pagesMeta=[]; normRect=null; activePageIndex=0; currentPageIndex=0; numPages=0;
    docEl.innerHTML="";
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard - this one has an even longer async
    // chain (getDocument -> per-page metadata -> lazy renders), so the
    // window for a second upload to land mid-flight is larger, not smaller.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null;
      fileBytesCache=null;
      resetDocState();
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    showError(null);
    updateGoState();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    fileBytesCache = bytes;
    const qp = document.getElementById("quickPreview"); if(qp) qp.innerHTML = "";
    let pdoc;
    try{
      pdoc = await loadPdfJsSafe({data:bytes.slice(0)});
    }catch(e){
      if(myToken !== loadToken) return;
      showWorkspace();
      showError("Could not read this PDF. Try a different file.");
      return;
    }
    if(myToken !== loadToken) return;
    numPages = pdoc.numPages;
    // Workspace must already be laid out (display:flex, real box sizes)
    // before buildDocument() creates the IntersectionObserver below -
    // observing targets that are still inside a display:none subtree
    // means the observer's root never has a size, and pages then never
    // get marked as intersecting even after the subtree becomes visible.
    showWorkspace();
    try{
      await buildDocument(pdoc, myToken);
    }catch(e){
      if(myToken !== loadToken) return;
      showError("Could not render this PDF's pages. Try a different file.");
    }
    if(myToken !== loadToken) return;
    updateGoState();
  });

  /** Lays out every page up front (cheap metadata-only pass - no pixels
   * rendered yet) so the full document exists in the scroll flow
   * immediately, then wires lazy bitmap rendering + the "current page"
   * tracker off one shared IntersectionObserver. */
  async function buildDocument(pdoc, myToken){
    resetDocState(); // destroys whatever the PREVIOUS activePdoc was, if any
    activePdoc = pdoc;
    numPages = pdoc.numPages;
    for(let i=1; i<=numPages; i++){
      const page = await pdoc.getPage(i);
      if(myToken !== loadToken) return;
      const vp = page.getViewport({scale:1});
      const wrap = document.createElement("div");
      wrap.className = "crop-page";
      wrap.dataset.pageIndex = String(i-1);
      wrap.style.aspectRatio = `${vp.width} / ${vp.height}`;
      wrap.innerHTML = `
        <canvas class="crop-page-canvas"></canvas>
        <div class="crop-page-loading">Loading page ${i}…</div>
        <div class="crop-select-layer"></div>
        <div class="crop-page-num">${i} / ${numPages}</div>`;
      const meta = {
        index:i-1, widthPt:vp.width, heightPt:vp.height,
        wrapEl:wrap, canvasEl:wrap.querySelector(".crop-page-canvas"),
        layerEl:wrap.querySelector(".crop-select-layer"),
        rectEl:null, rendered:false, rendering:false
      };
      docEl.appendChild(wrap);
      pagesMeta.push(meta);
      wireCropPageLayer(meta);
    }
    applyZoomWidth();
    updatePageIndicator();

    docObserver = new IntersectionObserver((entries)=>{
      let bestIdx = currentPageIndex, bestRatio = 0;
      entries.forEach(entry=>{
        const idx = Number(entry.target.dataset.pageIndex);
        if(entry.isIntersecting){
          renderPageIfNeeded(pdoc, pagesMeta[idx], myToken);
          if(entry.intersectionRatio > bestRatio){ bestRatio = entry.intersectionRatio; bestIdx = idx; }
        }
      });
      if(bestRatio > 0 && bestIdx !== currentPageIndex){
        currentPageIndex = bestIdx;
        updatePageIndicator();
      }
    }, {root:docViewport, rootMargin:"600px 0px", threshold:[0,0.15,0.3,0.5,0.75,1]});
    pagesMeta.forEach(m=>docObserver.observe(m.wrapEl));

    // Geometry-based fallback alongside the observer above (not instead
    // of it): IntersectionObserver callbacks are tied to the browser
    // actually producing compositor frames, which some embedded/headless
    // hosts suspend for an offscreen/inactive view (confirmed here -
    // requestAnimationFrame itself never fires in that state either) -
    // without this, pages could sit permanently unrendered there even
    // though every rect is correct. setTimeout-throttled rather than
    // rAF-throttled for that same reason - it still keeps a fast scroll
    // to ~1 scan per 100ms instead of one per scroll event, but doesn't
    // depend on a compositor frame ever being produced to fire at all.
    let fallbackQueued = false;
    function fallbackScan(){
      fallbackQueued = false;
      if(myToken !== loadToken) return;
      const vRect = docViewport.getBoundingClientRect();
      let bestIdx = currentPageIndex, bestOverlap = 0;
      pagesMeta.forEach(m=>{
        const r = m.wrapEl.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(r.bottom, vRect.bottom) - Math.max(r.top, vRect.top));
        if(overlap > 0 && r.top < vRect.bottom + 900 && r.bottom > vRect.top - 900){
          renderPageIfNeeded(pdoc, m, myToken);
        }
        if(overlap > bestOverlap){ bestOverlap = overlap; bestIdx = m.index; }
      });
      if(bestOverlap > 0 && bestIdx !== currentPageIndex){
        currentPageIndex = bestIdx;
        updatePageIndicator();
      }
    }
    function queueFallbackScan(){
      if(fallbackQueued) return;
      fallbackQueued = true;
      setTimeout(fallbackScan, 100);
    }
    fallbackScanHandler = queueFallbackScan;
    docViewport.addEventListener("scroll", fallbackScanHandler, {passive:true});
    queueFallbackScan();
  }

  async function renderPageIfNeeded(pdoc, meta, myToken){
    if(!meta || meta.rendered || meta.rendering) return;
    meta.rendering = true;
    try{
      // Fixed bitmap width baseline (not tied to the current CSS zoom
      // level) - stays sharp from 60% to 160% zoom without a re-render
      // per zoom step, since zoom only ever changes the page's CSS width.
      const targetW = 900;
      const scale = targetW / meta.widthPt;
      const rendered = await renderPdfPageCanvas(pdoc, meta.index+1, scale);
      if(myToken !== loadToken || !meta.canvasEl.isConnected) return;
      meta.canvasEl.width = rendered.width; meta.canvasEl.height = rendered.height;
      meta.canvasEl.getContext("2d").drawImage(rendered, 0, 0);
      meta.rendered = true;
      meta.wrapEl.classList.add("crop-page-rendered","crop-page-visible");
    }catch(e){
      if(myToken !== loadToken) return;
      const loading = meta.wrapEl.querySelector(".crop-page-loading");
      if(loading) loading.textContent = "Couldn't render this page.";
    }finally{
      meta.rendering = false;
    }
  }

  // Fits the page to the actual workspace on BOTH axes, not just width -
  // a portrait page capped only by width (e.g. a flat 640px) can still be
  // taller than the whole viewport, forcing a scroll just to see page 1.
  // Sizing off page 1's own aspect ratio (like the old single-canvas
  // version did for its dispScale) so a comfortable amount of it - not
  // literally 100% of it - fits in view, hinting there's more to scroll
  // to rather than either cramming or overflowing.
  function applyZoomWidth(){
    if(!pagesMeta.length) return;
    const containerW = docViewport.clientWidth - 32;
    const containerH = docViewport.clientHeight - 44;
    const aspect = pagesMeta[0].widthPt / pagesMeta[0].heightPt; // width/height
    const widthFromWidth = containerW || 640;
    const widthFromHeight = (containerH>0 ? containerH : 620) * 0.82 * aspect;
    const base = Math.max(320, Math.min(680, widthFromWidth, widthFromHeight));
    const w = Math.round(base*zoom);
    pagesMeta.forEach(m=>{ m.wrapEl.style.maxWidth = w+"px"; });
  }
  function updateZoomLabel(){ zoomLevelEl.textContent = Math.round(zoom*100)+"%"; }
  zoomInBtn.addEventListener("click", ()=>{ zoom=Math.min(1.6, +(zoom+0.1).toFixed(2)); applyZoomWidth(); updateZoomLabel(); });
  zoomOutBtn.addEventListener("click", ()=>{ zoom=Math.max(0.6, +(zoom-0.1).toFixed(2)); applyZoomWidth(); updateZoomLabel(); });
  // Self-removes on the first post-close resize, same leak/no-cleanup-hook
  // reasoning as cropKeyHandler() below - window-level listeners aren't
  // detached by panel.innerHTML replacement the way DOM-node listeners are.
  // rAF-coalesced: a window drag-resize can fire this many times per
  // frame, and applyZoomWidth() writes a style per page in pagesMeta -
  // on a long document that's a lot of redundant style writes per frame
  // without this, all collapsing to at most one actual layout pass per
  // frame with it.
  let resizeRaf = null;
  function resizeHandler(){
    if(!workspace.isConnected){
      window.removeEventListener("resize", resizeHandler);
      if(resizeRaf) cancelAnimationFrame(resizeRaf);
      return;
    }
    if(resizeRaf) return;
    resizeRaf = requestAnimationFrame(()=>{
      resizeRaf = null;
      if(workspace.style.display!=="none") applyZoomWidth();
    });
  }
  window.addEventListener("resize", resizeHandler);

  function updatePageIndicator(){ pageIndicator.textContent = `Page ${currentPageIndex+1} / ${Math.max(numPages,1)}`; }

  function localPos(meta, clientX, clientY){
    const r = meta.wrapEl.getBoundingClientRect();
    const x = (clientX-r.left)/r.width, y = (clientY-r.top)/r.height;
    return {x:Math.max(0,Math.min(1,x)), y:Math.max(0,Math.min(1,y))};
  }
  function ensureRectEl(meta){
    if(meta.rectEl) return meta.rectEl;
    const el = document.createElement("div");
    el.className = "crop-rect"; el.hidden = true;
    ["nw","n","ne","e","se","s","sw","w"].forEach(h=>{
      const hd = document.createElement("div");
      hd.className = "crop-handle "+h; hd.dataset.handle = h;
      el.appendChild(hd);
    });
    meta.wrapEl.appendChild(el);
    meta.rectEl = el;
    return el;
  }
  function setActivePage(idx){
    pagesMeta.forEach((m,i)=>{
      if(m.rectEl && i!==idx) m.rectEl.hidden = true;
      m.wrapEl.classList.toggle("crop-page-active", i===idx);
    });
    activePageIndex = idx;
  }
  function redrawRect(animate){
    if(!normRect){
      pagesMeta.forEach(m=>{ if(m.rectEl) m.rectEl.hidden = true; });
      updateGoState();
      return;
    }
    const meta = pagesMeta[activePageIndex];
    if(!meta) return;
    const el = ensureRectEl(meta);
    el.hidden = false;
    el.style.left = (normRect.x0*100)+"%";
    el.style.top = (normRect.y0*100)+"%";
    el.style.width = ((normRect.x1-normRect.x0)*100)+"%";
    el.style.height = ((normRect.y1-normRect.y0)*100)+"%";
    if(animate && window.gsap && !MOTION.reduced){
      gsap.fromTo(el, {opacity:0, scale:0.98}, {opacity:1, scale:1, duration:MOTION.fast, ease:MOTION.ease.enter, overwrite:"auto"});
      // Same stuck-invisible-forever safety net motionEnter() uses above:
      // GSAP's tween only advances on its own rAF-driven ticker, so a
      // tab/embedded view that never gets a compositor frame (backgrounded,
      // some embedded hosts) would otherwise leave this rect permanently
      // at the tween's opacity:0 starting point. Clearing the inline
      // styles GSAP set falls back to the CSS default (opacity:1) -
      // harmless if the tween already finished normally by then.
      setTimeout(()=>{ if(el.isConnected){ el.style.opacity=""; el.style.transform=""; } }, 500);
    }
    updateGoState();
  }
  function pulseRect(el){
    if(!el || !window.gsap || MOTION.reduced) return;
    gsap.fromTo(el, {filter:"brightness(1.7)"}, {filter:"brightness(1)", duration:.35, ease:"power2.out", overwrite:"auto"});
    setTimeout(()=>{ if(el.isConnected) el.style.filter=""; }, 600);
  }

  function wireCropPageLayer(meta){
    let mode=null, handle=null, startPt=null, startRect=null;
    function hitHandle(p){
      if(activePageIndex!==meta.index || !normRect) return null;
      const pts = {
        nw:{x:normRect.x0,y:normRect.y0}, n:{x:(normRect.x0+normRect.x1)/2,y:normRect.y0}, ne:{x:normRect.x1,y:normRect.y0},
        e:{x:normRect.x1,y:(normRect.y0+normRect.y1)/2}, se:{x:normRect.x1,y:normRect.y1}, s:{x:(normRect.x0+normRect.x1)/2,y:normRect.y1},
        sw:{x:normRect.x0,y:normRect.y1}, w:{x:normRect.x0,y:(normRect.y0+normRect.y1)/2}
      };
      const r = meta.wrapEl.getBoundingClientRect();
      const tolX = 14/r.width, tolY = 14/r.height;
      for(const k in pts){ if(Math.abs(p.x-pts[k].x)<=tolX && Math.abs(p.y-pts[k].y)<=tolY) return k; }
      return null;
    }
    function inside(p){
      if(activePageIndex!==meta.index || !normRect) return false;
      return p.x>normRect.x0 && p.x<normRect.x1 && p.y>normRect.y0 && p.y<normRect.y1;
    }
    meta.layerEl.addEventListener("pointerdown", e=>{
      if(e.button!=null && e.button!==0) return;
      // Capture is best-effort (keeps the drag tracking correctly if the
      // pointer leaves the layer's own bounds mid-gesture) - it can throw
      // "no active pointer" in some browsers/edge cases, which must not
      // abort the rest of this handler (mode/normRect below) the way an
      // uncaught exception here otherwise would.
      try{ meta.layerEl.setPointerCapture(e.pointerId); }catch(err){}
      const p = localPos(meta, e.clientX, e.clientY);
      startPt = p; startRect = normRect ? {...normRect} : null;
      const h = hitHandle(p);
      if(h){ mode="resize"; handle=h; }
      else if(inside(p)){ mode="move"; meta.rectEl && meta.rectEl.classList.add("crop-rect-dragging"); }
      else {
        mode = "new";
        setActivePage(meta.index);
        normRect = {x0:p.x, y0:p.y, x1:p.x, y1:p.y};
        redrawRect(true);
      }
    });
    meta.layerEl.addEventListener("pointermove", e=>{
      if(!mode){
        // Cursor feedback only, while idle.
        const p = localPos(meta, e.clientX, e.clientY);
        if(activePageIndex===meta.index && normRect){
          meta.layerEl.style.cursor = hitHandle(p) ? "" : (inside(p) ? "grab" : "crosshair");
        } else {
          meta.layerEl.style.cursor = "crosshair";
        }
        return;
      }
      const p = localPos(meta, e.clientX, e.clientY);
      if(mode==="new"){
        normRect = {x0:Math.min(startPt.x,p.x), y0:Math.min(startPt.y,p.y), x1:Math.max(startPt.x,p.x), y1:Math.max(startPt.y,p.y)};
      } else if(mode==="move"){
        const dx=p.x-startPt.x, dy=p.y-startPt.y;
        const w=startRect.x1-startRect.x0, h=startRect.y1-startRect.y0;
        const x0 = Math.max(0, Math.min(1-w, startRect.x0+dx));
        const y0 = Math.max(0, Math.min(1-h, startRect.y0+dy));
        normRect = {x0, y0, x1:x0+w, y1:y0+h};
      } else if(mode==="resize"){
        let {x0,y0,x1,y1} = startRect;
        const dx=p.x-startPt.x, dy=p.y-startPt.y;
        if(handle.includes("n")) y0 = Math.min(y0+dy, y1-MIN_SIZE);
        if(handle.includes("s")) y1 = Math.max(y1+dy, y0+MIN_SIZE);
        if(handle.includes("w")) x0 = Math.min(x0+dx, x1-MIN_SIZE);
        if(handle.includes("e")) x1 = Math.max(x1+dx, x0+MIN_SIZE);
        normRect = {x0:Math.max(0,x0), y0:Math.max(0,y0), x1:Math.min(1,x1), y1:Math.min(1,y1)};
      }
      redrawRect(false);
    });
    function endDrag(){
      if(mode && meta.rectEl){
        meta.rectEl.classList.remove("crop-rect-dragging");
        pulseRect(meta.rectEl);
      }
      mode=null; handle=null;
    }
    meta.layerEl.addEventListener("pointerup", endDrag);
    meta.layerEl.addEventListener("pointercancel", endDrag);
  }

  function resetSelection(){
    normRect = null;
    pagesMeta.forEach(m=>{ if(m.rectEl) m.rectEl.hidden = true; });
    updateGoState();
  }
  resetBtn.addEventListener("click", resetSelection);

  function cropKeyHandler(e){
    // panel.innerHTML gets replaced wholesale on every openPanel() (see
    // panel.js), which detaches `workspace` but has no hook to tell this
    // closure to clean up after itself - without this self-removal, every
    // Crop PDF open/close cycle left one more dead listener (plus its
    // whole closure: pagesMeta, normRect, etc) permanently attached to
    // document for the rest of the tab's life. Removing on the first
    // post-close keydown anywhere on the page bounds the leak to "one
    // extra no-op call" instead of "forever".
    if(!workspace.isConnected){ document.removeEventListener("keydown", cropKeyHandler, true); return; }
    if(workspace.style.display==="none") return;
    const active = document.activeElement;
    if(active && /INPUT|TEXTAREA/.test(active.tagName)) return;
    if((e.key==="Escape" || e.key==="Delete" || e.key==="Backspace") && normRect){
      resetSelection();
      e.preventDefault();
      // Capture-phase (see the addEventListener call below) + stopPropagation:
      // the sitewide Escape-closes-the-panel handler (document, bubble phase,
      // registered at module load - see its own comment near
      // overlay.addEventListener("click"...)) would otherwise close the
      // whole Crop PDF panel on the very same Escape press that was meant
      // to just clear an in-progress selection. Only swallowed when an
      // active selection actually consumed this Escape - with no selection,
      // propagation continues untouched and Escape closes the panel as
      // it does for every other tool.
      e.stopPropagation();
    }
  }
  // Capture (not bubble): the sitewide keydown listener above is attached
  // to `document` at module load, long before any tool panel - including
  // this one - ever opens, so on the bubble phase it would always run
  // first regardless of this listener's own registration order. Capture
  // runs top-down before any bubble-phase listener anywhere in the tree
  // gets a turn, which is what lets stopPropagation() above actually work.
  document.addEventListener("keydown", cropKeyHandler, true);

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Cropping PDF...");
    goBtn.disabled = true; const goLabel = goBtn.textContent; goBtn.textContent = "Cropping PDF...";
    const scope = (panel.querySelector('input[name="cropScope"]:checked') || {}).value || "all";
    const rect = normRect;
    try{
      const doc = await loadPdfSafe(fileBytesCache);
      doc.getPages().forEach((p,i)=>{
        if(scope==="current" && i!==currentPageIndex) return;
        if(!rect) return;
        const {width,height} = p.getSize();
        const l = Math.max(0, Math.min(rect.x0*width, width-1));
        const r = Math.max(0, Math.min((1-rect.x1)*width, width-1-l));
        const t = Math.max(0, Math.min(rect.y0*height, height-1));
        const b = Math.max(0, Math.min((1-rect.y1)*height, height-1-t));
        p.setCropBox(l, b, width-l-r, height-t-b);
      });
      const outBytes=await doc.save();
      const blob=new Blob([outBytes],{type:"application/pdf"});
      const outName = suffixedName(file, "cropped", "pdf");
      setStatus("Preparing download...");
      if(!operation.isCurrent()) return;
      const {url}=downloadBlob(blob,outName);
      const {canvas:thumb}=await pdfThumb(outBytes);
      setStatus("Done", true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
    }catch(e){
      out.innerHTML = "";
      showError("Something went wrong while cropping this PDF. Please try again.");
    }finally{
      goBtn.textContent = goLabel; updateGoState();
    }
  }));
};

/* ---- INVERT PDF COLORS ---- */
TOOLS.invertpdf = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Invert PDF Colors</h3></div>
    <div class="panel-body compact tool-workspace" id="invertpdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Invert PDF Colors</h2>
        <p class="tool-hero-desc">Renders each page and inverts its colors — useful for a dark-mode / negative version of a document.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="invertpdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Invert Colors</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("invertpdfToolbar").style.display="none"; document.getElementById("invertpdfBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("invertpdfToolbar").style.display="flex";
    document.getElementById("invertpdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const bytes=await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
    const outDoc = await PDFDocument.create();
    const scale = 1.6;
    try{
      for(let i=1;i<=pdoc.numPages;i++){
        setStatus("Inverting pages...", false, Math.round((i/pdoc.numPages)*100));
        // renderPdfPageCanvas(), not a raw page.render() call - every page
        // has to succeed for the output's page count/order to be correct
        // (unlike e.g. PDF to Word's best-effort per-page fallback), so a
        // hang here (pdf.js's render can hang indefinitely on some
        // inputs/environments - see that function's doc comment) needs to
        // surface as a catchable rejection instead of freezing this loop
        // forever with the progress bar stuck mid-way.
        const canvas = await renderPdfPageCanvas(pdoc, i, scale);
        const ctx = canvas.getContext("2d");
        const imgData = ctx.getImageData(0,0,canvas.width,canvas.height);
        const d = imgData.data;
        for(let px=0; px<d.length; px+=4){
          d[px]=255-d[px]; d[px+1]=255-d[px+1]; d[px+2]=255-d[px+2];
        }
        ctx.putImageData(imgData,0,0);
        const jpegUrl = canvas.toDataURL("image/jpeg", 0.9);
        const jpegBytes = Uint8Array.from(atob(jpegUrl.split(",")[1]), c=>c.charCodeAt(0));
        const img = await outDoc.embedJpg(jpegBytes);
        const pageDoc = outDoc.addPage([canvas.width/scale, canvas.height/scale]);
        pageDoc.drawImage(img, {x:0,y:0,width:canvas.width/scale, height:canvas.height/scale});
      }
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not invert this PDF (${escapeAttr(e.message)}). Try a different file.</div>`;
      return;
    }
    const outBytes = await outDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "inverted", "pdf");
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/* ---- ORGANIZE ----------------------------------------------------------
   Supports combining pages from MULTIPLE PDFs into one grid, iLovePDF-
   style: each source file gets a distinct color, shown as a border on
   every one of its page thumbnails and as a swatch in the "Files" list,
   so it's obvious at a glance which original file any page came from
   while drag-reordering/mixing pages across files. */
// Per-source-file identity color for Organize PDF's multi-file mode
// (lets a page's card show which uploaded file it came from). These are
// applied as inline styles (see buildPageGrid()'s appendCard()), so
// unlike the rest of the shared page-card CSS they can't theme-swap via
// a CSS variable - deliberately excludes the site's own --red (which IS
// the brand accent in light mode) and any green/lime shade (reserved
// for the selected-state accent), so a source-file color is never
// mistaken for either. Only ever used when 2+ files are actually loaded
// together - see addFiles() below - so a single-file Organize session
// (the common case) shows the exact same plain, uncolored cards Reorder
// Pages does.
const ORGANIZE_FILE_COLORS = ["#3B82F6","#8B5CF6","#F5B22D","#EC4899","#06B6D4","#F97316","#6366F1","#F43F5E"];
TOOLS.organize = function(){
  const entries = []; // {file, color, removed}
  let gridApi=null;
  openPanel(`
    <div class="panel-head"><h3>Organize PDF</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="organizeBody">
      <div class="tool-hero" id="organizeHero">
        <h2 class="tool-hero-title">Organize PDF</h2>
        <p class="tool-hero-desc">Reorder, rotate, duplicate, or remove pages across one or more PDFs.</p>
      </div>
      <div class="tool-upload-wrap" id="organizeUploadWrap">
        ${fileInputHTML("application/pdf", true, "Select PDF files")}
      </div>
      <p class="tool-privacy-hint" id="organizePrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="organizeWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Drag pages to reorder — even across files. Hover a page to rotate, duplicate, or remove it. Click to multi-select (Ctrl/Cmd+A select all, Delete to remove, Esc to clear).</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Organize PDF</h3>
          <div class="organize-files" id="organizeFilesList"></div>
          <input type="file" id="organizeAddInput" class="hidden" accept="application/pdf" multiple>
          <button type="button" class="organize-add-btn" id="organizeAddBtn">+ Add more files</button>
          <button class="btn tool-toolbar-primary" id="go">Organize PDF</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("organizeHero");
  const uploadWrap = document.getElementById("organizeUploadWrap");
  const privacyHint = document.getElementById("organizePrivacyHint");
  const workspace = document.getElementById("organizeWorkspace");
  const filesListEl = document.getElementById("organizeFilesList");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("organizeBody");
  const pageGridEl = document.getElementById("pageGrid");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  function renderFilesSidebar(){
    // Color-coding only means anything once there's a second file to
    // tell apart from the first - with exactly one file loaded (the
    // common case), the swatch stays the same neutral style as every
    // other file-identity chip on the site instead of an arbitrary
    // per-file color nobody needs yet. See addFiles()'s identical
    // reasoning for the page-card borders/labels themselves.
    const multiFile = entries.filter(e=>!e.removed).length > 1;
    filesListEl.innerHTML = entries.map((e, i)=>{
      if(e.removed) return "";
      const letter = String.fromCharCode(65 + i);
      const swatchStyle = multiFile ? ` style="background:${e.color};color:#fff"` : "";
      return `<div class="organize-file-row" data-doc-index="${i}">
        <span class="organize-file-swatch"${swatchStyle}>${letter}</span>
        <span class="organize-file-name" title="${escapeAttr(e.file.name)}">${escapeAttr(e.file.name)}</span>
        <button type="button" class="organize-file-remove" data-doc-index="${i}" aria-label="Remove ${escapeAttr(e.file.name)}">✕</button>
      </div>`;
    }).join("");
    filesListEl.querySelectorAll(".organize-file-remove").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const idx = parseInt(btn.dataset.docIndex);
        entries[idx].removed = true;
        gridApi && gridApi.removeSource(idx);
        renderFilesSidebar();
        if(entries.every(e=>e.removed)){
          gridApi?.destroy(); gridApi = null; pageGridEl.innerHTML=""; gridHint.style.display="none"; showEmptyState();
        }
      });
    });
  }

  async function addFiles(fs){
    const newSources = [];
    for(const f of fs){
      const color = ORGANIZE_FILE_COLORS[entries.length % ORGANIZE_FILE_COLORS.length];
      entries.push({file:f, color, removed:false});
      newSources.push({file:f, color});
    }
    renderFilesSidebar();
    if(!gridApi){
      gridHint.style.display="block";
      // A single file uploaded together (by far the common case, and
      // what every other page-grid tool - Reorder Pages included -
      // looks like) gets no per-file color at all, so its cards render
      // identically to Reorder's plain ones. Uploading several files
      // together IS a real "tell them apart" need, so those keep their
      // assigned colors. Adding a 2nd file later via addSource() below
      // always means 2+ files exist by definition, so that path is
      // untouched - see its own call for why.
      const sources = await Promise.all(newSources.map(async s=>({bytes:await s.file.arrayBuffer(), color:s.color})));
      const gridSources = sources.length>1 ? sources : sources.map(s=>({...s, color:null}));
      // zoomable dropped - matches Rotate PDF's own de-S/M/L-ing: every
      // page-grid tool now just uses the shared default size instead of
      // a tool-specific zoom toggle. multiSelect stays on (Organize's
      // bulk rotate/duplicate/delete genuinely depend on it), but its
      // visual toolbar row (the "Select all" pill + bulk-action bar) is
      // hidden via #organizeBody .page-grid-toolbar in index.html, same
      // as Extract/Delete Pages - the underlying capability is still
      // fully reachable via the existing keyboard shortcuts this tool's
      // own hint text already documents (Ctrl/Cmd+A select all, Delete
      // to remove, R/Shift+R to rotate), plus each card's own hover
      // controls for one-at-a-time actions including duplicate.
      gridApi = await buildPageGrid(pageGridEl, gridSources, {mode:"reorder", removable:true, rotatable:true, duplicable:true, multiSelect:true});
      showWorkspace();
    } else {
      for(const s of newSources){
        const bytes = await s.file.arrayBuffer();
        await gridApi.addSource(bytes, s.color);
      }
    }
  }

  wireDropzone(fs=>addFiles(fs));
  document.getElementById("organizeAddBtn").addEventListener("click", ()=>document.getElementById("organizeAddInput").click());
  document.getElementById("organizeAddInput").addEventListener("change", e=>{
    addFiles([...e.target.files]);
    e.target.value = "";
  });

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Applying...");
    const pagesSpec = gridApi.getPages();
    if(pagesSpec.length===0){ toast("At least one page must remain"); out.innerHTML=""; return; }
    const usedDocIndexes = [...new Set(pagesSpec.map(p=>p.docIndex))];
    const srcDocs = [];
    for(const idx of usedDocIndexes){
      const bytes = await entries[idx].file.arrayBuffer();
      srcDocs[idx] = await loadPdfSafe(bytes);
    }
    const newDoc = usedDocIndexes.length>1
      ? await buildPdfFromMultiDoc(srcDocs, pagesSpec)
      : await buildPdfFromPages(srcDocs[usedDocIndexes[0]], pagesSpec);
    const outBytes=await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const primaryFile = entries[usedDocIndexes[0]].file;
    const outName = usedDocIndexes.length>1 ? "organized.pdf" : suffixedName(primaryFile, "organized", "pdf");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/* ---- FLATTEN ---- */
TOOLS.flatten = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Flatten PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="flattenBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Flatten PDF</h2>
        <p class="tool-hero-desc">Any form fields present will be permanently flattened into the page content.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="flattenToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Flatten PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("flattenToolbar").style.display="none"; document.getElementById("flattenBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("flattenToolbar").style.display="flex";
    document.getElementById("flattenBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    setStatus("Flattening document...");
    try{ const form = doc.getForm(); form.flatten(); }catch(e){}
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "flattened", "pdf");
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  }));
};

/* ---- PDF to JPG ---- */
TOOLS.pdf2jpg = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to JPG</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2jpgBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to JPG</h2>
        <p class="tool-hero-desc">Turn every page of a PDF into a high-quality JPG image.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2jpgToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to JPG</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2jpgToolbar").style.display="none"; document.getElementById("pdf2jpgBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2jpgToolbar").style.display="flex";
    document.getElementById("pdf2jpgBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Rendering PDF pages...");
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
    const zip = new JSZip();
    let firstBlob=null;
    try{
      for(let i=1;i<=pdoc.numPages;i++){
        setStatus("Rendering PDF pages...", false, Math.round((i/pdoc.numPages)*100));
        // renderPdfPageCanvas(), not a raw page.render() - see Invert PDF
        // Colors' identical comment for why a hang here must reject
        // instead of freezing this loop forever.
        const canvas = await renderPdfPageCanvas(pdoc, i, 2);
        const blob = await new Promise(res=>canvas.toBlob(res,"image/jpeg",0.92));
        if(i===1) firstBlob=blob;
        zip.file(`page_${i}.jpg`, blob);
      }
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not render this PDF (${escapeAttr(e.message)}). Try a different file.</div>`;
      return;
    }
    setStatus("Preparing download...");
    if(pdoc.numPages===1){
      const outName = suffixedName(file, "page1", "jpg");
      if(!operation.isCurrent()) return;
      const {url}=downloadBlob(firstBlob,outName);
      const img=document.createElement("img"); img.src=url;
      setStatus("Done", true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(firstBlob.size), sizeGood:true, previewNode:img, url, filename:outName}));
    } else {
      const zipBlob = await zip.generateAsync({type:"blob"});
      const outName = suffixedName(file, "pages", "zip");
      if(!operation.isCurrent()) return;
      const {url}=downloadBlob(zipBlob,outName);
      setStatus("Done", true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName}));
    }
  }));
};

/* ---- JPG/Image to PDF ---- */
TOOLS.jpg2pdf = function(){
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>JPG to PDF</h3></div>
    <div class="panel-body compact tool-workspace keep-upload" id="jpg2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">JPG to PDF</h2>
        <p class="tool-hero-desc">Combine one or more images into a single PDF, in the order you add them.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("image/*", true, "Select images")}
      </div>
      <div class="tool-toolbar" id="jpg2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>JPG to PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  const refresh = ()=>{
    renderFileList(files, i=>{files.splice(i,1); refresh();});
    document.getElementById("go").disabled = files.length<1;
    document.getElementById("jpg2pdfToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("jpg2pdfBody").classList.toggle("is-loaded", files.length>0);
  };
  wireDropzone(fs=>{ files = files.concat(fs.filter(f=>f.type.startsWith("image/"))); refresh(); });
  /**
   * Embeds one image file into `doc`, returning the embedded image.
   * The dropzone/file input both accept `image/*` broadly, but the old
   * code only ever handled that promise: "PNG -> embedPng, anything else
   * -> embedJpg" - a WEBP (the default format for a huge share of real
   * phone screenshots/exports today), GIF, BMP, or any other real
   * `image/*` file hit embedJpg and threw "SOI not found in JPEG"
   * (confirmed by testing), which wasn't even caught anywhere - the UI
   * was left permanently stuck on "Building PDF..." forever, no error
   * shown at all. Genuine PNG/JPEG still take the fast direct-embed
   * path (pdf-lib natively supports both, no quality loss); anything
   * else is decoded via the browser's own image decoder (createImageBitmap
   * handles WEBP/GIF/BMP/AVIF/etc - whatever this browser can already
   * display) and re-encoded as PNG, so the tool actually delivers on
   * what "Select images" already promised instead of silently failing.
   */
  async function embedImageFile(doc, file){
    const type = (file.type||"").toLowerCase();
    if(type==="image/png") return doc.embedPng(new Uint8Array(await file.arrayBuffer()));
    if(type==="image/jpeg" || type==="image/jpg") return doc.embedJpg(new Uint8Array(await file.arrayBuffer()));
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const pngBlob = await new Promise(res=>canvas.toBlob(res, "image/png"));
    return doc.embedPng(new Uint8Array(await pngBlob.arrayBuffer()));
  }
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading images...");
    const doc = await PDFDocument.create();
    const failed = [];
    for(let i=0;i<files.length;i++){
      setStatus("Building PDF...", false, Math.round(((i+1)/files.length)*100));
      const f = files[i];
      try{
        const img = await embedImageFile(doc, f);
        const page = doc.addPage([img.width, img.height]);
        page.drawImage(img, {x:0,y:0,width:img.width, height:img.height});
      }catch(e){
        // One unreadable/corrupt file shouldn't discard everything else
        // the user already added - skip it and keep going, then report
        // exactly which file(s) didn't make it into the final PDF.
        failed.push(f.name);
      }
    }
    if(doc.getPageCount()===0){
      out.innerHTML = `<div class="status" style="color:var(--rose)">None of the selected files could be read as images. Try a different file.</div>`;
      return;
    }
    setStatus("Preparing download...");
    const outBytes = await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,"images.pdf");
    const {canvas}=await pdfThumb(outBytes);
    setStatus(failed.length ? `Done — couldn't read: ${failed.join(", ")}` : "Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:"images.pdf"}));
  }));
};
