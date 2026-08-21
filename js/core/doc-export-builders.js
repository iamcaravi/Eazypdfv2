/* ---- Minimal DOCX builder (text-only, no external docx library needed) ---- */
function escapeXml(s){
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
/* Extracts a page's text as structured paragraphs with per-run bold/
   italic/size instead of one flat unstyled string, so PDF to Word can
   preserve real formatting. Bold/italic come from pdf.js's internal font
   objects (page.commonObjs), which expose the actual parsed font
   descriptor's bold/italic flags - NOT content.styles[fontName].fontFamily,
   which was verified empirically to only ever return a generic CSS
   fallback ("sans-serif") regardless of the real embedded font, so it's
   useless for this. Deliberately out of scope here: real table
   reconstruction and precise text alignment (centered/right) detection -
   both need much more structural inference than font/position data alone
   reliably supports; a future pass could add them without touching this
   function's output shape. */
/* Devanagari vowel-sign reordering fix. U+093F (ि, VOWEL SIGN I) is the one
   Devanagari matra that renders to the LEFT of its base consonant while
   Unicode requires it stored AFTER the consonant. This PDF's embedded
   font's ToUnicode CMap emits glyphs in visual (rendering) order, so
   pdf.js's getTextContent() faithfully reproduces the "wrong" order
   (e.g. "तिथि" comes out as "ितिथ"). Swapping every ि back with the
   consonant it precedes restores the correct logical order; verified
   against real extracted text from the source document. */
function fixDevanagari(text){
  if(!text) return text;
  return text.normalize("NFC").replace(/ि([क-हक़-य़])/g, "$1ि");
}

/* Splits one line's items into cells (as item arrays, so per-run bold/
   italic/size survives) wherever a real visual gap exceeds minGap. Two
   distinct gap encodings show up across real-world PDFs, and a table only
   reads correctly if both are checked: (1) a whitespace-only filler item
   whose own width IS the gap - pdf.js inserts these to fill the space
   between two separately-positioned runs (confirmed against this
   document's actual table rows, e.g. a `" "` item with width 160pt sitting
   between a left-column value and the next label - the item's neighbors
   sit flush against it with ~0 positional jump, so the gap is only visible
   via the filler's own width); (2) a direct x-position jump with no filler
   item at all. Checking only positional jumps (as an earlier version of
   this function did) misses case (1) entirely and finds zero table cells
   on this kind of PDF. */
function splitLineIntoCellItems(items, minGap){
  const cells = [];
  let cur = [], runningX = null;
  for(const it of items){
    const gapBefore = runningX != null ? (it.x - runningX) : 0;
    const isFiller = it.str.trim()==="" && it.width > minGap;
    const gap = isFiller ? Math.max(gapBefore, it.width) : gapBefore;
    if(gap >= minGap && cur.some(x=>x.str.trim())){
      cells.push(cur); cur = [];
    }
    if(!isFiller) cur.push(it);
    runningX = it.x + (it.width || 0);
  }
  if(cur.some(x=>x.str.trim())) cells.push(cur);
  return cells;
}
function cellItemsToText(cellItems){
  return cellItems.map(i=>i.str).join("").trim();
}

/* ============================================================
   PDF -> WORD: DOCUMENT MODEL
   ============================================================
   Everything from here down to buildMixedDocx is organized in two
   strictly separate layers that do not call into each other in the wrong
   direction:

   1. DETECTION (this section): linesToParagraphs, extractPageBlocks,
      detectRulingGridTable, buildBorderlessTable, extractPageVisuals,
      detectHeaderFooter. These read PDF geometry (pdf.js text items,
      operator-list shapes/images) and produce plain JS objects - the
      "document model" - with NO OOXML/DOCX knowledge whatsoever. Audited
      directly (grepped for `<w:` inside every one of these functions) to
      confirm none of them emit XML strings - they never did, this section
      just makes that boundary explicit rather than implicit.

   2. RENDERING (below, starting at runFontsXml/runsToXml): consumes the
      document model and is the ONLY place `<w:...>` OOXML strings get
      built. Nothing in this layer re-derives geometry or makes detection
      decisions; it only shapes already-decided content into valid XML.

   The document model's shapes, produced by the detection layer:

     Block (page-level, in reading order) - one of:
       {type:"paragraph", runs:[Run], listItem, align, spacingBeforePt,
        lineSpacingPt, _y}
       {type:"table", rows:[[{text,span}]], shadeHex?, borderHex?, _y}
         - gap-detected, no real column-boundary geometry, auto-width
       {type:"gridtable", nRows, nCols, cells:[Cell], colWidthsPt,
        colBounds, rowBounds, _y}
         - real geometry-backed columns (ruling-line grid OR the
           borderless global-column-band model), real widths, real
           rowSpan/colSpan
         - colBounds/rowBounds: nCols+1/nRows+1 absolute-y-boundary
           arrays used to test which cell an image's center point falls
           into (see embedImagesIntoTableCells); ruling-grid bounds are
           real rule-line positions, borderless bounds are synthesized
           midpoints between line y's (no real row-height evidence)
       {type:"columns", left:[Paragraph], right:[Paragraph], shadeHex?, _y}
       {type:"image", pngBase64, width, height, widthPt?, heightPt?,
        placement:"centered"|"anchored", xPt?, yFromTopPt?, _y}
       {type:"separator", _y}
       {type:"pagebreak", sectionSize?}

     Run: {text, bold, italic, underline, color:[r,g,b]|null, size,
           fontFamily, isBreak?} - isBreak:true is a detected intentional
           hard line break rendered as <w:br/>, not a separate run of text.

     Cell (gridtable only): {r0, c0, rowSpan, colSpan, text, align,
           vAlign?, padLeftPt, runs?, shadeHex?, borderHex?, images?} -
           runs is only present when the cell's source lines came through
           linesToParagraphs (ruling-line path), giving it real per-line
           structure; the borderless path only ever produces single-line
           cells so it has no runs to preserve. images (array of the same
           image-block shape used at page level, minus placement/xPt/
           yFromTopPt) is attached by embedImagesIntoTableCells when a
           page image's center point geometrically falls inside this
           cell's colBounds/rowBounds - such images are consumed and do
           NOT also appear as a separate page-level image block.

   This model is deliberately NOT a set of classes/typed constructors -
   it's plain object literals, matching the rest of this codebase's style
   (no build step, no TypeScript). The schema above is the actual contract;
   changing a shape here means updating every renderer function that reads
   it (grep the field name across runFontsXml..buildMixedDocx). ============================================================ */

/* Groups already Y-clustered lines into paragraphs: a vertical gap
   noticeably larger than the line's own font size means a new paragraph,
   not just a wrapped line. A fully blank line always forces a break.
   When pageWidth is given, also detects real centered/right-aligned
   headings by comparing the line's own text bounding box against the
   page - not by guessing from content (e.g. "numbers are probably
   right-aligned"), only from geometry: a line whose left and right
   margins are both large and roughly equal reads as centered; one flush
   to the right edge reads as right-aligned. Ordinary left-flowing body
   text always has ~0 left margin so this can't misfire on it. */
function linesToParagraphs(lines, pageWidth){
  const sorted = lines.slice().sort((a,b)=> b.y - a.y);
  const paragraphs = [];
  let prevY = null, prevSize = null, current = null, prevLineRightExtent = null;
  for(const line of sorted){
    const items = line.items;
    const lineText = items.map(i=>i.str).join("");
    if(!lineText.trim()){ current = null; prevLineRightExtent = null; continue; }
    const size = (items.find(i=>i.str.trim()) || items[0]).size;
    const gap = prevY != null ? prevY - line.y : 0;
    const realItems = items.filter(it=>it.str.trim());
    const lineRightExtent = realItems.length ? Math.max(...realItems.map(it=>it.x+it.width)) : 0;
    const isNewParagraph = !current || (prevSize && gap > prevSize*1.6);
    if(isNewParagraph){
      current = {type:"paragraph", runs:[], listItem:false, _y: line.y, _lineGaps:[], _maxRightExtent: lineRightExtent};
      // Preserve the actual PDF vertical gap before this paragraph as
      // real w:spacing (converted pt->twips) instead of a single global
      // spacing value or fabricated blank paragraphs. Only meaningful
      // once a previous paragraph exists on the same page/region; capped
      // to guard against one stray huge gap (e.g. a genuine page-section
      // jump) blowing up the visible spacing.
      if(prevY != null && gap > 0) current.spacingBeforePt = Math.min(gap, 200);
      paragraphs.push(current);
      if(/^\s*([•●▪‣\-*]|\d{1,3}[.)])\s+/.test(lineText)) current.listItem = true;
      if(pageWidth){
        const real = realItems;
        if(real.length){
          const minX = Math.min(...real.map(it=>it.x));
          const maxX = Math.max(...real.map(it=>it.x+it.width));
          const leftGap = minX, rightGap = pageWidth - maxX;
          if(rightGap < pageWidth*0.04 && leftGap > pageWidth*0.2) current.align = "right";
          else if(leftGap > pageWidth*0.15 && rightGap > pageWidth*0.15 && Math.abs(leftGap-rightGap) < pageWidth*0.08) current.align = "center";
        }
      }
    } else {
      // Continuing the same paragraph - this gap is a genuine line-to-
      // line (not paragraph-to-paragraph) baseline distance, collected to
      // derive real intra-paragraph line spacing below.
      current._lineGaps.push(gap);
      // Intentional hard line break vs. normal word-wrap: a wrapped line
      // (except the true last one) fills close to the paragraph's own
      // right margin - so the line we're about to append TO reads as a
      // deliberate break if the PREVIOUS line ended noticeably short of
      // the widest line seen so far in this paragraph. This can't fire on
      // a normal wrapped paragraph (every line but the last stays close
      // to the running max by definition); it also can't detect a break
      // between two lines that are BOTH short with nothing wider to
      // compare against (e.g. a pure short-line address block) - a real,
      // disclosed limitation of geometry-only detection.
      // Threshold tuned conservatively (0.65, not the geometrically
      // "tighter-looking" 0.85): natural word-wrap regularly ends a line
      // anywhere from ~70-99% of the paragraph's fill width depending on
      // where word boundaries fall, so a tighter threshold was firing on
      // ordinary wrapped prose (confirmed against the real bill's long
      // Notes sections). 0.65 still catches lines that are CLEARLY short
      // (address-block-style deliberate breaks) while leaving normal
      // wrapping alone.
      if(prevLineRightExtent != null && current._maxRightExtent > 0 && prevLineRightExtent < current._maxRightExtent*0.65){
        current.runs.push({text:"", isBreak:true});
      }
      current._maxRightExtent = Math.max(current._maxRightExtent, lineRightExtent);
    }
    for(const item of items){
      const last = current.runs[current.runs.length-1];
      const colorKey = item.color ? item.color.join(",") : "";
      if(last && !last.isBreak && last.bold===item.bold && last.italic===item.italic && last.size===item.size
         && !!last.underline===!!item.underline && (last.color?last.color.join(","):"")===colorKey
         && last.fontFamily===item.fontFamily){
        last.text += item.str;
      } else {
        current.runs.push({text:item.str, bold:item.bold, italic:item.italic, size:item.size, underline:item.underline, color:item.color, fontFamily:item.fontFamily});
      }
    }
    current.runs.push({text:" ", bold:false, italic:false, size});
    prevY = line.y; prevSize = size; prevLineRightExtent = lineRightExtent;
  }
  // Derive real intra-paragraph line spacing (only meaningful for
  // paragraphs that actually span 2+ visual lines) instead of one global
  // line height, clamped to a sane range so one noisy gap can't produce
  // pathological spacing.
  paragraphs.forEach(p=>{
    if(p._lineGaps && p._lineGaps.length){
      const avg = p._lineGaps.reduce((a,b)=>a+b,0) / p._lineGaps.length;
      p.lineSpacingPt = Math.max(6, Math.min(60, avg));
    }
    delete p._lineGaps; delete p._maxRightExtent;
  });
  return paragraphs;
}

