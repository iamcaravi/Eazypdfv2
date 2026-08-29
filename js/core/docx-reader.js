/* ---------------- DOCX structured reader ----------------
   Reads word/document.xml (plus styles.xml, numbering.xml, header/footer parts, media, and each
   part's relationships) directly, instead of going through Mammoth.js or any text-extraction-then-
   HTML approach. Mammoth's own docs describe it as intentionally producing "clean" simplified HTML
   from a document's semantic structure - exactly the opposite of what's needed here: preserving the
   DOCX's actual layout (page geometry, exact fonts/sizes/colors, real table grid, images, tab stops,
   page breaks) as closely as technically possible, not a simplified reading of it. Font/run detail
   is also what lets Kruti Dev runs be told apart from real Unicode Hindi or plain English within the
   SAME document - see krutidev-to-unicode.js and TOOLS.word2pdf in pdf-convert-tools.js.

   A .docx is a ZIP archive (OOXML/Open Packaging Conventions); this unzips it with the already-lazy-
   loaded JSZip and parses each XML part with the browser's own DOMParser - no additional library for
   either step. Font/style resolution follows Word's real fallback order: a run's own direct
   <w:rFonts>/<w:sz>/<w:color>/etc, then its referenced character style (<w:rStyle>), then the
   paragraph's own default run properties, then the paragraph's referenced paragraph style, then the
   document-wide default in styles.xml's <w:docDefaults>.

   Deliberately NOT attempted here (disclosed limitations, not silent gaps - see TOOLS.word2pdf's own
   header comment for how each is handled without crashing): floating shapes/text boxes (VML/
   DrawingML shape geometry, as opposed to the inline <w:drawing> images this DOES read), multi-column
   section text flow (<w:cols> - columns are detected but rendered as a single column), row-spanning
   table cells (<w:vMerge>), and per-section odd/even/first-page header or footer variants (only the
   "default" header/footer of each section is read). */

const DOCX_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOCX_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DOCX_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const DOCX_WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const DOCX_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

// EMUs (English Metric Units, DrawingML's length unit) and twips (twentieths of a point, used
// almost everywhere else in WordprocessingML - page size, margins, indentation, spacing) both
// convert to PDF points with a fixed factor; half-points (font size) just need /2.
const EMU_PER_PT = 12700;
const TWIP_PER_PT = 20;

