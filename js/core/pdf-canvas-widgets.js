/* Shared drag-to-select crop interaction: supports drawing a new box,
   moving it, and resizing it from any edge/corner via small handles. */
function wireCropCanvas(canvas, state){
  const HANDLE = 9;
  let mode = null, resizeEdge = null, startPt = null, startRect = null;

  function getPos(e){
    const r = canvas.getBoundingClientRect();
    let x = (e.clientX-r.left) * (canvas.width/r.width);
    let y = (e.clientY-r.top) * (canvas.height/r.height);
    x = Math.max(0, Math.min(canvas.width, x));
    y = Math.max(0, Math.min(canvas.height, y));
    return {x,y};
  }
  function handlePoints(r){
    return {
      nw:{x:r.x,y:r.y}, n:{x:r.x+r.w/2,y:r.y}, ne:{x:r.x+r.w,y:r.y},
      e:{x:r.x+r.w,y:r.y+r.h/2}, se:{x:r.x+r.w,y:r.y+r.h}, s:{x:r.x+r.w/2,y:r.y+r.h},
      sw:{x:r.x,y:r.y+r.h}, w:{x:r.x,y:r.y+r.h/2}
    };
  }
  function hitHandle(p){
    const pts = handlePoints(state.rect);
    for(const key in pts){
      if(Math.abs(p.x-pts[key].x)<=HANDLE && Math.abs(p.y-pts[key].y)<=HANDLE) return key;
    }
    return null;
  }
  function inside(p){
    const r = state.rect;
    return p.x>r.x && p.x<r.x+r.w && p.y>r.y && p.y<r.y+r.h;
  }

  canvas.style.touchAction = "none";
  canvas.onpointerdown = e=>{
    canvas.setPointerCapture(e.pointerId);
    const p = getPos(e);
    startPt = p; startRect = {...state.rect};
    const h = hitHandle(p);
    if(h){ mode="resize"; resizeEdge=h; }
    else if(inside(p)){ mode="move"; }
    else { mode="new"; state.rect = {x:p.x, y:p.y, w:0, h:0}; }
    state.redraw();
  };
  canvas.onpointermove = e=>{
    if(!mode) return;
    const p = getPos(e);
    if(mode==="new"){
      state.rect = {x:Math.min(startPt.x,p.x), y:Math.min(startPt.y,p.y), w:Math.abs(p.x-startPt.x), h:Math.abs(p.y-startPt.y)};
    } else if(mode==="move"){
      const dx = p.x-startPt.x, dy = p.y-startPt.y;
      const nx = Math.max(0, Math.min(canvas.width-startRect.w, startRect.x+dx));
      const ny = Math.max(0, Math.min(canvas.height-startRect.h, startRect.y+dy));
      state.rect = {x:nx, y:ny, w:startRect.w, h:startRect.h};
    } else if(mode==="resize"){
      let {x,y,w,h} = startRect;
      let x2=x+w, y2=y+h;
      const dx=p.x-startPt.x, dy=p.y-startPt.y;
      if(resizeEdge.includes("n")) y = Math.min(y+dy, y2-10);
      if(resizeEdge.includes("s")) y2 = Math.max(y2+dy, y+10);
      if(resizeEdge.includes("w")) x = Math.min(x+dx, x2-10);
      if(resizeEdge.includes("e")) x2 = Math.max(x2+dx, x+10);
      x = Math.max(0,x); y = Math.max(0,y);
      x2 = Math.min(canvas.width,x2); y2 = Math.min(canvas.height,y2);
      state.rect = {x, y, w:x2-x, h:y2-y};
    }
    state.redraw();
  };
  canvas.onpointerup = ()=>{ mode=null; resizeEdge=null; };
}
function drawCropHandles(ctx, r){
  const pts = [
    [r.x,r.y],[r.x+r.w/2,r.y],[r.x+r.w,r.y],
    [r.x+r.w,r.y+r.h/2],[r.x+r.w,r.y+r.h],[r.x+r.w/2,r.y+r.h],
    [r.x,r.y+r.h],[r.x,r.y+r.h/2]
  ];
  ctx.save();
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#E8291B"; ctx.lineWidth = 1.5;
  pts.forEach(([px,py])=>{
    ctx.fillRect(px-5, py-5, 10, 10);
    ctx.strokeRect(px-5, py-5, 10, 10);
  });
  ctx.restore();
}
/**
 * Renders one PDF page to a thumbnail canvas, with a hang-proof timeout.
 * pdf.js's page.render() has been observed to hang indefinitely (never
 * resolving or rejecting) rather than erroring out, in some
 * environments. Every result screen across ~25 tools awaits this for
 * its preview thumbnail before showing the download link, so a hang
 * here means the whole tool looks permanently stuck at "Building..."
 * with no way to download a file that was actually already produced
 * successfully. A timeout with a null-canvas fallback means a slow/
 * failed thumbnail degrades to "no preview" instead of blocking the
 * download forever - every caller already handles a falsy canvas
 * (resultBox only renders the preview thumbs wrapper `if(previewNode)`).
 * @param {ArrayBuffer|Uint8Array} bytes - PDF bytes.
 * @param {number} [pageNum=1] - 1-based page to render.
 * @param {number} [maxH=110] - target canvas height in CSS px.
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{canvas: HTMLCanvasElement|null, numPages: number}>}
 *   `canvas` is null and `numPages` is 0 on timeout/failure.
 */
async function pdfThumb(bytes, pageNum=1, maxH=110, timeoutMs=8000){
  let loadingTask = null;
  let doc = null;
  let renderTask = null;
  let timeoutId = null;
  try {
    loadingTask = pdfjsLib.getDocument({data:bytes});
    const work = (async ()=>{
      doc = await loadingTask.promise;
      if(!doc.numPages || pageNum < 1 || pageNum > doc.numPages) throw new Error("Invalid PDF page");
      const page = await doc.getPage(pageNum);
      const vp1 = page.getViewport({scale:1});
      const scale = maxH/vp1.height;
      const vp = page.getViewport({scale});
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      renderTask = page.render({canvasContext:canvas.getContext("2d"), viewport:vp});
      await renderTask.promise;
      return {canvas, numPages:doc.numPages};
    })();

    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("pdfThumb timed out")), timeoutMs);
      }),
    ]);
  } catch (e) {
    try{ renderTask?.cancel(); }catch(_){}
    return { canvas: null, numPages: 0 };
  } finally {
    if(timeoutId) clearTimeout(timeoutId);
    try{
      if(doc) await doc.destroy();
      else await loadingTask?.destroy();
    }catch(_){}
  }
}
/**
 * Renders one PDF page to a canvas at an explicit scale (page-grid
 * thumbnails, image-fallback conversion paths). Unlike pdfThumb(), this
 * throws on timeout rather than swallowing - page.render() has been
 * observed elsewhere in this app to hang indefinitely (never resolving
 * or rejecting) rather than erroring, on some inputs/environments, same
 * category of issue pdfThumb() was fixed for earlier - but some callers
 * here use the rendered image as the actual deliverable, not just an
 * optional preview, so they need to decide how to handle a failure
 * themselves rather than silently getting nothing back.
 * @param {import("pdfjs-dist").PDFDocumentProxy} pdoc
 * @param {number} pageNum - 1-based page to render.
 * @param {number} scale - pdf.js viewport scale.
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<HTMLCanvasElement>} rejects on timeout.
 */
