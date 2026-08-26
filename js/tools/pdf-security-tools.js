/* ---------------- Shared: flatten a pdf.js document into a fresh, unencrypted PDF ----------------
   Renders every page to a raster image and embeds it full-bleed into a new
   pdf-lib document - the same "rip to image" technique pdf2jpg/jpg2pdf
   already use, just chained together instead of exported separately. Used
   by both Unlock PDF (when the file's encryption scheme isn't the simple
   one pdf-crypto.js can structurally decrypt) and Repair PDF (when a file
   is too structurally damaged for pdf-lib/pdf-crypto.js to rebuild). Always
   succeeds if pdf.js could render the pages at all - the honest tradeoff
   (documented in both tools' UI) is that the result's text is no longer
   selectable/searchable, since the page is now one flat image.
   @param {import("pdfjs-dist").PDFDocumentProxy} pdoc
   @param {(page:number, total:number)=>void} [onProgress]
   @returns {Promise<Uint8Array>}
*/
async function flattenPdocToPdfBytes(pdoc, onProgress){
  const doc = await PDFDocument.create();
  for(let i=1;i<=pdoc.numPages;i++){
    if(onProgress) onProgress(i, pdoc.numPages);
    const canvas = await renderPdfPageCanvas(pdoc, i, 2);
    const blob = await new Promise(res=>canvas.toBlob(res, "image/jpeg", 0.92));
    const imgBytes = new Uint8Array(await blob.arrayBuffer());
    const img = await doc.embedJpg(imgBytes);
    const page = doc.addPage([canvas.width, canvas.height]);
    page.drawImage(img, {x:0, y:0, width:canvas.width, height:canvas.height});
  }
  return doc.save();
}