function docxChildren(el, tag, ns){
  if(!el) return [];
  ns = ns || DOCX_W_NS;
  return Array.from(el.children).filter(c => c.localName === tag && c.namespaceURI === ns);
}
function docxChild(el, tag, ns){ return docxChildren(el, tag, ns)[0] || null; }
function docxDescendants(el, tag, ns){
  if(!el) return [];
  ns = ns || DOCX_W_NS;
  return Array.from(el.getElementsByTagNameNS(ns, tag));
}
function docxAttr(el, name, ns){
  if(!el) return null;
  ns = ns || DOCX_W_NS;
  return el.getAttributeNS(ns, name) || el.getAttribute((ns === DOCX_W_NS ? "w" : ns === DOCX_R_NS ? "r" : ns === DOCX_A_NS ? "a" : ns === DOCX_WP_NS ? "wp" : "w") + ":" + name);
}
function twipToPt(v){ const n = parseFloat(v); return isFinite(n) ? n / TWIP_PER_PT : null; }
function halfPtToPt(v){ const n = parseFloat(v); return isFinite(n) ? n / 2 : null; }
function emuToPt(v){ const n = parseFloat(v); return isFinite(n) ? n / EMU_PER_PT : null; }
function hexToRgb01(hex){
  if(!hex || hex === "auto" || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return { r: parseInt(hex.slice(0,2),16)/255, g: parseInt(hex.slice(2,4),16)/255, b: parseInt(hex.slice(4,6),16)/255 };
}

async function readDocxStructured(arrayBuffer){
  await ensureJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const parser = new DOMParser();

  async function readXmlPart(path){
    const entry = zip.file(path);
    if(!entry) return null;
    const text = await entry.async("text");
    return parser.parseFromString(text, "application/xml");
  }
  async function readRelsFor(partPath){
    const dir = partPath.includes("/") ? partPath.slice(0, partPath.lastIndexOf("/")) : "";
    const name = partPath.includes("/") ? partPath.slice(partPath.lastIndexOf("/")+1) : partPath;
    const relsPath = (dir ? dir + "/" : "") + "_rels/" + name + ".rels";
    const relsXml = await readXmlPart(relsPath);
    const map = {};
    if(relsXml){
      Array.from(relsXml.getElementsByTagNameNS(DOCX_RELS_NS, "Relationship")).forEach(relEl => {
        const id = relEl.getAttribute("Id");
        const type = relEl.getAttribute("Type") || "";
        const target = relEl.getAttribute("Target");
        if(id && target) map[id] = { type: type.split("/").pop(), target: (dir ? dir + "/" : "") + target.replace(/^\//,"") };
      });
    }
    return map;
  }

  const documentXml = await readXmlPart("word/document.xml");
  if(!documentXml) throw new Error("word/document.xml not found - not a valid .docx");
  const stylesXml = await readXmlPart("word/styles.xml");
  const numberingXml = await readXmlPart("word/numbering.xml");
  const docRels = await readRelsFor("word/document.xml");

  // ---- image bytes, resolved lazily per relationship id as they're actually referenced ----
  const mediaCache = {};
  async function loadMediaBytes(relId){
    if(mediaCache[relId]) return mediaCache[relId];
    const rel = docRels[relId];
    if(!rel || rel.type !== "image") return null;
    const entry = zip.file(rel.target);
    if(!entry) return null;
    const bytes = await entry.async("uint8array");
    const ext = rel.target.split(".").pop().toLowerCase();
    const format = ext === "png" ? "png" : (ext === "jpg" || ext === "jpeg") ? "jpg" : null; // pdf-lib only embeds PNG/JPG
    const result = format ? { bytes, format } : null;
    mediaCache[relId] = result;
    return result;
  }

  // ---- styles.xml: paragraph/character style properties by id, plus document-wide defaults ----
  const styleById = {}; // { rFonts, sizePt, bold, italic, underline, colorRgb, align, indent, spacing }
  let docDefaults = { rFonts: null, sizePt: null };
  let docParaDefaults = {};
  if(stylesXml){
    const docDefaultsEl = docxChild(stylesXml.documentElement, "docDefaults");
    if(docDefaultsEl){
      const rPrDefault = docxChild(docDefaultsEl, "rPrDefault");
      const rPr = rPrDefault ? docxChild(rPrDefault, "rPr") : null;
      docDefaults = readRunProps(rPr, {});
      const pPrDefault = docxChild(docDefaultsEl, "pPrDefault");
      const pPr = pPrDefault ? docxChild(pPrDefault, "pPr") : null;
      if(pPr) docParaDefaults = readParaProps(pPr);
    }
    Array.from(stylesXml.getElementsByTagNameNS(DOCX_W_NS, "style")).forEach(styleEl => {
      const id = docxAttr(styleEl, "styleId");
      if(!id) return;
      const rPr = docxChild(styleEl, "rPr");
      const pPr = docxChild(styleEl, "pPr");
      styleById[id] = {
        run: readRunProps(rPr, {}),
        para: pPr ? readParaProps(pPr) : null,
        basedOn: (() => { const b = docxChild(styleEl, "basedOn"); return b ? docxAttr(b, "val") : null; })(),
      };
    });
  }
  function resolvedStyleRun(styleId, seen){
    seen = seen || new Set();
    if(!styleId || seen.has(styleId) || !styleById[styleId]) return {};
    seen.add(styleId);
    const s = styleById[styleId];
    const parent = s.basedOn ? resolvedStyleRun(s.basedOn, seen) : {};
    return Object.assign({}, parent, s.run);
  }
  function resolvedStylePara(styleId, seen){
    seen = seen || new Set();
    if(!styleId || seen.has(styleId) || !styleById[styleId]) return {};
    seen.add(styleId);
    const s = styleById[styleId];
    const parent = s.basedOn ? resolvedStylePara(s.basedOn, seen) : {};
    return Object.assign({}, parent, s.para || {});
  }

  // ---- numbering.xml: numId -> per-level {format, bulletChar or numFmt} (simplified: no restart/
  // multi-level counter-format-string resolution, just "is it a bullet or a number at this level") ----
  const numFmtByNumId = {}; // numId -> {abstractNumId} ; abstractNumFmt: abstractNumId -> {0: "bullet"|"decimal"|..., ...}
  const abstractNumFmt = {};
  const listCounters = {}; // numId -> running counter for simple decimal lists (reset per numId, not per level - a disclosed simplification)
  if(numberingXml){
    Array.from(numberingXml.getElementsByTagNameNS(DOCX_W_NS, "abstractNum")).forEach(absEl => {
      const absId = docxAttr(absEl, "abstractNumId");
      const levels = {};
      docxChildren(absEl, "lvl").forEach(lvlEl => {
        const ilvl = docxAttr(lvlEl, "ilvl");
        const fmtEl = docxChild(lvlEl, "numFmt");
        levels[ilvl] = fmtEl ? docxAttr(fmtEl, "val") : "decimal";
      });
      if(absId) abstractNumFmt[absId] = levels;
    });
    Array.from(numberingXml.getElementsByTagNameNS(DOCX_W_NS, "num")).forEach(numEl => {
      const numId = docxAttr(numEl, "numId");
      const absIdEl = docxChild(numEl, "abstractNumId");
      if(numId && absIdEl) numFmtByNumId[numId] = docxAttr(absIdEl, "val");
    });
  }
  function listMarkerFor(numId, ilvl){
    const absId = numFmtByNumId[numId];
    const fmt = absId && abstractNumFmt[absId] ? (abstractNumFmt[absId][ilvl] || abstractNumFmt[absId]["0"]) : "bullet";
    if(fmt === "bullet") return "•";
    listCounters[numId] = (listCounters[numId] || 0) + 1;
    return listCounters[numId] + ".";
  }

  // ---- run properties: font, size, bold/italic/underline/strike, color, super/subscript ----
  function readRunProps(rPrEl, base){
    const out = Object.assign({}, base);
    if(!rPrEl) return out;
    const rFonts = docxChild(rPrEl, "rFonts");
    if(rFonts){
      out.rFonts = docxAttr(rFonts, "ascii") || docxAttr(rFonts, "hAnsi") || docxAttr(rFonts, "cs") || out.rFonts;
    }
    const sz = docxChild(rPrEl, "sz") || docxChild(rPrEl, "szCs");
    if(sz){ const pt = halfPtToPt(docxAttr(sz, "val")); if(pt) out.sizePt = pt; }
    const b = docxChild(rPrEl, "b") || docxChild(rPrEl, "bCs");
    if(b){ const v = docxAttr(b, "val"); out.bold = v === null || v === "true" || v === "1"; }
    const i = docxChild(rPrEl, "i") || docxChild(rPrEl, "iCs");
    if(i){ const v = docxAttr(i, "val"); out.italic = v === null || v === "true" || v === "1"; }
    const u = docxChild(rPrEl, "u");
    if(u){ const v = docxAttr(u, "val"); out.underline = !!v && v !== "none"; }
    const strike = docxChild(rPrEl, "strike");
    if(strike){ const v = docxAttr(strike, "val"); out.strike = v === null || v === "true" || v === "1"; }
    const color = docxChild(rPrEl, "color");
    if(color){ const rgb = hexToRgb01(docxAttr(color, "val")); if(rgb) out.color = rgb; }
    const va = docxChild(rPrEl, "vertAlign");
    if(va) out.vertAlign = docxAttr(va, "val"); // "superscript" | "subscript" | "baseline"
    return out;
  }

  // ---- paragraph properties: alignment, indentation, spacing, tabs, list, page-break-before ----
  function readParaProps(pPrEl){
    const out = {};
    const jc = docxChild(pPrEl, "jc");
    if(jc) out.align = docxAttr(jc, "val");
    const ind = docxChild(pPrEl, "ind");
    if(ind){
      out.indentLeftPt = twipToPt(docxAttr(ind, "left") || docxAttr(ind, "start"));
      out.indentRightPt = twipToPt(docxAttr(ind, "right") || docxAttr(ind, "end"));
      const firstLine = docxAttr(ind, "firstLine");
      const hanging = docxAttr(ind, "hanging");
      out.indentFirstLinePt = firstLine ? twipToPt(firstLine) : (hanging ? -twipToPt(hanging) : null);
    }
    const spacing = docxChild(pPrEl, "spacing");
    if(spacing){
      out.spaceBeforePt = twipToPt(docxAttr(spacing, "before"));
      out.spaceAfterPt = twipToPt(docxAttr(spacing, "after"));
      const beforeAuto = docxAttr(spacing, "beforeAutospacing");
      const afterAuto = docxAttr(spacing, "afterAutospacing");
      if(beforeAuto != null) out.spaceBeforeAuto = beforeAuto === "true" || beforeAuto === "1";
      if(afterAuto != null) out.spaceAfterAuto = afterAuto === "true" || afterAuto === "1";
      const line = docxAttr(spacing, "line");
      const lineRule = docxAttr(spacing, "lineRule");
      if(line) out.lineSpacing = { value: parseFloat(line), rule: lineRule || "auto" }; // auto: 240ths of a line; exact/atLeast: twips
    }
    const tabsEl = docxChild(pPrEl, "tabs");
    if(tabsEl) out.tabStopsPt = docxChildren(tabsEl, "tab").map(t => twipToPt(docxAttr(t, "pos"))).filter(v => v != null);
    const pageBreakBefore = docxChild(pPrEl, "pageBreakBefore");
    if(pageBreakBefore){ const v = docxAttr(pageBreakBefore, "val"); out.pageBreakBefore = v === null || v === "true" || v === "1"; }
    const numPr = docxChild(pPrEl, "numPr");
    if(numPr){
      const ilvlEl = docxChild(numPr, "ilvl");
      const numIdEl = docxChild(numPr, "numId");
      out.list = { ilvl: ilvlEl ? docxAttr(ilvlEl, "val") : "0", numId: numIdEl ? docxAttr(numIdEl, "val") : null };
    }
    return out;
  }

  function resolveRunStyleChain(rPrEl, paraDefaultRun, paraStyleId){
    const rStyleEl = rPrEl ? docxChild(rPrEl, "rStyle") : null;
    const rStyleId = rStyleEl ? docxAttr(rStyleEl, "val") : null;
    let props = Object.assign({}, docDefaults);
    // A paragraph style owns both pPr and rPr. resolvedStylePara() intentionally
    // returns only its paragraph properties, so asking that object for `.run`
    // silently discarded the style's font, size and emphasis. Resolve the run
    // half of the same style chain directly (including basedOn inheritance).
    props = Object.assign(props, resolvedStyleRun(paraStyleId));
    props = Object.assign(props, paraDefaultRun || {});
    if(rStyleId) props = Object.assign(props, resolvedStyleRun(rStyleId));
    props = readRunProps(rPrEl, props);
    return props;
  }

  // ---- inline image (w:drawing/w:pict) inside a run - returns {kind:"image", relId, widthPt, heightPt} or null ----
  function readInlineImage(runEl){
    const drawing = docxChild(runEl, "drawing", DOCX_W_NS);
    if(drawing){
      const blip = docxDescendants(drawing, "blip", DOCX_A_NS)[0];
      const relId = blip ? docxAttr(blip, "embed", DOCX_R_NS) : null;
      const extent = docxDescendants(drawing, "extent", DOCX_WP_NS)[0];
      // cx/cy are plain, UN-prefixed attributes in real OOXML (unlike almost everything else in
      // WordprocessingML) - a bare getAttribute(), not the w:/wp:-prefixed docxAttr() fallback.
      if(relId && extent){
        return { relId, widthPt: emuToPt(extent.getAttribute("cx")), heightPt: emuToPt(extent.getAttribute("cy")) };
      }
    }
    return null;
  }

  // ---- run -> a list of tokens: text runs split at tabs/breaks, plus any inline image ----
  function readRun(runEl, style){
    const tokens = [];
    const image = readInlineImage(runEl);
    if(image){ tokens.push(Object.assign({ kind: "image" }, image)); return tokens; }
    let buf = "";
    function flush(){ if(buf){ tokens.push({ kind: "text", text: buf, style }); buf = ""; } }
    Array.from(runEl.children).forEach(child => {
      if(child.namespaceURI !== DOCX_W_NS) return;
      if(child.localName === "t") buf += child.textContent;
      else if(child.localName === "tab"){ flush(); tokens.push({ kind: "tab" }); }
      else if(child.localName === "br"){
        const type = docxAttr(child, "type");
        flush();
        tokens.push(type === "page" ? { kind: "pageBreak" } : { kind: "lineBreak" });
      } else if(child.localName === "cr"){ flush(); tokens.push({ kind: "lineBreak" }); }
    });
    flush();
    return tokens;
  }

  function readRunsIn(containerEl, paraDefaultRun, paraStyleId){
    const tokens = [];
    Array.from(containerEl.children).forEach(child => {
      if(child.namespaceURI !== DOCX_W_NS) return;
      if(child.localName === "r"){
        const rPr = docxChild(child, "rPr");
        const style = resolveRunStyleChain(rPr, paraDefaultRun, paraStyleId);
        tokens.push(...readRun(child, style));
      } else if(child.localName === "hyperlink" || child.localName === "smartTag" || child.localName === "ins"){
        tokens.push(...readRunsIn(child, paraDefaultRun, paraStyleId));
      }
    });
    return tokens;
  }

  function readParagraph(pEl){
    const pPr = docxChild(pEl, "pPr");
    const pStyleEl = pPr ? docxChild(pPr, "pStyle") : null;
    const pStyleId = pStyleEl ? docxAttr(pStyleEl, "val") : null;
    const styleProps = resolvedStylePara(pStyleId);
    const ownProps = pPr ? readParaProps(pPr) : {};
    const props = Object.assign({}, docParaDefaults, styleProps, ownProps);
    const paraDefaultRPr = pPr ? docxChild(pPr, "rPr") : null;
    const paraDefaultRun = paraDefaultRPr ? readRunProps(paraDefaultRPr, {}) : {};
    const isHeading = !!(pStyleId && /^Heading\d*$/i.test(pStyleId));
    const tokens = readRunsIn(pEl, paraDefaultRun, pStyleId);
    return {
      type: "paragraph", isHeading,
      align: props.align || null,
      indentLeftPt: props.indentLeftPt || 0, indentRightPt: props.indentRightPt || 0, indentFirstLinePt: props.indentFirstLinePt || 0,
      spaceBeforePt: props.spaceBeforePt || 0, spaceAfterPt: props.spaceAfterPt || 0,
      spaceBeforeAuto: !!props.spaceBeforeAuto, spaceAfterAuto: !!props.spaceAfterAuto,
      lineSpacing: props.lineSpacing || null,
      tabStopsPt: props.tabStopsPt || null,
      pageBreakBefore: !!props.pageBreakBefore,
      list: props.list || null,
      listMarker: props.list ? listMarkerFor(props.list.numId, props.list.ilvl) : null,
      tokens,
    };
  }

  function readCellProps(tcEl){
    const tcPr = docxChild(tcEl, "tcPr");
    const out = { widthPt: null, gridSpan: 1, align: null, borders: null, shadeRgb: null };
    if(!tcPr) return out;
    const tcW = docxChild(tcPr, "tcW");
    if(tcW) out.widthPt = twipToPt(docxAttr(tcW, "w"));
    const gridSpan = docxChild(tcPr, "gridSpan");
    if(gridSpan) out.gridSpan = parseInt(docxAttr(gridSpan, "val"), 10) || 1;
    const shd = docxChild(tcPr, "shd");
    if(shd){ const rgb = hexToRgb01(docxAttr(shd, "fill")); if(rgb) out.shadeRgb = rgb; }
    return out;
  }

  function readCell(tcEl){
    const props = readCellProps(tcEl);
    const paragraphs = docxChildren(tcEl, "p").map(readParagraph);
    return Object.assign({ paragraphs }, props);
  }

  function readTable(tblEl){
    const gridCols = docxDescendants(tblEl, "gridCol").map(g => twipToPt(docxAttr(g, "w")));
    const rows = docxChildren(tblEl, "tr").map(trEl => docxChildren(trEl, "tc").map(readCell));
    return { type: "table", gridColsPt: gridCols, rows };
  }

  // ---- section properties (page size/orientation/margins, header/footer refs) - the LAST sectPr in
  // the body is the primary/only section for a single-section document; earlier ones (inside the
  // last paragraph of a preceding section) mark section BREAKS, each starting a fresh page with
  // its own geometry. ----
  async function readHeaderFooterPart(relId){
    const rel = docRels[relId];
    if(!rel) return null;
    const xml = await readXmlPart(rel.target);
    if(!xml) return null;
    const root = xml.documentElement;
    return docxChildren(root, "p").map(readParagraph);
  }
  async function readSectPr(sectPrEl){
    const pgSz = docxChild(sectPrEl, "pgSz");
    const pgMar = docxChild(sectPrEl, "pgMar");
    const cols = docxChild(sectPrEl, "cols");
    const section = {
      widthPt: pgSz ? twipToPt(docxAttr(pgSz, "w")) : 595.3,
      heightPt: pgSz ? twipToPt(docxAttr(pgSz, "h")) : 841.9,
      landscape: pgSz ? docxAttr(pgSz, "orient") === "landscape" : false,
      marginTopPt: pgMar ? twipToPt(docxAttr(pgMar, "top")) : 72,
      marginBottomPt: pgMar ? twipToPt(docxAttr(pgMar, "bottom")) : 72,
      marginLeftPt: pgMar ? twipToPt(docxAttr(pgMar, "left")) : 72,
      marginRightPt: pgMar ? twipToPt(docxAttr(pgMar, "right")) : 72,
      headerPt: pgMar ? twipToPt(docxAttr(pgMar, "header")) : 36,
      footerPt: pgMar ? twipToPt(docxAttr(pgMar, "footer")) : 36,
      columnCount: cols ? (parseInt(docxAttr(cols, "num"), 10) || 1) : 1,
      header: null, footer: null,
    };
    const headerRef = docxChildren(sectPrEl, "headerReference").find(h => docxAttr(h, "type") === "default") || docxChildren(sectPrEl, "headerReference")[0];
    const footerRef = docxChildren(sectPrEl, "footerReference").find(h => docxAttr(h, "type") === "default") || docxChildren(sectPrEl, "footerReference")[0];
    if(headerRef) section.header = await readHeaderFooterPart(docxAttr(headerRef, "id", DOCX_R_NS));
    if(footerRef) section.footer = await readHeaderFooterPart(docxAttr(footerRef, "id", DOCX_R_NS));
    return section;
  }

  const body = documentXml.getElementsByTagNameNS(DOCX_W_NS, "body")[0];
  if(!body) throw new Error("word/document.xml has no <w:body>");

  // Walk the body once, building blocks and slicing them into sections wherever a sectPr is found
  // (either the body's own trailing one, or one embedded in a paragraph's pPr marking where that
  // section ends).
  const sections = [];
  let currentBlocks = [];
  for(const child of Array.from(body.children)){
    if(child.namespaceURI !== DOCX_W_NS) continue;
    if(child.localName === "p"){
      currentBlocks.push(readParagraph(child));
      const pPr = docxChild(child, "pPr");
      const inlineSectPr = pPr ? docxChild(pPr, "sectPr") : null;
      if(inlineSectPr){
        sections.push({ section: await readSectPr(inlineSectPr), blocks: currentBlocks });
        currentBlocks = [];
      }
    } else if(child.localName === "tbl"){
      currentBlocks.push(readTable(child));
    } else if(child.localName === "sectPr"){
      sections.push({ section: await readSectPr(child), blocks: currentBlocks });
      currentBlocks = [];
    }
  }
  if(currentBlocks.length || !sections.length){
    sections.push({ section: await readSectPr(documentXml.createElementNS(DOCX_W_NS, "w:sectPr")), blocks: currentBlocks });
  }

  return { sections, loadMediaBytes };
}