/* Builds structured page blocks (paragraph / two-column / table) instead
   of one flat left-to-right text dump. Root cause of the old layout loss:
   extractStyledParagraphs (now removed) grouped items into lines by Y only
   and sorted every item on a line strictly by X with zero notion of
   column/region boundaries, so a genuine two-column page (e.g. account
   info on the left, division info on the right, both at the same Y) was
   merged into a single run-on line. This function instead classifies each
   line as a table row (>=3 small, consistent gaps), a two-column split
   (one very wide gap), or plain prose, and only then converts runs of
   same-classified lines into the matching DOCX structure. */
async function extractPageBlocks(pdoc, pageNum, visuals){
  const page = await pdoc.getPage(pageNum);
  await page.getOperatorList(); // populates commonObjs with real font descriptors
  const content = await page.getTextContent();
  const viewport = page.view; // [x0,y0,x1,y1] in PDF points
  const pageWidth = viewport[2] - viewport[0];
  const shapes = (visuals && visuals.shapes) || [];
  const colorSpans = (visuals && visuals.colorSpans) || [];

  const fontStyleCache = {};
  async function styleFor(fontName){
    if(fontStyleCache[fontName]) return fontStyleCache[fontName];
    let style = {bold:false, italic:false, fontFamily:null};
    try{
      const f = await page.commonObjs.get(fontName);
      if(f) style = {bold: !!f.bold, italic: !!f.italic, fontFamily: mapFontFamily(f.fallbackName)};
    }catch(e){ /* keep default (unstyled) if the font object isn't resolvable */ }
    fontStyleCache[fontName] = style;
    return style;
  }

  const lineTolerance = 3;
  const lines = [];
  for(const it of content.items){
    if(it.str === undefined) continue;
    const size = Math.abs(it.transform[0]) || Math.abs(it.transform[3]) || 10;
    const x = it.transform[4], y = it.transform[5];
    const style = it.str.trim() ? await styleFor(it.fontName) : {bold:false, italic:false, fontFamily:null};
    const color = it.str.trim() ? nearestColor(colorSpans, x, y, 40) : null;
    let line = lines.find(l => Math.abs(l.y - y) <= lineTolerance);
    if(!line){ line = {y, items:[]}; lines.push(line); }
    line.items.push({str: it.str, x, width: it.width||0, size, bold: style.bold, italic: style.italic, fontFamily: style.fontFamily, color});
  }
  lines.sort((a,b)=> b.y - a.y); // PDF y grows upward - top of page first
  lines.forEach(l => l.items.sort((a,b)=>a.x-b.x));

  // Real ruling-line tables take priority over whitespace-based detection
  // (PDF ruling lines are ground truth when present). Detect and remove
  // repeatedly so multiple separately-bordered tables on one page can each
  // be found, capped to avoid pathological loops on noisy pages.
  const gridTables = [];
  {
    let remainingShapes = shapes, remainingLines = lines;
    for(let guard=0; guard<5; guard++){
      const grid = detectRulingGridTable(remainingShapes, remainingLines);
      if(!grid) break;
      gridTables.push(grid);
      const [yBottom, yTop] = grid.consumedYRange;
      remainingLines = remainingLines.filter(l => l.y > yTop+2 || l.y < yBottom-2);
      remainingShapes = remainingShapes.filter(s => !grid.consumedShapes.includes(s));
    }
    if(remainingLines.length !== lines.length){ lines.length = 0; lines.push(...remainingLines); }
    if(remainingShapes.length !== shapes.length){ shapes.length = 0; shapes.push(...remainingShapes); }
  }

  // Match thin stroked rects (near-zero height, real width) to the text
  // line they sit directly under - those are underlines, not decorative
  // separators. Whatever's left over after that pass is a genuine
  // standalone rule (page/section divider) with no text to attach to.
  const underlineCandidates = shapes.filter(s => s.stroke && s.h < 2.5 && s.w > 3);
  const usedUnderlines = new Set();
  lines.forEach(line=>{
    const realItems = line.items.filter(i=>i.str.trim());
    if(!realItems.length) return;
    const minX = Math.min(...realItems.map(i=>i.x));
    const maxX = Math.max(...realItems.map(i=>i.x+i.width));
    for(let k=0;k<underlineCandidates.length;k++){
      if(usedUnderlines.has(k)) continue;
      const s = underlineCandidates[k];
      const overlap = Math.min(maxX, s.x+s.w) - Math.max(minX, s.x);
      if(Math.abs(s.y - line.y) <= 4 && overlap > 0.4*Math.min(s.w, maxX-minX)){
        usedUnderlines.add(k);
        line.items.forEach(i=>{ if(i.str.trim()) i.underline = true; });
      }
    }
  });
  const standaloneSeparators = underlineCandidates.filter((s,k)=>!usedUnderlines.has(k) && s.w > 30);

  // Large filled/stroked rects are containers/boxes (header bar, amount
  // boxes, notes box, etc.) - approximate them as shading/border color on
  // whichever table/column block falls inside their vertical extent,
  // picking the tightest (smallest-area) enclosing box so a page-wide
  // background rect doesn't win over a nested one.
  const boxCandidates = shapes.filter(s => s.w > 15 && s.h > 15 && (s.fill || s.stroke));
  function isNearWhite(rgb){ return rgb && rgb[0]>=245 && rgb[1]>=245 && rgb[2]>=245; }
  // Cell text is always rendered in its own (usually dark/black) color, so
  // shading a cell with a dark background would make the text unreadable -
  // this codebase has no mechanism to flip text to white for a dark cell,
  // so skip shading rather than risk illegible output.
  function isSafeForShading(rgb){ return rgb && !isNearWhite(rgb) && (0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2]) >= 140; }
  function findEnclosingBox(yTop, yBottom){
    let best=null, bestArea=Infinity;
    for(const b of boxCandidates){
      if(b.y <= yBottom+3 && b.y+b.h >= yTop-3){
        const area = b.w*b.h;
        if(area < bestArea){ bestArea = area; best = b; }
      }
    }
    return best;
  }

  // classify each line: small-gap split for table-cell candidates, a
  // separate much-larger-gap split for two-column candidates
  const bigGapThreshold = Math.max(80, pageWidth*0.14);
  lines.forEach(line=>{
    const anyReal = line.items.find(i=>i.str.trim());
    const size = anyReal ? anyReal.size : 10;
    const smallGapItemCells = splitLineIntoCellItems(line.items, Math.max(9, size*1.15));
    line.cells = smallGapItemCells.map(ci=>({
      text: cellItemsToText(ci),
      x: ci[0] ? ci[0].x : 0,
      xEnd: ci.length ? Math.max(...ci.map(it=>it.x+it.width)) : 0
    }));
    const bigGapItemCells = splitLineIntoCellItems(line.items, bigGapThreshold);
    if(bigGapItemCells.length === 2 && cellItemsToText(bigGapItemCells[0]) && cellItemsToText(bigGapItemCells[1])){
      line.colSplit = {left: bigGapItemCells[0], right: bigGapItemCells[1]};
    }
  });

  // table runs: start at a line with >=3 cells. A run can be EXTENDED by:
  //  (a) another >=3-cell line (updates the established column x-bands);
  //  (b) a line with FEWER cells (even just 1-2) whose cell x-position(s)
  //      geometrically match an already-established column band - this is
  //      what a real table row looks like when the outer table has a
  //      nested Rate/Amount sub-row pair and one sub-row simply has fewer
  //      populated columns than its siblings (confirmed against the real
  //      bill's "Calculation Details" table: a genuine "Fixed/Demand
  //      Charges  1.68" row only has 2 cells but both land squarely on
  //      established column starts, so it belongs in the same table);
  //  (c) the existing big-gap two-part colSplit signature (a genuine
  //      spanning row: one wide label cell + one value);
  //  (d) AT MOST ONE line that matches none of the above, bridged only if
  //      the line immediately after it resumes the table (another >=3
  //      line or a compatible-band line) - this is what a short in-table
  //      sub-header like "Govt Subsidy" looks like: it has no compatible
  //      column of its own, but real table rows continue right after it.
  //      A genuinely unrelated paragraph between two unrelated tables
  //      does NOT get this benefit of the doubt beyond one line, and only
  //      when the table actually resumes immediately after it.
  const isTableLine = l => l.cells.length >= 3;
  const colTolerance = 12;
  // establishedXs is kept as a small, CLUSTERED set of true column bands
  // (via the same clusterVals used elsewhere), not a raw accumulating
  // list of every cell x ever seen - an unbounded/unclustered set was
  // tried first and caused a serious bug: after enough rows, it contained
  // dozens of scattered x values across the whole page width, so ANY new
  // line's x (including ordinary left-flowing paragraph text sharing the
  // same left margin as the table) coincidentally "matched" something in
  // it, swallowing an entire unrelated Notes/legal-text section into one
  // table. Confirmed and fixed before this shipped.
  function xsCompatibleStrict(establishedXs, cellXs){
    // Require EVERY cell in the candidate line to land on a distinct
    // established band, and require at least 2 cells - a single value
    // coincidentally sharing an x with one column (e.g. the page's left
    // margin, which ordinary paragraphs also start at) is not enough
    // evidence on its own; that weaker single-value case is exactly what
    // the separate one-line "bridge" path below exists for, gated by its
    // own tighter check.
    if(cellXs.length < 2) return false;
    const usedBands = new Set();
    for(const x of cellXs){
      const bandIdx = establishedXs.findIndex((ex,bi)=> !usedBands.has(bi) && Math.abs(ex-x) <= colTolerance);
      if(bandIdx === -1) return false;
      usedBands.add(bandIdx);
    }
    return true;
  }
  lines.forEach(l => l.role = null);
  let i = 0;
  while(i < lines.length){
    if(isTableLine(lines[i])){
      let j = i+1;
      let establishedXs = clusterVals(lines[i].cells.map(c=>c.x), colTolerance);
      let bridgedStray = false;
      while(j < lines.length){
        const lj = lines[j];
        const ljXs = lj.cells.map(c=>c.x);
        if(isTableLine(lj)){
          establishedXs = clusterVals(establishedXs.concat(ljXs), colTolerance);
          j++; continue;
        }
        if(xsCompatibleStrict(establishedXs, ljXs)){
          establishedXs = clusterVals(establishedXs.concat(ljXs), colTolerance);
          j++; continue;
        }
        if(lj.colSplit){
          j++; continue;
        }
        if(!bridgedStray && j+1 < lines.length){
          const lnext = lines[j+1];
          const nextXs = lnext.cells.map(c=>c.x);
          const nextResumes = isTableLine(lnext) || xsCompatibleStrict(establishedXs, nextXs);
          if(nextResumes){ bridgedStray = true; j++; continue; }
        }
        break;
      }
      if(j - i >= 2){
        for(let k=i;k<j;k++) lines[k].role = "table";
        i = j; continue;
      }
    }
    i++;
  }
  // column runs (only among lines a table didn't already claim) - a single
  // isolated split line is still kept as a column pair (not required to
  // repeat across consecutive lines), since real-world layouts like
  // bilingual "label: value    label: value" rows often only line up with
  // their counterpart for one row at a time rather than a clean multi-row
  // block (adjacent rows can land on slightly different baselines per
  // script and fail the Y-tolerance grouping that would otherwise chain
  // them together).
  i = 0;
  while(i < lines.length){
    if(!lines[i].role && lines[i].colSplit){
      let j = i+1;
      while(j < lines.length && !lines[j].role && lines[j].colSplit) j++;
      for(let k=i;k<j;k++) lines[k].role = "column";
      i = j; continue;
    }
    i++;
  }

  // walk top-to-bottom emitting blocks
  const blocks = [];
  i = 0;
  while(i < lines.length){
    const role = lines[i].role;
    let j = i+1;
    while(j < lines.length && lines[j].role === role) j++;
    const run = lines.slice(i, j);
    const yTop = run[0].y, yBottom = run[run.length-1].y;
    const box = findEnclosingBox(yTop, yBottom);
    if(role === "table"){
      const borderless = buildBorderlessTable(run, pageWidth);
      if(borderless){
        const block = {type:"gridtable", nRows:borderless.nRows, nCols:borderless.nCols, cells:borderless.cells, colWidthsPt:borderless.colWidthsPt, colBounds:borderless.colBounds, rowBounds:borderless.rowBounds, _y: run[0].y};
        if(box){
          if(isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
          if(box.stroke) block.borderHex = rgbToHex(box.stroke);
        }
        blocks.push(block);
      } else {
        // The cross-row global-band model couldn't build a confident
        // shared column layout (common on very short 2-3 line label:value
        // runs - too few rows for the band statistics to resolve
        // cleanly). That's a real table candidate though - it already
        // passed the region-level gate (>=3 cells, >=2 consecutive
        // lines, stable count) - so fall back to a simple per-line,
        // auto-width table rather than discarding the structure entirely
        // into flat paragraphs.
        const width = run.reduce((m,l)=>Math.max(m, l.cells.length), 0);
        const rows = run.map(l=>{
          const cellTexts = l.cells.map(c=>fixDevanagari(c.text.trim()));
          if(cellTexts.length === 1 && width > 1) return [{text: cellTexts[0], span: width}];
          const padded = cellTexts.slice();
          while(padded.length < width) padded.push("");
          return padded.map(t=>({text:t, span:1}));
        });
        const block = {type:"table", rows, _y: run[0].y};
        if(box){
          if(isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
          if(box.stroke) block.borderHex = rgbToHex(box.stroke);
        }
        blocks.push(block);
      }
    } else if(role === "column"){
      const leftLines = run.map(l=>({y:l.y, items:l.colSplit.left}));
      const rightLines = run.map(l=>({y:l.y, items:l.colSplit.right}));
      const block = {type:"columns", left: linesToParagraphs(leftLines), right: linesToParagraphs(rightLines), _y: run[0].y};
      if(box && isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
      blocks.push(block);
    } else {
      blocks.push(...linesToParagraphs(run, pageWidth));
    }
    i = j;
  }
  standaloneSeparators.forEach(s=>{
    blocks.push({type:"separator", _y: s.y});
  });
  gridTables.forEach(g=>{
    blocks.push({type:"gridtable", nRows:g.nRows, nCols:g.nCols, cells:g.cells, colWidthsPt:g.colWidthsPt, colBounds:g.colBounds, rowBounds:g.rowBounds, _y: g._y});
  });
  blocks.sort((a,b)=> (b._y||0) - (a._y||0));
  return blocks;
}

/* Merges nearby 1D values (x or y coordinates) into representative
   cluster centers within tolerance - used both for ruling-line row/column
   positions and for borderless cross-row column-band detection. */
function clusterVals(vals, tol){
  const sorted = vals.slice().sort((a,b)=>a-b);
  const out = [];
  for(const v of sorted){
    if(out.length && v-out[out.length-1]<=tol) out[out.length-1] = (out[out.length-1]+v)/2;
    else out.push(v);
  }
  return out;
}

/* Detects a table from real PDF ruling lines (a grid of horizontal +
   vertical strokes) rather than whitespace gaps - the highest-fidelity
   signal when a PDF actually draws visible borders, and the only way to
   reliably detect merged cells (a missing ruling-line segment where one
   would otherwise be expected). Handles horizontal spans (e.g. a title
   row with no vertical dividers) and vertical spans between cells sharing
   an identical column range with no ruling line between them. This
   document's own tables have no ruling lines at all (verified against the
   real bill - confirmed empirically before building this), so this path
   exists for generality across other PDFs and was validated against a
   synthetic bordered/merged-cell test PDF instead. */
function detectRulingGridTable(shapes, lines){
  const hLines = shapes.filter(s=>s.stroke && s.h<2.5 && s.w>15);
  const vLines = shapes.filter(s=>s.stroke && s.w<2.5 && s.h>15);
  if(hLines.length<2 || vLines.length<2) return null;
  const rowYs = clusterVals(hLines.map(l=>l.y), 2).sort((a,b)=>b-a); // descending, top to bottom
  const colXs = clusterVals(vLines.map(l=>l.x), 2).sort((a,b)=>a-b);
  if(rowYs.length<2 || colXs.length<2) return null;
  const nRows = rowYs.length-1, nCols = colXs.length-1;
  if(nRows<1 || nCols<2) return null; // need a real 2D grid, not a single stray box

  function hasVerticalAt(x, yTop, yBottom){
    return vLines.some(l=> Math.abs(l.x-x)<=2 && l.y<=yBottom+2 && (l.y+l.h)>=yTop-2);
  }
  function hasHorizontalAt(y, xLeft, xRight){
    return hLines.some(l=> Math.abs(l.y-y)<=2 && l.x<=xLeft+2 && (l.x+l.w)>=xRight-2);
  }

  // horizontal spans per row (missing internal vertical divider = colspan)
  const rowSpanMap = [];
  for(let r=0;r<nRows;r++){
    const yTop = rowYs[r], yBottom = rowYs[r+1];
    const segs = []; let c=0;
    while(c<nCols){
      let span=1;
      while(c+span<nCols && !hasVerticalAt(colXs[c+span], yTop, yBottom)) span++;
      segs.push({c0:c, span});
      c += span;
    }
    rowSpanMap.push(segs);
  }
  // vertical spans: extend a segment downward while the row below has an
  // identical column range and no horizontal divider separates them
  const consumed = Array.from({length:nRows}, ()=>new Set());
  const cells = [];
  for(let r=0;r<nRows;r++){
    for(const seg of rowSpanMap[r]){
      if(consumed[r].has(seg.c0)) continue;
      let rowSpan=1, rr=r;
      while(rr+1<nRows){
        const below = rowSpanMap[rr+1].find(s=>s.c0===seg.c0 && s.span===seg.span);
        if(!below) break;
        const xLeft = colXs[seg.c0], xRight = colXs[seg.c0+seg.span];
        if(hasHorizontalAt(rowYs[rr+1], xLeft, xRight)) break; // real divider present - not merged
        consumed[rr+1].add(seg.c0);
        rowSpan++; rr++;
      }
      cells.push({r0:r, c0:seg.c0, rowSpan, colSpan:seg.span});
    }
  }

  const tableTop = rowYs[0], tableBottom = rowYs[rowYs.length-1];
  const relevantLines = lines.filter(l => l.y<=tableTop+2 && l.y>=tableBottom-2);
  cells.forEach(cell=>{
    const xLeft = colXs[cell.c0], xRight = colXs[cell.c0+cell.colSpan];
    const yTop = rowYs[cell.r0], yBottom = rowYs[cell.r0+cell.rowSpan];
    const cellLines = relevantLines
      .filter(l => l.y<=yTop+2 && l.y>=yBottom-2)
      .map(l => ({y:l.y, items: l.items.filter(it => it.x>=xLeft-1 && it.x<xRight+1)}))
      .filter(l => l.items.length);
    const paras = linesToParagraphs(cellLines);
    cell.text = paras.map(p => fixDevanagari(p.runs.map(r=>r.text).join(""))).join(" ").trim();
    // Preserve multiple original PDF lines inside one cell as real line
    // breaks within a single <w:p> (see gridTableBlockXml), instead of
    // flattening them into one space-joined string with no internal
    // structure - a 3-line cell should stay ONE cell, not become 3 rows
    // or lose its line boundaries entirely.
    cell.runs = [];
    paras.forEach((p, pi)=>{
      if(pi>0) cell.runs.push({text:"", isBreak:true});
      cell.runs.push(...p.runs);
    });
    // Real geometric alignment: compare the actual text bounding box to
    // the cell's known bounding box (available here because this is a
    // true ruling-line grid, unlike gap-detected tables which have no
    // real cell width to measure against) - not a content-based guess.
    const allItems = cellLines.flatMap(l=>l.items).filter(it=>it.str.trim());
    cell.align = "left";
    cell.vAlign = "top";
    cell.padLeftPt = 4;
    if(allItems.length){
      const itemMinX = Math.min(...allItems.map(it=>it.x));
      const itemMaxX = Math.max(...allItems.map(it=>it.x+it.width));
      const cellWidth = xRight - xLeft;
      const leftGap = itemMinX - xLeft, rightGap = xRight - itemMaxX;
      if(rightGap < cellWidth*0.08 && leftGap > cellWidth*0.15) cell.align = "right";
      else if(leftGap > cellWidth*0.15 && rightGap > cellWidth*0.15 && Math.abs(leftGap-rightGap) < cellWidth*0.12) cell.align = "center";
      // Real cell padding from the actual gap between the text and the
      // cell's left border, clamped to a sane range so a coincidentally
      // huge gap (e.g. a right/center-aligned cell) doesn't blow up the
      // margin - only trusted for left-aligned cells, where the gap is
      // genuinely the visual padding rather than an alignment artifact.
      if(cell.align === "left") cell.padLeftPt = Math.max(2, Math.min(14, leftGap));
      // Vertical alignment: compare the cell's occupied line-Y range
      // against its full row-band height (only meaningful for
      // multi-line-tall cells - ruling-line tables give a real row
      // height to measure against, unlike borderless/gap tables which
      // have no independent row-boundary geometry).
      const lineYs = cellLines.map(l=>l.y);
      const textTop = Math.max(...lineYs), textBottom = Math.min(...lineYs);
      const cellHeight = yTop - yBottom;
      const topGap = yTop - textTop, bottomGap = textBottom - yBottom;
      if(cellHeight > 4){
        if(bottomGap < cellHeight*0.15 && topGap > cellHeight*0.3) cell.vAlign = "bottom";
        else if(topGap > cellHeight*0.25 && bottomGap > cellHeight*0.25 && Math.abs(topGap-bottomGap) < cellHeight*0.15) cell.vAlign = "center";
      }
    }
  });

  return {
    _y: tableTop, nRows, nCols, cells,
    colWidthsPt: colXs.slice(0,-1).map((x,i)=>colXs[i+1]-x),
    colBounds: colXs, rowBounds: rowYs, // real cell boundaries, nCols+1/nRows+1 entries - lets an image's (x,y) be matched to the exact cell it visually sits in
    consumedYRange: [tableBottom, tableTop],
    consumedShapes: [...hLines, ...vLines]
  };
}

/* Builds a real cross-row column-band model for a borderless (no ruling
   lines) table candidate - the primary path for documents like the real
   bill, which has zero vector table borders anywhere in it (verified
   empirically). This replaces determining columns independently per line
   (the previous approach's core weakness: a row with fewer gaps than its
   neighbors just got padded with fabricated blank cells instead of being
   recognized as a genuine colSpan).
     1. Collect every whitespace-split cell from every line in the run.
     2. Cluster their start-x positions into GLOBAL column bands shared by
        the whole run, not computed per line.
     3. Re-assign each line's cells to those bands; a cell whose text
        extends past its band's right edge into the next band(s) becomes a
        real gridSpan instead of an isolated one-off cell.
     4. Bands with no content on a given row still get an empty <w:tc> -
        never silently dropped.
     5. Score confidence from (a) how many rows assign cleanly with no
        overlap collisions and (b) how many bands are actually reused
        across most rows (guards against a couple of coincidentally
        wide-spaced lines - e.g. a normal paragraph with aligned numbers -
        being mistaken for a table). Below threshold, return null so the
        caller falls back to ordinary paragraphs.
   No vertical-merge inference here (unlike the ruling-line path): a blank
   borderless cell has no positive evidence distinguishing "genuinely
   empty" from "merged with the cell above," and guessing wrong would
   corrupt real tabular data, so it's always left as an empty cell. */
function buildBorderlessTable(run, pageWidth){
  if(run.length < 2) return null;
  const allCells = [];
  run.forEach((line, li)=>{
    line.cells.forEach(c=>{ if(c.text) allCells.push({text:c.text, x:c.x, xEnd:c.xEnd, li}); });
  });
  if(allCells.length < 4) return null;

  const avgSize = run.reduce((s,l)=>{ const it=l.items.find(i=>i.str.trim()); return s+(it?it.size:10); }, 0) / run.length;
  const tolerance = Math.max(10, avgSize*1.3);
  const bandXs = clusterVals(allCells.map(c=>c.x), tolerance).sort((a,b)=>a-b);
  if(bandXs.length < 2) return null;
  const nCols = bandXs.length;
  const bandRight = bandXs.map((x,i)=>{
    if(i+1 < bandXs.length) return (x + bandXs[i+1]) / 2;
    const inBand = allCells.filter(c=>c.x >= x-tolerance);
    return Math.max(x+20, ...inBand.map(c=>c.xEnd));
  });
  function bandIndexForX(x){
    let best=0, bestD=Infinity;
    bandXs.forEach((bx,i)=>{ const d=Math.abs(bx-x); if(d<bestD){ bestD=d; best=i; } });
    return best;
  }

  const rowSlotsAll = []; // per row: array[nCols] of null | "SPANNED" | {text,span,x,xEnd}
  let cleanRows = 0;
  const bandUsedInRow = bandXs.map(()=>0);
  run.forEach((line, li)=>{
    const lineCells = allCells.filter(c=>c.li===li).sort((a,b)=>a.x-b.x);
    const rowSlots = new Array(nCols).fill(null);
    let collision = false;
    const usedBandsThisRow = new Set();
    lineCells.forEach(c=>{
      const startIdx = bandIndexForX(c.x);
      let endIdx = startIdx;
      for(let k=startIdx+1; k<nCols; k++){
        if(c.xEnd > bandRight[k-1] + tolerance*0.3) endIdx = k; else break;
      }
      const existing = rowSlots[startIdx];
      if(existing === "SPANNED"){
        // This band is already claimed by an earlier cell's colSpan (e.g.
        // an unusually long value that visually bleeds into the next
        // column) - never silently discard the real text that landed
        // here, even though it means this one row's structure isn't
        // perfectly clean. Append it to whichever cell actually owns the
        // span.
        for(let k=startIdx-1; k>=0; k--){
          if(rowSlots[k] && rowSlots[k]!=="SPANNED"){ rowSlots[k].text += " " + c.text; rowSlots[k].xEnd = Math.max(rowSlots[k].xEnd, c.xEnd); break; }
        }
        collision = true;
        return;
      }
      if(existing){
        // Two cells resolved to the same band start - again, keep both
        // texts rather than dropping one.
        existing.text += " " + c.text;
        existing.xEnd = Math.max(existing.xEnd, c.xEnd);
        collision = true;
        return;
      }
      rowSlots[startIdx] = {text:c.text, span: endIdx-startIdx+1, x:c.x, xEnd:c.xEnd};
      for(let k=startIdx+1; k<=endIdx; k++){ rowSlots[k] = "SPANNED"; usedBandsThisRow.add(k); }
      usedBandsThisRow.add(startIdx);
    });
    if(!collision) cleanRows++;
    usedBandsThisRow.forEach(b=>bandUsedInRow[b]++);
    rowSlotsAll.push(rowSlots);
  });

  const collisionFreeFraction = cleanRows / run.length;
  const bandsWellUsed = bandUsedInRow.filter(count => count >= run.length*0.5).length;
  const bandCoverageScore = bandsWellUsed / nCols;
  const confidence = collisionFreeFraction * Math.max(bandCoverageScore, bandsWellUsed>=2 ? 0.6 : 0);
  if(confidence < 0.55 || bandsWellUsed < 2) return null;

  // Safe vertical-merge detection. Borderless tables have no ruling-line
  // evidence, so a blank cell alone is NEVER enough (it's usually just a
  // genuinely empty value) - a merge is only inferred when ALL of these
  // independent signals agree simultaneously:
  //   1. the upper cell has real text;
  //   2. the lower cell is a TRUE empty slot (not text, not a colSpan
  //      continuation);
  //   3. the row below is not fully blank elsewhere (rules out merging
  //      across a genuinely blank row);
  //   4. the row above is a genuine data row too (has other content);
  //   5. the column behaves like a label column - left-positioned and/or
  //      predominantly non-numeric across the whole table (a blank in a
  //      numeric value column needs the same evidence bar, but is
  //      structurally rare to satisfy honestly since numeric columns
  //      seldom repeat identical unrelated values);
  //   6. both rows share real, DIFFERING content in some OTHER column -
  //      proof they're two distinct genuine data rows forming a matched
  //      pair (e.g. a "Rate" row and an "Amount" row), not coincidence.
  // Conservative on purpose: only ever merges one row into the row
  // immediately below it, never chains multiple rows, and a row that is
  // itself a merge continuation can never become a new merge owner.
  function isNumericText(t){ return /^-?[\d,]+\.?\d*%?$/.test((t||"").trim()); }
  const colStats = bandXs.map((_,c)=>{
    const texts = rowSlotsAll.map(row => (row[c] && row[c]!=="SPANNED") ? row[c].text : null).filter(t=>t!=null && t.trim());
    const numeric = texts.filter(isNumericText).length;
    return {nonNumericFraction: texts.length ? 1-(numeric/texts.length) : 0, populatedFraction: texts.length/rowSlotsAll.length};
  });
  function isLabelLikeColumn(c){
    const positionRatio = nCols>1 ? c/(nCols-1) : 0;
    const labelish = positionRatio <= 0.35 || colStats[c].nonNumericFraction >= 0.6;
    if(!labelish) return false;
    // A column used in only a handful of rows out of a much larger table
    // is not an established, trustworthy label column - it's more likely
    // a one-off artifact from a single oddly-positioned line (confirmed:
    // a real false positive on the real bill's 12-row "Calculation
    // Details" table came from a column populated in exactly 1 of 12
    // rows - a fragment of a multi-row bilingual header, not a genuine
    // repeating label column like the real Energy Charges/Fixed Demand
    // Charges cases, which are populated across roughly half the table's
    // rows). Fraction-based (not an absolute row count) so this doesn't
    // penalize small tables, where even a genuine 2-row label/continuation
    // pair only ever populates the label column in 1 of 2 rows (50%).
    //
    // Symmetric upper bound: a column populated in MOST rows is a column
    // where every entry normally carries its own label - an isolated blank
    // in that column is more likely a genuine data gap (missing/unreadable
    // value on an otherwise-standalone row) than evidence of a repeating
    // label-spans-2-rows pattern. Confirmed with a synthetic stress test
    // (5 independent single-row entries, one deliberately missing its own
    // label for an unrelated reason): without this bound, the row above it
    // gets a false rowSpan, silently absorbing an unrelated row's data
    // under the wrong label. Every genuine merge case measured so far
    // (single pairs and repeating pairs alike) sits at exactly 50% -
    // label populated in 1 of every 2 rows, by construction of the
    // label-row/continuation-row pattern itself - so 0.7 leaves real
    // headroom above that while still excluding the ~0.83 false case.
    // Not a claim this generalizes to every possible mixed table (a table
    // interleaving many standalone rows with a few genuine merges could
    // still push the fraction past 0.7) - only that it's strictly safer
    // than no upper bound at all, on every case tested.
    return colStats[c].populatedFraction >= 0.15 && colStats[c].populatedFraction <= 0.7;
  }
  const mergedFrom = rowSlotsAll.map(()=>new Array(nCols).fill(false));
  const ownerRowSpan = rowSlotsAll.map(()=>new Array(nCols).fill(1));
  for(let r=0; r<rowSlotsAll.length-1; r++){
    // Collect ALL merge-eligible columns for this row pair first, then
    // only commit them if the count is sparse (<=2). A genuine "one label
    // spans a 2-row entry" pattern (Energy Charges, Fixed/Demand Charges)
    // only ever affects the label column(s) - a row pair where MANY
    // columns simultaneously look mergeable is a sign of something else
    // entirely: a messy multi-row bilingual header block sharing an
    // interleaved row-split (confirmed against this exact table's header,
    // which triggered 4 simultaneous column "matches" purely as an
    // artifact of Hindi/English baseline splitting, not a real vertical
    // merge - caught by inspection and blocked by this cap rather than by
    // hardcoding anything about headers specifically).
    const candidates = [];
    for(let c=0; c<nCols; c++){
      if(mergedFrom[r][c]) continue; // a continuation row can't itself own a further merge (no chaining)
      const upper = rowSlotsAll[r][c];
      const lower = rowSlotsAll[r+1][c];
      if(!upper || upper==="SPANNED" || !upper.text || !upper.text.trim()) continue;
      if(lower !== null) continue;
      if(!isLabelLikeColumn(c)) continue;
      const rowBelowHasOther = rowSlotsAll[r+1].some((s,ci)=> ci!==c && s && s!=="SPANNED" && s.text && s.text.trim());
      if(!rowBelowHasOther) continue;
      const rowAboveHasOther = rowSlotsAll[r].some((s,ci)=> ci!==c && s && s!=="SPANNED" && s.text && s.text.trim());
      if(!rowAboveHasOther) continue;
      // Decisive signal: the row below must NOT have its own content in
      // the table's primary (leftmost) label column - if it does, it's
      // clearly an independent new entry with its own label (e.g. the
      // next charge type's row), not a continuation of this one, no
      // matter what else lines up. This single check is what actually
      // separates the real cases from a false one: an earlier version of
      // this algorithm instead required the two rows to share differing
      // text in some other overlapping column as "proof" of a genuine
      // pair - that fired on totally unrelated adjacent rows whenever
      // their numeric columns happened to overlap (nearly always true,
      // since amounts differ row to row) while MISSING the real Energy
      // Charges / Fixed Demand Charges cases (their Rate row and Amount
      // row populate different column positions by table design, so they
      // never share an overlapping populated column at all). Caught by
      // direct inspection against the real bill before shipping.
      const rowBelowOwnLabel = rowSlotsAll[r+1][0];
      const rowBelowHasOwnLabel = rowBelowOwnLabel && rowBelowOwnLabel!=="SPANNED" && rowBelowOwnLabel.text && rowBelowOwnLabel.text.trim();
      if(rowBelowHasOwnLabel) continue;
      candidates.push(c);
    }
    // Only ever commit the single LEFTMOST candidate (the primary/
    // description column) - a genuine label-spans-2-rows entry has
    // exactly one such column; a secondary early column that also
    // technically qualifies (e.g. a "sub-label" like "Energy" sitting
    // next to the real label, or a short numeric value that happens to
    // sit in the first ~35% of the table width) is real evidence for the
    // primary label but not independently trustworthy on its own, so it's
    // left unmerged rather than guessed at - safe, not lossy, just less
    // complete. A row pair with an implausibly large number of
    // simultaneous candidates (>3) skips merging entirely, since that
    // pattern only showed up on this table's messy multi-row bilingual
    // header block, never on a genuine data-row pair (confirmed by
    // inspection: real cases always produced 1-2 candidates, the header
    // produced 4).
    if(candidates.length >= 1 && candidates.length <= 3){
      const c = candidates[0];
      mergedFrom[r+1][c] = true;
      ownerRowSpan[r][c] = 2;
    }
  }

  const cells = [];
  rowSlotsAll.forEach((rowSlots, r)=>{
    for(let c=0; c<nCols; c++){
      if(mergedFrom[r][c]) continue; // swallowed into the owner cell directly above
      const slot = rowSlots[c];
      if(slot === "SPANNED") continue;
      if(slot === null){ cells.push({r0:r, c0:c, rowSpan:1, colSpan:1, text:"", align:"left", padLeftPt:4}); continue; }
      const bandLeft = bandXs[c], bandRightEdge = bandRight[c+slot.span-1];
      const cellWidth = bandRightEdge - bandLeft;
      const leftGap = slot.x - bandLeft, rightGap = bandRightEdge - slot.xEnd;
      let align = "left";
      if(rightGap < cellWidth*0.08 && leftGap > cellWidth*0.15) align = "right";
      else if(leftGap > cellWidth*0.15 && rightGap > cellWidth*0.15 && Math.abs(leftGap-rightGap) < cellWidth*0.12) align = "center";
      // No independent row-height geometry exists for borderless/gap
      // tables (unlike ruling-line tables, which have real row
      // boundaries), so vertical alignment can't be measured here -
      // left unset, which renders as Word's own default (top).
      const padLeftPt = align === "left" ? Math.max(2, Math.min(14, leftGap)) : 4;
      cells.push({r0:r, c0:c, rowSpan: ownerRowSpan[r][c], colSpan:slot.span, text: fixDevanagari(slot.text), align, padLeftPt});
    }
  });

  // Approximate row boundaries for cell-image matching. Borderless tables
  // have no independent row-height geometry (unlike ruling-line tables,
  // which have real horizontal rules) - each row is really just "the line
  // at this y", so boundaries are synthesized as the midpoint between
  // consecutive line y's, with the top/bottom edges extrapolated by the
  // same gap as the nearest real gap. Good enough to classify which row
  // an image's vertical center falls into; not claimed to be the PDF's
  // actual (nonexistent) row-height geometry.
  const rowYCenters = run.map(l=>l.y);
  let rowBounds;
  if(rowYCenters.length === 1){
    rowBounds = [rowYCenters[0]+8, rowYCenters[0]-8];
  } else {
    rowBounds = [rowYCenters[0] + (rowYCenters[0]-rowYCenters[1])];
    for(let r=0;r<rowYCenters.length-1;r++) rowBounds.push((rowYCenters[r]+rowYCenters[r+1])/2);
    rowBounds.push(rowYCenters[rowYCenters.length-1] - (rowYCenters[rowYCenters.length-2]-rowYCenters[rowYCenters.length-1]));
  }

  return {
    nRows: rowSlotsAll.length, nCols, cells,
    colWidthsPt: bandXs.map((x,i)=>bandRight[i]-x),
    colBounds: bandXs.concat([bandRight[bandRight.length-1]]), rowBounds,
    confidence
  };
}

/* Single pass over the page's operator list that tracks the CTM plus the
   current fill/stroke color and line width, extracting three things at
   once (one getOperatorList() walk instead of three separate ones):
     - images: embedded raster images (logo, QR codes) with placement.
     - shapes: filled/stroked rectangles - real vector boxes/borders/
       separator lines/underlines drawn as thin rects, not text.
     - colorSpans: the fill color active at each text-matrix-set point
       (Tm x CTM), i.e. the same (x,y) space getTextContent() itself
       reports per item, so a run's real color can later be found by
       proximity - getTextContent() has no color info of its own since
       PDF text color is graphics-state, not a text-content property. */
async function extractPageVisuals(pdoc, pageNum){
  const page = await pdoc.getPage(pageNum);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const images = [], shapes = [], colorSpans = [];
  let stack = [[1,0,0,1,0,0]];
  let fillColor = [0,0,0], strokeColor = [0,0,0], lineWidth = 1, pendingPath = null, inTextObject = false;
  function mul(m, cur){
    return [
      m[0]*cur[0]+m[1]*cur[2], m[0]*cur[1]+m[1]*cur[3],
      m[2]*cur[0]+m[3]*cur[2], m[2]*cur[1]+m[3]*cur[3],
      m[4]*cur[0]+m[5]*cur[2]+cur[4], m[4]*cur[1]+m[5]*cur[3]+cur[5]
    ];
  }
  function apply(m, x, y){ return [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]]; }
  for(let idx=0; idx<opList.fnArray.length; idx++){
    const fn = opList.fnArray[idx];
    const args = opList.argsArray[idx];
    if(fn === OPS.save){ stack.push(stack[stack.length-1].slice()); }
    else if(fn === OPS.restore){ if(stack.length>1) stack.pop(); }
    else if(fn === OPS.transform){ stack[stack.length-1] = mul(args, stack[stack.length-1]); }
    else if(fn === OPS.setFillRGBColor){ fillColor = [args[0],args[1],args[2]]; }
    else if(fn === OPS.setStrokeRGBColor){ strokeColor = [args[0],args[1],args[2]]; }
    else if(fn === OPS.setLineWidth){ lineWidth = args[0]; }
    else if(fn === OPS.beginText){ inTextObject = true; }
    else if(fn === OPS.endText){ inTextObject = false; }
    else if(fn === OPS.setTextMatrix){
      const m = mul(args, stack[stack.length-1]);
      colorSpans.push({x:m[4], y:m[5], color:fillColor.slice()});
    }
    else if(fn === OPS.constructPath){ pendingPath = args; }
    else if(fn===OPS.fill || fn===OPS.eoFill || fn===OPS.stroke || fn===OPS.fillStroke || fn===OPS.eoFillStroke){
      // Some PDFs (this bill's Devanagari included) render glyphs as
      // filled vector paths inside a BT/ET text object rather than as
      // standard font glyphs - those show up in the operator list as
      // ordinary constructPath+fill calls, indistinguishable from a real
      // background box at the OPS level alone. Skip anything drawn while
      // inside a text object so glyph outlines never get misread as
      // decorative boxes (confirmed root cause of large solid-black
      // "boxes" showing up on pages with vector-drawn Devanagari text).
      if(pendingPath){
        if(!inTextObject){
          const coords = pendingPath[1];
          const m = stack[stack.length-1];
          let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
          for(let k=0; k+1<coords.length; k+=2){
            const [px,py] = apply(m, coords[k], coords[k+1]);
            if(px<minX) minX=px; if(px>maxX) maxX=px; if(py<minY) minY=py; if(py>maxY) maxY=py;
          }
          if(isFinite(minX) && maxX>=minX && maxY>=minY){
            const doFill = fn===OPS.fill||fn===OPS.eoFill||fn===OPS.fillStroke||fn===OPS.eoFillStroke;
            const doStroke = fn===OPS.stroke||fn===OPS.fillStroke||fn===OPS.eoFillStroke;
            shapes.push({x:minX, y:minY, w:maxX-minX, h:maxY-minY, fill: doFill?fillColor.slice():null, stroke: doStroke?strokeColor.slice():null, lineWidth});
          }
        }
        pendingPath = null;
      }
    }
    else if(fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject){
      const objId = args[0];
      const m = stack[stack.length-1];
      const w = Math.hypot(m[0], m[1]), h = Math.hypot(m[2], m[3]);
      if(w < 8 || h < 8) continue; // skip tiny/decorative artifacts
      try{
        const img = await page.objs.get(objId);
        if(img && (img.data || img.bitmap)) images.push({x:m[4], y:m[5], width:w, height:h, raw:img});
      }catch(e){ /* unresolved image object - skip it */ }
    }
  }
  return {images, shapes, colorSpans};
}
function rgbToHex(rgb){
  return rgb.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0")).join("").toUpperCase();
}
function nearestColor(colorSpans, x, y, maxDist){
  let best=null, bestD=maxDist*maxDist;
  for(const c of colorSpans){
    const dx=c.x-x, dy=c.y-y, d=dx*dx+dy*dy;
    if(d<=bestD){ bestD=d; best=c.color; }
  }
  return best;
}
/* page.commonObjs font descriptors expose a reliable generic family via
   .fallbackName ("serif"/"sans-serif"/"monospace") even when the real
   embedded font can't be identified/embedded - map that to a Word-safe
   equivalent instead of forcing every run onto one generic font. */
function mapFontFamily(fallbackName){
  if(fallbackName === "serif") return "Times New Roman";
  if(fallbackName === "monospace") return "Consolas";
  return "Calibri";
}
function pdfImageToPngBase64(img){
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if(img.bitmap){
    ctx.drawImage(img.bitmap, 0, 0, img.width, img.height);
  } else {
    const imgData = ctx.createImageData(img.width, img.height);
    const src = img.data;
    if(img.kind === 3){ // RGBA_32BPP
      imgData.data.set(src);
    } else if(img.kind === 2){ // RGB_24BPP
      for(let p=0, s=0; p<imgData.data.length; p+=4, s+=3){
        imgData.data[p]=src[s]; imgData.data[p+1]=src[s+1]; imgData.data[p+2]=src[s+2]; imgData.data[p+3]=255;
      }
    } else { // grayscale/unknown - best-effort
      for(let p=0, s=0; p<imgData.data.length; p+=4, s++){
        const v = src[s]||0; imgData.data[p]=v; imgData.data[p+1]=v; imgData.data[p+2]=v; imgData.data[p+3]=255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }
  return canvasToPngBase64(canvas);
}

/* Matches page-level images against gridtable cells by pure geometry: an
   image whose center point falls within a cell's colBounds/rowBounds
   range (both derived from real table geometry - ruling-line rules or
   the borderless column-band model) is visually "inside" that cell, so
   it's moved from the flat page-image list into cell.images and
   rendered as part of the table instead of floating as a separate
   anchored/centered block. Only gridtable blocks that expose colBounds/
   rowBounds are considered; images that don't land inside any cell are
   returned unchanged for the existing page-level placement path.
   pageImages entries are the {type:"image", xPt, _y, widthPt, heightPt,
   ...} shape built by TOOLS.pdf2word/test harnesses - xPt/_y are the
   PDF-space (y-up) bottom-left corner, matching colBounds/rowBounds'
   coordinate space. */
function embedImagesIntoTableCells(pageBlocks, pageImages){
  const gridtables = pageBlocks.filter(b=>b.type==="gridtable" && b.colBounds && b.rowBounds);
  const unmatched = [];
  for(const im of pageImages){
    const cx = im.xPt + im.widthPt/2;
    const cy = im._y + im.heightPt/2;
    let placed = false;
    for(const tbl of gridtables){
      const {colBounds, rowBounds, nCols, nRows, cells} = tbl;
      if(cx < colBounds[0] || cx > colBounds[nCols]) continue;
      if(cy > rowBounds[0] || cy < rowBounds[nRows]) continue;
      let c = -1;
      for(let i=0;i<nCols;i++){ if(cx >= colBounds[i] && cx <= colBounds[i+1]){ c=i; break; } }
      let r = -1;
      for(let i=0;i<nRows;i++){ if(cy <= rowBounds[i] && cy >= rowBounds[i+1]){ r=i; break; } }
      if(c===-1 || r===-1) continue;
      const cell = cells.find(cl=> r>=cl.r0 && r<cl.r0+cl.rowSpan && c>=cl.c0 && c<cl.c0+cl.colSpan);
      if(!cell) continue;
      // A center point landing inside a cell isn't enough on its own - a
      // large background/watermark graphic spanning the whole table can
      // have its center coincidentally fall inside one cell's bounds
      // without actually being "inside" that cell at all (real-bill page
      // 1 has exactly this: a 561x155pt background wash behind the entire
      // summary table, center landing in one cell). Require the image to
      // actually fit within (a modest margin over) the matched cell's own
      // real geometry, not just have a center point that lands there.
      const cellWidthPt = colBounds[cell.c0+cell.colSpan] - colBounds[cell.c0];
      const cellHeightPt = rowBounds[cell.r0] - rowBounds[cell.r0+cell.rowSpan];
      if(im.widthPt > cellWidthPt*1.3 || im.heightPt > cellHeightPt*1.3) continue;
      if(!cell.images) cell.images = [];
      cell.images.push({pngBase64: im.pngBase64, width: im.width, height: im.height, widthPt: im.widthPt, heightPt: im.heightPt});
      placed = true;
      break;
    }
    if(!placed) unmatched.push(im);
  }
  return unmatched;
}

/* ============================================================
   PDF -> WORD: DOCX RENDERING LAYER
   ============================================================
   Everything from here to buildMixedDocx consumes the document model
   described in the DOCUMENT MODEL comment above linesToParagraphs and
   turns it into OOXML strings. This is the ONLY part of the pipeline that
   knows DOCX exists - no function above this point (in the detection
   layer) should be modified to fix a rendering problem, and no function
   here should be modified to fix a geometry/detection problem. If a bug
   spans both (e.g. a field the detection layer forgot to set), fix the
   detection layer's output shape, not this layer's handling of a missing
   field. ============================================================ */

/* Word's default document font (Calibri, and most other Latin fonts) has
   no Devanagari glyphs, so any run containing Devanagari codepoints needs
   an explicit complex-script font declared or it can render as tofu/boxes
   in some Word installations. Nirmala UI ships with Windows 10+ and Office
   and is the standard system font for Devanagari, so it's a safe default
   without needing to embed the source PDF's actual (likely unlicensed for
   embedding) font. */
function runFontsXml(text, fontFamily){
  const isDev = DEVANAGARI_RE.test(text);
  if(isDev && fontFamily) return `<w:rFonts w:ascii="${fontFamily}" w:hAnsi="Nirmala UI" w:cs="Nirmala UI"/>`;
  if(isDev) return `<w:rFonts w:cs="Nirmala UI" w:hAnsi="Nirmala UI"/>`;
  if(fontFamily) return `<w:rFonts w:ascii="${fontFamily}" w:hAnsi="${fontFamily}"/>`;
  return "";
}
/* Shared run renderer used both by top-level paragraphs and by table
   cells that contain multiple original PDF lines (see gridTableBlockXml)
   - a run with isBreak:true is a detected intentional hard line break
   (see linesToParagraphs), rendered as a real <w:br/> inside the SAME
   paragraph/cell rather than as a separate paragraph. */
function runsToXml(runs){
  return runs.map(r=>{
    if(r.isBreak) return `<w:r><w:br/></w:r>`;
    if(!r.text) return "";
    const fixed = fixDevanagari(r.text);
    const rPr = [runFontsXml(fixed, r.fontFamily)];
    if(r.bold) rPr.push("<w:b/>");
    if(r.italic) rPr.push("<w:i/>");
    if(r.underline) rPr.push(`<w:u w:val="single"/>`);
    // Skip near-black (nothing gained, it's the default) and near-white
    // (would render as invisible text on the page's white background,
    // since a matching dark cell shading isn't guaranteed to line up).
    if(r.color && !(r.color[0]<20 && r.color[1]<20 && r.color[2]<20) && !(r.color[0]>235 && r.color[1]>235 && r.color[2]>235)){
      rPr.push(`<w:color w:val="${rgbToHex(r.color)}"/>`);
    }
    if(r.size) rPr.push(`<w:sz w:val="${Math.max(2, Math.round(r.size*2))}"/>`); // DOCX sizes are half-points
    const rPrXml = rPr.join("") ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
    return `<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(fixed)}</w:t></w:r>`;
  }).join("");
}
function styledParagraphXml(block){
  const runsXml = runsToXml(block.runs);
  const pPrParts = [];
  if(block.listItem) pPrParts.push(`<w:ind w:left="720"/>`);
  if(block.align && block.align!=="left") pPrParts.push(`<w:jc w:val="${block.align}"/>`);
  // Both paragraph-to-paragraph spacing (before) and intra-paragraph
  // line spacing (line/lineRule) live on the SAME <w:spacing> element -
  // OOXML only allows one per pPr, so they're merged here rather than
  // emitted as two separate elements (which would be invalid).
  const spacingAttrs = [];
  if(block.spacingBeforePt) spacingAttrs.push(`w:before="${Math.round(block.spacingBeforePt*20)}"`);
  if(block.lineSpacingPt) spacingAttrs.push(`w:line="${Math.max(1, Math.round(block.lineSpacingPt*20))}" w:lineRule="atLeast"`);
  if(spacingAttrs.length) pPrParts.push(`<w:spacing ${spacingAttrs.join(" ")}/>`);
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runsXml}</w:p>`;
}
/* block.rows is an array of rows, each row an array of {text, span} cells
   (span>1 = a real gridSpan, e.g. a section-title row spanning the whole
   table width - see extractPageBlocks). */
function tableBlockXml(block){
  const cols = block.rows.reduce((m,r)=>Math.max(m, r.reduce((s,c)=>s+(c.span||1),0)), 1);
  const gridCols = Array.from({length:cols}).map(()=>`<w:gridCol/>`).join("");
  const borderColor = block.borderHex || "BFBFBF";
  const border = `<w:top w:val="single" w:sz="4" w:color="${borderColor}"/><w:left w:val="single" w:sz="4" w:color="${borderColor}"/><w:bottom w:val="single" w:sz="4" w:color="${borderColor}"/><w:right w:val="single" w:sz="4" w:color="${borderColor}"/>`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";
  const rowsXml = block.rows.map(row=>{
    const cellsXml = row.map(cell=>{
      const cellText = cell.text || "";
      const t = escapeXml(cellText);
      const spanXml = cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : "";
      return `<w:tc><w:tcPr><w:tcBorders>${border}</w:tcBorders>${shd}${spanXml}<w:tcMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:r><w:rPr>${runFontsXml(cellText, null)}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p></w:tc>`;
    }).join("");
    return `<w:tr>${cellsXml}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}<w:insideH w:val="single" w:sz="4" w:color="${borderColor}"/><w:insideV w:val="single" w:sz="4" w:color="${borderColor}"/></w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}
/* Real ruling-line table with true row/col spans (see
   detectRulingGridTable). Unlike tableBlockXml's auto-width gap-detected
   tables, this one carries real column widths from the PDF geometry and
   uses fixed layout so Word doesn't freely resize columns, plus true
   <w:vMerge> for vertical spans (tableBlockXml only ever produces
   horizontal gridSpan, since gap-detection alone can't reliably tell
   "genuinely blank cell" apart from "vertically merged cell"). */
/* Shared by buildMixedDocx's top-level image blocks AND gridTableBlockXml's
   cell-embedded images: registers one image into the zip's media folder +
   relationships list and returns the <pic:pic> XML plus its final EMU
   size. zipCtx = {mediaFolder, relEntries, counters:{relCounter,
   imgCounter}} - counters is a mutable object (not primitives) so both
   call sites share one running id sequence, which is required since
   relationship ids must be unique across the whole document.xml.rels. */
function buildPictureXml(im, zipCtx, maxWidthEmu){
  zipCtx.counters.imgCounter++; zipCtx.counters.relCounter++;
  const relId = "rId"+zipCtx.counters.relCounter;
  const imgCounter = zipCtx.counters.imgCounter;
  const fname = `image${imgCounter}.png`;
  zipCtx.mediaFolder.file(fname, im.pngBase64, {base64:true});
  zipCtx.relEntries.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fname}"/>`);
  let cx = im.widthPt!=null ? Math.round(im.widthPt*12700) : pxToEmu(im.width);
  let cy = im.heightPt!=null ? Math.round(im.heightPt*12700) : pxToEmu(im.height);
  if(maxWidthEmu && cx > maxWidthEmu){ const ratio = maxWidthEmu/cx; cx = maxWidthEmu; cy = Math.round(cy*ratio); }
  const picXml = `<pic:pic><pic:nvPicPr><pic:cNvPr id="${imgCounter}" name="Picture ${imgCounter}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`;
  return {picXml, cx, cy, imgCounter, relId};
}
function inlinePictureParagraphXml(im, zipCtx, maxWidthEmu){
  const {picXml, cx, cy, imgCounter} = buildPictureXml(im, zipCtx, maxWidthEmu);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function gridTableBlockXml(block, zipCtx){
  const colWidthsTwips = block.colWidthsPt.map(w=>Math.max(1, Math.round(w*20)));
  const totalTwips = colWidthsTwips.reduce((a,b)=>a+b, 0);
  const gridCols = colWidthsTwips.map(w=>`<w:gridCol w:w="${w}"/>`).join("");
  const borderColor = block.borderHex || "000000";
  const border = `<w:top w:val="single" w:sz="4" w:color="${borderColor}"/><w:left w:val="single" w:sz="4" w:color="${borderColor}"/><w:bottom w:val="single" w:sz="4" w:color="${borderColor}"/><w:right w:val="single" w:sz="4" w:color="${borderColor}"/>`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";

  const occ = Array.from({length:block.nRows}, ()=>new Array(block.nCols).fill(null));
  block.cells.forEach(cell=>{
    for(let r=cell.r0; r<cell.r0+cell.rowSpan; r++)
      for(let c=cell.c0; c<cell.c0+cell.colSpan; c++)
        occ[r][c] = cell;
  });

  let rowsXml = "";
  for(let r=0; r<block.nRows; r++){
    let rowXml = "";
    let c = 0;
    while(c < block.nCols){
      const cell = occ[r][c];
      if(!cell || cell.c0 !== c){ c++; continue; }
      const cellWidthTwips = colWidthsTwips.slice(cell.c0, cell.c0+cell.colSpan).reduce((a,b)=>a+b, 0);
      const tcW = `<w:tcW w:w="${cellWidthTwips}" w:type="dxa"/>`;
      const spanXml = cell.colSpan > 1 ? `<w:gridSpan w:val="${cell.colSpan}"/>` : "";
      if(cell.r0 === r){
        const vMergeXml = cell.rowSpan > 1 ? `<w:vMerge w:val="restart"/>` : "";
        const t = escapeXml(cell.text || "");
        const jcXml = cell.align && cell.align!=="left" ? `<w:jc w:val="${cell.align}"/>` : "";
        const vAlignXml = cell.vAlign && cell.vAlign!=="top" ? `<w:vAlign w:val="${cell.vAlign}"/>` : "";
        const padLeftTwips = Math.round((cell.padLeftPt!=null ? cell.padLeftPt : 4) * 20);
        // Ruling-grid cells carry real per-line runs (built by
        // linesToParagraphs, including any detected hard line breaks
        // between original PDF lines) - use those directly instead of
        // the flattened plain-text fallback (only used by borderless/
        // gap-detected cells, which are always single-line by
        // construction so there's no line structure to preserve there).
        const cellContentXml = (cell.runs && cell.runs.length) ? runsToXml(cell.runs) : `<w:r><w:rPr>${runFontsXml(cell.text||"", null)}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
        // A cell with matched images (embedImagesIntoTableCells) renders
        // them as their own inline paragraph(s) after the text paragraph,
        // capped to the cell's own width in EMU so a real-size photo
        // doesn't blow out the column - a plain visual constraint, not a
        // content-specific rule.
        let cellImagesXml = "";
        if(zipCtx && cell.images && cell.images.length){
          const cellMaxWidthEmu = Math.max(1, cellWidthTwips - 8) * 635;
          cellImagesXml = cell.images.map(im=>inlinePictureParagraphXml(im, zipCtx, cellMaxWidthEmu)).join("");
        }
        rowXml += `<w:tc><w:tcPr>${tcW}<w:tcBorders>${border}</w:tcBorders>${shd}${spanXml}${vMergeXml}${vAlignXml}<w:tcMar><w:left w:w="${padLeftTwips}" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr><w:p>${jcXml?`<w:pPr>${jcXml}</w:pPr>`:""}${cellContentXml}</w:p>${cellImagesXml}</w:tc>`;
      } else {
        rowXml += `<w:tc><w:tcPr>${tcW}<w:tcBorders>${border}</w:tcBorders>${shd}${spanXml}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
      }
      c += cell.colSpan;
    }
    rowsXml += `<w:tr>${rowXml}</w:tr>`;
  }
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalTwips}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}<w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}
function columnsBlockXml(block){
  const leftXml = block.left.map(styledParagraphXml).join("") || "<w:p/>";
  const rightXml = block.right.map(styledParagraphXml).join("") || "<w:p/>";
  const noBorder = `<w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/>`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${noBorder}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr>${shd}</w:tcPr>${leftXml}</w:tc><w:tc><w:tcPr>${shd}</w:tcPr>${rightXml}</w:tc></w:tr></w:tbl>`;
}
/* A vector-drawn rule with no text attached to it (page/section divider,
   e.g. the line under a heading or between report sections) - approximated
   as a paragraph-level bottom border since DOCX has no bare "draw a line
   here" primitive outside of drawing canvases/shapes. */
function separatorBlockXml(){
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>`;
}
/* Detects table columns using pdf.js's synthetic whitespace items rather
   than joining all text into one string and guessing from literal
   multi-space characters (the old approach - unreliable, since many
   table-generating PDFs never embed literal multi-space runs; the visual
   gap between columns comes purely from each cell's text being positioned
   separately, not from spacing characters). Verified empirically first:
   pdf.js inserts a space-only text item to fill the gap between two
   separately-positioned runs, and that item's own `width` IS the actual
   visual gap size in PDF points - a gap noticeably wider than normal
   single/double inter-word spacing reliably signals a real column
   boundary. */
