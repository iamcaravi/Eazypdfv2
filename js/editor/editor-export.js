/* ==========================================================================
   js/editor/editor-export.js
   ---------------------------------------------------------------------------
   Flattens editor-objects.js's object list back into the original PDF and
   triggers a download. editor-toolbar.js's Save button already calls
   window.EditorExport.exportCurrentDocument() — this implements that.

   Uses RenderEngine.getOriginalBytes() (Priority 5B, see render-engine.js's
   own file header — it already retains a clone of the loaded file's bytes
   specifically for this) rather than re-reading the input File, and pdf-lib
   (already loaded by index.html for every other tool) to reconstruct the
   output, reusing index.html's own loadPdfSafe()/downloadBlob() helpers
   when present (same fallback convention every other editor-*.js file
   already uses for its index.html-only dependencies).

   Coordinate conversion: editor-objects.js stores each object as xPct/yPct
   (top-left, 0-100, percent of the page box) / wPct/hPct (percent size).
   pdf-lib's page space has its origin at the bottom-left in points, so
   every draw call below converts top-down percentages into that space
   using the page's own getSize() — see toPdfBox().

   Known v1 limitations (documented, not silently wrong):
     - Text uses pdf-lib's built-in StandardFonts only (no font embedding),
       mapped from the six Properties-panel font choices to the nearest of
       Helvetica/Times/Courier — an embedded TrueType font is future work.
     - Text does not word-wrap; only explicit newlines in the box break
       lines. Long single lines can overflow the box, same as most simple
       PDF text tools.
     - Rectangle corner radius (data.radius) IS applied on export (Phase
       12) via drawSvgPath() with a hand-built rounded-rect path, since
       pdf-lib's drawRectangle has no radius parameter of its own — see
       roundedRectSvgPath()/drawShapeObject() below. Sharp-cornered (r=0)
       rectangles are unaffected, still drawn via the original drawRectangle
       call.
   ---------------------------------------------------------------------------
   Public surface: window.EditorExport.init()
                   window.EditorExport.exportCurrentDocument() -> Promise
   ========================================================================== */