/* ---- PROTECT PDF (add an open password, 40-bit RC4) ---- */
TOOLS.protect = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.protect")}</h3></div>
    <div class="panel-body compact tool-workspace" id="protectBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.protect")}</h2>
        <p class="tool-hero-desc">${t("toolProtect.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("toolSplit.selectPdfFile"))}
      </div>
      <div class="tool-content-area" id="protectFields" style="display:none">
        <div class="status" role="note">${t("toolProtect.legacyWarning")}</div>
        <div class="field"><label for="protectPw">${t("toolProtect.openPasswordLabel")}</label><input type="password" id="protectPw" autocomplete="new-password"></div>
        <div class="field"><label for="protectPw2">${t("toolProtect.confirmPasswordLabel")}</label><input type="password" id="protectPw2" autocomplete="new-password"></div>
        <div class="field">
          <div class="tool-content-area-label">${t("toolProtect.permissionsLabel")}</div>
          <label class="checkbox-row"><input type="checkbox" id="permPrint" checked> ${t("toolProtect.permPrint")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permCopy" checked> ${t("toolProtect.permCopy")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permModify" checked> ${t("toolProtect.permModify")}</label>
          <label class="checkbox-row"><input type="checkbox" id="permAnnotate" checked> ${t("toolProtect.permAnnotate")}</label>
        </div>
        <div class="status" id="protectError" style="color:var(--rose)" hidden></div>
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintPassword")}</p>
      <div class="tool-toolbar" id="protectToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("tools.protect")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{
      file=null;
      document.getElementById("protectToolbar").style.display="none";
      document.getElementById("protectFields").style.display="none";
      document.getElementById("protectBody").classList.remove("is-loaded");
    });
    document.getElementById("protectToolbar").style.display="flex";
    document.getElementById("protectFields").style.display="block";
    document.getElementById("protectBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out = document.getElementById("out");
    const errEl = document.getElementById("protectError");
    errEl.hidden = true;
    const pw = document.getElementById("protectPw").value;
    const pw2 = document.getElementById("protectPw2").value;
    if(!pw){ errEl.hidden=false; errEl.textContent = t("toolProtect.errEnterPassword"); return; }
    if(pw !== pw2){ errEl.hidden=false; errEl.textContent = t("toolProtect.errPasswordMismatch"); return; }
    const permissions = {
      print: document.getElementById("permPrint").checked,
      copy: document.getElementById("permCopy").checked,
      modify: document.getElementById("permModify").checked,
      annotate: document.getElementById("permAnnotate").checked,
    };
    out.innerHTML = statusEl(T("workspace.statusReadingPdf"));
    // Guards the same rapid-file-replacement/double-click race every
    // Go-button handler in this app needs (see pdf-page-tools-1.js's
    // Compress PDF for the established pattern).
    goBtn.disabled = true;
    try{
      const bytes = await file.arrayBuffer();
      let doc;
      try{
        doc = await loadPdfSafe(bytes);
      }catch(e){
        const isEncrypted = /encrypt/i.test(e.name||"") || /encrypt/i.test(e.message||"");
        throw new Error(isEncrypted ? t("toolProtect.errAlreadyProtected") : e.message);
      }
      setStatus(T("workspace.statusPreparingDocument"));
      // useObjectStreams:false - pdf-crypto.js's raw-byte rewriter only
      // understands a classic xref table with top-level indirect objects,
      // not PDF 1.5+ compressed object streams. See that file's header.
      const rawBytes = await doc.save({useObjectStreams:false});
      setStatus(t("toolProtect.statusEncrypting"));
      const protectedBytes = encryptPdfBytes(rawBytes, {userPassword:pw, ownerPassword:pw, permissions});
      // Runtime self-check: independently re-open the result with pdf.js
      // (a mature, separately-implemented decryptor) using the same
      // password. This is the actual correctness guarantee for a hand-
      // rolled encryption routine that has never been run through an
      // automated test in this environment - a failure here means the
      // output would not be a valid protected PDF, so it's never handed
      // to the user; see js/core/pdf-crypto.js's file header for why.
      let verifyPage1;
      try{
        const verifyDoc = operation.track(await loadPdfJsSafe({data: protectedBytes.slice(0), password: pw}));
        verifyPage1 = await verifyDoc.getPage(1);
      }catch(e){
        throw new Error(t("toolProtect.errFailedGeneric"));
      }
      setStatus(T("workspace.statusPreparingDownload"));
      const blob = new Blob([protectedBytes], {type:"application/pdf"});
      const outName = suffixedName(file, "protected", "pdf");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const previewScale = 220 / verifyPage1.getViewport({scale:1}).height;
      const canvas = document.createElement("canvas");
      const vp = verifyPage1.getViewport({scale: previewScale});
      canvas.width = vp.width; canvas.height = vp.height;
      await verifyPage1.render({canvasContext:canvas.getContext("2d"), viewport:vp}).promise;
      setStatus(t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${escapeAttr(e.message)}</div>`;
    }finally{
      goBtn.disabled = false;
    }
  }));
};

/* ---- UNLOCK PDF (remove a known password) ---- */
TOOLS.unlock = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null, fileBytes=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.unlock")}</h3></div>
    <div class="panel-body compact tool-workspace" id="unlockBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.unlock")}</h2>
        <p class="tool-hero-desc">${t("toolUnlock.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <div class="tool-content-area" id="unlockFields" style="display:none">
        <div class="status" id="unlockStatus"></div>
        <div class="field" id="unlockPwField" style="display:none">
          <label for="unlockPw">${t("toolUnlock.passwordLabel")}</label>
          <input type="password" id="unlockPw" autocomplete="current-password">
        </div>
        <div class="status" id="unlockError" style="color:var(--rose)" hidden></div>
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFilePassword")}</p>
      <div class="tool-toolbar" id="unlockToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>${t("tools.unlock")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  const statusBox = document.getElementById("unlockStatus");
  const pwField = document.getElementById("unlockPwField");
  const pwInput = document.getElementById("unlockPw");
  const errEl = document.getElementById("unlockError");
  const goBtn = document.getElementById("go");
  let needsPassword = false;

  async function inspectFile(){
    errEl.hidden = true;
    try{
      const inspectionDoc = await loadPdfJsSafe({data: fileBytes.slice(0)});
      await inspectionDoc.destroy();
      needsPassword = false;
      pwField.style.display = "none";
      statusBox.textContent = t("toolUnlock.statusNotProtected");
      goBtn.disabled = true;
    }catch(e){
      if(e && e.name === "PasswordException"){
        needsPassword = true;
        pwField.style.display = "block";
        statusBox.textContent = t("toolUnlock.statusProtectedEnterPw");
        goBtn.disabled = false;
        pwInput.focus();
      } else {
        needsPassword = false;
        pwField.style.display = "none";
        statusBox.textContent = t("toolUnlock.statusCouldNotRead");
        goBtn.disabled = true;
      }
    }
  }
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{
      file=null; fileBytes=null;
      document.getElementById("unlockToolbar").style.display="none";
      document.getElementById("unlockFields").style.display="none";
      document.getElementById("unlockBody").classList.remove("is-loaded");
    });
    document.getElementById("unlockToolbar").style.display="flex";
    document.getElementById("unlockFields").style.display="block";
    document.getElementById("unlockBody").classList.add("is-loaded");
    statusBox.textContent = t("toolUnlock.statusCheckingFile");
    pwField.style.display = "none";
    goBtn.disabled = true;
    file.arrayBuffer().then(buf=>{ fileBytes = new Uint8Array(buf); inspectFile(); });
  });
  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const out = document.getElementById("out");
    errEl.hidden = true;
    const password = needsPassword ? pwInput.value : "";
    if(needsPassword && !password){ errEl.hidden=false; errEl.textContent=t("toolUnlock.errEnterPassword"); return; }
    out.innerHTML = statusEl(t("toolUnlock.statusOpeningPdf"));
    let pdoc;
    try{
      pdoc = operation.track(await loadPdfJsSafe({data: fileBytes.slice(0), password}));
    }catch(e){
      out.innerHTML = "";
      errEl.hidden = false;
      errEl.textContent = (e && e.name === "PasswordException") ? t("toolUnlock.errIncorrectPassword") : t("toolUnlock.errCouldNotOpen");
      return;
    }
    try{
      let outBytes = null;
      // Fast path: this exact PDF was encrypted with the simple scheme
      // pdf-crypto.js fully understands - decrypt in place and keep every
      // page fully vector/text, not a rasterized copy.
      const fast = tryDecryptSimplePdfBytes(fileBytes, password);
      if(fast && fast.bytes){
        try{
          operation.track(await loadPdfJsSafe({data: fast.bytes.slice(0)})); // self-check: must now open with NO password
          outBytes = fast.bytes;
        }catch(e){ outBytes = null; } // fall through to the flatten path below
      }
      const flattened = !outBytes;
      if(flattened){
        setStatus(t("toolUnlock.statusRenderingPages"));
        outBytes = await flattenPdocToPdfBytes(pdoc, (p,total)=>setStatus(t("toolUnlock.statusRenderingPages"), false, Math.round((p/total)*100)));
      }
      setStatus(T("workspace.statusPreparingDownload"));
      const blob = new Blob([outBytes], {type:"application/pdf"});
      const outName = suffixedName(file, "unlocked", "pdf");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const {canvas} = await pdfThumb(outBytes);
      setStatus(flattened ? t("toolUnlock.doneFlattened") : t("workspace.done"), true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolUnlock.errCouldNotUnlock", {msg: escapeAttr(e.message)})}</div>`;
    }
  }));
};