async function renderPdfPageCanvas(pdoc, pageNum, scale, timeoutMs=10000){
  const page = await pdoc.getPage(pageNum);
  const vp = page.getViewport({scale});
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const renderTask = page.render({canvasContext:canvas.getContext("2d"), viewport:vp});
  let timeoutId = null;
  try{
    await Promise.race([
      renderTask.promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Page render timed out")), timeoutMs);
      })
    ]);
    return canvas;
  }catch(error){
    try{ renderTask.cancel(); }catch(_){}
    throw error;
  }finally{
    if(timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Browser-first state model shared by every page workspace. PDF parsing,
 * thumbnail rendering and serialization intentionally stay in the existing
 * helpers below; this class owns only lightweight page-operation state.
 * That separation also leaves a stable `extensions` bag for future OCR,
 * edit and redact layers without coupling those features to today's tools.
 */
class PDFWorkspaceModel {
  constructor({sources=[], pages=[], historyLimit=50} = {}){
    this.sources = sources.map((source, index)=>({
      id: source.id || `source-${index+1}`,
      name: source.name || source.label || `Document ${index+1}`,
      pageCount: Number(source.pageCount) || 0,
      docIndex: Number.isInteger(source.docIndex) ? source.docIndex : index,
      size: Number(source.size) || 0,
      type: source.type || "application/pdf",
      lastModified: Number(source.lastModified) || 0,
      color: source.color || null,
      extensions: {...(source.extensions || {})}
    }));
    this.historyLimit = Math.max(1, Number(historyLimit) || 50);
    this._undo = [];
    this._redo = [];
    this._listeners = new Set();
    this._nextId = 1;
    this.pages = pages.map((page, index)=>this._normalizePage(page, index));
    this._normalizeOrder();
  }

  _newId(){ return `workspace-page-${this._nextId++}`; }
  _normalizePage(page, index){
    const normalized = {
      id: page.id || this._newId(),
      sourceId: page.sourceId || this.sources[page.docIndex || 0]?.id || null,
      docIndex: Number.isInteger(page.docIndex) ? page.docIndex : 0,
      sourcePageIndex: Number.isInteger(page.sourcePageIndex) ? page.sourcePageIndex : (Number.isInteger(page.index) ? page.index : null),
      pageIndex: index,
      order: Number.isFinite(page.order) ? page.order : index,
      rotation: ((Number(page.rotation) || 0) % 360 + 360) % 360,
      selected: Boolean(page.selected),
      deleted: Boolean(page.deleted),
      duplicateOf: page.duplicateOf || null,
      blank: Boolean(page.blank),
      width: page.width == null ? null : Number(page.width),
      height: page.height == null ? null : Number(page.height),
      extensions: {...(page.extensions || {})}
    };
    const match = /^workspace-page-(\d+)$/.exec(normalized.id);
    if(match) this._nextId = Math.max(this._nextId, Number(match[1])+1);
    return normalized;
  }
  _clonePages(){ return this.pages.map(page=>({...page, extensions:{...page.extensions}})); }
  _restore(snapshot){ this.pages = snapshot.map((page, index)=>this._normalizePage(page, index)); this._normalizeOrder(); }
  _normalizeOrder(){
    this.pages.sort((a,b)=>a.order-b.order);
    this.pages.forEach((page, index)=>{ page.order=index; page.pageIndex=index; });
  }
  _emit(type){
    const detail = {type, canUndo:this.canUndo, canRedo:this.canRedo, pages:this.activePages};
    this._listeners.forEach(listener=>listener(detail));
  }
  _mutate(type, change){
    const before = this._clonePages();
    const changed = change();
    if(changed === false) return false;
    this._normalizeOrder();
    this._undo.push({type, pages:before});
    if(this._undo.length > this.historyLimit) this._undo.shift();
    this._redo.length = 0;
    this._emit(type);
    return true;
  }
  get activePages(){ return this.pages.filter(page=>!page.deleted); }
  get selectedPages(){ return this.pages.filter(page=>!page.deleted && page.selected); }
  get canUndo(){ return this._undo.length > 0; }
  get canRedo(){ return this._redo.length > 0; }
  subscribe(listener){ this._listeners.add(listener); return ()=>this._listeners.delete(listener); }
  page(id){ return this.pages.find(page=>page.id===id) || null; }
  setSelected(ids, selected=true){
    const wanted = new Set(ids);
    this.pages.forEach(page=>{ if(wanted.has(page.id) && !page.deleted) page.selected=Boolean(selected); });
    this._emit("selection");
  }
  selectOnly(ids){
    const wanted = new Set(ids);
    this.pages.forEach(page=>{ page.selected=!page.deleted && wanted.has(page.id); });
    this._emit("selection");
  }
  clearSelection(){ this.pages.forEach(page=>{ page.selected=false; }); this._emit("selection"); }
  reorder(pageIds){
    const activeIds = this.activePages.map(page=>page.id);
    if(pageIds.length!==activeIds.length || new Set(pageIds).size!==pageIds.length || pageIds.some(id=>!activeIds.includes(id))) return false;
    if(pageIds.every((id,index)=>id===activeIds[index])) return false;
    return this._mutate("reorder", ()=>{
      const activeById = new Map(this.activePages.map(page=>[page.id,page]));
      const deleted = this.pages.filter(page=>page.deleted);
      this.pages = [...pageIds.map(id=>activeById.get(id)), ...deleted];
      this.pages.forEach((page,index)=>{ page.order=index; });
    });
  }
  reorderSources(docIndexes){
    const rank = new Map(docIndexes.map((docIndex,index)=>[docIndex,index]));
    const pageIds = this.activePages.slice().sort((a,b)=>{
      const sourceOrder = (rank.get(a.docIndex) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.docIndex) ?? Number.MAX_SAFE_INTEGER);
      return sourceOrder || a.order-b.order;
    }).map(page=>page.id);
    return this.reorder(pageIds);
  }
  rotatePages(ids, delta){
    const wanted = new Set(ids);
    if(!delta || !this.pages.some(page=>wanted.has(page.id) && !page.deleted)) return false;
    return this._mutate("rotate", ()=>this.pages.forEach(page=>{
      if(wanted.has(page.id) && !page.deleted) page.rotation=((page.rotation+delta)%360+360)%360;
    }));
  }
  rotateSelected(delta){ return this.rotatePages(this.selectedPages.map(page=>page.id), delta); }
  deletePages(ids){
    const wanted = new Set(ids);
    if(!this.pages.some(page=>wanted.has(page.id) && !page.deleted)) return false;
    return this._mutate("delete", ()=>this.pages.forEach(page=>{
      if(wanted.has(page.id)){ page.deleted=true; page.selected=false; }
    }));
  }
  deleteSelected(){ return this.deletePages(this.selectedPages.map(page=>page.id)); }
  duplicatePages(ids){
    const wanted = new Set(ids);
    const duplicated = [];
    const changed = this._mutate("duplicate", ()=>{
      const next = [];
      this.pages.forEach(page=>{
        next.push(page);
        if(wanted.has(page.id) && !page.deleted){
          const copy = this._normalizePage({...page, id:this._newId(), selected:false, duplicateOf:page.id}, next.length);
          next.push(copy);
          duplicated.push(copy);
        }
      });
      if(!duplicated.length) return false;
      this.pages = next;
      this.pages.forEach((page,index)=>{ page.order=index; });
    });
    return changed ? duplicated : [];
  }
  duplicateSelected(){ return this.duplicatePages(this.selectedPages.map(page=>page.id)); }
  addPages(pages){
    const added = pages.map((page,index)=>this._normalizePage(page, this.pages.length+index));
    this.pages.push(...added);
    this._normalizeOrder();
    this._undo.length = 0;
    this._redo.length = 0;
    this._emit("source");
    return added;
  }
  insertPages(pages, activeIndex=this.activePages.length){
    const added = pages.map((page,index)=>this._normalizePage(page, this.pages.length+index));
    const nextActive = this.activePages[Math.max(0, activeIndex)];
    const firstDeletedIndex = this.pages.findIndex(page=>page.deleted);
    const insertionIndex = nextActive ? this.pages.indexOf(nextActive) : (firstDeletedIndex>=0 ? firstDeletedIndex : this.pages.length);
    this._mutate("insert", ()=>{
      this.pages.splice(insertionIndex, 0, ...added);
      this.pages.forEach((page,index)=>{ page.order=index; });
    });
    return added;
  }
  removeSource(docIndex){
    this.pages = this.pages.filter(page=>page.docIndex!==docIndex);
    this.sources = this.sources.filter(source=>source.docIndex!==docIndex);
    this._normalizeOrder();
    this._undo.length = 0;
    this._redo.length = 0;
    this._emit("source");
  }
  undo(){
    const entry = this._undo.pop();
    if(!entry) return false;
    this._redo.push({type:entry.type, pages:this._clonePages()});
    this._restore(entry.pages);
    this._emit("undo");
    return true;
  }
  redo(){
    const entry = this._redo.pop();
    if(!entry) return false;
    this._undo.push({type:entry.type, pages:this._clonePages()});
    this._restore(entry.pages);
    this._emit("redo");
    return true;
  }
  toPageSpecs({selectedOnly=false, excludeSelected=false} = {}){
    let pages = selectedOnly ? this.selectedPages : this.activePages;
    if(excludeSelected) pages = pages.filter(page=>!page.selected);
    return pages.map(page=>this.toPageSpec(page));
  }
  toPageSpec(page){
    return page.blank
      ? {blank:true, width:page.width, height:page.height, rotation:page.rotation}
      : {index:page.sourcePageIndex, docIndex:page.docIndex, rotation:page.rotation};
  }
  pageSpecsForSourceIndexes(indices, {docIndex=0, inputOrder=false} = {}){
    const wanted = new Set(indices);
    const matches = this.activePages.filter(page=>!page.blank && page.docIndex===docIndex && wanted.has(page.sourcePageIndex));
    if(!inputOrder) return matches.map(page=>this.toPageSpec(page));
    return indices.flatMap(index=>matches.filter(page=>page.sourcePageIndex===index).map(page=>this.toPageSpec(page)));
  }
}

window.PDFWorkspace = Object.freeze({Model:PDFWorkspaceModel, buildPdf:buildPdfFromWorkspace});

/**
 * Shared iLovePDF-style page-thumbnail grid, backing Delete Pages,
 * Extract Pages, Reorder Pages, Split, Organize, and Rotate. All flags
 * below default to false, so existing callers (Delete Pages, Extract
 * Pages, plain Reorder) are unaffected by ones they don't pass.
 * @param {HTMLElement} container - element to render the grid into.
 * @param {ArrayBuffer|Uint8Array} bytes - PDF bytes to render pages from.
 * @param {object} [opts]
 * @param {"reorder"|"select"} [opts.mode="reorder"] - "reorder": drag
 *   cards to reorder; getOrder() returns the current 0-based original
 *   page indices in on-screen order. "select": click a card to toggle
 *   it; getSelected() returns a Set of 0-based indices currently
 *   selected.
 * @param {boolean} [opts.removable=false] - reorder mode only: shows a
 *   hover ✕ on each card to drop that page entirely.
 * @param {boolean} [opts.rotatable=false] - hover-reveal rotate-left/
 *   right buttons per card, plus a bulk "Rotate Selected" action.
 * @param {boolean} [opts.duplicable=false] - hover-reveal duplicate
 *   button per card, plus a bulk "Duplicate Selected" action.
 * @param {boolean} [opts.multiSelect=false] - reorder mode only: click-
 *   to-select alongside dragging, via an always-visible corner checkbox
 *   (mode "select" already gets click-to-select natively).
 * @param {boolean} [opts.zoomable=false] - adds a Small/Medium/Large
 *   thumbnail-size toggle.
 * @param {boolean} [opts.showSourceLabels=false] - shows each source
 *   filename below its pages in a multi-document workspace.
 * @returns {Promise<{workspace: PDFWorkspaceModel, getOrder: Function, getSelected: Function,
 *   getPages: Function, getSelectedPages: Function, selectOddEven:
 *   Function, selectAll: Function, clearSelection: Function, rotateAll:
 *   Function, undo: Function, redo: Function}>}
 */
async function buildPageGrid(container, bytesOrSources, {mode="reorder", removable=false, rotatable=false, duplicable=false, multiSelect=false, zoomable=false, showSourceLabels=false} = {}){
  // Single-file callers (Split/Rotate/DeletePages/ExtractPages/Reorder/
  // AddBlankPage) pass raw bytes, unchanged from before this function
  // supported multi-file sources - normalized to a 1-item sources array so
  // their behavior/output is bit-for-bit identical (docIndex is always 0,
  // no color border is ever applied). Merge and Organize pass arrays of
  // source descriptors to combine multiple documents in one workspace.
  const sources = Array.isArray(bytesOrSources) ? bytesOrSources : [{bytes: bytesOrSources}];
  const maxWorkspaceBytes = window.YOYO_RUNTIME?.limits?.maxBatchBytes || (400 * 1024 * 1024);
  const totalSourceBytes = sources.reduce((sum,source)=>sum+(source.bytes?.byteLength || source.size || 0), 0);
  if(totalSourceBytes > maxWorkspaceBytes){
    throw new Error(`These PDFs exceed the ${Math.round(maxWorkspaceBytes/(1024*1024))} MB browser workspace limit.`);
  }
  const loadedSources = await Promise.allSettled(sources.map(s=>loadPdfJsSafe({data:s.bytes.slice(0)})));
  const failedSource = loadedSources.find(result=>result.status==="rejected");
  if(failedSource){
    await Promise.allSettled(loadedSources.filter(result=>result.status==="fulfilled").map(result=>result.value.destroy()));
    throw failedSource.reason;
  }
  let pdocs = loadedSources.map(result=>result.value);
  const numPages = pdocs.reduce((sum,p)=>sum+p.numPages, 0);
  const maxWorkspacePages = window.YOYO_RUNTIME?.limits?.maxPdfPages || 1500;
  if(numPages > maxWorkspacePages){
    await Promise.allSettled(pdocs.map(pdoc=>pdoc.destroy()));
    throw new Error(`These PDFs contain ${numPages} pages in total; the browser workspace limit is ${maxWorkspacePages}.`);
  }
  const workspace = new PDFWorkspaceModel({
    sources: sources.map((source, docIndex)=>({
      id:`source-${docIndex+1}`, docIndex, name:source.name || source.label, pageCount:pdocs[docIndex].numPages,
      size:source.size || source.bytes?.byteLength, type:source.type, lastModified:source.lastModified, color:source.color
    })),
    pages: pdocs.flatMap((pdoc, docIndex)=>Array.from({length:pdoc.numPages}, (_, sourcePageIndex)=>({
      sourceId:`source-${docIndex+1}`, docIndex, sourcePageIndex
    })))
  });
  const selectionEnabled = mode==="select" || (mode==="reorder" && multiSelect);
  const showBulkBar = selectionEnabled && (rotatable || duplicable || removable);
  const historyEnabled = mode==="reorder" || removable || rotatable || duplicable;
  container.innerHTML = "";
  container.classList.add("page-grid");
  document.querySelector(".panel-body")?.classList.toggle("has-file", numPages>0);

  const toolbar = document.createElement("div");
  toolbar.className = "page-grid-toolbar";
  let bulkBar = null;
  if(showBulkBar){
    bulkBar = document.createElement("div");
    bulkBar.className = "page-grid-bulkbar";
    toolbar.appendChild(bulkBar);
  }
  // Select all / Deselect all: previously only reachable via the Ctrl+A/
  // Escape keyboard shortcuts below (real, but completely undiscoverable -
  // nothing in the UI hinted they existed). bulkBar itself can't host
  // "Select all" since it only renders once something is ALREADY selected
  // (chicken-and-egg) - this sits in the toolbar proper instead, always
  // visible whenever the grid supports selection at all, mirroring iLovePDF's
  // organize/delete-pages page pickers. "Deselect all" is intentionally
  // the bulk bar's existing "Clear" button, not a second always-visible
  // button here - once anything is selected the bulk bar is already on
  // screen, so a second always-there control would just be redundant.
  let selectCtl = null;
  if(selectionEnabled){
    selectCtl = document.createElement("div");
    selectCtl.className = "page-grid-selectctl";
    selectCtl.innerHTML = `<button type="button" class="bulkbar-btn" data-act="selectAll" draggable="false">Select all</button>`;
    toolbar.appendChild(selectCtl);
  }
  if(zoomable){
    const zoomCtl = document.createElement("div");
    zoomCtl.className = "page-grid-zoom";
    zoomCtl.innerHTML = `<span>Size</span>
      <button type="button" class="zoom-btn" data-zoom="s" draggable="false">S</button>
      <button type="button" class="zoom-btn active" data-zoom="m" draggable="false">M</button>
      <button type="button" class="zoom-btn" data-zoom="l" draggable="false">L</button>`;
    toolbar.appendChild(zoomCtl);
  }
  let historyCtl = null;
  if(historyEnabled){
    historyCtl = document.createElement("div");
    historyCtl.className = "page-grid-history";
    historyCtl.innerHTML = `<button type="button" class="bulkbar-btn" data-history="undo" disabled aria-label="Undo page operation">↶ Undo</button><button type="button" class="bulkbar-btn" data-history="redo" disabled aria-label="Redo page operation">↷ Redo</button>`;
    toolbar.appendChild(historyCtl);
  }
  if(toolbar.children.length) container.appendChild(toolbar);

  const cardsWrap = document.createElement("div");
  cardsWrap.className = "page-grid-cards zoom-m";
  container.appendChild(cardsWrap);

  const firstVp = (await pdocs[0].getPage(1)).getViewport({scale:1});
  const scale = 260 / firstVp.height;

  const cardById = new Map();
  function workspaceId(card){ return card?.dataset.workspacePageId || ""; }
  function updateHistoryControls(){
    if(!historyCtl) return;
    historyCtl.querySelector('[data-history="undo"]').disabled = !workspace.canUndo;
    historyCtl.querySelector('[data-history="redo"]').disabled = !workspace.canRedo;
  }

  function rotateCard(card, delta){
    const pageId = workspaceId(card);
    workspace.rotatePages([pageId], delta);
    const cur = workspace.page(pageId)?.rotation ?? ((parseInt(card.dataset.rotation||"0") + delta) % 360 + 360) % 360;
    card.dataset.rotation = cur;
    updateHistoryControls();
    const cv = card.querySelector("canvas");
    if(!cv) return;
    cv.classList.remove("rot-90","rot-180","rot-270");
    if(cur) cv.classList.add("rot-"+cur);
  }

  async function duplicateCards(cards){
    await Promise.all(cards.map(renderCardCanvas)); // copy rendered pixels when available; lazy rendering remains the fallback
    const copies = workspace.duplicatePages(cards.map(workspaceId));
    if(!copies.length) return;
    copies.forEach(copy=>{
      const card = cardById.get(copy.duplicateOf);
      if(!card) return;
      const clone = card.cloneNode(true);
      const srcCanvas = card.querySelector("canvas");
      const dstCanvas = clone.querySelector("canvas");
      if(srcCanvas && dstCanvas){
        dstCanvas.width = srcCanvas.width; dstCanvas.height = srcCanvas.height;
        dstCanvas.getContext("2d").drawImage(srcCanvas,0,0);
      }
      clone.classList.remove("selected","dragging","drag-over");
      clone.dataset.workspacePageId = copy.id;
      clone.dataset.rotation = copy.rotation;
      syncCheckToggle(clone, false);
      const lbl = clone.querySelector(".page-num");
      if(lbl) lbl.textContent += " (copy)";
      wireCard(clone);
      card.after(clone);
      cardById.set(copy.id, clone);
      evictObserver?.observe(clone);
    });
    updateBulkBar();
    updateHistoryControls();
  }
  function duplicateCard(card){ return duplicateCards([card]); }

  // Shared by the toolbar's "Select all" button, the Ctrl+A/Escape
  // shortcuts, and the returned gridApi - one implementation instead of
  // three copies of the same querySelectorAll+classList dance.
  function syncCheckToggle(card, selected){ card.querySelector(".page-check-toggle")?.setAttribute("aria-checked", String(selected)); }
  function selectAllPages(){
    const cards = [...cardsWrap.querySelectorAll('.page-card')].filter(c=>c.style.display!=="none");
    workspace.selectOnly(cards.map(workspaceId));
    cards.forEach(c=>{ c.classList.add("selected"); syncCheckToggle(c, true); });
    updateBulkBar();
  }
  function clearAllSelection(){
    workspace.clearSelection();
    cardsWrap.querySelectorAll(".page-card.selected").forEach(c=>{ c.classList.remove("selected"); syncCheckToggle(c, false); });
    updateBulkBar();
  }
  if(selectCtl){
    selectCtl.querySelector('[data-act="selectAll"]').addEventListener("click", selectAllPages);
  }

  function updateBulkBar(){
    if(!bulkBar) return;
    const n = cardsWrap.querySelectorAll(".page-card.selected").length;
    if(n===0){ bulkBar.innerHTML=""; bulkBar.style.display="none"; return; }
    bulkBar.style.display = "flex";
    bulkBar.innerHTML = `<span class="bulkbar-count">${n} selected</span>` +
      (rotatable ? `<button type="button" class="bulkbar-btn" data-act="rotL" draggable="false">⟲ Rotate</button><button type="button" class="bulkbar-btn" data-act="rotR" draggable="false">⟳ Rotate</button>` : "") +
      (duplicable ? `<button type="button" class="bulkbar-btn" data-act="dup" draggable="false">⧉ Duplicate</button>` : "") +
      (removable ? `<button type="button" class="bulkbar-btn bulkbar-danger" data-act="del" draggable="false">✕ Delete</button>` : "") +
      `<button type="button" class="bulkbar-btn" data-act="clear" draggable="false">Clear</button>`;
    bulkBar.querySelectorAll("[data-act]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const act = btn.dataset.act;
        const selected = [...cardsWrap.querySelectorAll(".page-card.selected")];
        if(act==="rotL" || act==="rotR"){
          const delta = act==="rotL" ? -90 : 90;
          workspace.rotatePages(selected.map(workspaceId), delta);
          selected.forEach(c=>syncCardState(c));
        }
        if(act==="dup") duplicateCards(selected);
        if(act==="del") removeCards(selected);
        if(act==="clear"){ clearAllSelection(); return; }
        updateBulkBar();
        updateHistoryControls();
      });
    });
  }

  function syncCardState(card){
    const page = workspace.page(workspaceId(card));
    if(!page){ card.style.display="none"; return; }
    card.style.display = page.deleted ? "none" : "";
    card.classList.toggle("selected", page.selected && !page.deleted);
    syncCheckToggle(card, page.selected && !page.deleted);
    card.setAttribute("aria-pressed", String(page.selected && !page.deleted));
    card.dataset.rotation = String(page.rotation);
    const canvas = card.querySelector("canvas");
    if(canvas){
      canvas.classList.remove("rot-90","rot-180","rot-270");
      if(page.rotation) canvas.classList.add("rot-"+page.rotation);
    }
  }

  function syncWorkspace({reorder=false} = {}){
    workspace.pages.forEach(page=>{
      if(!cardById.has(page.id) && !page.blank){
        const card = appendCard(page.docIndex, page.sourcePageIndex+1, page);
        if(page.duplicateOf){
          const label = card.querySelector(".page-num");
          if(label) label.textContent += " (copy)";
        }
      }
    });
    if(reorder){
      const desiredCards = workspace.pages.map(page=>cardById.get(page.id)).filter(Boolean);
      const modelIds = new Set(workspace.pages.map(page=>page.id));
      const slotParents = [...cardsWrap.querySelectorAll('.page-card')]
        .filter(card=>modelIds.has(workspaceId(card)))
        .map(card=>card.parentElement || cardsWrap);
      desiredCards.forEach((card,index)=>(slotParents[index] || cardsWrap).appendChild(card));
    }
    cardById.forEach(syncCardState);
    updateBulkBar();
    updateHistoryControls();
  }

  function refreshSourceLabels(){
    if(!showSourceLabels) return;
    cardById.forEach(card=>{
      const page = workspace.page(workspaceId(card));
      if(!page || page.blank) return;
      const source = workspace.sources.find(item=>item.docIndex===page.docIndex);
      let badge = card.querySelector(".page-source-label");
      if(!badge){
        badge = document.createElement("span");
        badge.className = "page-source-label";
        card.querySelector(".page-num")?.before(badge);
      }
      const sourceLetter = String.fromCharCode(65 + page.docIndex);
      badge.textContent = `${sourceLetter} · ${source?.name || `Document ${page.docIndex+1}`}`;
      badge.title = source?.name || `Document ${page.docIndex+1}`;
      if(source?.color) badge.style.color = source.color;
    });
  }

  function removeCards(cards){
    const removableCards = cards.filter(card=>workspace.page(workspaceId(card)) && card.style.display!=="none");
    if(!workspace.deletePages(removableCards.map(workspaceId))) return;
    removableCards.forEach(card=>{
      card.classList.add("removing");
      setTimeout(()=>{ card.classList.remove("removing"); syncCardState(card); },160);
    });
    updateHistoryControls();
  }

  function wireCard(card){
    if(mode==="select"){
      card.onclick = ()=>{
        const nowSelected = card.classList.toggle("selected");
        workspace.setSelected([workspaceId(card)], nowSelected);
        card.setAttribute("aria-pressed", String(nowSelected));
        updateBulkBar();
      };
    } else if(multiSelect){
      card.addEventListener("click", e=>{
        if(e.target.closest(".page-thumb-actions,.page-remove,.page-check-toggle")) return;
        const nowSelected = card.classList.toggle("selected");
        workspace.setSelected([workspaceId(card)], nowSelected);
        syncCheckToggle(card, nowSelected);
        updateBulkBar();
      });
    }
    const chkToggle = card.querySelector(".page-check-toggle");
    if(chkToggle) chkToggle.onclick = e=>{
      e.stopPropagation();
      const nowSelected = card.classList.toggle("selected");
      workspace.setSelected([workspaceId(card)], nowSelected);
      chkToggle.setAttribute("aria-checked", String(nowSelected));
      updateBulkBar();
    };
    const rotL = card.querySelector(".page-rotate-left");
    const rotR = card.querySelector(".page-rotate-right");
    if(rotL) rotL.onclick = e=>{ e.stopPropagation(); rotateCard(card,-90); };
    if(rotR) rotR.onclick = e=>{ e.stopPropagation(); rotateCard(card,90); };
    const dup = card.querySelector(".page-dup-btn");
    if(dup) dup.onclick = e=>{ e.stopPropagation(); duplicateCard(card); };
    const moveEarlier = card.querySelector(".page-move-earlier");
    const moveLater = card.querySelector(".page-move-later");
    if(moveEarlier) moveEarlier.onclick = e=>{
      e.stopPropagation();
      const previous = card.previousElementSibling;
      if(previous?.classList.contains("page-card")){
        card.parentElement.insertBefore(card, previous);
        workspace.reorder([...cardsWrap.querySelectorAll('.page-card')].filter(c=>c.style.display!=="none").map(workspaceId));
        updateHistoryControls();
      }
    };
    if(moveLater) moveLater.onclick = e=>{
      e.stopPropagation();
      const next = card.nextElementSibling;
      if(next?.classList.contains("page-card")){
        card.parentElement.insertBefore(next, card);
        workspace.reorder([...cardsWrap.querySelectorAll('.page-card')].filter(c=>c.style.display!=="none").map(workspaceId));
        updateHistoryControls();
      }
    };
    const rm = card.querySelector(".page-remove");
    if(rm) rm.onclick = e=>{ e.stopPropagation(); removeCards([card]); };
  }

  /* Phase 7: renders (or re-renders, after a timeout) exactly one card's
     canvas on demand, instead of the old for-loop awaiting every page's
     render up front - that blocked the whole grid behind however many
     pages the PDF had, even the ones scrolled far out of view. Idempotent
     via dataset.rendered, since duplicateCard() and the IntersectionObserver
     below can both ask for the same card. */
  async function renderCardCanvas(card){
    if(card.dataset.rendered === "true") return;
    card.dataset.rendered = "true";
    const pageNum = parseInt(card.dataset.page) + 1;
    const docIdx = parseInt(card.dataset.docIndex || "0");
    const thumb = card.querySelector(".page-thumb");
    const placeholder = thumb && thumb.querySelector(".page-thumb-placeholder");
    try{
      const canvas = await renderPdfPageCanvas(pdocs[docIdx], pageNum, scale);
      const rot = card.dataset.rotation;
      if(rot && rot !== "0") canvas.classList.add("rot-"+rot);
      if(placeholder) placeholder.replaceWith(canvas);
      else if(thumb) thumb.insertBefore(canvas, thumb.firstChild);
    }catch(e){
      card.dataset.rendered = "false"; // let a later intersection retry
      if(placeholder) placeholder.textContent = "⚠";
    }
  }

  /**
   * Builds and appends one page-card, for source `docIdx`'s page `i`
   * (1-based, within that source). Factored out of the original single
   * top-level loop so appendSource() (the "+ Add more files" case) can
   * call the exact same card-building logic for a file added after the
   * initial grid was built, instead of re-implementing it.
   */
  function appendCard(docIdx, i, workspacePage){
    const color = sources[docIdx] && sources[docIdx].color;
    const card = document.createElement("div");
    card.className = "page-card" + (mode==="select" ? " page-card-select" : "");
    card.dataset.page = i-1;
    card.dataset.docIndex = docIdx;
    card.dataset.rotation = "0";
    card.dataset.rendered = "false";
    const pageState = workspacePage || workspace.pages.find(page=>page.docIndex===docIdx && page.sourcePageIndex===i-1 && !cardById.has(page.id));
    card.dataset.workspacePageId = pageState?.id || "";
    card.draggable = mode === "reorder";
    if(mode==="select"){
      // A clickable <div> otherwise has no keyboard affordance at all -
      // wireCard()'s onclick toggle already handles the mouse case.
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-pressed", "false");
      card.setAttribute("aria-label", "Page "+i);
      card.addEventListener("keydown", e=>{
        if(e.key===" " || e.key==="Enter"){ e.preventDefault(); card.click(); }
      });
    }

    const thumb = document.createElement("div");
    thumb.className = "page-thumb";
    if(color){ thumb.style.borderColor = color; thumb.style.borderWidth = "3px"; }
    const placeholder = document.createElement("div");
    placeholder.className = "page-thumb-placeholder";
    placeholder.innerHTML = '<span class="page-thumb-spinner" aria-hidden="true"></span>';
    thumb.appendChild(placeholder);
    if(rotatable || duplicable || mode==="reorder"){
      const actions = document.createElement("div");
      actions.className = "page-thumb-actions";
      let html = "";
      if(rotatable) html += `<button type="button" class="page-rotate-left" aria-label="Rotate page ${i} left" draggable="false">⟲</button><button type="button" class="page-rotate-right" aria-label="Rotate page ${i} right" draggable="false">⟳</button>`;
      if(duplicable) html += `<button type="button" class="page-dup-btn" aria-label="Duplicate page ${i}" draggable="false">⧉</button>`;
      if(mode==="reorder") html += `<button type="button" class="page-move-earlier" aria-label="Move page ${i} earlier" draggable="false">←</button><button type="button" class="page-move-later" aria-label="Move page ${i} later" draggable="false">→</button>`;
      actions.innerHTML = html;
      thumb.appendChild(actions);
    }
    card.appendChild(thumb);

    const label = document.createElement("span");
    label.className = "page-num";
    label.textContent = "Page " + i;
    if(color){ label.style.color = color; label.style.fontWeight = "700"; }
    card.appendChild(label);

    if(mode==="select"){
      const chk = document.createElement("span");
      chk.className = "page-check";
      chk.textContent = "✓";
      card.appendChild(chk);
    } else if(multiSelect){
      // Real checkbox semantics on this dedicated toggle (not the whole
      // card, unlike mode==="select" above) - the card itself is also
      // draggable here (reorder+multiSelect, Split/Organize's case), so
      // role="button" on the whole card would collide with drag-reorder
      // semantics and read ambiguously to a screen reader. tabindex is
      // required since a bare <span> isn't keyboard-reachable by default.
      const chk = document.createElement("span");
      chk.className = "page-check page-check-toggle";
      chk.setAttribute("draggable","false");
      chk.setAttribute("role","checkbox");
      chk.setAttribute("tabindex","0");
      chk.setAttribute("aria-checked","false");
      chk.setAttribute("aria-label","Select page "+i);
      chk.textContent = "✓";
      chk.addEventListener("keydown", e=>{
        if(e.key===" " || e.key==="Enter"){ e.preventDefault(); chk.click(); }
      });
      card.appendChild(chk);
    }
    // Not restricted to mode==="reorder": Delete Pages (mode:"select")
    // now also passes removable:true for its own per-thumbnail ✕ button,
    // reusing this exact same element/wiring rather than a second
    // implementation. No existing caller combines mode:"select" with
    // removable:true, so this only adds behavior for a combination
    // nobody used before - every current reorder+removable caller
    // (Reorder/Add Blank Page/Split/Organize) and every select-mode
    // caller without removable (Rotate/Extract Pages) is unaffected.
    if(removable){
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "page-remove";
      rm.setAttribute("aria-label", "Remove page "+i);
      rm.setAttribute("draggable","false");
      rm.textContent = "✕";
      card.appendChild(rm);
    }
    wireCard(card);
    cardsWrap.appendChild(card);
    if(pageState) cardById.set(pageState.id, card);
    renderObserver.observe(card);
    if(evictObserver) evictObserver.observe(card);
    return card;
  }

  // Phase 7 (see renderCardCanvas comment below): only render a card's
  // canvas once it's actually scrolled near view. Declared before the
  // initial build loop (instead of after, as originally) so appendCard()
  // above can register newly-built cards with it too.
  const renderObserver = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(!entry.isIntersecting) return;
      renderCardCanvas(entry.target);
      renderObserver.unobserve(entry.target);
    });
  }, {root:null, rootMargin:"600px 0px 600px 0px", threshold:0});

  // Phase 7: on a large document, a rendered card's canvas is never
  // released once scrolled past - a 200-page PDF fully scrolled through
  // in Delete/Extract/Reorder/Split/Organize/Rotate would otherwise hold
  // ~200 thumbnail bitmaps (~40MB+) resident for the rest of the panel's
  // life. Evicts back to the same placeholder appendCard() starts with
  // (renderObserver already knows how to fill it back in) once a card is
  // scrolled a long way past view - a much wider margin than the render
  // observer's so ordinary scrolling within one screenful never thrashes
  // render/evict/render. Skipped entirely below a page-count threshold
  // (~12MB of thumbnails) where there's nothing worth reclaiming - same
  // "only long documents evict" threshold philosophy as Sign PDF/Crop
  // PDF's own page-viewport KEEP_RADIUS eviction. Mid-drag/selected cards
  // are left alone rather than yanking a canvas out from under an
  // in-progress interaction.
  const evictLargeDocs = numPages > 60;
  const evictObserver = evictLargeDocs ? new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting) return;
      const card = entry.target;
      if(card.dataset.rendered !== "true") return;
      if(card.classList.contains("selected") || card.classList.contains("dragging")) return;
      const cv = card.querySelector("canvas");
      const thumb = card.querySelector(".page-thumb");
      if(!cv || !thumb) return;
      const placeholder = document.createElement("div");
      placeholder.className = "page-thumb-placeholder";
      placeholder.innerHTML = '<span class="page-thumb-spinner" aria-hidden="true"></span>';
      cv.replaceWith(placeholder);
      card.dataset.rendered = "false";
      renderObserver.observe(card); // re-renders on the way back into view
    });
  }, {root:null, rootMargin:"3000px 0px 3000px 0px", threshold:0}) : null;

  pdocs.forEach((pdoc, docIdx)=>{
    for(let i=1;i<=pdoc.numPages;i++){
      const pageState = workspace.pages.find(page=>page.docIndex===docIdx && page.sourcePageIndex===i-1);
      appendCard(docIdx, i, pageState);
    }
  });
  refreshSourceLabels();
  if(mode==="reorder") wirePageGridDrag(cardsWrap, ()=>{
    workspace.reorder([...cardsWrap.querySelectorAll('.page-card')].filter(c=>c.style.display!=="none").map(workspaceId));
    updateHistoryControls();
  });

  if(historyCtl){
    historyCtl.addEventListener("click", event=>{
      const action = event.target.closest("[data-history]")?.dataset.history;
      if(!action) return;
      const changed = action==="undo" ? workspace.undo() : workspace.redo();
      if(changed) syncWorkspace({reorder:true});
    });
    updateHistoryControls();
  }

  if(zoomable){
    toolbar.querySelectorAll(".zoom-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        toolbar.querySelectorAll(".zoom-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        cardsWrap.classList.remove("zoom-s","zoom-m","zoom-l");
        cardsWrap.classList.add("zoom-"+btn.dataset.zoom);
      });
    });
  }

  let gridKeyHandler = null;
  if(selectionEnabled){
    gridKeyHandler = function keyHandler(e){
      if(!document.body.contains(container)){ document.removeEventListener("keydown", keyHandler); return; }
      const active = document.activeElement;
      if(active && /INPUT|TEXTAREA/.test(active.tagName)) return;
      if((e.ctrlKey||e.metaKey) && !e.shiftKey && e.key.toLowerCase()==="z" && historyEnabled){
        if(workspace.undo()){ e.preventDefault(); syncWorkspace({reorder:true}); }
      } else if(((e.ctrlKey||e.metaKey) && (e.shiftKey && e.key.toLowerCase()==="z" || e.key.toLowerCase()==="y")) && historyEnabled){
        if(workspace.redo()){ e.preventDefault(); syncWorkspace({reorder:true}); }
      } else if((e.key==="Delete"||e.key==="Backspace") && removable){
        const sel = cardsWrap.querySelectorAll(".page-card.selected");
        if(sel.length){ e.preventDefault(); removeCards([...sel]); updateBulkBar(); }
      } else if(e.key==="a" && (e.ctrlKey||e.metaKey)){
        e.preventDefault();
        selectAllPages();
      } else if(e.key==="Escape"){
        clearAllSelection();
      } else if(rotatable && (e.key==="r"||e.key==="R")){
        const sel = cardsWrap.querySelectorAll(".page-card.selected");
        if(sel.length){
          workspace.rotatePages([...sel].map(workspaceId), e.shiftKey ? -90 : 90);
          [...sel].forEach(syncCardState);
          updateHistoryControls();
        }
      }
    }
    document.addEventListener("keydown", gridKeyHandler);
  }

  let gridDestroyed = false;
  let unregisterGridCleanup = () => {};
  async function destroyGrid(){
    if(gridDestroyed) return;
    gridDestroyed = true;
    unregisterGridCleanup();
    renderObserver.disconnect();
    evictObserver?.disconnect();
    if(gridKeyHandler) document.removeEventListener("keydown", gridKeyHandler);
    const documents = pdocs;
    pdocs = [];
    await Promise.allSettled(documents.filter(Boolean).map(pdoc=>pdoc.destroy()));
  }
  unregisterGridCleanup = registerToolCleanup(destroyGrid);

  return {
    workspace,
    destroy: destroyGrid,
    getOrder(){ return workspace.activePages.map(page=>page.sourcePageIndex); },
    getSelected(){ return new Set(workspace.selectedPages.map(page=>page.sourcePageIndex)); },
    // Blank cards (see insertBlankPage() below - Add Blank Page's own grid
    // is the only caller that ever creates one) carry no real source page
    // to copy, so they report {blank:true, width, height} instead of
    // {index, docIndex} - buildPdfFromPages() branches on that flag.
    // Every other card is completely unaffected (dataset.blank is simply
    // absent), so this is a strict addition, not a behavior change, for
    // every existing caller of getPages().
    getPages(){ return workspace.toPageSpecs(); },
    getSelectedPages(){ return workspace.toPageSpecs({selectedOnly:true}); },
    getDeletedPages(){ return workspace.pages.filter(page=>page.deleted).map(page=>workspace.toPageSpec(page)); },
    selectSourcePages(indices, docIndex=0){
      const wanted = new Set(indices);
      workspace.selectOnly(workspace.activePages
        .filter(page=>!page.blank && page.docIndex===docIndex && wanted.has(page.sourcePageIndex))
        .map(page=>page.id));
      syncWorkspace();
    },
    pageSpecsForSourceIndexes(indices, options){ return workspace.pageSpecsForSourceIndexes(indices, options); },
    exportPdf(srcDocs, options){ return buildPdfFromWorkspace(srcDocs, workspace, options); },
    selectOddEven(which){
      [...cardsWrap.querySelectorAll(".page-card")].filter(c=>c.style.display!=="none").forEach((c,pos)=>{
        const isOdd = pos % 2 === 0;
        const on = which==="odd" ? isOdd : !isOdd;
        c.classList.toggle("selected", on);
        syncCheckToggle(c, on);
      });
      workspace.selectOnly([...cardsWrap.querySelectorAll(".page-card.selected")].map(workspaceId));
      updateBulkBar();
    },
    selectAll: selectAllPages,
    clearSelection: clearAllSelection,
    rotateAll(delta){
      workspace.rotatePages(workspace.activePages.map(page=>page.id), delta);
      cardsWrap.querySelectorAll(".page-card").forEach(syncCardState);
      updateHistoryControls();
    },
    // Rotate PDF's sidebar "Apply Rotation" button needs this - its own
    // hint text already promises "select several pages and use 'Apply to
    // selected/all' below", but rotateAll() above always rotates
    // EVERYTHING regardless of selection, silently contradicting that
    // promise (confirmed: selecting 3 pages and clicking it rotated the
    // whole document). rotateAll() itself is left alone since Split/
    // Organize's own bulk-bar rotate buttons already correctly scope to
    // selection independently, via this same rotateCard() - this just
    // exposes the equivalent for Rotate's separate sidebar control.
    rotateSelected(delta){
      workspace.rotateSelected(delta);
      cardsWrap.querySelectorAll(".page-card.selected").forEach(syncCardState);
      updateHistoryControls();
    },
    undo(){ const changed=workspace.undo(); if(changed) syncWorkspace({reorder:true}); return changed; },
    redo(){ const changed=workspace.redo(); if(changed) syncWorkspace({reorder:true}); return changed; },
    /**
     * Appends another file's pages to the end of the existing grid without
     * disturbing any card already placed/reordered/rotated - the "+ Add
     * more files" case in Organize PDF. Returns the new source's docIndex.
     */
    async addSource(bytes, color, metadata={}){
      const docIdx = pdocs.length;
      const loadedSourceBytes = workspace.sources.reduce((sum,source)=>sum+source.size, 0);
      if(loadedSourceBytes + bytes.byteLength > maxWorkspaceBytes){
        throw new Error(`Adding this PDF would exceed the ${Math.round(maxWorkspaceBytes/(1024*1024))} MB browser workspace limit.`);
      }
      const pdoc = await loadPdfJsSafe({data:bytes.slice(0)});
      const loadedPageCount = workspace.sources.reduce((sum,source)=>sum+source.pageCount, 0);
      if(loadedPageCount + pdoc.numPages > maxWorkspacePages){
        await pdoc.destroy();
        throw new Error(`Adding this PDF would exceed the ${maxWorkspacePages}-page browser workspace limit.`);
      }
      pdocs.push(pdoc);
      sources.push({bytes, color, ...metadata});
      const sourceId = `source-${docIdx+1}`;
      workspace.sources.push({
        id:sourceId, name:metadata.name || metadata.label || `Document ${docIdx+1}`, pageCount:pdoc.numPages,
        docIndex:docIdx, size:Number(metadata.size)||bytes.byteLength, type:metadata.type||"application/pdf",
        lastModified:Number(metadata.lastModified)||0, color:color||null, extensions:{...(metadata.extensions||{})}
      });
      const added = workspace.addPages(Array.from({length:pdoc.numPages}, (_,sourcePageIndex)=>({sourceId, docIndex:docIdx, sourcePageIndex})));
      for(let i=1;i<=pdoc.numPages;i++) appendCard(docIdx, i, added[i-1]);
      refreshSourceLabels();
      updateHistoryControls();
      return docIdx;
    },
    /** Removes every card belonging to the given docIndex (a file removed from the sidebar list). */
    removeSource(docIdx){
      cardsWrap.querySelectorAll(`.page-card[data-doc-index="${docIdx}"]`).forEach(c=>{
        cardById.delete(workspaceId(c));
        c.remove();
      });
      workspace.removeSource(docIdx);
      const removedDocument = pdocs[docIdx];
      pdocs[docIdx] = null;
      removedDocument?.destroy();
      updateBulkBar();
      updateHistoryControls();
    },
    reorderSources(docIndexes){
      const changed = workspace.reorderSources(docIndexes);
      if(changed) syncWorkspace({reorder:true});
      return changed;
    },
    /**
     * Inserts a real, blank page-card at on-screen position `afterIndex`
     * (0 = before every current card) - Add Blank Page's own workflow.
     * Deliberately its own small function rather than a branch inside
     * appendCard()/renderCardCanvas() (which every mode/tool above
     * shares): a blank card has no source pdoc page to render, so
     * reusing those would mean threading an "isBlank" special case
     * through code Delete/Extract Pages etc. also depend on, for no
     * benefit - this instead reuses just the two pieces that already
     * generalize cleanly: wireCard() (rotate/remove/select wiring) and
     * rotateCard() (used automatically once the card exists, since it
     * only ever looks at dataset.rotation + a <canvas> child, both of
     * which this card has).
     * Orientation follows whichever neighbor page is closest to the
     * insertion point (previous page if there is one, else the next
     * one, else a default A4 portrait size) - including that neighbor's
     * OWN current rotation, so a blank page inserted next to a page the
     * user already rotated 90 lands visually matching it, not fighting
     * it. The blank page itself always starts at rotation 0; the user
     * can rotate it independently afterward via its own buttons.
     * @param {number} afterIndex - 0-based on-screen position to insert
     *   before (i.e. insert after the card currently at afterIndex-1).
     * @returns {Promise<HTMLElement>} the new card element.
     */
    async insertBlankPage(afterIndex){
      async function dimsOf(card){
        let w, h;
        if(card.dataset.blank==="true"){
          w = parseFloat(card.dataset.blankWidth); h = parseFloat(card.dataset.blankHeight);
        } else {
          const docIdx = parseInt(card.dataset.docIndex||"0");
          const pageNum = parseInt(card.dataset.page)+1;
          const vp = (await pdocs[docIdx].getPage(pageNum)).getViewport({scale:1});
          w = vp.width; h = vp.height;
        }
        const rot = ((parseInt(card.dataset.rotation||"0"))%360+360)%360;
        return (rot===90||rot===270) ? {width:h, height:w} : {width:w, height:h};
      }
      const allCards = [...cardsWrap.querySelectorAll(".page-card")];
      const prevCard = allCards[afterIndex-1] || null;
      const nextCard = allCards[afterIndex] || null;
      const dims = prevCard ? await dimsOf(prevCard)
        : nextCard ? await dimsOf(nextCard)
        : {width:595.28, height:841.89}; // A4 portrait - only when the document has no pages at all

      const card = document.createElement("div");
      card.className = "page-card";
      card.dataset.blank = "true";
      card.dataset.blankWidth = dims.width;
      card.dataset.blankHeight = dims.height;
      card.dataset.rotation = "0";
      card.draggable = mode === "reorder";
      const blankState = workspace.insertPages([{blank:true, width:dims.width, height:dims.height}], afterIndex)[0];
      card.dataset.workspacePageId = blankState.id;

      const thumb = document.createElement("div");
      thumb.className = "page-thumb";
      const targetH = 260, s = targetH/dims.height;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(dims.width*s));
      canvas.height = Math.max(1, Math.round(dims.height*s));
      canvas.getContext("2d").fillStyle = "#fff";
      canvas.getContext("2d").fillRect(0,0,canvas.width,canvas.height);
      thumb.appendChild(canvas);
      if(rotatable || mode==="reorder"){
        const actions = document.createElement("div");
        actions.className = "page-thumb-actions";
        let actionHtml = "";
        if(rotatable) actionHtml += `<button type="button" class="page-rotate-left" aria-label="Rotate blank page left" draggable="false">⟲</button><button type="button" class="page-rotate-right" aria-label="Rotate blank page right" draggable="false">⟳</button>`;
        if(mode==="reorder") actionHtml += `<button type="button" class="page-move-earlier" aria-label="Move blank page earlier" draggable="false">←</button><button type="button" class="page-move-later" aria-label="Move blank page later" draggable="false">→</button>`;
        actions.innerHTML = actionHtml;
        thumb.appendChild(actions);
      }
      card.appendChild(thumb);

      const label = document.createElement("span");
      label.className = "page-num";
      label.textContent = "Blank Page";
      card.appendChild(label);

      if(removable){
        const rm = document.createElement("button");
        rm.type = "button"; rm.className = "page-remove";
        rm.setAttribute("aria-label", "Remove blank page");
        rm.setAttribute("draggable", "false");
        rm.textContent = "✕";
        card.appendChild(rm);
      }
      wireCard(card);
      if(nextCard) cardsWrap.insertBefore(card, nextCard); else cardsWrap.appendChild(card);
      cardById.set(blankState.id, card);
      updateBulkBar();
      updateHistoryControls();
      return card;
    }
  };
}
/**
 * Copies pagesSpec into a fresh PDFDocument, applying each entry's extra
 * rotation on top of whatever rotation the source page already had.
 * Shared by Split/Organize/Rotate so none of them duplicate this copy+
 * rotate logic.
 * @param {import("pdf-lib").PDFDocument} srcDoc - source document.
 * @param {{index: number, rotation: number}[]} pagesSpec - pages to
 *   copy, in output order; `index` may repeat (duplicated pages copy
 *   independently, each with its own `rotation`).
 * @returns {Promise<import("pdf-lib").PDFDocument>}
 */
