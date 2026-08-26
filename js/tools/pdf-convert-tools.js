/* ---- PDF to Word (basic, text-only) ---- */
TOOLS.pdf2word = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.pdf2word")}</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2wordBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.pdf2word")}</h2>
        <p class="tool-hero-desc">${t("toolPdf2word.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="pdf2wordToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolPdf2word.convertToWord")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2wordToolbar").style.display="none"; document.getElementById("pdf2wordBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2wordToolbar").style.display="flex";
    document.getElementById("pdf2wordBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(T("workspace.statusReadingPdf"));
    // Guards against the same race every Go-button handler in this app
    // needs (see pdf-page-tools-1.js's Compress PDF for the established
    // pattern): without this, clicking Go again - or dropping a
    // replacement file and clicking Go while this run is still in
    // flight - starts a second concurrent conversion writing to the same
    // #out/#statusLine, and whichever finishes last wins regardless of
    // which file it was actually converting.
    goBtn.disabled = true;
    try {
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
    const pageBlocksList = [];
    const pageSizesArr = [];
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus(t("toolPdf2word.statusExtracting"), false, Math.round((i/pdoc.numPages)*100));
      const page_i = await pdoc.getPage(i);
      pageSizesArr.push({widthPt: page_i.view[2]-page_i.view[0], heightPt: page_i.view[3]-page_i.view[1]});
      let visuals = {images:[], shapes:[], colorSpans:[]};
      try{ visuals = await extractPageVisuals(pdoc, i); }catch(e){ /* no vector/image/color data - text still extracts fine */ }
      let pageBlocks = [];
      try{ pageBlocks = await extractPageBlocks(pdoc, i, visuals); }catch(e){ /* fall through to page-image fallback below */ }
      // A page whose entire content is a table (no separate title/body
      // paragraph anywhere on it) has real, extractable text too - only
      // checking "paragraph"-type blocks here was a real bug: a
      // table-only page would incorrectly read as textless and get
      // replaced with a flat page screenshot, discarding the actual
      // editable table structure entirely. Found via a dedicated
      // "image inside table, no surrounding heading" test case that
      // exposed it - every real-bill page happens to have a title
      // paragraph alongside its tables, so this never surfaced before.
      const pageHasText = pageBlocks.some(blockHasRealText);
      let thisPageBlocks = [];
      if(!pageHasText){
        try{
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.6);
          thisPageBlocks = [{type:"image", pngBase64:canvasToPngBase64(canvas), width:canvas.width, height:canvas.height}];
        }catch(e){ /* nothing extractable and nothing renderable - leave this page out */ }
      } else {
        // Merge real embedded images (logo, QR) into the text flow by
        // approximate vertical position instead of only ever falling back
        // to a whole-page screenshot. Wide images (banners/logos spanning
        // most of the page width) render centered inline with the text
        // flow, matching how they actually behave visually. Narrow images
        // (QR codes, stamps, small logos) are independently positioned in
        // the source - not part of any text line - so they're anchored at
        // their real page-relative x/y instead of just being dropped into
        // the flow whenever their Y-sort position happens to fall, which
        // is the only way to keep e.g. a QR code sitting next to its
        // "Scan & Pay" label rather than drifting to wherever text
        // ordering puts it.
        const pageWidthPt = pageSizesArr[pageSizesArr.length-1].widthPt;
        const pageHeightPt = pageSizesArr[pageSizesArr.length-1].heightPt;
        const wideThreshold = pageWidthPt * 0.35;
        const pageImages = visuals.images.map(im=>{
          const wide = im.width >= wideThreshold;
          return {
            type:"image", pngBase64: pdfImageToPngBase64(im.raw),
            width: im.width, height: im.height,
            widthPt: im.width, heightPt: im.height, _y: im.y,
            placement: wide ? "centered" : "anchored",
            xPt: im.x, yFromTopPt: pageHeightPt - (im.y + im.height),
            pageWidthPt, pageHeightPt
          };
        });
        // Geometrically test every image against gridtable cell bounds
        // first - an image genuinely inside a table cell (e.g. a product
        // photo in an "Image" column) should render as part of that
        // cell, not float as a separately-anchored page block. Only
        // images that don't land inside any cell fall through to the
        // existing centered/anchored placement below.
        const unmatchedImages = embedImagesIntoTableCells(pageBlocks, pageImages);
        thisPageBlocks = pageBlocks.concat(unmatchedImages).sort((a,b)=> (b._y||0) - (a._y||0));
      }
      pageBlocksList.push(thisPageBlocks);
    }

    // Detect real repeating headers/footers (e.g. a company name at the
    // top of every page, a legal footer at the bottom) - only promoted
    // to actual DOCX header/footer parts when the SAME normalized text
    // (digits masked, so "Page 1 of 4" / "Page 2 of 4" still match)
    // appears at the top/bottom of a strong majority of pages. Ordinary
    // one-off content near a page edge never matches this bar, since it
    // requires repetition, not just position.
    const {headerRuns, footerRuns} = detectHeaderFooter(pageBlocksList);

    setStatus(t("toolPdf2word.statusBuilding"));
    let prevPageSize = pageSizesArr[0];
    const blocks = [];
    pageBlocksList.forEach((pb, idx)=>{
      blocks.push(...pb);
      if(idx < pageBlocksList.length-1){
        const nextSize = pageSizesArr[idx+1];
        // A plain page break can't change paper size/orientation mid
        // document - only a real DOCX section break can. Only pay that
        // cost when the next page's size actually differs (rounded to
        // avoid a section break firing on sub-point PDF measurement
        // noise between otherwise-identical pages).
        const changed = Math.round(nextSize.widthPt) !== Math.round(prevPageSize.widthPt) || Math.round(nextSize.heightPt) !== Math.round(prevPageSize.heightPt);
        blocks.push(changed ? {type:"pagebreak", sectionSize: prevPageSize} : {type:"pagebreak"});
        prevPageSize = nextSize;
      }
    });
    const finalPageSize = pageSizesArr[pageSizesArr.length-1];
    const blob = await buildMixedDocx(blocks, finalPageSize, {headerRuns, footerRuns});
    const outName = suffixedName(file, "converted", "docx");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Word to PDF (basic, text-only via mammoth) ---- */
TOOLS.word2pdf = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.word2pdf")}</h3></div>
    <div class="panel-body compact tool-workspace" id="word2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.word2pdf")}</h2>
        <p class="tool-hero-desc">${t("toolWord2pdf.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".docx", false, t("toolWord2pdf.selectDocx"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="word2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolWord2pdf.convertToPdf")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("word2pdfToolbar").style.display="none"; document.getElementById("word2pdfBody").classList.remove("is-loaded"); });
    document.getElementById("word2pdfToolbar").style.display="flex";
    document.getElementById("word2pdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolWord2pdf.statusReading"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await ensureMammoth();
    const arrayBuffer = await file.arrayBuffer();
    let result;
    try {
      /* mammoth.extractRawText() has been observed to hang indefinitely
         (never resolving or rejecting) rather than erroring, in some
         environments - without this timeout, that leaves the tool stuck
         on "Reading document..." forever with no way forward, unlike
         pdfThumb's failures elsewhere which can degrade gracefully (no
         text extracted means there's nothing to build a PDF from, so
         this one has to surface as a real error, not a silent skip). */
      result = await Promise.race([
        mammoth.extractRawText({arrayBuffer}),
        new Promise((_, reject) => setTimeout(() => reject(new Error(t("toolWord2pdf.errTookTooLong"))), 15000))
      ]);
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolWord2pdf.errCouldNotRead", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    const text = winAnsiSafe(result.value);
    setStatus(t("toolWord2pdf.statusRenderingPages"));
    let outBytes;
    try {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const size=11, margin=50, maxWidth=495, lineHeight=15;
      let page = doc.addPage([595,842]); let y = 842-margin;
      function newPageIfNeeded(){ if(y<margin){ page=doc.addPage([595,842]); y=842-margin; } }
      text.split("\n").forEach(para=>{
        const words = para.split(/\s+/);
        let line="";
        for(const w of words){
          const test = line? line+" "+w : w;
          if(font.widthOfTextAtSize(test,size) > maxWidth){
            page.drawText(line, {x:margin,y,size,font}); y-=lineHeight; newPageIfNeeded(); line=w;
          } else line=test;
        }
        page.drawText(line,{x:margin,y,size,font}); y-=lineHeight; newPageIfNeeded();
      });
      outBytes = await doc.save();
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolWord2pdf.errCouldNotBuild", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- PDF to Excel (basic, one line of text per row) ---- */
TOOLS.pdf2excel = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.pdf2excel")}</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2excelBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.pdf2excel")}</h2>
        <p class="tool-hero-desc">${t("toolPdf2excel.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="pdf2excelToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolPdf2excel.convertToExcel")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2excelToolbar").style.display="none"; document.getElementById("pdf2excelBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2excelToolbar").style.display="flex";
    document.getElementById("pdf2excelBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(T("workspace.statusReadingPdf"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await Promise.all([ensureXLSX(), ensureJSZip()]);
    const bytes=await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
    const wb = XLSX.utils.book_new();
    const imagePlacements=[];
    // One entry per worksheet appended below, in the SAME order - passed
    // to applyCellFormattingToXlsx so each PDF page's own real geometry/
    // styling only ever applies to ITS OWN sheet. Each PDF page becomes
    // its own worksheet (see the architectural decision below) instead of
    // every page being forced onto one shared row/column grid.
    const pagesFormatting = [];
    // A single Excel workbook has one continuous row/column grid, but a
    // PDF has arbitrary per-page X/Y coordinates - forcing every page
    // onto ONE shared grid means an unrelated table on page 5 can only
    // ever be reconciled against (never truly independent of) whatever
    // page 1 already established, and two structurally different pages
    // permanently compete for the same physical column axis. Since a PDF
    // page break is already a REAL visual break in the source document
    // (the reader's eye resets to a new page), giving each page its own
    // worksheet - its own real MediaBox dimensions, its own real column/
    // row grid, its own real page setup - is the more faithful mapping,
    // not a lesser one: nothing about "closer to the source PDF" is lost
    // by not visually gluing two different physical pages together. A
    // table that genuinely continues across a page break simply repeats
    // its header on the next page's own sheet, exactly as the source PDF
    // itself does when printed/paginated.
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus(t("toolPdf2excel.statusDetectingTables"), false, Math.round((i/pdoc.numPages)*100));
      const pdfPage = await pdoc.getPage(i);
      const pageGeometry = detectPageGeometry(pdfPage.view[2]-pdfPage.view[0], pdfPage.view[3]-pdfPage.view[1]);
      const sheetName = `Page ${i}`.slice(0,31);
      const content = await pdfPage.getTextContent();
      const pageText = content.items.map(it=>it.str).join(" ").trim();
      if(pageText.length < 6){
        const rows = [[`Page ${i} (image content — see embedded image below)`]];
        try{
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.3);
          const rowFrom = rows.length;
          imagePlacements.push({sheetIndex: wb.SheetNames.length, row: rowFrom, col: 0, pngBase64: canvasToPngBase64(canvas), widthPx: canvas.width, heightPx: canvas.height});
          const heightRows = Math.max(4, Math.round(canvas.height/20));
          for(let r=0;r<heightRows;r++) rows.push([]);
        }catch(e){ /* keep the text-only row if rendering fails */ }
        const ws = XLSX.utils.aoa_to_sheet(rows);
        if(pageGeometry) ws["!margins"] = {left:0.7, right:0.7, top:0.75, bottom:0.75, header:0.3, footer:0.3};
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        pagesFormatting.push({gridRanges:[], cellStyles:[], rowHeights:{}, cellEdges:[], pageGeometry});
        continue;
      }
      // Real ruling-line grids and the confident borderless column-band
      // model - the same table detection PDF to Word already relies on -
      // take priority over the old pure text-gap guessing below, which is
      // kept only as the last-resort fallback for a page where this finds
      // no usable structure at all (e.g. no operator-list/visuals data).
      let visuals = {images:[], shapes:[], colorSpans:[]};
      try{ visuals = await extractPageVisuals(pdoc, i); }catch(e){ /* no vector/table-ruling data - fallback below still works */ }
      let blocks = [];
      try{ blocks = await extractPageBlocks(pdoc, i, visuals); }catch(e){ /* fall through to the plain gap-based extractor */ }
      if(!blocks.length){
        const rows = extractTableRows(content);
        const ws = XLSX.utils.aoa_to_sheet(rows);
        if(pageGeometry) ws["!margins"] = {left:0.7, right:0.7, top:0.75, bottom:0.75, header:0.3, footer:0.3};
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        pagesFormatting.push({gridRanges:[], cellStyles:[], rowHeights:{}, cellEdges:[], pageGeometry});
        continue;
      }
      // buildPageLayout constructs THIS page's own real, self-contained
      // coordinate grid from its own blocks alone (no cross-page carry-
      // forward - see the architectural note above), then
      // layoutToSheetRows converts it starting at row 0, since this page
      // is now its own sheet.
      const pageLayout = buildPageLayout(blocks, pdfPage.view[2]-pdfPage.view[0], pdfPage.view[3]-pdfPage.view[1], null);
      const converted = layoutToSheetRows(pageLayout, 0);
      const ws = XLSX.utils.aoa_to_sheet(converted.rows);
      if(converted.merges.length) ws["!merges"] = converted.merges;
      if(pageLayout.colBoundsPt.length > 1){
        // PDF points -> Excel's character-count column-width unit (~7px
        // per character at the default Calibri 11 font, 96 CSS px per
        // 72pt) - the one part of column/cell styling SheetJS's free
        // build actually honors on write (unlike cell.s borders/fonts -
        // see applyCellFormattingToXlsx). Deliberately absolute, not
        // rescaled: pageSetup below sets a paperSize matching THIS page's
        // own real dimensions and prints at natural 100% scale (no
        // fitToWidth stretch), so each column's physical printed width
        // must equal its real PDF width for the printed page to actually
        // match the source page. wch<->pixel formula is Excel's own
        // documented conversion for the default Calibri 11 font (7px
        // Maximum Digit Width): pixels = wch*7 + 5. Real geometry-derived
        // column identity (buildPageLayout's colBoundsPt), not a
        // per-index blended array - this page's own grid, nothing else's.
        const PX_PER_PT = 96/72, MDW = 7;
        ws["!cols"] = pageLayout.colBoundsPt.slice(0,-1).map((x,i)=>{
          const w = pageLayout.colBoundsPt[i+1]-x;
          return {wch: Math.max(1, Math.round(((w||60) * PX_PER_PT - 5) / MDW * 100) / 100)};
        });
      }
      if(pageGeometry){
        // Real physical margins: how far THIS page's own first detected
        // table sits from ITS OWN page edges - not a fixed default, and
        // not borrowed from a different page.
        const firstGrid = blocks.find(b=>b.type==="gridtable" && b.colBounds && b.rowBounds);
        const toIn = pt => Math.max(0.2, pt/72);
        ws["!margins"] = firstGrid ? {
          left: toIn(Math.min(...firstGrid.colBounds)), right: toIn(pageGeometry.widthPt - Math.max(...firstGrid.colBounds)),
          top: toIn(pageGeometry.heightPt - Math.max(...firstGrid.rowBounds)), bottom: toIn(Math.min(...firstGrid.rowBounds)),
          header: 0.3, footer: 0.3
        } : {left:0.7, right:0.7, top:0.75, bottom:0.75, header:0.3, footer:0.3};
      }
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      pagesFormatting.push({gridRanges: converted.gridRanges, cellStyles: converted.cellStyles, rowHeights: converted.rowHeights, cellEdges: converted.cellEdges, pageGeometry});
    }
    setStatus(t("toolPdf2excel.statusBuilding"));
    let wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
    wbout = await applyCellFormattingToXlsx(wbout, pagesFormatting);
    const blob = imagePlacements.length ? await embedImagesInXlsx(wbout, imagePlacements) : new Blob([wbout], {type:"application/octet-stream"});
    const outName = suffixedName(file, "converted", "xlsx");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- PDF to PowerPoint (one full-page image per slide) ---- */
TOOLS.pdf2pptx = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.pdf2pptx")}</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2pptxBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.pdf2pptx")}</h2>
        <p class="tool-hero-desc">${t("toolPdf2pptx.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="pdf2pptxToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolPdf2pptx.convertToPowerPoint")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2pptxToolbar").style.display="none"; document.getElementById("pdf2pptxBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2pptxToolbar").style.display="flex";
    document.getElementById("pdf2pptxBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolPdf2pptx.statusRenderingPages"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    let blob;
    try{
      const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
      const pages = [];
      for(let i=1;i<=pdoc.numPages;i++){
        setStatus(t("toolPdf2pptx.statusRenderingPages"), false, Math.round((i/pdoc.numPages)*90));
        const canvas = await renderPdfPageCanvas(pdoc, i, 2);
        const pageBlob = await new Promise(res=>canvas.toBlob(res,"image/jpeg",0.92));
        pages.push({blob:pageBlob, widthPx:canvas.width, heightPx:canvas.height});
      }
      setStatus(t("toolPdf2pptx.statusBuilding"), false, 95);
      blob = await buildPptxFromPageImages(pages, file.name.replace(/\.[^./\\]+$/, ""));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolPdf2pptx.errCouldNotConvert", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    const outName = suffixedName(file, "converted", "pptx");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus(t("toolPdf2pptx.doneNotEditable"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Excel to PDF (basic table layout) ---- */
TOOLS.excel2pdf = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.excel2pdf")}</h3></div>
    <div class="panel-body compact tool-workspace" id="excel2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.excel2pdf")}</h2>
        <p class="tool-hero-desc">${t("toolExcel2pdf.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".xlsx,.xls,.csv", false, t("toolExcel2pdf.selectSpreadsheet"))}
      </div>
      <div class="status" role="note">${t("toolExcel2pdf.onlyFirstSheetNote")}</div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFiles")}</p>
      <div class="tool-toolbar" id="excel2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("toolWord2pdf.convertToPdf")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("excel2pdfToolbar").style.display="none"; document.getElementById("excel2pdfBody").classList.remove("is-loaded"); });
    document.getElementById("excel2pdfToolbar").style.display="flex";
    document.getElementById("excel2pdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out=document.getElementById("out"); out.innerHTML=statusEl(t("toolExcel2pdf.statusReading"));
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await ensureXLSX();
    let outBytes;
    try {
      const bytes = await file.arrayBuffer();
      const wb = XLSX.read(bytes, {type:"array"});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:""});
      // Explicit, not silent: a workbook with sheets the user can't see
      // converted should never look like a complete conversion.
      if(wb.SheetNames.length > 1 && typeof toast === "function"){
        const count = wb.SheetNames.length - 1;
        const names = wb.SheetNames.slice(1).join(", ");
        toast(t(count === 1 ? "toolExcel2pdf.toastOnlySheetConvertedOne" : "toolExcel2pdf.toastOnlySheetConvertedMany", {sheet: wb.SheetNames[0], count, names}));
      }
      setStatus(t("toolExcel2pdf.statusGenerating"));
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
      const margin=36, size=9, rowHeight=18;
      const pageWidth=842, pageHeight=595; // landscape for wide tables
      let page = doc.addPage([pageWidth,pageHeight]); let y = pageHeight-margin;
      const colCount = Math.max(1, ...rows.map(r=>r.length));
      const colWidth = Math.min(110, (pageWidth-margin*2)/colCount);
      function newPageIfNeeded(){ if(y < margin+rowHeight){ page=doc.addPage([pageWidth,pageHeight]); y=pageHeight-margin; } }
      rows.forEach((row,ri)=>{
        newPageIfNeeded();
        row.forEach((cell,ci)=>{
          const text = winAnsiSafe(String(cell).slice(0,20));
          page.drawText(text, {x:margin+ci*colWidth, y, size, font: ri===0?boldFont:font, color:rgb(0.1,0.1,0.1)});
        });
        y -= rowHeight;
      });
      outBytes = await doc.save();
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolExcel2pdf.errCouldNotConvert", {msg: escapeAttr(e.message)})}</div>`;
      return;
    }
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus(T("workspace.statusPreparingDownload"));
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus(t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Merge Excel (low-level OOXML/JSZip package merge, see js/core/xlsx-merge.js) ---- */
TOOLS.mergeexcel = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let files=[];
  const sheetNameCache = new WeakMap();

  openPanel(`
    <div class="panel-head"><h3>${t("tools.mergeexcel")}</h3></div>
    <div class="panel-body compact tool-workspace merge-workspace" id="mergeexcelBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("toolMergeExcel.heroTitle")}</h2>
        <p class="tool-hero-desc">${t("toolMergeExcel.heroDesc")}</p>
      </div>
      <p class="page-grid-hint" id="mergeexcelHint" style="display:none">${t("toolMergeExcel.addFilesHint")}</p>
      <div class="tool-upload-wrap workspace-host" id="mergeexcelUploadWrap">
        ${fileInputHTML(".xlsx", true, t("toolMergeExcel.selectExcelFiles"))}
        <div class="workspace-action-stack" id="mergeexcelFileToolbar" style="display:none">
          <button type="button" class="workspace-action-btn workspace-action-primary" id="mergeexcelAddFab" aria-label="${t("toolMergeExcel.addMoreFiles")}" data-tip="${t("toolMergeExcel.addMoreFiles")}">
            +<span class="workspace-action-badge" id="mergeexcelFileCount" hidden></span>
          </button>
        </div>
      </div>
      <div class="tool-content-area merge-info-tip">
        <span class="tip-icon" aria-hidden="true">ℹ️</span><span>${t("toolMergeExcel.infoTip")}</span>
      </div>
      <p class="tool-privacy-hint">🔒 ${t("toolMergeExcel.privacyHint")}</p>
      <div class="split-error" id="mergeexcelError" hidden></div>
      <div class="tool-toolbar" id="mergeexcelToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>${t("toolMergeExcel.mergeWorkbooks")} <span aria-hidden="true">&rarr;</span></button>
      </div>
      <div id="out"></div>
    </div>`);

  const errorBox = document.getElementById("mergeexcelError");
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${escapeAttr(msg)}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }

  async function loadSheetNames(file){
    if(sheetNameCache.has(file)) return sheetNameCache.get(file);
    const promise = (async ()=>{
      try{
        await ensureJSZip();
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const wbFile = zip.file("xl/workbook.xml");
        if(!wbFile) return null;
        const wbXml = await wbFile.async("string");
        return [...wbXml.matchAll(/<sheet\b[^>]*\sname="([^"]*)"/g)].map(m=>m[1]);
      }catch(e){ return null; }
    })();
    sheetNameCache.set(file, promise);
    return promise;
  }

  const flistDrag = wireFileCardDrag(()=>files, reordered=>{ files = reordered; refresh(); });
  const refresh = ()=>{
    renderFileList(files, i=>{files.splice(i,1); refresh();});
    document.querySelectorAll("#flist .file-card").forEach((card,i)=>{
      let badge = card.querySelector(".file-card-order");
      if(!badge){ badge = document.createElement("span"); badge.className="file-card-order"; card.prepend(badge); }
      badge.textContent = i+1;
      // Best-effort, per-file sheet-name preview - not required for the
      // merge itself, just lets the user confirm what's inside each file
      // before merging. Silently omitted (never blocks the tool) if the
      // file can't be read as a workbook.
      let sheetsEl = card.querySelector(".file-card-sheets");
      if(!sheetsEl){
        sheetsEl = document.createElement("div");
        sheetsEl.className = "file-card-sheets";
        sheetsEl.textContent = t("toolMergeExcel.readingSheets");
        card.appendChild(sheetsEl);
        loadSheetNames(files[i]).then(names=>{
          if(!sheetsEl.isConnected) return;
          if(names && names.length) sheetsEl.textContent = names.join(", ");
          else sheetsEl.remove();
        });
      }
    });
    flistDrag.rewire();
    document.getElementById("go").disabled = files.length<2;
    document.getElementById("mergeexcelToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("mergeexcelFileToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("mergeexcelHint").style.display = files.length ? "block" : "none";
    const countBadge = document.getElementById("mergeexcelFileCount");
    if(files.length){ countBadge.hidden=false; countBadge.textContent = files.length; } else countBadge.hidden = true;
    document.getElementById("mergeexcelBody").classList.toggle("is-loaded", files.length>0);
    showError(files.length===1 ? t("toolMergeExcel.errAddOneMore") : null);
  };
  document.getElementById("mergeexcelAddFab").addEventListener("click", ()=>document.getElementById("fi").click());
  wireDropzone(fs=>{ files = files.concat(fs.filter(f=>f.name.toLowerCase().endsWith(".xlsx"))); refresh(); });

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolMergeExcel.statusReadingWorkbooks"));
    showError(null);
    try{
      await ensureJSZip();
      const inputs = [];
      for(const f of files) inputs.push({ name: f.name, bytes: await f.arrayBuffer() });
      if(!operation.isCurrent()) return;
      const result = await XlsxMerge.mergeWorkbooks(inputs, (pct, msg)=>{ if(operation.isCurrent()) setStatus(msg, false, pct); });
      if(!operation.isCurrent()) return;
      const blob = new Blob([result.bytes], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      const outName = suffixedName(files[0], "merged", "xlsx");
      setStatus(T("workspace.statusPreparingDownload"));
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
      // Truthful, specific caveats only - never a blanket "some formatting
      // may be lost" disclaimer, and never shown at all when the merge
      // engine found nothing worth flagging.
      if(result.warnings.length){
        const note = document.createElement("div");
        note.className = "status mergeexcel-warning";
        note.setAttribute("role", "note");
        note.innerHTML = `<span aria-hidden="true">⚠️</span><span>${result.warnings.map(w=>escapeAttr(w)).join(" ")}</span>`;
        out.appendChild(note);
      }
    }catch(e){
      out.innerHTML = "";
      showError(e && e.message ? e.message : t("toolMergeExcel.errGenericFailed"));
    }
  }));
};
