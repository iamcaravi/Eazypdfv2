/* ---------------- XLSX merge engine ----------------
   Merges the worksheets of 2+ .xlsx workbooks into one output workbook by
   treating each file as a raw OOXML/ZIP package (JSZip) and patching only
   the specific attributes/indexes that are genuinely workbook-relative
   (style indexes, shared-string indexes, relationship targets, sheet-name
   references inside formulas) - every worksheet's own XML is otherwise
   copied byte-for-byte, which is what preserves dimensions, merged cells,
   row heights, column widths, hidden rows/cols, freeze panes and page
   setup/print settings automatically, with zero dedicated code for any of
   them (they're all self-contained attributes/elements inside the
   worksheet part itself).

   Deliberately regex/string-based rather than DOMParser-based, matching
   the only other OOXML surgery already in this codebase
   (embedImagesInXlsx in doc-export-builders.js) - this also means this
   file runs identically under a plain Node vm sandbox (see
   tests/xlsx-merge.test.js) and in the browser, with no jsdom/DOMParser
   dependency either way.

   No File/Blob/DOM API is used anywhere below - callers pass
   {name, bytes} pairs and get a Uint8Array back, so this same engine is
   directly unit-testable in Node.

   What is NOT safely preserved, and why (see the merge report returned
   to callers rather than a silent best-effort with no signal):
   - Color themes after the first workbook (xl/theme/theme1.xml) - only
     one theme can exist in the output; theme-relative colors in later
     workbooks may render differently.
   - Cross-sheet formula references to a sheet that had to be renamed for
     a collision - rewritten with a best-effort regex (SheetName! /
     'Sheet Name'! tokens), not a real formula parser.
   - Workbook-level (global) defined names that collide by name - the
     later one is dropped rather than producing an invalid duplicate.
   - External workbook links (xl/externalLinks/*) - dropped.
   - Pivot tables/caches, slicers, threaded comments, rich-value/dynamic-
     array metadata - not merged; detected and reported, never silently
     discarded. */