async function buildPdfFromPages(srcDoc, pagesSpec){
  const newDoc = await PDFDocument.create();
  // A `{blank:true, width, height}` entry (Add Blank Page's own grid -
  // see buildPageGrid()'s insertBlankPage()) has no source page to copy,
  // so it's excluded from the copyPages() batch below and instead
  // creates a fresh blank page directly. copyPages() is still called
  // once for every REAL entry together (not one-by-one), same as
  // before - only the interleaving with blank entries is new, and only
  // applies to callers that actually produce blank entries (currently
  // just Add Blank Page); every other existing caller's pagesSpec has
  // no `blank` entries, so their output is unchanged.
  const realIndices = pagesSpec.filter(p=>!p.blank).map(p=>p.index);
  const copiedPages = await newDoc.copyPages(srcDoc, realIndices);
  let copyCursor = 0;
  for(const spec of pagesSpec){
    const rot = spec.rotation || 0;
    if(spec.blank){
      const page = newDoc.addPage([spec.width, spec.height]);
      if(rot) page.setRotation(degrees(rot % 360));
    } else {
      const p = copiedPages[copyCursor++];
      if(rot) p.setRotation(degrees((p.getRotation().angle + rot) % 360));
      newDoc.addPage(p);
    }
  }
  return newDoc;
}
/**
 * Same as buildPdfFromPages(), but for a page grid built from multiple
 * source files (Organize PDF's multi-file mode) - each pagesSpec entry
 * also carries a docIndex saying which of srcDocs it came from, since
 * pdf-lib's copyPages() only copies from one source document at a time.
 * @param {PDFDocument[]} srcDocs
 * @param {{index:number, rotation:number, docIndex:number}[]} pagesSpec
 */