function extractTableRows(content){
  const lineTolerance = 3;
  const lines = [];
  for(const it of content.items){
    const x = it.transform[4], y = it.transform[5];
    let line = lines.find(l => Math.abs(l.y - y) <= lineTolerance);
    if(!line){ line = {y, items:[]}; lines.push(line); }
    line.items.push({str: it.str, x, width: it.width || 0, size: Math.abs(it.transform[0]) || 10});
  }
  lines.sort((a,b)=> b.y - a.y); // PDF y grows upward - top of page first
  lines.forEach(l => l.items.sort((a,b)=>a.x-b.x));

  return lines.map(line => {
    const cells = [];
    let current = "";
    for(const item of line.items){
      const isColumnGap = item.str.trim()==="" && item.width > Math.max(10, item.size*1.2);
      if(isColumnGap && current.trim()){
        cells.push(current.trim());
        current = "";
      } else {
        current += item.str;
      }
    }
    if(current.trim()) cells.push(current.trim());
    return cells.length ? cells : [""];
  });
}
async function buildBasicDocx(paragraphs){
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const bodyParas = paragraphs.map(p=>{
    if(!p.trim()) return `<w:p/>`;
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`;
  }).join("");
  zip.folder("word").file("document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyParas}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body>
</w:document>`);
  zip.folder("word").folder("_rels").file("document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

/* ---- DOCX builder that mixes embedded page images ---- */
function pxToEmu(px, dpi=96){ return Math.round(px * 914400 / dpi); }
const DEVANAGARI_RE = /[ऀ-ॿ]/;
/* DOCX page size mirrors the source PDF's actual page dimensions (1pt =
   20 twips) instead of always forcing A4, so Letter/Legal/custom sized
   (and landscape) PDFs don't get silently reflowed onto the wrong paper
   size. Margins scale down on very small custom pages so they can't
   exceed half the page in either dimension. Used both for the document's
   final (body-level) section and for any mid-document section breaks
   inserted where the source PDF's page size actually changes.
   headerRid/footerRid (when given) wire that section to the shared
   header1.xml/footer1.xml parts - DOCX only supports ONE header/footer
   pair per document in this implementation (applied to every section),
   which matches the common case (a header/footer that's the same content
   repeated on every page) rather than per-section headers. */
function sectPrXml(sizeObj, headerRid, footerRid){
  let pgW = 11906, pgH = 16838, orient = "";
  if(sizeObj && sizeObj.widthPt && sizeObj.heightPt){
    pgW = Math.round(sizeObj.widthPt*20);
    pgH = Math.round(sizeObj.heightPt*20);
    if(pgW > pgH) orient = ' w:orient="landscape"';
  }
  const margin = Math.max(360, Math.min(1417, Math.floor(Math.min(pgW,pgH)/2) - 200));
  const refs = (headerRid ? `<w:headerReference w:type="default" r:id="${headerRid}"/>` : "")
    + (footerRid ? `<w:footerReference w:type="default" r:id="${footerRid}"/>` : "");
  return `<w:sectPr>${refs}<w:pgSz w:w="${pgW}" w:h="${pgH}"${orient}/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}"/></w:sectPr>`;
}

/* Whether a block (of ANY type - paragraph, table, gridtable, columns)
   carries real, non-whitespace text. Used to decide whether a page has
   extractable content at all (vs. needing the whole-page-screenshot
   fallback) - checking only paragraph-type blocks here was a real bug,
   since a page whose entire content is a table has no paragraph blocks
   at all despite having plenty of real text. */
function blockHasRealText(b){
  if(!b) return false;
  if(b.type === "paragraph") return b.runs.some(r=>r.text && r.text.trim());
  if(b.type === "table") return b.rows.some(row=>row.some(c=>c.text && c.text.trim()));
  if(b.type === "gridtable") return b.cells.some(c=>c.text && c.text.trim());
  if(b.type === "columns") return [...b.left, ...b.right].some(p=>p.runs.some(r=>r.text && r.text.trim()));
  return false;
}

/* Detects genuine repeating headers/footers across pages - promoted to
   real DOCX header/footer parts only when the exact same literal text
   (whitespace/case normalized, but NOT digit-masked) appears as the
   first (header candidate) or last (footer candidate) paragraph on a
   strong majority (>=60%, min 2) of pages. Ordinary one-off page content
   can never satisfy this - it requires real repetition across pages,
   not just position on one page.

   Deliberately requires LITERAL text equality, not a digit-masked
   pattern match ("Page 1 of 4" vs "Page 2 of 4" no longer count as "the
   same"). A real DOCX <w:ftr>/<w:hdr> can only ever hold ONE fixed,
   static text repeated verbatim on every page - there is no per-page
   substitution. Digit-masking was tried first (so genuine pagination
   footers would still be recognized as "repeating"), but it silently
   corrupts any per-page-varying content that happens to share a
   template: confirmed both on the intended pagination case itself (a
   real "Page 1 of 2"/"Page 2 of 2" footer pair got collapsed to a
   static footer reading "Page 1 of 2" on BOTH pages - page 2's real
   footer was deleted and replaced with the wrong page's text) and on a
   more damaging case (three pages with genuinely different subtotal
   amounts - "$120.00"/"$340.00"/"$275.50" - collapsed to a static
   footer showing "$120.00" on every page, silently overwriting two
   pages' real financial values). Requiring literal equality means a
   genuine pagination footer no longer gets auto-promoted to a running
   footer (a minor convenience loss), but no page's real, correct text
   can ever be silently deleted or replaced with another page's value -
   the right trade given data loss/corruption outranks a cosmetic
   nicety. */
function headerFooterNormText(block){
  if(!block || block.type !== "paragraph") return null;
  const t = block.runs.map(r=>r.text).join("").trim().toLowerCase();
  return t || null;
}
function detectHeaderFooter(pageBlocksList){
  if(pageBlocksList.length < 2) return {headerRuns:null, footerRuns:null};
  function majorityBlock(candidates){
    const counts = {};
    candidates.forEach(b=>{ const t=headerFooterNormText(b); if(t) counts[t]=(counts[t]||0)+1; });
    let best=null, bestCount=0;
    for(const k in counts){ if(counts[k]>bestCount){ bestCount=counts[k]; best=k; } }
    const threshold = Math.max(2, Math.ceil(candidates.length*0.6));
    if(!best || bestCount < threshold) return null;
    return candidates.find(b=>headerFooterNormText(b)===best);
  }
  const firsts = pageBlocksList.map(pb => pb.find(b=>b.type==="paragraph") || null);
  const lasts = pageBlocksList.map(pb => { const paras=pb.filter(b=>b.type==="paragraph"); return paras.length?paras[paras.length-1]:null; });
  const headerBlock = majorityBlock(firsts);
  const footerBlock = majorityBlock(lasts);
  // Remove the matched instances from every page's block list so the
  // content isn't duplicated in both the header/footer part AND the body.
  if(headerBlock){
    const pattern = headerFooterNormText(headerBlock);
    pageBlocksList.forEach(pb=>{ const idx=pb.findIndex(b=>headerFooterNormText(b)===pattern); if(idx>=0) pb.splice(idx,1); });
  }
  if(footerBlock){
    const pattern = headerFooterNormText(footerBlock);
    pageBlocksList.forEach(pb=>{ const idx=pb.findIndex(b=>headerFooterNormText(b)===pattern); if(idx>=0) pb.splice(idx,1); });
  }
  return {headerRuns: headerBlock ? headerBlock.runs : null, footerRuns: footerBlock ? footerBlock.runs : null};
}
async function buildMixedDocx(blocks, pageSize, headerFooter){
  const zip = new JSZip();
  const hasImages = blocks.some(b=>b.type==="image" || (b.type==="gridtable" && b.cells.some(c=>c.images && c.images.length)));
  const headerRuns = headerFooter && headerFooter.headerRuns;
  const footerRuns = headerFooter && headerFooter.footerRuns;

  const mediaFolder = zip.folder("word").folder("media");
  const maxWidthEmu = 5760000; // ~6.3in usable page width
  const relEntries = [];
  // Shared counter state so top-level image blocks AND table-cell-embedded
  // images (rendered from inside gridTableBlockXml) draw relationship/image
  // ids from one running sequence - required since rIds must be unique
  // across the whole document.xml.rels, and header/footer also consume one
  // each before any image is registered.
  const zipCtx = {mediaFolder, relEntries, counters:{relCounter:1, imgCounter:0}};
  let headerRid = null, footerRid = null;
  if(headerRuns){
    zipCtx.counters.relCounter++; headerRid = "rId"+zipCtx.counters.relCounter;
    relEntries.push(`<Relationship Id="${headerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`);
    zip.folder("word").file("header1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styledParagraphXml({runs:headerRuns})}</w:hdr>`);
  }
  if(footerRuns){
    zipCtx.counters.relCounter++; footerRid = "rId"+zipCtx.counters.relCounter;
    relEntries.push(`<Relationship Id="${footerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`);
    zip.folder("word").file("footer1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styledParagraphXml({runs:footerRuns})}</w:ftr>`);
  }

  zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${hasImages ? '<Default Extension="png" ContentType="image/png"/>' : ''}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
${headerRuns ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
${footerRuns ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}
</Types>`);
  zip.folder("_rels").file(".rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  const bodyParts = blocks.map(b=>{
    if(b.type === "image"){
      // Images extracted from real embedded PDF image objects carry their
      // true size in PDF points (1pt = 12700 EMU); the whole-page-screenshot
      // fallback only has pixel dimensions, sized via pxToEmu as before -
      // buildPictureXml handles both via widthPt/heightPt vs width/height.
      const {picXml, cx, cy, imgCounter} = buildPictureXml(b, zipCtx, maxWidthEmu);
      if(b.placement === "anchored" && b.xPt != null){
        // Independently-positioned image (QR code, stamp, small logo) -
        // anchored at its real page-relative x/y (measured from the page
        // edge, matching the page's own dimensions exactly since the
        // DOCX page size mirrors the PDF's) with square text wrap, rather
        // than dropped inline wherever its Y-sort position happens to
        // land. relativeHeight must be unique per anchored image so Word
        // doesn't collapse their z-order.
        const xEmu = Math.max(0, Math.round(b.xPt*12700));
        const yEmu = Math.max(0, Math.round(b.yFromTopPt*12700));
        return `<w:p><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${1000+imgCounter}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${xEmu}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${yEmu}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
      }
      // Wide banner/logo images behave as normal centered inline content.
      const jc = b.placement === "centered" ? `<w:pPr><w:jc w:val="center"/></w:pPr>` : "";
      return `<w:p>${jc}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    if(b.type === "pagebreak"){
      // A plain page break can't change paper size/orientation - only a
      // real section break can. sectionSize is only set when the PDF's
      // NEXT page actually has a different size, so this stays a simple
      // <w:br> for the overwhelming majority of documents (including the
      // real bill, which is 4 uniform A4 pages) and only pays for a
      // section break where the source genuinely needs one (e.g. a
      // landscape page inserted between portrait pages).
      if(b.sectionSize) return `<w:p><w:pPr>${sectPrXml(b.sectionSize, headerRid, footerRid)}</w:pPr></w:p>`;
      return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    }
    if(b.type === "paragraph"){ return styledParagraphXml(b); }
    if(b.type === "table"){ return tableBlockXml(b); }
    if(b.type === "gridtable"){ return gridTableBlockXml(b, zipCtx); }
    if(b.type === "columns"){ return columnsBlockXml(b); }
    if(b.type === "separator"){ return separatorBlockXml(); }
    if(!b.text || !b.text.trim()) return `<w:p/>`;
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(fixDevanagari(b.text))}</w:t></w:r></w:p>`;
  }).join("");

  // Final section's properties describe the LAST PDF page's size (mid-
  // document size changes are handled per-pagebreak above via sectPrXml).
  zip.folder("word").file("document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${bodyParts}${sectPrXml(pageSize, headerRid, footerRid)}</w:body>
</w:document>`);
  zip.folder("word").folder("_rels").file("document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries.join("")}</Relationships>`);
  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

/* ---- XLSX post-processor that anchors page images into the sheet (JSZip augments the SheetJS output) ---- */
async function embedImagesInXlsx(wbArray, placements){
  if(!placements.length) return new Blob([wbArray], {type:"application/octet-stream"});
  const zip = await JSZip.loadAsync(wbArray);

  let ct = await zip.file("[Content_Types].xml").async("string");
  if(!/Extension="png"/.test(ct)) ct = ct.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>');
  ct = ct.replace("</Types>", '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
  zip.file("[Content_Types].xml", ct);

  let drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  let anchors = "";
  placements.forEach((p, idx)=>{
    const n = idx+1;
    zip.folder("xl").folder("media").file(`image${n}.png`, p.pngBase64, {base64:true});
    drawingRels += `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/>`;
    const widthCols = Math.max(2, Math.round(p.widthPx/64));
    const heightRows = Math.max(4, Math.round(p.heightPx/20));
    anchors += `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${p.col+widthCols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row+heightRows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${n+1}" name="Picture ${n}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${n}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
  });
  drawingRels += `</Relationships>`;
  zip.folder("xl").folder("drawings").folder("_rels").file("drawing1.xml.rels", drawingRels);
  zip.folder("xl").folder("drawings").file("drawing1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`);

  const sheetPath = "xl/worksheets/sheet1.xml";
  let sheetXml = await zip.file(sheetPath).async("string");
  if(!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  sheetXml = sheetXml.replace("</worksheet>", '<drawing r:id="rIdDrawing1"/></worksheet>');
  zip.file(sheetPath, sheetXml);

  const relsPath = "xl/worksheets/_rels/sheet1.xml.rels";
  const existingRels = zip.file(relsPath);
  let sheetRels;
  if(existingRels){
    sheetRels = await existingRels.async("string");
    sheetRels = sheetRels.replace("</Relationships>", '<Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
  } else {
    sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  }
  zip.file(relsPath, sheetRels);

  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