var XlsxMerge = (function(){
  "use strict";

  const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const NS_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

  const REL_TYPE = {
    worksheet: NS_R + "/worksheet",
    styles: NS_R + "/styles",
    sharedStrings: NS_R + "/sharedStrings",
    theme: NS_R + "/theme",
    drawing: NS_R + "/drawing",
    table: NS_R + "/table",
    comments: NS_R + "/comments",
    vmlDrawing: NS_R + "/vmlDrawing",
    printerSettings: NS_R + "/printerSettings",
    hyperlink: NS_R + "/hyperlink",
    officeDocument: NS_R + "/officeDocument",
    coreProperties: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
    extendedProperties: NS_R + "/extended-properties"
  };

  const CT_OVERRIDE = {
    workbook: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    worksheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
    styles: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    sharedStrings: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
    theme: "application/vnd.openxmlformats-officedocument.theme+xml",
    drawing: "application/vnd.openxmlformats-officedocument.drawing+xml",
    table: "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml",
    comments: "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml",
    core: "application/vnd.openxmlformats-package.core-properties+xml",
    app: "application/vnd.openxmlformats-officedocument.extended-properties+xml"
  };
  const CT_DEFAULT_BY_EXT = {
    rels: "application/vnd.openxmlformats-package.relationships+xml",
    xml: "application/xml",
    png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif",
    bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf",
    vml: "application/vnd.openxmlformats-officedocument.vmlDrawing",
    bin: "application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"
  };

  // xl/ top-level parts this engine actively understands and carries
  // forward (possibly with remapping). Anything else found under xl/ is
  // reported, never silently dropped.
  const KNOWN_XL_PREFIXES = [
    "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml",
    "xl/sharedStrings.xml", "xl/theme/", "xl/worksheets/", "xl/drawings/",
    "xl/media/", "xl/tables/", "xl/printerSettings/"
  ];
  // xl/comments*.xml and xl/calcChain.xml are handled/dropped by name below.

  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  // Inverse of esc() - MUST be applied to every attribute value pulled out
  // of source XML that this engine later re-embeds via esc() (sheet names,
  // numFmt formatCodes, relationship targets, table names...), or the
  // still-escaped raw text gets escaped a SECOND time (e.g. a currency
  // format's literal quotes, "₹"#,##0.00, written by the source as
  // formatCode="&quot;₹&quot;#,##0.00" comes back from a naive attribute
  // read still containing the literal "&quot;" text; re-escaping that
  // turns it into "&amp;quot;...", which Excel decodes back to a LITERAL
  // "&quot;" string inside the format code - a syntactically broken
  // number format, which is exactly the class of defect Excel's repair
  // reports as "Repaired Records: Format" in xl/styles.xml). &amp; is
  // decoded LAST so "&amp;lt;" (an already-escaped &lt;) doesn't get
  // double-unescaped into a literal "<".
  function unescXml(s){
    return String(s == null ? "" : s)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, "&");
  }

  /** Extracts every top-level (non-nested-under-itself) `<tag ...>` or
   * self-closing `<tag .../>` element from xml. Safe for OOXML spreadsheet
   * elements used here (font/fill/border/xf/si/sheet/numFmt/dxf/col) -
   * none of them contain another element of the same name. */
  function extractElements(xml, tag){
    if(!xml) return [];
    const re = new RegExp("<" + tag + "(\\s[^>]*)?/>|<" + tag + "(\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "g");
    const out = [];
    let m;
    while((m = re.exec(xml))){
      const selfClosing = m[1] != null;
      out.push({
        raw: m[0],
        attrs: (selfClosing ? m[1] : m[2]) || "",
        inner: selfClosing ? null : (m[3] || ""),
        selfClosing
      });
    }
    return out;
  }

  function getBlock(xml, tag){
    if(!xml) return null;
    const re = new RegExp("<" + tag + "(\\s[^>]*)?/>|<" + tag + "(\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">");
    const m = re.exec(xml);
    if(!m) return null;
    const selfClosing = m[1] != null;
    return { attrs: (selfClosing ? m[1] : m[2]) || "", inner: selfClosing ? "" : (m[3] || "") };
  }

  function getAttr(attrs, name){
    const m = new RegExp("(?:^|\\s)" + name + '="([^"]*)"').exec(attrs || "");
    return m ? unescXml(m[1]) : null;
  }

  function elementXml(tag, list){
    if(!list.length) return "";
    return "<" + tag + ' count="' + list.length + '">' + list.map(e => e.raw).join("") + "</" + tag + ">";
  }

  function xmlDecl(){
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  }

  // ---- relationship (.rels) helpers ----
  function parseRelationships(xml){
    if(!xml) return [];
    return extractElements(xml, "Relationship").map(e => ({
      id: getAttr(e.attrs, "Id"),
      type: getAttr(e.attrs, "Type"),
      target: getAttr(e.attrs, "Target"),
      targetMode: getAttr(e.attrs, "TargetMode")
    }));
  }
  function buildRelationshipsXml(rels){
    const body = rels.map(r =>
      '<Relationship Id="' + esc(r.id) + '" Type="' + esc(r.type) + '" Target="' + esc(r.target) + '"' +
      (r.targetMode ? ' TargetMode="' + esc(r.targetMode) + '"' : "") + "/>"
    ).join("");
    return xmlDecl() + '<Relationships xmlns="' + NS_RELS + '">' + body + "</Relationships>";
  }

  // ---- zip-relative path resolution ----
  function folderOf(partPath){
    const i = partPath.lastIndexOf("/");
    return i === -1 ? "" : partPath.slice(0, i);
  }
  function resolveRelTarget(basePartPath, target){
    if(/^\//.test(target)) return target.replace(/^\//, "");
    const baseFolder = folderOf(basePartPath);
    const segments = (baseFolder ? baseFolder.split("/") : []).concat(target.split("/"));
    const out = [];
    for(const seg of segments){
      if(seg === "." || seg === "") continue;
      if(seg === "..") out.pop();
      else out.push(seg);
    }
    return out.join("/");
  }
  function relsPathFor(partPath){
    const folder = folderOf(partPath);
    const base = partPath.slice(folder.length ? folder.length + 1 : 0);
    return (folder ? folder + "/" : "") + "_rels/" + base + ".rels";
  }
  function extOf(partPath){
    const m = /\.([a-z0-9]+)$/i.exec(partPath);
    return m ? m[1].toLowerCase() : "";
  }

  // ---- sheet name uniqueness ----
  function uniquifySheetName(name, used){
    const clean = String(name || "Sheet").replace(/[\[\]:*?/\\]/g, "").slice(0, 31) || "Sheet";
    if(!used.has(clean)){ used.add(clean); return clean; }
    let n = 2;
    for(;;){
      const suffix = " (" + n + ")";
      const candidate = clean.slice(0, Math.max(1, 31 - suffix.length)) + suffix;
      if(!used.has(candidate)){ used.add(candidate); return candidate; }
      n++;
    }
  }

  // ---- best-effort sheet-name token rewrite (formulas + defined names) ----
  function rewriteSheetNameTokens(text, renameMap){
    if(!renameMap || !renameMap.size || !text) return text;
    return text.replace(/(^|[^!'\w])(?:'((?:[^']|'')*)'|([A-Za-z_À-￿][\w.À-￿]*))!/g,
      (whole, pre, quoted, bare) => {
        const name = quoted != null ? quoted.replace(/''/g, "'") : bare;
        if(!renameMap.has(name)) return whole;
        const next = renameMap.get(name);
        const needsQuote = /[^A-Za-z0-9_]/.test(next) || /^[0-9]/.test(next);
        const rendered = needsQuote ? "'" + next.replace(/'/g, "''") + "'" : next;
        return pre + rendered + "!";
      });
  }
  function rewriteFormulasInWorksheet(sheetXml, renameMap){
    if(!renameMap || !renameMap.size) return sheetXml;
    // MUST distinguish self-closing <f t="shared" si="N"/> (a shared-
    // formula FOLLOWER cell - no text of its own, it inherits the formula
    // from whichever earlier cell in the group has the actual text) from
    // paired <f ...>text</f>. A pattern that doesn't (the previous version
    // here: /<f([^>]*)>([\s\S]*?)<\/f>/g) misreads the self-closing form
    // as an unclosed opening tag and then hunts forward for the NEXT
    // </f> anywhere later in the sheet, silently swallowing every row/
    // cell in between into one mangled "formula" - real workbooks that
    // mix a shared-formula column with an ordinary formula elsewhere on
    // the same sheet (extremely common) hit this every time, corrupting
    // the sheet enough that Excel's repair strips the formula outright.
    return sheetXml.replace(/<f(\s[^>]*)?\/>|<f((?:\s[^>]*)?)>([\s\S]*?)<\/f>/g, (whole, selfAttrs, pairAttrs, text) => {
      if(selfAttrs != null) return whole; // shared-formula follower - nothing to rewrite
      return "<f" + pairAttrs + ">" + rewriteSheetNameTokens(text, renameMap) + "</f>";
    });
  }

  // ---- worksheet cell/row/col style + shared-string remap ----
  function remapWorksheetIndexes(sheetXml, styleRemap, sstOffset){
    let out = sheetXml;
    if(styleRemap){
      out = out.replace(/<c((?:\s[^>]*)?)\/>|<c((?:\s[^>]*)?)>([\s\S]*?)<\/c>/g, (whole, selfAttrs, pairAttrs, inner) => {
        const selfClosing = selfAttrs != null;
        let attrs = selfClosing ? selfAttrs : pairAttrs;
        attrs = attrs.replace(/(\s)s="(\d+)"/, (m0, ws, idx) => {
          const oldIdx = Number(idx);
          const newIdx = styleRemap.has(oldIdx) ? styleRemap.get(oldIdx) : oldIdx;
          return ws + 's="' + newIdx + '"';
        });
        let newInner = inner;
        if(!selfClosing && sstOffset && /(\s)t="s"/.test(attrs)){
          newInner = inner.replace(/<v>(\d+)<\/v>/, (m0, n) => "<v>" + (Number(n) + sstOffset) + "</v>");
        }
        return selfClosing ? "<c" + attrs + "/>" : "<c" + attrs + ">" + newInner + "</c>";
      });
      out = out.replace(/<row(\s[^>]*)?(\/>|>)/g, (whole, attrs, closer) => {
        if(!attrs) return whole;
        const newAttrs = attrs.replace(/(\s)s="(\d+)"/, (m0, ws, idx) => {
          const oldIdx = Number(idx);
          return ws + 's="' + (styleRemap.has(oldIdx) ? styleRemap.get(oldIdx) : oldIdx) + '"';
        });
        return "<row" + newAttrs + closer;
      });
      out = out.replace(/<col(\s[^>]*)?\/>/g, (whole, attrs) => {
        if(!attrs) return whole;
        const newAttrs = attrs.replace(/(\s)style="(\d+)"/, (m0, ws, idx) => {
          const oldIdx = Number(idx);
          return ws + 'style="' + (styleRemap.has(oldIdx) ? styleRemap.get(oldIdx) : oldIdx) + '"';
        });
        return "<col" + newAttrs + "/>";
      });
    }
    return out;
  }
  function remapConditionalFormattingDxf(sheetXml, dxfRemap){
    if(!dxfRemap) return sheetXml;
    return sheetXml.replace(/(\s)dxfId="(\d+)"/g, (m0, ws, idx) => {
      const oldIdx = Number(idx);
      return ws + 'dxfId="' + (dxfRemap.has(oldIdx) ? dxfRemap.get(oldIdx) : oldIdx) + '"';
    });
  }

  // ---- source package reading ----
  async function partString(zip, path){
    const f = zip.file(path);
    return f ? await f.async("string") : null;
  }

  async function readWorkbookPackage(name, bytes, warn){
    const zip = await JSZip.loadAsync(bytes);
    const workbookXml = await partString(zip, "xl/workbook.xml");
    if(!workbookXml) throw new Error("“" + name + "” does not look like a valid .xlsx file (missing xl/workbook.xml).");
    const workbookRelsXml = await partString(zip, "xl/_rels/workbook.xml.rels");
    const workbookRels = parseRelationships(workbookRelsXml);
    const relById = new Map(workbookRels.map(r => [r.id, r]));

    const sheetEls = extractElements(getBlock(workbookXml, "sheets") ? getBlock(workbookXml, "sheets").inner : "", "sheet");
    const sheets = sheetEls.map(e => {
      const rId = getAttr(e.attrs, "r:id") || getAttr(e.attrs, "id");
      const rel = relById.get(rId);
      return {
        name: getAttr(e.attrs, "name") || "Sheet",
        sheetId: getAttr(e.attrs, "sheetId"),
        state: getAttr(e.attrs, "state"),
        rId,
        target: rel ? resolveRelTarget("xl/workbook.xml", rel.target) : null
      };
    }).filter(s => s.target && zip.file(s.target));
    if(!sheets.length) throw new Error("“" + name + "” has no readable worksheets.");

    const stylesRel = workbookRels.find(r => r.type === REL_TYPE.styles);
    const sstRel = workbookRels.find(r => r.type === REL_TYPE.sharedStrings);
    const themeRel = workbookRels.find(r => r.type === REL_TYPE.theme);
    const externalLinkRel = workbookRels.find(r => /\/externalLink(Path)?$/.test(r.type || ""));

    const definedNamesBlock = getBlock(workbookXml, "definedNames");

    const allPaths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
    const unsupported = allPaths.filter(p => {
      if(!p.startsWith("xl/")) return false;
      if(p === "xl/calcChain.xml") return false; // safe to drop: pure perf cache, Excel rebuilds it
      if(/^xl\/comments\d*\.xml$/.test(p)) return false; // handled per-worksheet below
      if(/^xl\/worksheets\/_rels\//.test(p)) return false;
      if(/^xl\/drawings\/_rels\//.test(p)) return false;
      return !KNOWN_XL_PREFIXES.some(prefix => p.startsWith(prefix));
    });
    if(unsupported.length) warn("unsupported-parts", name, unsupported);
    if(externalLinkRel) warn("external-links", name);

    return {
      name, zip, workbookXml, sheets,
      stylesXml: stylesRel ? await partString(zip, resolveRelTarget("xl/workbook.xml", stylesRel.target)) : null,
      sharedStringsXml: sstRel ? await partString(zip, resolveRelTarget("xl/workbook.xml", sstRel.target)) : null,
      themePath: themeRel ? resolveRelTarget("xl/workbook.xml", themeRel.target) : null,
      themeXml: themeRel ? await partString(zip, resolveRelTarget("xl/workbook.xml", themeRel.target)) : null,
      definedNamesXml: definedNamesBlock ? definedNamesBlock.inner : ""
    };
  }

  // ---- styles.xml merge ----
  function mergeStyles(sources, warn){
    const mergedNumFmts = []; // {id, formatCode}
    const numFmtByCode = new Map();
    let nextNumFmtId = 164;
    const mergedFonts = [], mergedFills = [], mergedBorders = [], mergedDxfs = [], mergedCellStyleXfs = [], mergedCellXfs = [];
    const cellXfRemaps = [];
    const dxfRemaps = [];
    let baseCellStyles = "", baseTableStyles = "";

    sources.forEach((src, si) => {
      const stylesXml = src.stylesXml;
      const numFmtEls = stylesXml ? extractElements(getBlock(stylesXml, "numFmts") ? getBlock(stylesXml, "numFmts").inner : "", "numFmt") : [];
      const numFmtRemap = new Map();
      numFmtEls.forEach(e => {
        const oldId = Number(getAttr(e.attrs, "numFmtId"));
        const code = getAttr(e.attrs, "formatCode") || "";
        if(numFmtByCode.has(code)){
          numFmtRemap.set(oldId, numFmtByCode.get(code));
        } else {
          const newId = nextNumFmtId++;
          numFmtByCode.set(code, newId);
          mergedNumFmts.push({ id: newId, formatCode: code });
          numFmtRemap.set(oldId, newId);
        }
      });
      const remapNumFmtId = (id) => {
        const n = Number(id);
        return (n >= 164 && numFmtRemap.has(n)) ? numFmtRemap.get(n) : n;
      };

      const fontEls = stylesXml ? extractElements(getBlock(stylesXml, "fonts") ? getBlock(stylesXml, "fonts").inner : "", "font") : [];
      const fontOffset = mergedFonts.length;
      mergedFonts.push(...fontEls);

      const fillEls = stylesXml ? extractElements(getBlock(stylesXml, "fills") ? getBlock(stylesXml, "fills").inner : "", "fill") : [];
      const fillOffset = mergedFills.length;
      mergedFills.push(...fillEls);

      const borderEls = stylesXml ? extractElements(getBlock(stylesXml, "borders") ? getBlock(stylesXml, "borders").inner : "", "border") : [];
      const borderOffset = mergedBorders.length;
      mergedBorders.push(...borderEls);

      const dxfEls = stylesXml ? extractElements(getBlock(stylesXml, "dxfs") ? getBlock(stylesXml, "dxfs").inner : "", "dxf") : [];
      const dxfOffset = mergedDxfs.length;
      mergedDxfs.push(...dxfEls);
      const dxfRemap = new Map();
      dxfEls.forEach((e, i) => dxfRemap.set(i, dxfOffset + i));
      dxfRemaps.push(dxfRemap);

      const remapXfAttrs = (attrs) => {
        let a = attrs;
        const numFmtId = getAttr(a, "numFmtId");
        if(numFmtId != null) a = a.replace(/(\s)numFmtId="(\d+)"/, (m0, ws) => ws + 'numFmtId="' + remapNumFmtId(numFmtId) + '"');
        const fontId = getAttr(a, "fontId");
        if(fontId != null) a = a.replace(/(\s)fontId="(\d+)"/, (m0, ws) => ws + 'fontId="' + (Number(fontId) + fontOffset) + '"');
        const fillId = getAttr(a, "fillId");
        if(fillId != null) a = a.replace(/(\s)fillId="(\d+)"/, (m0, ws) => ws + 'fillId="' + (Number(fillId) + fillOffset) + '"');
        const borderId = getAttr(a, "borderId");
        if(borderId != null) a = a.replace(/(\s)borderId="(\d+)"/, (m0, ws) => ws + 'borderId="' + (Number(borderId) + borderOffset) + '"');
        return a;
      };

      const cellStyleXfEls = stylesXml ? extractElements(getBlock(stylesXml, "cellStyleXfs") ? getBlock(stylesXml, "cellStyleXfs").inner : "", "xf") : [];
      const cellStyleXfsOffset = mergedCellStyleXfs.length;
      cellStyleXfEls.forEach(e => {
        const newAttrs = remapXfAttrs(e.attrs);
        mergedCellStyleXfs.push({ ...e, attrs: newAttrs, raw: e.selfClosing ? "<xf" + newAttrs + "/>" : "<xf" + newAttrs + ">" + e.inner + "</xf>" });
      });

      const cellXfEls = stylesXml ? extractElements(getBlock(stylesXml, "cellXfs") ? getBlock(stylesXml, "cellXfs").inner : "", "xf") : [];
      const cellXfRemap = new Map();
      cellXfEls.forEach((e, oldIndex) => {
        let newAttrs = remapXfAttrs(e.attrs);
        const xfId = getAttr(newAttrs, "xfId");
        const newXfId = (xfId != null ? Number(xfId) : 0) + cellStyleXfsOffset;
        newAttrs = xfId != null
          ? newAttrs.replace(/(\s)xfId="(\d+)"/, (m0, ws) => ws + 'xfId="' + newXfId + '"')
          : newAttrs + ' xfId="' + newXfId + '"';
        const raw = e.selfClosing ? "<xf" + newAttrs + "/>" : "<xf" + newAttrs + ">" + e.inner + "</xf>";
        mergedCellXfs.push({ ...e, attrs: newAttrs, raw });
        cellXfRemap.set(oldIndex, mergedCellXfs.length - 1);
      });
      cellXfRemaps.push(cellXfRemap);

      // Named cell styles ("Normal", etc.) and table styles are kept from
      // the FIRST workbook only: concatenating "Normal" entries from every
      // source is a well-known real-world cause of "needs repair" prompts,
      // and cell rendering doesn't depend on cellStyles at all (only on
      // cellXfs, which every source's cells already reference correctly
      // via cellXfRemap above) - so this only risks losing later files'
      // *named* style gallery entries, never their actual visible formatting.
      if(si === 0){
        const cs = getBlock(stylesXml, "cellStyles");
        baseCellStyles = cs ? elementXml("cellStyles", extractElements(cs.inner, "cellStyle")) : "";
        const ts = getBlock(stylesXml, "tableStyles");
        if(ts) baseTableStyles = "<tableStyles" + ts.attrs + ">" + ts.inner + "</tableStyles>";
      } else if(stylesXml && (getBlock(stylesXml, "cellStyles") || getBlock(stylesXml, "tableStyles"))){
        warn("named-styles-dropped", src.name);
      }
    });

    const xml = xmlDecl() +
      '<styleSheet xmlns="' + NS_MAIN + '">' +
      elementXml("numFmts", mergedNumFmts.map(f => ({ raw: '<numFmt numFmtId="' + f.id + '" formatCode="' + esc(f.formatCode) + '"/>' }))) +
      elementXml("fonts", mergedFonts) +
      elementXml("fills", mergedFills) +
      elementXml("borders", mergedBorders) +
      elementXml("cellStyleXfs", mergedCellStyleXfs) +
      elementXml("cellXfs", mergedCellXfs) +
      baseCellStyles +
      (mergedDxfs.length ? elementXml("dxfs", mergedDxfs) : '<dxfs count="0"/>') +
      baseTableStyles +
      "</styleSheet>";

    return { xml, cellXfRemaps, dxfRemaps };
  }

  // ---- sharedStrings.xml merge ----
  function mergeSharedStrings(sources){
    const merged = [];
    const offsets = [];
    sources.forEach(src => {
      const items = src.sharedStringsXml ? extractElements(src.sharedStringsXml, "si") : [];
      offsets.push(items.length ? merged.length : 0);
      merged.push(...items);
    });
    if(!merged.length) return { xml: null, offsets };
    const xml = xmlDecl() +
      '<sst xmlns="' + NS_MAIN + '" count="' + merged.length + '" uniqueCount="' + merged.length + '">' +
      merged.map(e => e.raw).join("") + "</sst>";
    return { xml, offsets };
  }

  // ---- defined names merge ----
  function mergeDefinedNames(sources, sheetOffsetBySource, renameMaps, warn){
    const globalSeen = new Map(); // lowercase name -> true
    const parts = [];
    sources.forEach((src, si) => {
      const names = extractElements(src.definedNamesXml, "definedName");
      names.forEach(e => {
        const localSheetId = getAttr(e.attrs, "localSheetId");
        const name = getAttr(e.attrs, "name") || "";
        let attrs = e.attrs;
        let inner = rewriteSheetNameTokens(e.inner, renameMaps[si]);
        if(localSheetId != null){
          const newLocal = Number(localSheetId) + sheetOffsetBySource[si];
          attrs = attrs.replace(/(\s)localSheetId="(\d+)"/, (m0, ws) => ws + 'localSheetId="' + newLocal + '"');
        } else {
          const key = name.toLowerCase();
          if(globalSeen.has(key)){
            warn("defined-name-collision", src.name, name);
            return;
          }
          globalSeen.set(key, true);
        }
        parts.push("<definedName" + attrs + ">" + inner + "</definedName>");
      });
    });
    return parts.length ? "<definedNames>" + parts.join("") + "</definedNames>" : "";
  }

  // ---- copying a dependent part (drawing/table/comments/vml/printerSettings) with its own rels ----
  async function copyPartTree(srcZip, srcPath, zipOut, newPath, ctx){
    const isBinary = /\.(png|jpe?g|gif|bmp|tiff|emf|wmf|bin)$/i.test(srcPath);
    const file = srcZip.file(srcPath);
    if(!file) return false;
    if(isBinary){
      zipOut.file(newPath, await file.async("uint8array"));
    } else {
      let text = await file.async("string");
      const srcRelsPath = relsPathFor(srcPath);
      const srcRels = srcZip.file(srcRelsPath) ? parseRelationships(await srcZip.file(srcRelsPath).async("string")) : [];
      if(srcRels.length){
        const newRels = [];
        for(const rel of srcRels){
          if(rel.targetMode === "External"){ newRels.push(rel); continue; }
          const resolved = resolveRelTarget(srcPath, rel.target);
          const childNewPath = ctx.newPathFor(resolved, rel.type);
          if(childNewPath){
            await copyPartTree(srcZip, resolved, zipOut, childNewPath, ctx);
            newRels.push({ ...rel, target: ctx.relativeFrom(newPath, childNewPath) });
          } else {
            warnUnresolved(ctx, srcPath, rel);
          }
        }
        if(newRels.length) zipOut.file(relsPathFor(newPath), buildRelationshipsXml(newRels));
      }
      zipOut.file(newPath, text);
    }
    ctx.registerContentType(newPath);
    return true;
  }
  function warnUnresolved(ctx, srcPath, rel){
    ctx.warn("unresolved-dependency", srcPath, rel.type);
  }

  const EXT_COUNTERS = () => ({ media: 0, drawing: 0, table: 0, comments: 0, vml: 0, printerSettings: 0 });

  /** Decides the output path for a resolved source-package part path,
   * based on its relationship type, using per-output-package sequential
   * counters so no two source files can ever collide on a filename. */
  function makePathAllocator(counters){
    return function(resolvedPath, relType){
      if(relType === REL_TYPE.drawing) return "xl/drawings/drawing" + (++counters.drawing) + ".xml";
      if(relType === REL_TYPE.table) return "xl/tables/table" + (++counters.table) + ".xml";
      if(relType === REL_TYPE.comments) return "xl/comments" + (++counters.comments) + ".xml";
      if(relType === REL_TYPE.vmlDrawing) return "xl/drawings/vmlDrawing" + (++counters.vml) + ".vml";
      if(relType === REL_TYPE.printerSettings) return "xl/printerSettings/printerSettings" + (++counters.printerSettings) + ".bin";
      if(/\/image$/.test(relType || "")){
        const ext = extOf(resolvedPath) || "png";
        return "xl/media/image" + (++counters.media) + "." + ext;
      }
      return null; // unknown dependency type - not copied, caller warns
    };
  }
  function relativeFromWorksheetsOrDrawings(fromPath, toPath){
    // Every part this engine copies lives exactly one folder under xl/
    // (xl/drawings/, xl/tables/, xl/media/, xl/printerSettings/, or
    // directly xl/commentsN.xml) - so a relative reference from another
    // such part (or from xl/worksheets/) is always "../<folder>/<file>"
    // or "../<file>" for the flat xl/commentsN.xml/xl/theme case.
    const toRel = toPath.replace(/^xl\//, "");
    return "../" + toRel;
  }

  function tableRenameXml(tableXml, uniqueName, uniqueId){
    let out = tableXml.replace(/(<table\b[^>]*\sname=")[^"]*(")/, "$1" + esc(uniqueName) + "$2");
    if(!/\sname="/.test(out.match(/<table\b[^>]*>/)[0])) out = out.replace(/<table\b/, '<table name="' + esc(uniqueName) + '"');
    out = out.replace(/(<table\b[^>]*\sdisplayName=")[^"]*(")/, "$1" + esc(uniqueName) + "$2");
    out = out.replace(/(<table\b[^>]*\sid=")[^"]*(")/, '$1' + uniqueId + '$2');
    return out;
  }

  // ---- post-merge structural validator ----
  // Re-reads the FINISHED package fresh (never trusts in-memory state from
  // the build above) and checks every cross-reference an Excel-compatible
  // reader actually resolves: style indexes, shared-string indexes, dxf
  // indexes, and every workbook/worksheet relationship target. This is
  // exactly the class of bug that produces Excel's "repair" dialog
  // silently (a dangling s="" or a cellXfs entry pointing at a font/fill/
  // border index that doesn't exist) - if any of these are wrong, this
  // throws with the SPECIFIC broken reference instead of shipping a file
  // that merely "downloads" or "JSZip can read it".
  async function validateMergedPackage(zipOut){
    const errors = [];
    const file = (p) => zipOut.file(p);
    const text = async (p) => { const f = file(p); return f ? f.async("string") : null; };

    const stylesXml = await text("xl/styles.xml");
    if(!stylesXml) errors.push("xl/styles.xml is missing from the merged package.");
    const countOf = (tag) => {
      const block = getBlock(stylesXml, tag);
      const inner = block ? block.inner : "";
      const childTag = tag === "numFmts" ? "numFmt" : tag === "cellXfs" || tag === "cellStyleXfs" ? "xf"
        : tag === "dxfs" ? "dxf" : tag.slice(0, -1);
      return block ? extractElements(inner, childTag).length : 0;
    };
    const fontsCount = countOf("fonts"), fillsCount = countOf("fills"), bordersCount = countOf("borders");
    const cellStyleXfsCount = countOf("cellStyleXfs"), cellXfsCount = countOf("cellXfs"), dxfsCount = countOf("dxfs");
    const numFmtIds = new Set();
    const numFmtsBlock = getBlock(stylesXml, "numFmts");
    if(numFmtsBlock) extractElements(numFmtsBlock.inner, "numFmt").forEach(e => numFmtIds.add(Number(getAttr(e.attrs, "numFmtId"))));

    function checkXfEntries(tag, hasXfId){
      const block = getBlock(stylesXml, tag);
      if(!block) return;
      extractElements(block.inner, "xf").forEach((e, i) => {
        const numFmtId = Number(getAttr(e.attrs, "numFmtId") || 0);
        if(numFmtId >= 164 && !numFmtIds.has(numFmtId)) errors.push(`xl/styles.xml: ${tag}[${i}] references missing numFmtId ${numFmtId}`);
        const fontId = Number(getAttr(e.attrs, "fontId") || 0);
        if(fontId >= fontsCount) errors.push(`xl/styles.xml: ${tag}[${i}] references out-of-range fontId ${fontId} (fonts count=${fontsCount})`);
        const fillId = Number(getAttr(e.attrs, "fillId") || 0);
        if(fillId >= fillsCount) errors.push(`xl/styles.xml: ${tag}[${i}] references out-of-range fillId ${fillId} (fills count=${fillsCount})`);
        const borderId = Number(getAttr(e.attrs, "borderId") || 0);
        if(borderId >= bordersCount) errors.push(`xl/styles.xml: ${tag}[${i}] references out-of-range borderId ${borderId} (borders count=${bordersCount})`);
        if(hasXfId){
          const xfId = Number(getAttr(e.attrs, "xfId") || 0);
          if(xfId >= cellStyleXfsCount) errors.push(`xl/styles.xml: ${tag}[${i}] references out-of-range xfId ${xfId} (cellStyleXfs count=${cellStyleXfsCount})`);
        }
      });
    }
    checkXfEntries("cellStyleXfs", false);
    checkXfEntries("cellXfs", true);

    const sstXml = await text("xl/sharedStrings.xml");
    const sstCount = sstXml ? extractElements(sstXml, "si").length : 0;

    const workbookXml = await text("xl/workbook.xml");
    const relsXml = await text("xl/_rels/workbook.xml.rels");
    const rels = new Map(parseRelationships(relsXml).map(r => [r.id, r]));
    const sheetsBlock = workbookXml ? getBlock(workbookXml, "sheets") : null;
    const sheetEls = sheetsBlock ? extractElements(sheetsBlock.inner, "sheet") : [];
    if(!sheetEls.length) errors.push("xl/workbook.xml has no <sheet> entries.");
    for(const e of sheetEls){
      const sheetName = getAttr(e.attrs, "name");
      const rId = getAttr(e.attrs, "r:id");
      const rel = rels.get(rId);
      if(!rel){ errors.push(`xl/workbook.xml: sheet "${sheetName}" r:id "${rId}" has no matching entry in workbook.xml.rels`); continue; }
      const target = resolveRelTarget("xl/workbook.xml", rel.target);
      if(!file(target)) errors.push(`xl/workbook.xml: sheet "${sheetName}" target "${target}" does not exist in the package`);
    }

    const worksheetPaths = Object.keys(zipOut.files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
    for(const path of worksheetPaths){
      const xml = await text(path);
      const cellRe = /<c((?:\s[^>]*)?)\/>|<c((?:\s[^>]*)?)>([\s\S]*?)<\/c>/g;
      let m;
      while((m = cellRe.exec(xml))){
        const attrs = m[1] != null ? m[1] : m[2];
        const ref = getAttr(attrs, "r") || "?";
        const sMatch = /\ss="(\d+)"/.exec(attrs);
        if(sMatch && Number(sMatch[1]) >= cellXfsCount) errors.push(`${path}: cell ${ref} references out-of-range style ${sMatch[1]} (cellXfs count=${cellXfsCount})`);
        if(/\st="s"/.test(attrs) && m[3] != null){
          const vMatch = /<v>(\d+)<\/v>/.exec(m[3]);
          if(vMatch && Number(vMatch[1]) >= sstCount) errors.push(`${path}: cell ${ref} references out-of-range shared string ${vMatch[1]} (sharedStrings count=${sstCount})`);
        }
      }
      // A real formula's text is plain PCDATA - it can never legitimately
      // contain a raw, unescaped "<" or ">" (any actual </>/&lt;/&gt; a
      // formula needs are written as XML entities by every compliant
      // writer). Finding one is the direct fingerprint of a regex-based
      // rewrite having misidentified a self-closing <f .../> as an
      // unclosed opening tag and swallowed real markup as if it were
      // formula text - exactly what previously produced Excel's "Removed
      // Records: Formula".
      extractElements(xml, "f").forEach(e => {
        if(e.inner && /[<>]/.test(e.inner)){
          errors.push(`${path}: a <f> formula element's text contains raw markup (${JSON.stringify(e.inner.slice(0, 60))}) - a self-closing formula element was likely misparsed as unclosed`);
        }
      });
      const rowRe = /<row(\s[^>]*)?(\/>|>)/g;
      while((m = rowRe.exec(xml))){
        if(!m[1]) continue;
        const sMatch = /\ss="(\d+)"/.exec(m[1]);
        if(sMatch && Number(sMatch[1]) >= cellXfsCount) errors.push(`${path}: row ${getAttr(m[1], "r") || "?"} references out-of-range style ${sMatch[1]} (cellXfs count=${cellXfsCount})`);
      }
      const colRe = /<col(\s[^>]*)?\/>/g;
      while((m = colRe.exec(xml))){
        if(!m[1]) continue;
        const sMatch = /\sstyle="(\d+)"/.exec(m[1]);
        if(sMatch && Number(sMatch[1]) >= cellXfsCount) errors.push(`${path}: col min=${getAttr(m[1], "min") || "?"} references out-of-range style ${sMatch[1]} (cellXfs count=${cellXfsCount})`);
      }
      const dxfRe = /\sdxfId="(\d+)"/g;
      while((m = dxfRe.exec(xml))){
        if(Number(m[1]) >= dxfsCount) errors.push(`${path}: conditional formatting references out-of-range dxfId ${m[1]} (dxfs count=${dxfsCount})`);
      }

      // Tag-balance well-formedness check: catches the WHOLE CLASS of bug
      // where a regex-based rewrite misreads a self-closing tag (e.g.
      // <f t="shared" si="0"/>) as an unclosed opening tag and swallows
      // everything up to some later, unrelated closing tag - the exact
      // failure mode that previously mangled sheets mixing shared-formula
      // follower cells with an ordinary formula elsewhere on the sheet.
      // Index-bounds checks above can't detect this (the mangled region
      // can still contain in-range indexes); only a structural balance
      // check catches it.
      ["c", "row", "f"].forEach(tag => {
        const opens = (xml.match(new RegExp("<" + tag + "(?=[\\s/>])", "g")) || []).length;
        const selfClosing = (xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?/>", "g")) || []).length;
        const closes = (xml.match(new RegExp("</" + tag + ">", "g")) || []).length;
        if(opens - selfClosing !== closes){
          errors.push(`${path}: malformed <${tag}> elements (${opens - selfClosing} opening tag(s), ${closes} closing tag(s)) - the worksheet XML is not well-formed`);
        }
      });

      const wsRelsPath = relsPathFor(path);
      const wsRelsXml = await text(wsRelsPath);
      if(wsRelsXml){
        for(const r of parseRelationships(wsRelsXml)){
          if(r.targetMode === "External") continue;
          const resolved = resolveRelTarget(path, r.target);
          if(!file(resolved)) errors.push(`${wsRelsPath}: relationship ${r.id} target "${resolved}" does not exist in the package`);
        }
      }
    }

    return errors;
  }

  /**
   * Merges 2+ .xlsx packages' worksheets into one output workbook.
   * @param {{name:string, bytes:ArrayBuffer|Uint8Array}[]} files
   * @param {(percent:number, message:string)=>void} [onProgress]
   * @returns {Promise<{bytes:Uint8Array, sheetNames:string[], warnings:Array}>}
   */
  async function mergeWorkbooks(files, onProgress){
    if(!files || files.length < 2) throw new Error("Select at least 2 .xlsx files to merge.");

    const warningsRaw = [];
    const warn = (kind, ...args) => warningsRaw.push({ kind, args });

    const report = (pct, msg) => { if(onProgress) onProgress(pct, msg); };

    report(2, "Reading workbooks...");
    const sources = [];
    for(let i = 0; i < files.length; i++){
      const f = files[i];
      sources.push(await readWorkbookPackage(f.name, f.bytes, warn));
      report(2 + Math.round((i + 1) / files.length * 18), "Reading workbooks...");
    }

    report(22, "Resolving sheet names...");
    const usedNames = new Set();
    const renameMaps = sources.map(() => new Map());
    const outputSheets = [];
    const sheetOffsetBySource = [];
    sources.forEach((src, si) => {
      sheetOffsetBySource.push(outputSheets.length);
      src.sheets.forEach(sheet => {
        const unique = uniquifySheetName(sheet.name, usedNames);
        if(unique !== sheet.name) renameMaps[si].set(sheet.name, unique);
        outputSheets.push({ name: unique, sourceIndex: si, sheet });
      });
    });

    report(28, "Merging styles...");
    const styleMerge = mergeStyles(sources, warn);

    report(38, "Merging shared strings...");
    const sstMerge = mergeSharedStrings(sources);

    // Theme: first workbook's theme wins; detect (byte-diff) later ones
    // that genuinely differ, so theme-relative colors get a real warning
    // instead of silently rendering wrong.
    const baseTheme = sources.find(s => s.themeXml);
    for(const src of sources){
      if(src === baseTheme || !src.themeXml) continue;
      if(src.themeXml !== baseTheme.themeXml) warn("theme-mismatch", src.name);
    }

    report(45, "Copying worksheets...");
    const zipOut = new JSZip();
    const counters = EXT_COUNTERS();
    const pathAllocator = makePathAllocator(counters);
    const ctx = {
      warn,
      newPathFor: pathAllocator,
      relativeFrom: relativeFromWorksheetsOrDrawings,
      registerContentType: () => {} // content types are finalized in one pass below, from zipOut's actual file list
    };

    const workbookRelEntries = [];
    const sheetElements = [];
    let nextRid = 1;
    let usedTableNames = new Set();
    let nextTableId = 1;

    for(let outIdx = 0; outIdx < outputSheets.length; outIdx++){
      const { name, sourceIndex, sheet } = outputSheets[outIdx];
      const src = sources[sourceIndex];
      let sheetXml = await src.zip.file(sheet.target).async("string");

      sheetXml = remapWorksheetIndexes(sheetXml, styleMerge.cellXfRemaps[sourceIndex], sstMerge.offsets[sourceIndex]);
      sheetXml = remapConditionalFormattingDxf(sheetXml, styleMerge.dxfRemaps[sourceIndex]);
      if(renameMaps[sourceIndex].size) sheetXml = rewriteFormulasInWorksheet(sheetXml, renameMaps[sourceIndex]);

      const newSheetPath = "xl/worksheets/sheet" + (outIdx + 1) + ".xml";
      const newSheetRelsPath = relsPathFor(newSheetPath);

      const srcRelsPath = relsPathFor(sheet.target);
      const srcRelsFile = src.zip.file(srcRelsPath);
      const newRelsEntries = [];
      if(srcRelsFile){
        const rels = parseRelationships(await srcRelsFile.async("string"));
        for(const rel of rels){
          if(rel.targetMode === "External"){ newRelsEntries.push(rel); continue; }
          if(rel.type === REL_TYPE.hyperlink){ newRelsEntries.push(rel); continue; }
          const resolved = resolveRelTarget(sheet.target, rel.target);
          if(rel.type === REL_TYPE.table){
            const tableXmlRaw = await src.zip.file(resolved).async("string");
            const tableId = nextTableId++;
            const originalName = (getAttr((/<table\b[^>]*>/.exec(tableXmlRaw) || [""])[0], "displayName") || "Table" + tableId);
            const uniqueName = uniquifySheetName(originalName, usedTableNames).replace(/\s\(/, "_(").replace(/[()]/g, m => m);
            const patched = tableRenameXml(tableXmlRaw, uniqueName.replace(/\s/g, "_"), tableId);
            const newTablePath = "xl/tables/table" + tableId + ".xml";
            zipOut.file(newTablePath, patched);
            newRelsEntries.push({ ...rel, target: relativeFromWorksheetsOrDrawings(newSheetRelsPath, newTablePath) });
            continue;
          }
          const newPath = pathAllocator(resolved, rel.type);
          if(!newPath){ warn("unresolved-dependency", src.name, rel.type); continue; }
          const ok = await copyPartTree(src.zip, resolved, zipOut, newPath, ctx);
          if(ok) newRelsEntries.push({ ...rel, target: relativeFromWorksheetsOrDrawings(newSheetRelsPath, newPath) });
        }
      }

      zipOut.file(newSheetPath, sheetXml);
      if(newRelsEntries.length) zipOut.file(newSheetRelsPath, buildRelationshipsXml(newRelsEntries));

      const rId = "rId" + (nextRid++);
      workbookRelEntries.push({ id: rId, type: REL_TYPE.worksheet, target: "worksheets/sheet" + (outIdx + 1) + ".xml" });
      sheetElements.push({ name, sheetId: outIdx + 1, rId, state: sheet.state });

      report(45 + Math.round((outIdx + 1) / outputSheets.length * 35), "Copying worksheets...");
    }

    report(82, "Writing workbook structure...");

    zipOut.file("xl/styles.xml", styleMerge.xml);
    const stylesRid = "rId" + (nextRid++);
    workbookRelEntries.push({ id: stylesRid, type: REL_TYPE.styles, target: "styles.xml" });

    let sstRid = null;
    if(sstMerge.xml){
      zipOut.file("xl/sharedStrings.xml", sstMerge.xml);
      sstRid = "rId" + (nextRid++);
      workbookRelEntries.push({ id: sstRid, type: REL_TYPE.sharedStrings, target: "sharedStrings.xml" });
    }

    let themeRid = null;
    if(baseTheme){
      zipOut.file("xl/theme/theme1.xml", baseTheme.themeXml);
      themeRid = "rId" + (nextRid++);
      workbookRelEntries.push({ id: themeRid, type: REL_TYPE.theme, target: "theme/theme1.xml" });
    }

    const definedNamesXml = mergeDefinedNames(sources, sheetOffsetBySource, renameMaps, warn);

    const sheetNames = sheetElements.map(s => s.name);
    const workbookXml = xmlDecl() +
      '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_R + '">' +
      "<sheets>" + sheetElements.map(s =>
        '<sheet name="' + esc(s.name) + '" sheetId="' + s.sheetId + '"' +
        (s.state && s.state !== "visible" ? ' state="' + esc(s.state) + '"' : "") +
        ' r:id="' + s.rId + '"/>'
      ).join("") + "</sheets>" +
      definedNamesXml +
      '<calcPr fullCalcOnLoad="1"/>' +
      "</workbook>";
    zipOut.file("xl/workbook.xml", workbookXml);
    zipOut.file("xl/_rels/workbook.xml.rels", buildRelationshipsXml(workbookRelEntries));

    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    zipOut.file("docProps/core.xml", xmlDecl() +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      "<dc:creator>YOYOPDF</dc:creator><cp:lastModifiedBy>YOYOPDF</cp:lastModifiedBy>" +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
      "</cp:coreProperties>");
    zipOut.file("docProps/app.xml", xmlDecl() +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      "<Application>YOYOPDF</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>" +
      '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>' + sheetNames.length + '</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
      '<TitlesOfParts><vt:vector size="' + sheetNames.length + '" baseType="lpstr">' + sheetNames.map(n => "<vt:lpstr>" + esc(n) + "</vt:lpstr>").join("") + "</vt:vector></TitlesOfParts>" +
      "<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>" +
      "</Properties>");

    zipOut.file("_rels/.rels", buildRelationshipsXml([
      { id: "rId1", type: REL_TYPE.officeDocument, target: "xl/workbook.xml" },
      { id: "rId2", type: REL_TYPE.coreProperties, target: "docProps/core.xml" },
      { id: "rId3", type: REL_TYPE.extendedProperties, target: "docProps/app.xml" }
    ]));

    // [Content_Types].xml: one Override per XML part that needs a specific
    // type (everything the generic "xml" Default would otherwise
    // mis-describe), one Default per file extension actually used.
    const overrides = [
      ["/xl/workbook.xml", CT_OVERRIDE.workbook],
      ["/docProps/core.xml", CT_OVERRIDE.core],
      ["/docProps/app.xml", CT_OVERRIDE.app],
      ["/xl/styles.xml", CT_OVERRIDE.styles]
    ];
    if(sstMerge.xml) overrides.push(["/xl/sharedStrings.xml", CT_OVERRIDE.sharedStrings]);
    if(baseTheme) overrides.push(["/xl/theme/theme1.xml", CT_OVERRIDE.theme]);
    Object.keys(zipOut.files).forEach(path => {
      if(zipOut.files[path].dir) return;
      if(/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) overrides.push(["/" + path, CT_OVERRIDE.worksheet]);
      else if(/^xl\/drawings\/drawing\d+\.xml$/.test(path)) overrides.push(["/" + path, CT_OVERRIDE.drawing]);
      else if(/^xl\/tables\/table\d+\.xml$/.test(path)) overrides.push(["/" + path, CT_OVERRIDE.table]);
      else if(/^xl\/comments\d+\.xml$/.test(path)) overrides.push(["/" + path, CT_OVERRIDE.comments]);
    });
    const usedExts = new Set(["rels", "xml"]);
    Object.keys(zipOut.files).forEach(path => { if(!zipOut.files[path].dir) usedExts.add(extOf(path)); });
    const defaults = [...usedExts].filter(ext => CT_DEFAULT_BY_EXT[ext]).map(ext => [ext, CT_DEFAULT_BY_EXT[ext]]);

    zipOut.file("[Content_Types].xml", xmlDecl() +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      defaults.map(([ext, type]) => '<Default Extension="' + ext + '" ContentType="' + type + '"/>').join("") +
      overrides.map(([part, type]) => '<Override PartName="' + esc(part) + '" ContentType="' + type + '"/>').join("") +
      "</Types>");

    report(92, "Validating merged package...");
    const structuralErrors = await validateMergedPackage(zipOut);
    if(structuralErrors.length){
      // Never ship a package that would trigger Excel's repair dialog -
      // fail loudly with the exact broken reference(s) instead of a
      // silent "it downloaded" success. See the module doc comment: this
      // is the one thing this engine refuses to do quietly.
      const err = new Error(
        "Merge produced an invalid workbook and was stopped before download " +
        "(this is a bug in the merge engine, not your files): " +
        structuralErrors.slice(0, 5).join("; ") +
        (structuralErrors.length > 5 ? ` (+${structuralErrors.length - 5} more)` : "")
      );
      err.structuralErrors = structuralErrors;
      throw err;
    }

    report(96, "Finalizing package...");
    const bytes = await zipOut.generateAsync({
      type: "uint8array",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });

    const warnings = summarizeWarnings(warningsRaw);
    report(100, "Done");
    return { bytes, sheetNames, warnings };
  }

  function summarizeWarnings(raw){
    const out = [];
    const byKind = new Map();
    raw.forEach(w => { if(!byKind.has(w.kind)) byKind.set(w.kind, []); byKind.get(w.kind).push(w.args); });

    if(byKind.has("theme-mismatch")){
      const files = byKind.get("theme-mismatch").map(a => a[0]);
      out.push("Different color themes: " + files.join(", ") + " use a different theme than the first file — cells using theme-based colors from those files may render with the first file's theme colors instead of their own.");
    }
    if(byKind.has("external-links")){
      const files = byKind.get("external-links").map(a => a[0]);
      out.push("External workbook links in " + files.join(", ") + " were not carried over to the merged file.");
    }
    if(byKind.has("defined-name-collision")){
      const items = byKind.get("defined-name-collision").map(a => a[1] + " (from " + a[0] + ")");
      out.push("Duplicate workbook-level named range" + (items.length > 1 ? "s were" : " was") + " dropped to avoid an invalid duplicate: " + items.join(", ") + ".");
    }
    if(byKind.has("named-styles-dropped")){
      const files = byKind.get("named-styles-dropped").map(a => a[0]);
      out.push("Custom named cell styles (the “Cell Styles” gallery) from " + files.join(", ") + " were not carried over by name — the actual formatting on each cell is still preserved.");
    }
    if(byKind.has("unsupported-parts")){
      const list = byKind.get("unsupported-parts").map(a => a[0] + ": " + a[1].map(p => p.replace(/^xl\//, "")).join(", "));
      out.push("Some workbook features aren't supported by this merge and were left out — " + list.join("; ") + ".");
    }
    if(byKind.has("unresolved-dependency")){
      out.push("Some worksheet resources referenced an unrecognized dependency type and could not be copied.");
    }
    return out;
  }

  return { mergeWorkbooks, uniquifySheetName, validateMergedPackage, _internal: { extractElements, getBlock, resolveRelTarget, rewriteSheetNameTokens } };
})();