async function buildPdfFromMultiDoc(srcDocs, pagesSpec){
  const newDoc = await PDFDocument.create();
  // Copy in per-source batches (fewer copyPages() calls than one-by-one),
  // then re-assemble in the caller's original order.
  const byDoc = new Map();
  pagesSpec.forEach((spec, pos)=>{
    if(spec.blank) return;
    const docIdx = spec.docIndex || 0;
    if(!byDoc.has(docIdx)) byDoc.set(docIdx, []);
    byDoc.get(docIdx).push({pos, index:spec.index, rotation:spec.rotation||0});
  });
  const copiedByPos = new Array(pagesSpec.length);
  for(const [docIdx, entries] of byDoc){
    const pages = await newDoc.copyPages(srcDocs[docIdx], entries.map(e=>e.index));
    pages.forEach((p,i)=>{
      const rot = entries[i].rotation;
      if(rot) p.setRotation(degrees((p.getRotation().angle + rot) % 360));
      copiedByPos[entries[i].pos] = p;
    });
  }
  pagesSpec.forEach((spec,pos)=>{
    if(spec.blank){
      const page = newDoc.addPage([spec.width, spec.height]);
      if(spec.rotation) page.setRotation(degrees(spec.rotation % 360));
    } else {
      newDoc.addPage(copiedByPos[pos]);
    }
  });
  return newDoc;
}