(function () {
  // Only ever used by the window.downloadBlob-missing fallback below (a
  // defensive path for a dependency index.html always actually loads) -
  // tracked and revoked on the next export the same way pdf-processing-
  // utils.js's own downloadBlob() tracks __activeResultUrl, so repeated
  // exports through this fallback don't leak one object URL each.
  let __fallbackExportUrl = null;
  let currentFileName = '';
  let documentGeneration = 0;
  let exportController = null;
  let fallbackExportPromise = null;

  function init() {
    const exportButton = document.querySelector('[data-action="export"]');
    if(typeof window.createOperationController === 'function') {
      exportController = window.createOperationController(exportButton, {busyLabel:'Saving...', timeoutMs:120000});
    }
    window.addEventListener('editor:documentLoaded', (e) => {
      documentGeneration += 1;
      exportController?.cancel();
      currentFileName = (e.detail && e.detail.fileName) || '';
    });
  }

  function outputFileName() {
    // Defers to pdf-processing-utils.js's suffixedName() when it's loaded
    // (same index.html-only-dependency fallback convention as
    // downloadBlob() above) so this export path strips any prior
    // _compressed/_rotated/etc suffix and caps length exactly like every
    // other tool's download, instead of maintaining a second, weaker
    // copy of that logic.
    if (typeof window.suffixedName === 'function') {
      return window.suffixedName(currentFileName ? { name: currentFileName } : null, 'edited', 'pdf');
    }
    const base = currentFileName ? currentFileName.replace(/\.pdf$/i, '') : 'document';
    return `${base}_edited.pdf`;
  }

  function mapFontKey(fontFamily, bold, italic) {
    const family = (fontFamily || 'Arial').toLowerCase();
    let base = 'Helvetica';
    if (family.includes('times') || family.includes('georgia')) base = 'TimesRoman';
    else if (family.includes('courier')) base = 'Courier';
    if (base === 'TimesRoman') {
      if (bold && italic) return 'TimesRomanBoldItalic';
      if (bold) return 'TimesRomanBold';
      if (italic) return 'TimesRomanItalic';
      return 'TimesRoman';
    }
    if (base === 'Courier') {
      if (bold && italic) return 'CourierBoldOblique';
      if (bold) return 'CourierBold';
      if (italic) return 'CourierOblique';
      return 'Courier';
    }
    if (bold && italic) return 'HelveticaBoldOblique';
    if (bold) return 'HelveticaBold';
    if (italic) return 'HelveticaOblique';
    return 'Helvetica';
  }

  /** Converts an object's top-down xPct/yPct/wPct/hPct box into pdf-lib's
   *  bottom-left-origin point space for a page of size (pw, ph). */
  function toPdfBox(obj, pw, ph) {
    const x = (obj.xPct / 100) * pw;
    const w = (obj.wPct / 100) * pw;
    const h = (obj.hPct / 100) * ph;
    const yTop = (obj.yPct / 100) * ph;
    const y = ph - yTop - h; // bottom-left corner, PDF space
    return { x, y, w, h, yTopPdf: ph - yTop };
  }

  function hexToRgb01(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '000000');
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
  }

  function sniffImageType(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
    return null;
  }

  async function drawTextObject(page, obj, pdfDoc, fontCache, rgb) {
    const d = obj.data || {};
    const { x, w, yTopPdf } = toPdfBox(obj, ...pageSize(page));
    const key = mapFontKey(d.fontFamily, d.bold, d.italic);
    if (!fontCache[key]) fontCache[key] = await pdfDoc.embedFont(window.PDFLib.StandardFonts[key]);
    const font = fontCache[key];
    const size = d.fontSize || 16;
    const color = hexToRgb01(d.color);
    const sanitize = typeof window.winAnsiSafe === 'function' ? window.winAnsiSafe : (s) => s;
    const rawText = sanitize(d.text != null ? d.text : 'Text');
    const lines = String(rawText).split('\n');
    const lineHeight = size * 1.2;
    let cursorY = yTopPdf - size; // first baseline just under the top edge
    for (const line of lines) {
      let lineX = x;
      if (d.align === 'center' || d.align === 'right') {
        const textWidth = font.widthOfTextAtSize(line, size);
        if (d.align === 'center') lineX = x + (w - textWidth) / 2;
        else lineX = x + (w - textWidth);
      }
      page.drawText(line, { x: lineX, y: cursorY, size, font, color: rgb(color.r, color.g, color.b) });
      if (d.underline) {
        const textWidth = font.widthOfTextAtSize(line, size);
        page.drawLine({ start: { x: lineX, y: cursorY - size * 0.12 }, end: { x: lineX + textWidth, y: cursorY - size * 0.12 }, thickness: Math.max(0.5, size * 0.05), color: rgb(color.r, color.g, color.b) });
      }
      cursorY -= lineHeight;
    }
  }

  async function drawImageObject(page, obj, pdfDoc) {
    const d = obj.data || {};
    if (!d.src) throw new Error('An image object has no source data.');
    const res = await fetch(d.src);
    const buf = new Uint8Array(await res.arrayBuffer());
    const kind = sniffImageType(buf);
    let embedded;
    if (kind === 'png') embedded = await pdfDoc.embedPng(buf);
    else if (kind === 'jpg') embedded = await pdfDoc.embedJpg(buf);
    else throw new Error('An image object uses an unsupported format.');
    const { x, y, w, h } = toPdfBox(obj, ...pageSize(page));
    page.drawImage(embedded, { x, y, width: w, height: h });
  }

  /** SVG path for a rounded rectangle, top-left-anchored, y increasing
   *  downward (the convention page.drawSvgPath() expects - it flips the
   *  path into PDF's y-up space itself via its own anchor+scale, the same
   *  way toPdfBox()'s yTopPdf already anchors drawTextObject() above). r is
   *  pre-clamped by the caller so it can never exceed half of w or h. */
  function roundedRectSvgPath(w, h, r) {
    return `M ${r},0 L ${w - r},0 A ${r},${r} 0 0 1 ${w},${r} L ${w},${h - r} A ${r},${r} 0 0 1 ${w - r},${h} L ${r},${h} A ${r},${r} 0 0 1 0,${h - r} L 0,${r} A ${r},${r} 0 0 1 ${r},0 Z`;
  }

  function drawShapeObject(page, obj, rgb) {
    const d = obj.data || {};
    const { x, y, w, h, yTopPdf } = toPdfBox(obj, ...pageSize(page));
    const stroke = hexToRgb01(d.stroke);
    const strokeWidth = d.strokeWidth != null ? d.strokeWidth : 2;
    if (obj.type === 'rectangle') {
      const fill = hexToRgb01(d.fill);
      const radius = Math.max(0, Math.min(d.radius || 0, w / 2, h / 2));
      if (radius > 0) {
        // Sharp corners still go through drawRectangle (unchanged, zero
        // regression risk for the common no-radius case) - only a real
        // radius takes the SVG-path route pdf-lib needs for rounding,
        // since drawRectangle has no radius parameter of its own.
        page.drawSvgPath(roundedRectSvgPath(w, h, radius), {
          x, y: yTopPdf,
          color: rgb(fill.r, fill.g, fill.b),
          borderColor: rgb(stroke.r, stroke.g, stroke.b),
          borderWidth: strokeWidth,
        });
      } else {
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(fill.r, fill.g, fill.b), borderColor: rgb(stroke.r, stroke.g, stroke.b), borderWidth: strokeWidth });
      }
    } else if (obj.type === 'ellipse') {
      const fill = hexToRgb01(d.fill);
      page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, color: rgb(fill.r, fill.g, fill.b), borderColor: rgb(stroke.r, stroke.g, stroke.b), borderWidth: strokeWidth });
    } else if (obj.type === 'line') {
      page.drawLine({ start: { x, y: y + h }, end: { x: x + w, y }, thickness: strokeWidth, color: rgb(stroke.r, stroke.g, stroke.b) });
    }
  }

  /** Freehand strokes have no native pdf-lib primitive — drawn as a chain
   *  of straight segments between consecutive recorded points, same
   *  approach the on-screen SVG polyline preview uses. Points are stored
   *  (editor-objects.js) as 0-100 percentages of the object's own box, not
   *  the page, so each point is converted through that box first. */
  function drawDrawObject(page, obj, rgb) {
    const d = obj.data || {};
    const pts = d.points || [];
    if (pts.length < 2) return;
    const [pw, ph] = pageSize(page);
    const boxX = (obj.xPct / 100) * pw;
    const boxW = (obj.wPct / 100) * pw;
    const boxH = (obj.hPct / 100) * ph;
    const boxYTop = (obj.yPct / 100) * ph;
    const stroke = hexToRgb01(d.stroke);
    const strokeWidth = d.strokeWidth != null ? d.strokeWidth : 2;
    function toAbs(p) {
      const x = boxX + (p.x / 100) * boxW;
      const yTop = boxYTop + (p.y / 100) * boxH;
      return { x, y: ph - yTop };
    }
    for (let i = 1; i < pts.length; i++) {
      const a = toAbs(pts[i - 1]), b = toAbs(pts[i]);
      page.drawLine({ start: a, end: b, thickness: strokeWidth, color: rgb(stroke.r, stroke.g, stroke.b) });
    }
  }

  function drawHighlightObject(page, obj, rgb) {
    const d = obj.data || {};
    const { x, y, w, h } = toPdfBox(obj, ...pageSize(page));
    const fill = hexToRgb01(d.fill || '#ffeb3b');
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(fill.r, fill.g, fill.b), opacity: d.opacity != null ? d.opacity : 0.4 });
  }

  function drawWhiteoutObject(page, obj, rgb) {
    const d = obj.data || {};
    const { x, y, w, h } = toPdfBox(obj, ...pageSize(page));
    const fill = hexToRgb01(d.color || '#ffffff');
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(fill.r, fill.g, fill.b) });
  }

  function pageSize(page) {
    const { width, height } = page.getSize();
    return [width, height];
  }

  function exportStatus(text) {
    window.dispatchEvent(new CustomEvent('editor:progressText', { detail: { text } }));
  }

  function triggerDownload(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function performExport(operation) {
    if (!window.RenderEngine) throw new Error('The PDF editor is not ready.');
    const original = window.RenderEngine.getOriginalBytes();
    if (!original) throw new Error('Open a PDF before exporting.');
    const PDFLibNS = window.PDFLib;
    if (!PDFLibNS) throw new Error('The PDF export library is unavailable.');
    const { rgb } = PDFLibNS;
    const exportGeneration = documentGeneration;
    exportStatus('Saving PDF...');

    const pdfDoc = typeof window.loadPdfSafe === 'function'
      ? await window.loadPdfSafe(original)
      : await PDFLibNS.PDFDocument.load(original);
    const objectList = window.EditorObjects ? window.EditorObjects.getState() : [];
    const pages = pdfDoc.getPages();
    const fontCache = {};

    for (const obj of objectList) {
      operation.throwIfStale();
      const page = pages[obj.page - 1];
      if (!page) throw new Error(`Object ${obj.id} points to a page that no longer exists.`);

      if (obj.type === 'text') await drawTextObject(page, obj, pdfDoc, fontCache, rgb);
      else if (obj.type === 'image') await drawImageObject(page, obj, pdfDoc);
      else if (obj.type === 'rectangle' || obj.type === 'ellipse' || obj.type === 'line') drawShapeObject(page, obj, rgb);
      else if (obj.type === 'draw') drawDrawObject(page, obj, rgb);
      else if (obj.type === 'highlight') drawHighlightObject(page, obj, rgb);
      else if (obj.type === 'whiteout') drawWhiteoutObject(page, obj, rgb);
      else throw new Error(`Object ${obj.id} has an unsupported type: ${obj.type}.`);
    }

    operation.throwIfStale();
    if(exportGeneration !== documentGeneration) {
      const error = new Error('The document changed while it was being exported. Please save the current document again.');
      error.name = 'AbortError';
      throw error;
    }
    const outBytes = await pdfDoc.save();
    operation.throwIfStale();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const fileName = outputFileName();

    if (typeof window.downloadBlob === 'function') {
      const { url } = window.downloadBlob(blob, fileName);
      triggerDownload(url, fileName);
    } else {
      if (__fallbackExportUrl) URL.revokeObjectURL(__fallbackExportUrl);
      __fallbackExportUrl = URL.createObjectURL(blob);
      triggerDownload(__fallbackExportUrl, fileName);
    }
    exportStatus('Saved ' + fileName);
    return { fileName, byteLength: outBytes.length };
  }

  function reportExportFailure(error) {
    const message = error?.message || 'The edited PDF could not be exported.';
    console.error('EditorExport:', error);
    exportStatus('Export failed: ' + message);
    if(typeof window.toast === 'function') window.toast(message);
  }

  function exportCurrentDocument() {
    if(exportController){
      return exportController.run(performExport, {busyLabel:'Saving...', timeoutMs:120000})
        .catch(reportExportFailure);
    }
    if(fallbackExportPromise) return fallbackExportPromise;
    const context = {
      isCurrent: () => true,
      throwIfStale: () => {},
    };
    fallbackExportPromise = performExport(context)
      .catch(reportExportFailure)
      .finally(() => { fallbackExportPromise = null; });
    return fallbackExportPromise;
  }

  window.EditorExport = { init, exportCurrentDocument };
})();
