/* Keyboard commands and the serializable in-memory clipboard for Edit PDF.
   Native input/textarea/contenteditable editing is deliberately left alone. */
(function () {
  const OBJECT_MIME = 'application/x-yoyopdf-objects+json';
  const PASTE_OFFSET_PCT = 1.5;
  let root = null;
  let clipboard = null;
  let pasteCount = 0;

  function init(rootEl) {
    root = rootEl;
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    window.addEventListener('editor:documentLoaded', () => { clipboard = null; pasteCount = 0; });
  }

  function isActive() { return !!(root && root.isConnected); }

  function isTextEntry(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName || '') || !!target.closest?.('[contenteditable="true"]');
  }

  function isNativeEditing(event) {
    return isTextEntry(event?.target) || isTextEntry(document.activeElement);
  }

  function selectedObjects() {
    return window.EditorObjects?.getSelectedObjects?.() || window.EditorObjects?.getAllObjects?.().filter((object) => object.selected) || [];
  }

  function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
      const copy = {};
      Object.keys(value).forEach((key) => { copy[key] = cloneValue(value[key]); });
      return copy;
    }
    return value;
  }

  function snapshotSelection() {
    const items = selectedObjects().map((object) => ({
      type:object.type,page:object.page,xPct:object.xPct,yPct:object.yPct,wPct:object.wPct,hPct:object.hPct,
      data:cloneValue(object.data || {})
    }));
    if (!items.length) return null;
    const plainText = items.length === 1 && items[0].type === 'text'
      ? String(items[0].data.text || '')
      : `${items.length} YOYOPDF editor object${items.length === 1 ? '' : 's'}`;
    return {version:1,items,plainText};
  }

  function setClipboardData(event, payload) {
    if (!event.clipboardData || !payload) return;
    try { event.clipboardData.setData(OBJECT_MIME, JSON.stringify(payload)); } catch (_) { /* custom MIME can be browser-restricted */ }
    event.clipboardData.setData('text/plain', payload.plainText || '');
  }

  function onCopy(event) {
    if (!isActive() || isNativeEditing(event)) return;
    const payload = snapshotSelection();
    if (!payload) return;
    event.preventDefault();
    clipboard = payload;
    pasteCount = 0;
    setClipboardData(event, payload);
  }

  function onCut(event) {
    if (!isActive() || isNativeEditing(event)) return;
    const payload = snapshotSelection();
    if (!payload) return;
    event.preventDefault();
    clipboard = payload;
    pasteCount = 0;
    setClipboardData(event, payload);
    const ids = selectedObjects().map((object) => object.id);
    window.EditorObjects?.deleteObjects(ids);
  }

  function clipboardPayload(event) {
    const custom = event.clipboardData?.getData(OBJECT_MIME);
    if (custom) {
      try {
        const parsed = JSON.parse(custom);
        if (parsed?.version === 1 && Array.isArray(parsed.items)) return parsed;
      } catch (_) { /* malformed external custom clipboard data falls through to plain text */ }
    }
    const plain = event.clipboardData?.getData('text/plain') || '';
    if (clipboard && (!plain || plain === clipboard.plainText)) return clipboard;
    return plain ? {version:1,items:[],plainText:plain} : clipboard;
  }

  function independentPasteData(data) {
    const next = cloneValue(data || {});
    if (Number.isFinite(Number(next.layoutFontSize))) next.fontSize = Number(next.layoutFontSize);
    if (Number.isFinite(Number(next.layoutHorizontalScale))) next.horizontalScale = Number(next.layoutHorizontalScale);
    delete next.replaceOriginal;
    delete next.sourceKey;
    delete next.sourceText;
    delete next.sourceBox;
    delete next.sourceCommitted;
    delete next.backgroundColor;
    delete next.reflowGenerated;
    delete next.reflowOwner;
    delete next.reflowBaseBox;
    delete next.reflowApplied;
    delete next.layoutLines;
    delete next.layoutMode;
    delete next.layoutFontSize;
    delete next.layoutHorizontalScale;
    return next;
  }

  function cascadeDelta(items) {
    const step = PASTE_OFFSET_PCT * ((pasteCount % 8) + 1);
    const minX = Math.min(...items.map((item) => item.xPct));
    const minY = Math.min(...items.map((item) => item.yPct));
    const maxX = Math.max(...items.map((item) => item.xPct + item.wPct));
    const maxY = Math.max(...items.map((item) => item.yPct + item.hPct));
    let dx = Math.min(step, 100 - maxX), dy = Math.min(step, 100 - maxY);
    if (dx < Math.min(step, .25)) dx = -Math.min(step, minX);
    if (dy < Math.min(step, .25)) dy = -Math.min(step, minY);
    return {dx,dy};
  }

  function pasteObjects(payload) {
    const items = payload?.items || [];
    if (!items.length || !window.EditorObjects) return false;
    const page = window.ViewportManager?.getCurrentPage?.() || items[0].page || 1;
    const {dx,dy} = cascadeDelta(items);
    pasteCount += 1;
    const specs = items.map((item) => ({
      type:item.type,page,
      xPct:clamp(item.xPct + dx,0,Math.max(0,100-item.wPct)),
      yPct:clamp(item.yPct + dy,0,Math.max(0,100-item.hPct)),
      wPct:item.wPct,hPct:item.hPct,data:independentPasteData(item.data)
    }));
    window.EditorObjects.addObjects(specs);
    return true;
  }

  function pastePlainText(text) {
    if (!text || !window.EditorObjects) return false;
    const page = window.ViewportManager?.getCurrentPage?.() || 1;
    const offset = PASTE_OFFSET_PCT * ((pasteCount % 8) + 1);
    pasteCount += 1;
    window.EditorObjects.addObjects([{
      type:'text',page,xPct:clamp(10+offset,0,68),yPct:clamp(10+offset,0,92),wPct:30,hPct:6,
      data:{text,fontFamily:'Arial',fontSize:16,bold:false,italic:false,underline:false,color:'#000000',opacity:1,align:'left',lineHeight:1.2,rotation:0}
    }]);
    return true;
  }

  function onPaste(event) {
    if (!isActive() || isNativeEditing(event)) return;
    const payload = clipboardPayload(event);
    if (!payload) return;
    const handled = payload.items?.length ? pasteObjects(payload) : pastePlainText(payload.plainText);
    if (handled) event.preventDefault();
  }

  function onKeyDown(event) {
    if (!isActive() || isNativeEditing(event)) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = String(event.key || '').toLowerCase();
    if (modifier && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) window.EditorHistory?.redo();
      else window.EditorHistory?.undo();
      return;
    }
    if (modifier && key === 'y') {
      event.preventDefault();
      window.EditorHistory?.redo();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const selected = selectedObjects();
      if (!selected.length) return;
      event.preventDefault();
      window.EditorObjects?.deleteObjects(selected.map((object) => object.id));
      return;
    }
    if (event.key === 'Escape' && selectedObjects().length) {
      event.preventDefault();
      window.EditorObjects?.deselectAll();
      event.stopImmediatePropagation();
    }
  }

  function clamp(value,min,max) { return Math.max(min,Math.min(max,value)); }

  window.EditorCommands = { init };
})();