/**
 * One serialization entry point for every connected page-operation tool.
 * `srcDocs` may be one PDFDocument or a sparse docIndex-aligned array for
 * multi-source Organize workspaces. Callers may export the whole active
 * workspace, only selected pages, everything except selected pages, or a
 * pre-grouped subset (Split) without rebuilding page state themselves.
 */
async function buildPdfFromWorkspace(srcDocs, workspace, {selectedOnly=false, excludeSelected=false, pages=null} = {}){
  const docs = Array.isArray(srcDocs) ? srcDocs : [srcDocs];
  const pagesSpec = pages || workspace.toPageSpecs({selectedOnly, excludeSelected});
  return buildPdfFromMultiDoc(docs, pagesSpec);
}
/**
 * Greedily packs a document's pages into groups whose saved byte size
 * stays under maxBytes, adding one page at a time and closing the current
 * group as soon as the next page would push it over the limit. A single
 * page that alone exceeds maxBytes is still emitted on its own (nothing
 * smaller is possible) rather than looping forever.
 * @param {PDFDocument} srcDoc
 * @param {number} maxBytes
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<{index:number, rotation:number}[][]>}
 */
/**
 * @param {{index:number,rotation:number}[]} [workspacePages] - ordered
 *   active page specifications from PDFWorkspaceModel. Repeated indexes
 *   are preserved so duplicated pages are packed independently.
 */
