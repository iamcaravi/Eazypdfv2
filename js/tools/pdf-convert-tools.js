/* ---- PDF to Word (basic, text-only) ---- */
TOOLS.pdf2word = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to Word</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2wordBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to Word</h2>
        <p class="tool-hero-desc">Extracts editable text with real formatting (font size, bold, italic, paragraphs, lists) preserved.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2wordToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to Word</button>
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
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
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
      setStatus("Extracting content...", false, Math.round((i/pdoc.numPages)*100));
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

    setStatus("Building Word document...");
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
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Word to PDF (basic, text-only via mammoth) ---- */
TOOLS.word2pdf = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Word to PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="word2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Word to PDF</h2>
        <p class="tool-hero-desc">Basic version: reads the text from your .docx file and lays it out as a PDF.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".docx", false, "Select .docx file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="word2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to PDF</button>
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
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading Word document...");
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
        new Promise((_, reject) => setTimeout(() => reject(new Error("Reading the document took too long")), 15000))
      ]);
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not read this document (${escapeAttr(e.message)}). Try a different .docx file.</div>`;
      return;
    }
    const text = winAnsiSafe(result.value);
    setStatus("Rendering pages...");
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
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not build the PDF (${escapeAttr(e.message)}).</div>`;
      return;
    }
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- PDF to Excel (basic, one line of text per row) ---- */
TOOLS.pdf2excel = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to Excel</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2excelBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to Excel</h2>
        <p class="tool-hero-desc">Extracts text into rows and columns, approximating the table layout from spacing.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2excelToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to Excel</button>
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
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    // Same rapid-file-replacement/double-click guard as PDF to Word above.
    goBtn.disabled = true;
    try {
    await Promise.all([ensureXLSX(), ensureJSZip()]);
    const bytes=await file.arrayBuffer();
    const pdoc = operation.track(await loadPdfJsSafe({data:bytes}));
    const rows=[];
    const imagePlacements=[];
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus("Detecting tables...", false, Math.round((i/pdoc.numPages)*100));
      const page = await pdoc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(it=>it.str).join(" ").trim();
      if(pageText.length < 6){
        rows.push([`Page ${i} (image content — see embedded image below)`]);
        try{
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.3);
          const rowFrom = rows.length;
          imagePlacements.push({row: rowFrom, col: 0, pngBase64: canvasToPngBase64(canvas), widthPx: canvas.width, heightPx: canvas.height});
          const heightRows = Math.max(4, Math.round(canvas.height/20));
          for(let r=0;r<heightRows;r++) rows.push([]);
        }catch(e){ /* keep the text-only row if rendering fails */ }
      } else {
        rows.push(...extractTableRows(content));
      }
      rows.push([]);
    }
    setStatus("Building Excel workbook...");
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
    const blob = imagePlacements.length ? await embedImagesInXlsx(wbout, imagePlacements) : new Blob([wbout], {type:"application/octet-stream"});
    const outName = suffixedName(file, "converted", "xlsx");
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- PDF to PowerPoint (one full-page image per slide) ---- */
TOOLS.pdf2pptx = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to PowerPoint</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2pptxBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to PowerPoint</h2>
        <p class="tool-hero-desc">Turns every page into its own slide, image-based for pixel-perfect layout.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2pptxToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to PowerPoint</button>
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
    const out=document.getElementById("out"); out.innerHTML=statusEl("Rendering PDF pages...");
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
        setStatus("Rendering PDF pages...", false, Math.round((i/pdoc.numPages)*90));
        const canvas = await renderPdfPageCanvas(pdoc, i, 2);
        const pageBlob = await new Promise(res=>canvas.toBlob(res,"image/jpeg",0.92));
        pages.push({blob:pageBlob, widthPx:canvas.width, heightPx:canvas.height});
      }
      setStatus("Building presentation...", false, 95);
      blob = await buildPptxFromPageImages(pages, file.name.replace(/\.[^./\\]+$/, ""));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not convert this PDF (${escapeAttr(e.message)}). Try a different file.</div>`;
      return;
    }
    const outName = suffixedName(file, "converted", "pptx");
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    setStatus("Done — each page became a full-slide image; text isn't editable in PowerPoint", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Excel to PDF (basic table layout) ---- */
TOOLS.excel2pdf = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Excel to PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="excel2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Excel to PDF</h2>
        <p class="tool-hero-desc">Basic version: converts the first sheet into a simple table PDF.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".xlsx,.xls,.csv", false, "Select spreadsheet")}
      </div>
      <div class="status" role="note">Only the first sheet is converted. If your workbook has more than one sheet, the others are left out of the PDF.</div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="excel2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to PDF</button>
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
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading spreadsheet...");
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
        toast(`Only "${wb.SheetNames[0]}" was converted — ${wb.SheetNames.length - 1} other sheet${wb.SheetNames.length - 1 === 1 ? "" : "s"} (${wb.SheetNames.slice(1).join(", ")}) were left out.`);
      }
      setStatus("Generating PDF pages...");
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
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not convert this spreadsheet (${escapeAttr(e.message)}).</div>`;
      return;
    }
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus("Preparing download...");
    if(!operation.isCurrent()) return;
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};

