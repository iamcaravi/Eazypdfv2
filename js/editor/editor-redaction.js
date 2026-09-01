/* ========================================================================== 
   Permanent redaction support for Edit PDF.

   pdf-lib can add content but cannot safely remove arbitrary glyphs, images,
   form XObjects, or transparency groups from an existing page content stream.
   A black overlay would therefore be cosmetic only. This module takes the
   conservative browser-first route: after ordinary edits are applied, every
   page containing a pending redaction is rendered to pixels, the redaction
   appearance is burned into those pixels, and a NEW PDF is assembled entirely
   from page images. No original page object, shared resource dictionary,
   annotation, link, form widget, or content stream is copied.

   Redaction model (compatible with EditorObjects and workspace extensions):
     { id, page, xPct, yPct, wPct, hPct,
       data: { label, reason, color, state:'pending' } }
   ========================================================================== */
(function () {
  'use strict';

  const MAX_RENDER_PIXELS = 16_000_000;
  const DEFAULT_SCALE = 2;

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function normalize(object) {
    const data = object?.data || {};
    const xPct = clamp(finite(object?.xPct, 0), 0, 100);
    const yPct = clamp(finite(object?.yPct, 0), 0, 100);
    return {
      id: String(object?.id || ''),
      type: 'redaction',
      page: Math.max(1, Math.floor(finite(object?.page, 1))),
      xPct,
      yPct,
      wPct: clamp(finite(object?.wPct, 0), 0, 100 - xPct),
      hPct: clamp(finite(object?.hPct, 0), 0, 100 - yPct),
      label: String(data.label ?? object?.label ?? '').trim().slice(0, 120),
      reason: String(data.reason ?? object?.reason ?? '').trim().slice(0, 500),
      color: /^#[0-9a-f]{6}$/i.test(data.color ?? object?.color ?? '') ? (data.color ?? object.color) : '#000000',
      state: (data.state ?? object?.state) === 'completed' ? 'completed' : 'pending'
    };
  }

  function collect(objects) {
    return (Array.isArray(objects) ? objects : [])
      .filter((object) => object?.type === 'redaction')
      .map(normalize)
      .filter((region) => region.wPct > 0 && region.hPct > 0);
  }

  function toWorkspaceExtension(object) {
    const region = normalize(object);
    return {
      kind: 'redaction', page: region.page,
      rect: { xPct: region.xPct, yPct: region.yPct, wPct: region.wPct, hPct: region.hPct },
      label: region.label, reason: region.reason, appearance: { color: region.color }, state: region.state
    };
  }

  function paint(ctx, width, height, regions) {
    for (const region of regions) {
      const x = Math.floor(region.xPct * width / 100);
      const y = Math.floor(region.yPct * height / 100);
      const right = Math.ceil((region.xPct + region.wPct) * width / 100);
      const bottom = Math.ceil((region.yPct + region.hPct) * height / 100);
      const w = Math.max(1, right - x), h = Math.max(1, bottom - y);
      ctx.save();
      ctx.fillStyle = region.color || '#000000';
      ctx.fillRect(x, y, w, h);
      if (region.label && w >= 28 && h >= 12) {
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        const fontSize = Math.max(9, Math.min(18, h * 0.42));
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${fontSize}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(region.label, x + w / 2, y + h / 2, Math.max(1, w - 8));
      }
      ctx.restore();
    }
  }

  function canvasImageBytes(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('The redacted page image could not be created.')); return; }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', 0.95));
  }

  function copyMetadata(source, target) {
    const pairs = [
      ['getTitle', 'setTitle'], ['getAuthor', 'setAuthor'], ['getSubject', 'setSubject'],
      ['getCreator', 'setCreator'], ['getProducer', 'setProducer'],
      ['getCreationDate', 'setCreationDate'], ['getModificationDate', 'setModificationDate']
    ];
    for (const [getter, setter] of pairs) {
      try { const value = source[getter]?.(); if (value != null) target[setter]?.(value); } catch (_) {}
    }
    try { const keywords = source.getKeywords?.(); if (keywords) target.setKeywords?.(String(keywords).split(/,\s*/)); } catch (_) {}
  }

  async function buildPermanentPdf(editedBytes, redactionObjects, options) {
    const opts = options || {};
    const operation = opts.operation || { throwIfStale() {} };
    const regions = collect(redactionObjects);
    if (!regions.length) return { bytes: editedBytes, redactedPages: [], redactionCount: 0 };
    if (!window.PDFLib || typeof window.loadPdfJsSafe !== 'function') {
      throw new Error('Permanent redaction support is unavailable in this browser session.');
    }

    const byPage = new Map();
    regions.forEach((region) => {
      const list = byPage.get(region.page) || [];
      list.push(region); byPage.set(region.page, list);
    });

    const sourceBytes = editedBytes instanceof Uint8Array ? editedBytes : new Uint8Array(editedBytes);
    const sourceDoc = await window.PDFLib.PDFDocument.load(sourceBytes.slice());
    const renderedDoc = await window.loadPdfJsSafe({ data: sourceBytes.slice() });
    const outputDoc = await window.PDFLib.PDFDocument.create();
    copyMetadata(sourceDoc, outputDoc);

    try {
      const pageCount = sourceDoc.getPageCount();
      for (const pageNumber of byPage.keys()) {
        if (pageNumber > pageCount) throw new Error(`Redaction points to missing page ${pageNumber}.`);
      }
      for (let index = 0; index < pageCount; index += 1) {
        operation.throwIfStale();
        const pageNumber = index + 1;
        opts.onProgress?.(pageNumber, pageCount);
        const pageRegions = byPage.get(pageNumber) || [];

        const pdfPage = await renderedDoc.getPage(pageNumber);
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const safeScale = Math.min(DEFAULT_SCALE, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, baseViewport.width * baseViewport.height)));
        if (!Number.isFinite(safeScale) || safeScale <= 0) throw new Error(`Page ${pageNumber} has invalid dimensions for redaction.`);
        const viewport = pdfPage.getViewport({ scale: safeScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('This browser cannot create a secure redaction canvas.');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        operation.throwIfStale();
        if (pageRegions.length) paint(ctx, canvas.width, canvas.height, pageRegions);
        const image = await outputDoc.embedJpg(await canvasImageBytes(canvas));
        canvas.width = 1; canvas.height = 1;
        const page = outputDoc.addPage([baseViewport.width, baseViewport.height]);
        page.drawImage(image, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
        pdfPage.cleanup?.();
      }
      operation.throwIfStale();
      const bytes = await outputDoc.save();

      // Every rebuilt page must contain only its flattened page image. This
      // also prevents inherited/shared resources from an affected page from
      // hitching a ride through an otherwise-unaffected page's resource tree.
      const verifyDoc = await window.loadPdfJsSafe({ data: bytes.slice() });
      try {
        for (let pageNumber = 1; pageNumber <= verifyDoc.numPages; pageNumber += 1) {
          const page = await verifyDoc.getPage(pageNumber);
          const [text, annotations] = await Promise.all([page.getTextContent(), page.getAnnotations()]);
          if (text.items.length || annotations.length) throw new Error(`Permanent redaction verification failed on page ${pageNumber}.`);
          page.cleanup?.();
        }
      } finally { await verifyDoc.destroy(); }
      return { bytes, redactedPages: Array.from(byPage.keys()).sort((a, b) => a - b), flattenedPages: pageCount, redactionCount: regions.length };
    } finally {
      await renderedDoc.destroy();
    }
  }

  window.EditorRedaction = { normalize, collect, paint, toWorkspaceExtension, buildPermanentPdf };
})();