async function splitBySize(srcDoc, maxBytes, onProgress, workspacePages){
  const total = srcDoc.getPageCount();
  const livePages = workspacePages || Array.from({length:total}, (_,index)=>({index, rotation:0}));
  const groups = [];
  let current = [];
  for(let k=0;k<livePages.length;k++){
    const pageSpec = livePages[k];
    const candidate = [...current, pageSpec];
    const doc = await buildPdfFromPages(srcDoc, candidate);
    const bytes = await doc.save();
    if(bytes.length > maxBytes && current.length > 0){
      groups.push(current);
      current = [pageSpec];
    } else {
      current = candidate;
    }
    if(onProgress) onProgress(k+1, livePages.length);
  }
  if(current.length) groups.push(current);
  return groups;
}
/* Root cause of drops being intermittently ignored (confirmed by directly
   sampling the grid's own layout): the ~16px CSS gap between every pair
   of .page-card elements, and the space below/after the last card,
   belongs to neither card - roughly a third of the grid's visible area,
   measured. The old dragover/drop handlers below required
   e.target.closest(".page-card") to resolve to an actual card, so a
   dragover/drop landing in that dead space did nothing, with zero visual
   feedback explaining why - which reads exactly like "drop sometimes
   just doesn't work," needing another attempt nudged a few pixels onto
   real card pixels. resolveDropTarget() below fixes this at the source:
   when the pointer isn't directly over a card, it falls back to the
   nearest card by geometry, so a drop anywhere reasonably close to the
   grid always resolves to *some* card - dropping in a gap is no longer
   silently ignored, it lands wherever that gap's nearest neighbor is.
   A dedicated insertion-line indicator (rather than only highlighting
   the hovered card's border, as before) also now shows precisely where
   the card will land, addressed at the same target the drop itself
   uses, so what's shown during the drag is exactly what happens on
   release. */