/* ---- Merge Excel (low-level OOXML/JSZip package merge, see js/core/xlsx-merge.js) ---- */
TOOLS.mergeexcel = function(){
  let files=[];
  const sheetNameCache = new WeakMap();

  openPanel(`
    <div class="panel-head"><h3>Merge Excel</h3></div>
    <div class="panel-body compact tool-workspace merge-workspace" id="mergeexcelBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Merge Excel workbooks</h2>
        <p class="tool-hero-desc">Combine 2 or more .xlsx files into one workbook, keeping each worksheet's own layout and formatting.</p>
      </div>
      <p class="page-grid-hint" id="mergeexcelHint" style="display:none">Add .xlsx files and drag them into the order you want their sheets combined.</p>
      <div class="tool-upload-wrap workspace-host" id="mergeexcelUploadWrap">
        ${fileInputHTML(".xlsx", true, "Select Excel files")}
        <div class="workspace-action-stack" id="mergeexcelFileToolbar" style="display:none">
          <button type="button" class="workspace-action-btn workspace-action-primary" id="mergeexcelAddFab" aria-label="Add more files" data-tip="Add more files">
            +<span class="workspace-action-badge" id="mergeexcelFileCount" hidden></span>
          </button>
        </div>
      </div>
      <div class="tool-content-area merge-info-tip">
        <span class="tip-icon" aria-hidden="true">ℹ️</span><span>Worksheets are combined in file order — drag files to reorder, or remove one before merging. Sheets with the same name are kept as separate sheets (e.g. "Sheet1" and "Sheet1 (2)").</span>
      </div>
      <p class="tool-privacy-hint">🔒 Your Excel files are processed locally in your browser — nothing is uploaded or stored anywhere.</p>
      <div class="split-error" id="mergeexcelError" hidden></div>
      <div class="tool-toolbar" id="mergeexcelToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>Merge Workbooks <span aria-hidden="true">&rarr;</span></button>
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
        sheetsEl.textContent = "Reading sheets…";
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
    showError(files.length===1 ? "Add at least one more .xlsx file — Merge Excel needs 2 or more workbooks." : null);
  };
  document.getElementById("mergeexcelAddFab").addEventListener("click", ()=>document.getElementById("fi").click());
  wireDropzone(fs=>{ files = files.concat(fs.filter(f=>f.name.toLowerCase().endsWith(".xlsx"))); refresh(); });

  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl("Reading workbooks...");
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
      setStatus("Preparing download...");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      setStatus("Done", true);
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
      showError(e && e.message ? e.message : "Something went wrong while merging these workbooks. Please try again.");
    }
  }));
};
