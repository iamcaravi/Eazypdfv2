/* Page-local geometry planner for edits to extractable PDF text.
   It measures with the resolved browser font, calibrates those measurements
   against the source PDF run, and returns percentage-space patches plus the
   minimum native text-run displacements needed to prevent collisions. */
(function () {
  const pages = new Map();
  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');

  class SpatialIndex {
    constructor(items, bucketSize) {
      this.bucketSize = bucketSize || 64;
      this.buckets = new Map();
      items.forEach((item) => this.insert(item));
    }

    insert(item) {
      const b = this.bucketSize;
      const x0 = Math.floor(item.x / b), x1 = Math.floor((item.x + item.width) / b);
      const y0 = Math.floor(item.y / b), y1 = Math.floor((item.y + item.height) / b);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        if (!this.buckets.has(key)) this.buckets.set(key, []);
        this.buckets.get(key).push(item);
      }
    }

    query(rect, padding) {
      const pad = padding || 0, b = this.bucketSize, found = new Map();
      const x0 = Math.floor((rect.x - pad) / b), x1 = Math.floor((rect.x + rect.width + pad) / b);
      const y0 = Math.floor((rect.y - pad) / b), y1 = Math.floor((rect.y + rect.height + pad) / b);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        (this.buckets.get(`${x}:${y}`) || []).forEach((item) => found.set(item.index, item));
      }
      return Array.from(found.values());
    }
  }

  function registerPage(pageNumber, layout) {
    const items = layout.items.map((item) => Object.assign({}, item, {
      sourceKey: `${pageNumber}:${item.index}`,
      right: item.x + item.width,
      bottom: item.y + item.height
    }));
    pages.set(pageNumber, {
      width: layout.width,
      height: layout.height,
      rotation: layout.rotation,
      items,
      byKey: new Map(items.map((item) => [item.sourceKey, item])),
      index: new SpatialIndex(items, 64)
    });
  }

  function clear() { pages.clear(); }

  function fontString(data, size) {
    return `${data.italic ? 'italic ' : ''}${data.bold ? '700 ' : '400 '}${Math.max(1, size)}px "${String(data.fontFamily || 'sans-serif').replace(/"/g, '')}"`;
  }

  function rawMeasure(text, data, size) {
    if (!measureContext) return Array.from(String(text || '')).length * size * 0.55;
    measureContext.font = fontString(data, size);
    let width = measureContext.measureText(String(text || '')).width;
    const chars = Array.from(String(text || ''));
    width += Math.max(0, chars.length - 1) * (Number(data.characterSpacing) || 0);
    width += chars.filter((char) => /\s/u.test(char)).length * (Number(data.wordSpacing) || 0);
    return width * (Number(data.horizontalScale) || 1);
  }

  function metricScale(source, data, size) {
    const measured = rawMeasure(source.text, data, size);
    return measured > 0 && source.width > 0 ? source.width / measured : 1;
  }

  function measure(text, data, size, scale) {
    return rawMeasure(text, data, size) * scale;
  }

  /** Resolve the source run's browser metric correction once, before its
   *  first editable DOM node is mounted. The same canonical scale is then
   *  used in edit mode and after commit, avoiding a typography jump when
   *  reflow used to introduce layoutHorizontalScale only after editing. */
  function sourceMetrics(source, pageNumber) {
    const page = pages.get(pageNumber);
    const canonical = page?.byKey.get(`${pageNumber}:${source?.index}`) || source;
    const size = Number(canonical?.fontSize) || 12;
    const calibration = canonical ? metricScale(canonical, canonical, size) : 1;
    const tolerance = canonical ? Math.max(2, canonical.fontSize * 0.55, canonical.height * 0.45) : 0;
    const below = page && canonical ? page.items.filter((item) =>
      item.sourceKey !== canonical.sourceKey && item.y > canonical.y + tolerance &&
      item.y <= canonical.y + canonical.height * 10
    ) : [];
    const edgeTolerance = canonical ? Math.max(1, canonical.fontSize * 0.12) : 0;
    const rightPeers = below.filter((item) => Math.abs(item.right - canonical.right) <= edgeTolerance).length;
    const leftPeers = below.filter((item) => Math.abs(item.x - canonical.x) <= edgeTolerance).length;
    const inferredAlign = rightPeers >= 2 && rightPeers > leftPeers ? 'right' : null;
    return Object.assign({
      fontMetricScale:calibration,
      layoutHorizontalScale:(Number(canonical?.horizontalScale) || 1) * calibration
    }, inferredAlign ? {align:inferredAlign} : {});
  }

  function verticalOverlap(a, b) {
    return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  }

  function sameRow(a, b, tolerance) {
    const overlap = verticalOverlap(a, b);
    return overlap >= Math.min(a.height, b.height) * 0.42 || Math.abs((a.baseline || a.bottom) - (b.baseline || b.bottom)) <= tolerance;
  }

  function splitLongToken(token, maxWidth, data, size, scale) {
    const parts = [], chars = Array.from(token);
    let part = '';
    chars.forEach((char) => {
      const candidate = part + char;
      if (part && measure(candidate, data, size, scale) > maxWidth) { parts.push(part); part = char; }
      else part = candidate;
    });
    if (part || !parts.length) parts.push(part);
    return parts;
  }

  function wrapText(text, maxWidth, data, size, scale) {
    const lines = [];
    String(text == null ? '' : text).split('\n').forEach((paragraph) => {
      const tokens = paragraph.split(/(\s+)/u).filter(Boolean);
      let line = '';
      tokens.forEach((token) => {
        const candidate = line + token;
        if (!line || measure(candidate, data, size, scale) <= maxWidth) { line = candidate; return; }
        lines.push(line.trimEnd());
        if (measure(token, data, size, scale) <= maxWidth) line = token.trimStart();
        else {
          const pieces = splitLongToken(token.trim(), maxWidth, data, size, scale);
          lines.push(...pieces.slice(0, -1));
          line = pieces[pieces.length - 1] || '';
        }
      });
      lines.push(line);
    });
    return lines.length ? lines : [''];
  }

  function inferContext(page, source) {
    const tolerance = Math.max(2, source.fontSize * 0.55, source.height * 0.45);
    const local = page.index.query({x:0, y:source.y - source.height * 4, width:page.width, height:source.height * 9}, 4)
      .filter((item) => item.sourceKey !== source.sourceKey);
    const row = local.filter((item) => sameRow(source, item, tolerance)).sort((a, b) => a.x - b.x);
    const right = row.filter((item) => item.x >= source.right - tolerance).sort((a, b) => a.x - b.x);
    const below = local.filter((item) => item.y > source.y + tolerance);
    const alignedBelow = below.filter((item) => Math.abs(item.x - source.x) <= Math.max(5, source.fontSize * 1.25));
    const rightAnchor = right[0];
    const repeatedRightColumn = rightAnchor && below.some((item) => Math.abs(item.x - rightAnchor.x) <= Math.max(5, source.fontSize));
    const repeatedLeftColumn = alignedBelow.length > 0;
    const tableLike = !!(rightAnchor && repeatedRightColumn && repeatedLeftColumn);
    const paragraphLike = !tableLike && alignedBelow.some((item) => {
      const verticalGap = item.y - source.bottom;
      return verticalGap >= -tolerance && verticalGap <= Math.max(source.height * 2.5, source.fontSize * 3);
    });
    return { tolerance, row, right, below, alignedBelow, tableLike, paragraphLike };
  }

  function rowChain(context, source, gap) {
    const result = [];
    let edge = source.right;
    context.right.forEach((item) => {
      if (!result.length || item.x - edge <= Math.max(gap * 4, source.fontSize * 2)) {
        result.push(item);
        edge = Math.max(edge, item.right);
      }
    });
    return result;
  }

  function pct(value, total) { return total ? value / total * 100 : 0; }

  function plan(object, allObjects) {
    const page = pages.get(object.page);
    const data = object.data || {};
    const source = page?.byKey.get(data.sourceKey);
    if (!page || !source) return null;

    const size = Number(data.fontSize) || source.fontSize || 12;
    const originalSize = Number(data.originalFontSize) || source.fontSize || size;
    const calibrationData = Object.assign({}, data, {fontFamily:data.originalFontFamily || data.fontFamily});
    const calibration = metricScale(source, calibrationData, originalSize);
    const text = String(data.text == null ? '' : data.text);
    const naturalWidth = Math.max(1, measure(text, data, size, calibration));
    const lineHeight = Math.max(source.height, size * (Number(data.lineHeight) || 1.2));
    const margin = Math.max(4, size * 0.45);
    const gap = Math.max(1.5, size * 0.18);
    const pageRight = page.width - margin;
    const pageBottom = page.height - margin;
    const context = inferContext(page, source);
    const nearestRight = context.right[0] || null;
    const freeWidth = Math.max(source.width, (nearestRight ? nearestRight.x - gap : pageRight) - source.x);
    let width = Math.max(source.width, Math.min(naturalWidth, pageRight - source.x));
    let x = source.x;
    let height = source.height;
    let layoutMode = 'single';
    let layoutFontSize = size;
    let lines = [text];
    const shifts = [];

    if (Math.abs(Number(source.angle) || 0) > 2 || data.vertical) {
      if (naturalWidth > source.width) layoutFontSize = Math.max(size * 0.72, size * source.width / naturalWidth);
      return {
        patch:{
          xPct:pct(source.x,page.width),yPct:pct(source.y,page.height),wPct:pct(source.width,page.width),hPct:pct(source.height,page.height),
          data:{layoutMode:'single',layoutFontSize,fontMetricScale:calibration,layoutHorizontalScale:(Number(data.horizontalScale)||1)*calibration,layoutLines:[text],reflowApplied:true}
        },
        shifts:[],page
      };
    }

    const preserveSingleTokenMetrics = (context.tableLike || data.align === 'right') && !/\s/u.test(text);
    if (preserveSingleTokenMetrics && naturalWidth > source.width) {
      // IDs, account numbers and numeric table values should expand at their
      // source size instead of silently changing font size/weight. The normal
      // move/resize controls remain available if the user wants to reposition
      // the enlarged value inside its visual cell.
      width = Math.max(source.width, Math.min(naturalWidth, pageRight - source.x));
      if (data.align === 'right') x = Math.max(margin, source.right - width);
    } else if (naturalWidth > freeWidth + 0.25) {
      const chain = rowChain(context, source, gap);
      const requiredShift = nearestRight ? naturalWidth + gap - (nearestRight.x - source.x) : 0;
      const chainRight = chain.reduce((right, item) => Math.max(right, item.right), 0);
      const horizontalSlack = chain.length ? pageRight - chainRight : 0;

      if (!context.tableLike && chain.length && requiredShift > 0 && requiredShift <= horizontalSlack) {
        width = naturalWidth;
        chain.forEach((item) => shifts.push({sourceKey:item.sourceKey, x:item.x + requiredShift, y:item.y}));
      } else if (context.paragraphLike || context.tableLike || !nearestRight) {
        let wrapWidth = context.tableLike ? freeWidth : Math.max(freeWidth, pageRight - source.x);
        wrapWidth = Math.max(source.width, Math.min(wrapWidth, pageRight - source.x));
        lines = wrapText(text, wrapWidth, data, size, calibration);
        width = wrapWidth;
        height = Math.max(source.height, lines.length * lineHeight);
        layoutMode = lines.length > 1 ? 'wrap' : 'single';

        if (context.tableLike) {
          const nextRowY = context.alignedBelow.reduce((y, item) => Math.min(y, item.y), Infinity);
          const rowSpace = Number.isFinite(nextRowY) ? Math.max(source.height, nextRowY - source.y - gap) : pageBottom - source.y;
          if (height > rowSpace) {
            const fitted = Math.max(size * 0.72, size * Math.min(wrapWidth / naturalWidth, rowSpace / height));
            layoutFontSize = fitted;
            lines = wrapText(text, wrapWidth, data, fitted, calibration);
            height = Math.min(rowSpace, Math.max(source.height, lines.length * fitted * (Number(data.lineHeight) || 1.2)));
          }
        } else if (height > source.height) {
          const delta = height - source.height;
          context.alignedBelow
            .filter((item) => item.x < source.x + width + gap && item.right > source.x - gap)
            .forEach((item) => shifts.push({sourceKey:item.sourceKey, x:item.x, y:item.y + delta}));
        }
      } else {
        width = freeWidth;
        layoutFontSize = Math.max(size * 0.72, size * freeWidth / naturalWidth);
      }
    }

    if (source.y + height > pageBottom) {
      const availableHeight = Math.max(source.height, pageBottom - source.y);
      layoutFontSize = Math.max(size * 0.72, layoutFontSize * availableHeight / height);
      lines = wrapText(text, width, data, layoutFontSize, calibration);
      height = Math.min(availableHeight, Math.max(source.height, lines.length * layoutFontSize * (Number(data.lineHeight) || 1.2)));
    }

    const occupiedKeys = new Set((allObjects || []).filter((item) => item.page === object.page && item.id !== object.id && item.data?.sourceKey).map((item) => item.data.sourceKey));
    const uniqueShifts = [];
    const seen = new Set();
    shifts.forEach((shift) => {
      if (shift.sourceKey === source.sourceKey || seen.has(shift.sourceKey)) return;
      const item = page.byKey.get(shift.sourceKey);
      if (!item) return;
      seen.add(shift.sourceKey);
      uniqueShifts.push(Object.assign({}, shift, {item, alreadyMaterialized:occupiedKeys.has(shift.sourceKey)}));
    });

    return {
      patch: {
        xPct:pct(x,page.width), yPct:pct(source.y,page.height),
        wPct:pct(width,page.width), hPct:pct(height,page.height),
        data:{layoutMode,layoutFontSize,fontMetricScale:calibration,layoutHorizontalScale:(Number(data.horizontalScale)||1)*calibration,layoutLines:lines,reflowApplied:true}
      },
      shifts:uniqueShifts,
      page
    };
  }

  /** Recalculate wrapping for a user-resized text object without moving the
   *  box back to the source coordinates. Percentage geometry remains the
   *  single authority shared by the editor and PDF export. */
  function planWithinBox(object) {
    const page = pages.get(object.page);
    if (!page) return null;
    const data = object.data || {};
    const source = page.byKey.get(data.sourceKey);
    const width = Math.max(1, object.wPct / 100 * page.width);
    const height = Math.max(1, object.hPct / 100 * page.height);
    const size = Number(data.fontSize) || source?.fontSize || 12;
    const originalSize = Number(data.originalFontSize) || source?.fontSize || size;
    const calibrationData = Object.assign({}, data, {fontFamily:data.originalFontFamily || data.fontFamily});
    const calibration = source ? metricScale(source, calibrationData, originalSize) : 1;
    const text = String(data.text == null ? '' : data.text);
    const rotated = Math.abs(Number(data.rotation) || 0) > 2 || data.vertical;
    let layoutFontSize = size;
    let lines = rotated ? [text] : wrapText(text, width, data, size, calibration);
    let neededHeight = lines.length * size * (Number(data.lineHeight) || 1.2);

    if (rotated) {
      const naturalWidth = measure(text, data, size, calibration);
      if (naturalWidth > width) layoutFontSize = Math.max(size * 0.72, size * width / naturalWidth);
    } else if (neededHeight > height) {
      // Preserve the source size whenever the user's box can hold it. Font
      // reduction is only the fallback for a genuinely undersized box.
      layoutFontSize = Math.max(size * 0.72, size * height / neededHeight);
      lines = wrapText(text, width, data, layoutFontSize, calibration);
      neededHeight = lines.length * layoutFontSize * (Number(data.lineHeight) || 1.2);
      if (neededHeight > height) layoutFontSize = Math.max(size * 0.72, layoutFontSize * height / neededHeight);
    }

    return {
      layoutMode:lines.length > 1 ? 'wrap' : 'single',
      layoutFontSize,
      fontMetricScale:calibration,
      layoutHorizontalScale:(Number(data.horizontalScale) || 1) * calibration,
      layoutLines:lines,
      reflowApplied:true,
      manualGeometry:true
    };
  }

  window.EditorTextLayout = { registerPage, clear, sourceMetrics, plan, planWithinBox };
})();