function wirePageGridDrag(container, onReorder){
  let dragEl = null;
  let rafId = null;
  const indicator = document.createElement("div");
  indicator.className = "page-grid-drop-indicator";
  indicator.setAttribute("aria-hidden", "true");

  function candidateCards(){
    return [...container.querySelectorAll(".page-card")].filter(c=>c!==dragEl);
  }
  // Distance from (x,y) to a rect's nearest edge - 0 when the point is
  // already inside it. Used to find the nearest card when the pointer
  // isn't directly over one.
  function distToRect(rect, x, y){
    const dx = Math.max(rect.left-x, 0, x-rect.right);
    const dy = Math.max(rect.top-y, 0, y-rect.bottom);
    return Math.hypot(dx, dy);
  }
  function resolveDropTarget(x, y){
    const direct = document.elementFromPoint(x, y);
    let card = direct && direct.closest && direct.closest(".page-card");
    if(card === dragEl) card = null;
    if(!card){
      let bestDist = Infinity;
      for(const c of candidateCards()){
        const d = distToRect(c.getBoundingClientRect(), x, y);
        if(d < bestDist){ bestDist = d; card = c; }
      }
    }
    if(!card) return null;
    const rect = card.getBoundingClientRect();
    return { card, before: (x - rect.left) < rect.width/2 };
  }
  function showIndicatorAt(target){
    if(!target){ indicator.remove(); return; }
    // card.parentElement, not `container` - identical for every caller
    // except Split's Range/Custom mode, where cards sit nested inside a
    // .range-group-cards wrapper (see regroupSplitPages() in TOOLS.split).
    // insertBefore() requires the reference node to be a direct child of
    // whatever element you call it on, so reordering across two different
    // range groups would throw against the outer `container`; the card's
    // own immediate parent is always correct regardless of nesting depth.
    target.card.parentElement.insertBefore(indicator, target.before ? target.card : target.card.nextSibling);
  }

  container.addEventListener("dragstart", e=>{
    const card = e.target.closest(".page-card");
    if(!card) return;
    dragEl = card;
    card.classList.add("dragging");
    if(e.dataTransfer){
      e.dataTransfer.effectAllowed = "move";
      try{ e.dataTransfer.setData("text/plain", card.dataset.page); }catch(_){}
    }
  });
  container.addEventListener("dragend", ()=>{
    if(rafId){ cancelAnimationFrame(rafId); rafId=null; }
    if(dragEl) dragEl.classList.remove("dragging");
    indicator.remove();
    dragEl = null;
  });
  container.addEventListener("dragover", e=>{
    e.preventDefault();
    if(!dragEl) return;
    if(e.dataTransfer) e.dataTransfer.dropEffect = "move";
    // rAF-throttled: dragover can fire dozens of times per second, and
    // resolveDropTarget() walks every card's getBoundingClientRect() when
    // the pointer isn't over one directly - coalescing to one resolve per
    // frame keeps that cheap even on a large multi-page document, without
    // affecting drop correctness (drop always resolves fresh from its own
    // event coordinates, never from a stale throttled position).
    const {clientX, clientY} = e;
    if(rafId) return;
    rafId = requestAnimationFrame(()=>{
      rafId = null;
      if(!dragEl) return;
      showIndicatorAt(resolveDropTarget(clientX, clientY));
    });
  });
  container.addEventListener("drop", e=>{
    e.preventDefault();
    if(!dragEl) return;
    indicator.remove();
    const target = resolveDropTarget(e.clientX, e.clientY);
    if(!target || target.card===dragEl) return;
    target.card.parentElement.insertBefore(dragEl, target.before ? target.card : target.card.nextSibling);
    if(onReorder) onReorder();
  });
}
/**
 * Drag-to-reorder for Merge PDF's #flist file-card grid (separate from
 * wirePageGridDrag() above, which is hardcoded to .page-card/data-page -
 * this instead reads/writes back the caller's File[] array, since
 * renderFileList() re-renders #flist from scratch on every add/remove and
 * needs the reordered array, not just a rearranged DOM).
 * @param {() => File[]} getFiles - returns the current files array.
 * @param {(reordered: File[]) => void} onReorder - called with the new
 *   order once a drag completes, so the caller can refresh() from it.
 * @returns {{rewire(): void}} rewire() is a no-op - listeners are wired
 *   once via delegation on the (never-replaced) #flist container itself.
 */