/* ---- REPAIR PDF (recover a malformed/corrupt file) ---- */
TOOLS.repair = function(){
  const t = window.I18N ? I18N.t : (k)=>k;
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>${t("tools.repair")}</h3></div>
    <div class="panel-body compact tool-workspace" id="repairBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">${t("tools.repair")}</h2>
        <p class="tool-hero-desc">${t("toolRepair.heroDesc")}</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, t("workspace.selectPdfFiles"))}
      </div>
      <p class="tool-privacy-hint">🔒 ${T("workspace.privacyHintFile")}</p>
      <div class="tool-toolbar" id="repairToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">${t("tools.repair")}</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("repairToolbar").style.display="none"; document.getElementById("repairBody").classList.remove("is-loaded"); });
    document.getElementById("repairToolbar").style.display="flex";
    document.getElementById("repairBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", withToolOperation(document.getElementById("go"), async (_event, operation)=>{
    const goBtn = document.getElementById("go");
    const out = document.getElementById("out");
    out.innerHTML = statusEl(t("toolRepair.statusAnalyzing"));
    // Same rapid-file-replacement/double-click guard as Protect PDF above.
    goBtn.disabled = true;
    try {
    const bytes = await file.arrayBuffer();
    let outBytes = null, flattened = false;

    // Level 1: pdf-lib's own tolerant parser + a clean re-save. A plain
    // resave already fixes a large class of real-world damage (a broken/
    // stale xref table, dangling references pdf-lib's loader recovers
    // from) since it rebuilds the whole file structure from the parsed
    // object graph rather than patching bytes in place.
    try{
      const doc = await loadPdfSafe(bytes, {
        ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false,
      });
      setStatus(t("toolRepair.statusRebuilding"));
      const rebuilt = await doc.save();
      operation.track(await loadPdfJsSafe({data: rebuilt.slice(0)})); // self-check: must actually open
      outBytes = rebuilt;
    }catch(e){ /* structural repair failed - try visual recovery below */ }

    // Level 2: pdf.js is often more forgiving than pdf-lib about damaged
    // xref tables. If the file's pages can still be RENDERED even though
    // its structure can't be cleanly rebuilt, recover them as a flattened,
    // image-based PDF rather than giving up - an honest "recovered, but
    // no longer editable text" result beats no result at all.
    if(!outBytes){
      try{
        setStatus(t("toolRepair.statusTryingVisualRecovery"));
        const pdoc = operation.track(await loadPdfJsSafe({data: bytes.slice(0), stopAtErrors:false}));
        if(pdoc.numPages < 1) throw new Error("no pages found");
        outBytes = await flattenPdocToPdfBytes(pdoc, (p,total)=>setStatus(t("toolRepair.statusRecoveringPages"), false, Math.round((p/total)*100)));
        flattened = true;
      }catch(e){ outBytes = null; }
    }

    if(!outBytes){
      out.innerHTML = `<div class="status" style="color:var(--rose)">${t("toolRepair.errTooDamaged")}</div>`;
      return;
    }
    setStatus(T("workspace.statusPreparingDownload"));
    const blob = new Blob([outBytes], {type:"application/pdf"});
    const outName = suffixedName(file, "repaired", "pdf");
    if(!operation.isCurrent()) return;
    const {url} = downloadBlob(blob, outName);
    const {canvas} = await pdfThumb(outBytes);
    setStatus(flattened ? t("toolRepair.doneFlattened") : t("workspace.done"), true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};
