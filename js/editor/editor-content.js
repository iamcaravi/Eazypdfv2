/* Lazy native-PDF content interaction for Edit PDF.
   Text geometry is extracted only for the current page and its neighbours. The original page stays
   rendered by pdf.js; selectable hit regions are lightweight DOM metadata, not duplicate visible
   text. Activating a region creates a normal EditorObjects text object whose export replaces only
   that source rectangle, keeping untouched PDF content intact. */
(function(){
  let root=null, generation=0, activeTool='select';
  const loadedPages=new Set();
  const sourceObjects=new Map();
  const sourceHits=new Map();
  const pageLayouts=new Map();

  function init(rootEl){
    root=rootEl;
    root.dataset.activeTool='select';
    window.addEventListener('editor:documentLoaded',()=>{
      generation++;
      loadedPages.clear();
      sourceObjects.clear();
      sourceHits.clear();
      pageLayouts.clear();
      window.EditorTextLayout?.clear();
      root.querySelectorAll('.editor-native-layer').forEach(el=>el.remove());
    });
    window.addEventListener('editor:pageChange',(event)=>{
      const page=event.detail.page, total=event.detail.pageCount;
      [page-1,page,page+1].filter(n=>n>=1&&n<=total).forEach(ensurePage);
    });
    window.addEventListener('editor:toolChange',(event)=>{
      activeTool=event.detail.tool || 'select';
      root.dataset.activeTool=activeTool;
    });
    window.addEventListener('editor:objectsChanged',syncSourceObjects);
    window.addEventListener('editor:textEditFinished',(event)=>{
      const object=event.detail?.object;
      if(!object?.data?.replaceOriginal) return;
      const key=object.data.sourceKey, hit=sourceHits.get(key);
      if((event.detail.cancelled || !event.detail.changed) && object.data.text===object.data.sourceText){
        sourceObjects.delete(key);
        window.EditorObjects?.discardObject(object.id);
        hit?.classList.remove('is-activated');
      }else{
        if(event.detail.changed) applyTextLayout(object);
        hit?.classList.add('is-activated');
      }
    });
  }

  async function ensurePage(pageNumber){
    if(loadedPages.has(pageNumber) || !window.RenderEngine) return;
    const ownGeneration=generation;
    loadedPages.add(pageNumber);
    try{
      const layout=await window.RenderEngine.getPageTextLayout(pageNumber);
      if(ownGeneration!==generation) return;
      pageLayouts.set(pageNumber,layout);
      window.EditorTextLayout?.registerPage(pageNumber,layout);
      const pageEl=root.querySelector(`.editor-canvas-page[data-page="${pageNumber}"]`);
      if(!pageEl) { loadedPages.delete(pageNumber); return; }
      const layer=document.createElement('div');
      layer.className='editor-native-layer';
      layer.setAttribute('aria-label',`Editable text on page ${pageNumber}`);
      layout.items.forEach(item=>{
        if(!item.text.trim()) return;
        const hit=document.createElement('button');
        hit.type='button'; hit.className='editor-native-text';
        hit.dataset.sourceKey=`${pageNumber}:${item.index}`;
        hit.title='Edit existing PDF text';
        hit.setAttribute('aria-label',`Edit text: ${item.text.slice(0,80)}`);
        hit.style.left=`${item.x/layout.width*100}%`;
        hit.style.top=`${item.y/layout.height*100}%`;
        hit.style.width=`${Math.max(1,item.width)/layout.width*100}%`;
        hit.style.height=`${Math.max(1,item.height)/layout.height*100}%`;
        if(Math.abs(item.angle)>0.1) hit.style.transform=`rotate(${item.angle}deg)`;
        sourceHits.set(hit.dataset.sourceKey,hit);
        hit.addEventListener('click',(event)=>{
          if(activeTool!=='select' && activeTool!=='text') return;
          event.preventDefault(); event.stopPropagation();
          hit.classList.add('is-activated');
          activateText(pageNumber,item,layout,undefined,hit,{pointer:{clientX:event.clientX,clientY:event.clientY}});
        });
        layer.appendChild(hit);
      });
      pageEl.appendChild(layer);
    }catch(error){
      loadedPages.delete(pageNumber);
      console.warn(`Could not build editable text layer for page ${pageNumber}:`,error);
    }
  }

  function sampleBackground(pageNumber,item,layout){
    const pageEl=root.querySelector(`.editor-canvas-page[data-page="${pageNumber}"]`);
    const canvas=pageEl?.querySelector('canvas');
    if(!canvas || !canvas.width || !canvas.height) return '#ffffff';
    const sx=canvas.width/layout.width, sy=canvas.height/layout.height;
    const points=[
      [item.x-1,item.y-1],[item.x+item.width+1,item.y-1],
      [item.x-1,item.y+item.height+1],[item.x+item.width+1,item.y+item.height+1]
    ];
    try{
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const colors=points.map(([x,y])=>{
        const px=Math.max(0,Math.min(canvas.width-1,Math.round(x*sx)));
        const py=Math.max(0,Math.min(canvas.height-1,Math.round(y*sy)));
        return Array.from(ctx.getImageData(px,py,1,1).data).slice(0,3);
      });
      const rgb=[0,1,2].map(channel=>colors.map(c=>c[channel]).sort((a,b)=>a-b)[Math.floor(colors.length/2)]);
      return '#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('');
    }catch(_){ return '#ffffff'; }
  }

  function activateText(pageNumber,item,layout,replacement,hit,options){
    if(!window.EditorObjects) return null;
    const opts=options||{};
    window.EditorObjects.cancelPlacement();
    const key=`${pageNumber}:${item.index}`;
    const existingId=sourceObjects.get(key);
    if(existingId){
      const existing=window.EditorObjects.getAllObjects().find(obj=>obj.id===existingId);
      if(existing){
        if(replacement!=null) window.EditorObjects.updateObject(existingId,{data:Object.assign({},existing.data,{text:replacement})},{silent:!!opts.silent});
        if(opts.select!==false) window.EditorObjects.selectObject(existingId);
        return existing;
      }
      sourceObjects.delete(key);
    }
    const geometry=opts.geometry||item;
    const programmaticReplacement=replacement!=null&&replacement!==item.text;
    const transientActivation=!programmaticReplacement&&!opts.reflowGenerated&&!opts.silent;
    const xPct=geometry.x/layout.width*100, yPct=geometry.y/layout.height*100;
    const wPct=Math.max(1,geometry.width==null?item.width:geometry.width)/layout.width*100;
    const hPct=Math.max(1,geometry.height==null?item.height:geometry.height)/layout.height*100;
    const backgroundColor=sampleBackground(pageNumber,item,layout);
    const sourceHit=hit || sourceHits.get(key);
    sourceHit?.style.setProperty('--editor-source-background',backgroundColor);
    const object=window.EditorObjects.addObject({
      type:'text',page:pageNumber,xPct,yPct,wPct,hPct,
      data:{text:replacement!=null?replacement:item.text,fontFamily:item.fontFamily,originalFontFamily:item.fontFamily,fontName:item.fontName,fontSize:item.fontSize,originalFontSize:item.fontSize,bold:item.bold,italic:item.italic,color:item.color||'#000000',opacity:item.opacity==null?1:item.opacity,
        characterSpacing:item.characterSpacing||0,wordSpacing:item.wordSpacing||0,horizontalScale:item.horizontalScale||1,direction:item.direction||'ltr',vertical:!!item.vertical,
        align:item.direction==='rtl'?'right':'left',lineHeight:Math.max(1,(item.ascent||.8)-(item.descent||-.2)),rotation:item.angle||0,transform:item.transform,baseline:item.baseline,baselineOffset:item.baseline-item.y,
        replaceOriginal:true,sourceKey:key,sourceText:item.text,sourceBox:{xPct:item.x/layout.width*100,yPct:item.y/layout.height*100,wPct:Math.max(1,item.width)/layout.width*100,hPct:Math.max(1,item.height)/layout.height*100},backgroundColor,
        sourceCommitted:programmaticReplacement||!!opts.reflowGenerated,reflowGenerated:!!opts.reflowGenerated,reflowOwner:opts.reflowOwner||null,reflowBaseBox:opts.reflowBaseBox||null}
    },{silent:!!opts.silent||transientActivation,select:opts.select!==false,notify:!opts.reflowGenerated});
    sourceObjects.set(key,object.id);
    sourceHit?.classList.add('is-activated');
    if(opts.edit!==false){
      const pointer=opts.pointer || null;
      setTimeout(()=>window.EditorObjects.editText(object.id,pointer),0);
    }
    return object;
  }

  function syncSourceObjects(){
    sourceObjects.clear();
    (window.EditorObjects?.getAllObjects()||[]).forEach(object=>{
      if(object.data?.sourceKey) sourceObjects.set(object.data.sourceKey,object.id);
    });
    sourceHits.forEach((hit,key)=>hit.classList.toggle('is-activated',sourceObjects.has(key)));
  }

  function applyTextLayout(object){
    const layout=pageLayouts.get(object.page);
    const manualLayoutData=object.data?.manualGeometry&&window.EditorTextLayout?.planWithinBox(object);
    const plan=manualLayoutData
      ? {patch:{data:manualLayoutData},shifts:[]}
      : window.EditorTextLayout?.plan(object,window.EditorObjects?.getAllObjects()||[]);
    if(!layout || !plan) return;
    const owner=object.data.sourceKey;
    const plannedKeys=new Set(plan.shifts.map(shift=>shift.sourceKey));
    const all=window.EditorObjects.getAllObjects();

    all.filter(candidate=>candidate.id!==object.id&&candidate.data?.reflowOwner===owner&&!plannedKeys.has(candidate.data.sourceKey)).forEach(candidate=>{
      const hit=sourceHits.get(candidate.data.sourceKey);
      if(candidate.data.reflowGenerated && candidate.data.text===candidate.data.sourceText){
        window.EditorObjects.discardObject(candidate.id,{silent:true});
        sourceObjects.delete(candidate.data.sourceKey);
        hit?.classList.remove('is-activated');
      }else if(candidate.data.reflowBaseBox){
        window.EditorObjects.updateObject(candidate.id,Object.assign({},candidate.data.reflowBaseBox,{data:{reflowOwner:null,reflowBaseBox:null}}),{silent:true});
      }
    });

    window.EditorObjects.updateObject(object.id,plan.patch,{silent:true});
    plan.shifts.forEach(shift=>{
      const item=shift.item;
      const existingId=sourceObjects.get(shift.sourceKey);
      const existing=existingId&&window.EditorObjects.getAllObjects().find(candidate=>candidate.id===existingId);
      const geometry={x:shift.x,y:shift.y,width:item.width,height:item.height};
      if(existing){
        const base=existing.data.reflowBaseBox||{xPct:existing.xPct,yPct:existing.yPct,wPct:existing.wPct,hPct:existing.hPct};
        window.EditorObjects.updateObject(existing.id,{
          xPct:geometry.x/layout.width*100,yPct:geometry.y/layout.height*100,
          data:{reflowOwner:owner,reflowBaseBox:base}
        },{silent:true});
      }else{
        activateText(object.page,item,layout,item.text,sourceHits.get(shift.sourceKey),{
          edit:false,silent:true,select:false,geometry,reflowGenerated:true,reflowOwner:owner,
          reflowBaseBox:{xPct:item.x/layout.width*100,yPct:item.y/layout.height*100,wPct:item.width/layout.width*100,hPct:item.height/layout.height*100}
        });
      }
    });
  }

  async function search(query,onProgress){
    const normalized=String(query||'').toLocaleLowerCase();
    if(!normalized) return [];
    const results=[], total=window.RenderEngine.getNumPages();
    for(let page=1;page<=total;page++){
      const layout=await window.RenderEngine.getPageTextLayout(page);
      for(const item of layout.items){
        const lower=item.text.toLocaleLowerCase();
        let from=0,index;
        while((index=lower.indexOf(normalized,from))!==-1){ results.push({page,item,layout,index,length:normalized.length}); from=index+Math.max(1,normalized.length); }
      }
      if(onProgress) onProgress(page,total);
    }
    return results;
  }

  function replaceResult(result,query,replacement){
    const text=result.item.text;
    const next=text.slice(0,result.index)+replacement+text.slice(result.index+query.length);
    return activateText(result.page,result.item,result.layout,next);
  }

  function openFindReplace(){
    const overlay=document.createElement('div');
    overlay.className='editor-dialog-overlay';
    overlay.innerHTML=`<form class="editor-dialog" aria-label="Find and replace PDF text">
      <div class="editor-dialog-head"><strong>Find &amp; Replace</strong><button type="button" data-close aria-label="Close">✕</button></div>
      <label>Find<input name="find" type="search" required autocomplete="off"></label>
      <label>Replace with<input name="replace" type="text" autocomplete="off"></label>
      <div class="editor-find-status" role="status">Search works on extractable text. Scanned pages are skipped.</div>
      <div class="editor-dialog-actions"><button type="button" data-find>Find</button><button type="button" data-replace disabled>Replace current</button><button type="button" data-all disabled>Replace all</button></div>
    </form>`;
    document.body.appendChild(overlay);
    const form=overlay.querySelector('form'),status=overlay.querySelector('.editor-find-status');
    const replaceButton=overlay.querySelector('[data-replace]'),allButton=overlay.querySelector('[data-all]');
    let results=[],current=0,lastQuery='';
    const close=()=>overlay.remove();
    overlay.querySelector('[data-close]').addEventListener('click',close);
    overlay.addEventListener('mousedown',event=>{if(event.target===overlay) close();});
    overlay.querySelector('[data-find]').addEventListener('click',async()=>{
      lastQuery=form.elements.find.value;
      status.textContent='Searching…';
      results=await search(lastQuery,(page,total)=>{status.textContent=`Searching page ${page} of ${total}…`;}); current=0;
      status.textContent=results.length?`${results.length} match${results.length===1?'':'es'} found.`:'No matches found.';
      replaceButton.disabled=!results.length; allButton.disabled=!results.length;
      if(results.length) window.ViewportManager.scrollToPage(results[0].page);
    });
    replaceButton.addEventListener('click',()=>{
      if(!results.length) return;
      replaceResult(results[current],lastQuery,form.elements.replace.value);
      current=Math.min(results.length-1,current+1);
      status.textContent=`Replaced match ${current||1} of ${results.length}.`;
      window.ViewportManager.scrollToPage(results[current].page);
    });
    allButton.addEventListener('click',()=>{
      const unique=new Map(); results.forEach(result=>unique.set(`${result.page}:${result.item.index}`,result));
      const escaped=lastQuery.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      unique.forEach(result=>activateText(result.page,result.item,result.layout,result.item.text.replace(new RegExp(escaped,'gi'),form.elements.replace.value)));
      status.textContent=`Prepared ${results.length} replacements in ${unique.size} text object${unique.size===1?'':'s'}. Apply Changes to save them.`;
      replaceButton.disabled=true; allButton.disabled=true;
    });
    form.addEventListener('submit',event=>{event.preventDefault();overlay.querySelector('[data-find]').click();});
    form.elements.find.focus();
  }

  window.EditorContent={init,ensurePage,search,openFindReplace};
})();