function wireFileCardDrag(getFiles, onReorder){
  const flist = document.getElementById("flist");
  function enhanceCard(card){
    card.draggable = true;
    if(card.querySelector(".file-card-order-controls")) return;
    const controls = document.createElement("div");
    controls.className = "file-card-order-controls";
    controls.innerHTML = `<button type="button" data-move="-1" aria-label="Move file earlier">←</button><button type="button" data-move="1" aria-label="Move file later">→</button>`;
    card.appendChild(controls);
  }
  flist.querySelectorAll(".file-card").forEach(enhanceCard);
  let dragEl = null;
  const observer = new MutationObserver(()=>{
    flist.querySelectorAll(".file-card").forEach(enhanceCard);
  });
  observer.observe(flist, {childList:true});
  if(typeof registerToolCleanup === "function") registerToolCleanup(()=>observer.disconnect());
  flist.addEventListener("click", event=>{
    const button = event.target.closest(".file-card-order-controls button");
    if(!button) return;
    event.stopPropagation();
    const card = button.closest(".file-card");
    const files = getFiles().slice();
    const index = Number(card?.dataset.i);
    const target = index + Number(button.dataset.move);
    if(!Number.isInteger(index) || target < 0 || target >= files.length) return;
    [files[index], files[target]] = [files[target], files[index]];
    onReorder(files);
  });
  flist.addEventListener("dragstart", e=>{
    const card = e.target.closest(".file-card");
    if(!card || e.target.closest("button")) return;
    dragEl = card;
    card.classList.add("dragging");
    if(e.dataTransfer){
      e.dataTransfer.effectAllowed = "move";
      try{ e.dataTransfer.setData("text/plain", card.dataset.i); }catch(_){}
    }
  });
  flist.addEventListener("dragend", ()=>{
    if(dragEl) dragEl.classList.remove("dragging");
    flist.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over"));
    if(dragEl){
      const files = getFiles();
      const order = [...flist.querySelectorAll(".file-card")].map(c=>parseInt(c.dataset.i));
      onReorder(order.map(i=>files[i]));
    }
    dragEl = null;
  });
  flist.addEventListener("dragover", e=>{
    e.preventDefault();
    const card = e.target.closest(".file-card");
    if(!card || card===dragEl) return;
    flist.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over"));
    card.classList.add("drag-over");
  });
  flist.addEventListener("drop", e=>{
    e.preventDefault();
    const card = e.target.closest(".file-card");
    if(!card || !dragEl || card===dragEl) return;
    card.classList.remove("drag-over");
    const rect = card.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width/2;
    flist.insertBefore(dragEl, before ? card : card.nextSibling);
  });
  return { rewire(){ flist.querySelectorAll(".file-card").forEach(enhanceCard); } };
}
function canvasToPngBase64(canvas){
  return canvas.toDataURL("image/png").split(",")[1];
}
/* Moved here from js/tools/pdf-page-tools-2.js (Phase 12): shared by the
   header/footer preview canvas AND export in TOOLS.headerfooter, and also
   by TOOLS.pagenumbers's own preview/export (pdf-page-tools-1.js,
   "page1" runtime profile) - one formula for the X position so a live
   preview can't quietly show something the export doesn't match. This
   file is the one thing both the "page1" and "page2" profiles already
   load, which pdf-page-tools-2.js itself is not for "page1" pages -
   defining it there left TOOLS.pagenumbers throwing a real, silently-
   swallowed ReferenceError on every click. marginX is fixed (not user-
   configurable - a running header/footer conventionally sits in a fixed
   top/bottom strip; alignment within that strip is the actual "Position"
   control worth exposing). */
function headerFooterAnchor(align, pageWidth, textWidth, marginX=30){
  if(align==="center") return pageWidth/2 - textWidth/2;
  if(align==="right") return pageWidth - marginX - textWidth;
  return marginX;
}
// statusEl()/setStatus()/resultBox() moved to js/core/pdf-processing-utils.js
// (Phase 11): image-tools.js calls all three on every processing path but
// intentionally does not load this file (tests/routes.smoke.test.js pins
// image-only routes to skip pdf-canvas-widgets.js/pdf-lib/pdf.js), and none
// of the three touch this file's actual canvas widgets (crop handles, page
// grid drag) - they belong with the other cross-tool helpers in
// pdf-processing-utils.js, which every route already loads.
