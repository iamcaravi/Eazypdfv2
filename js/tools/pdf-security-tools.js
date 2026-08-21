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
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Protect PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="protectBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Protect PDF</h2>
        <p class="tool-hero-desc">Add compatibility password protection for basic access control.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <div class="tool-content-area" id="protectFields" style="display:none">
        <div class="status" role="note">Legacy compatibility protection: 40-bit RC4 works with older PDF readers, but is not strong modern encryption. Do not rely on it for highly sensitive documents.</div>
        <div class="field"><label for="protectPw">Open password</label><input type="password" id="protectPw" autocomplete="new-password"></div>
        <div class="field"><label for="protectPw2">Confirm password</label><input type="password" id="protectPw2" autocomplete="new-password"></div>
        <div class="field">
          <div class="tool-content-area-label">Permissions (honored by readers that respect them)</div>
          <label class="checkbox-row"><input type="checkbox" id="permPrint" checked> Allow printing</label>
          <label class="checkbox-row"><input type="checkbox" id="permCopy" checked> Allow copying text/images</label>
          <label class="checkbox-row"><input type="checkbox" id="permModify" checked> Allow document editing</label>
          <label class="checkbox-row"><input type="checkbox" id="permAnnotate" checked> Allow annotations/comments</label>
        </div>
        <div class="status" id="protectError" style="color:var(--rose)" hidden></div>
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your password is never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="protectToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Protect PDF</button>
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
    if(!pw){ errEl.hidden=false; errEl.textContent = "Enter an open password."; return; }
    if(pw !== pw2){ errEl.hidden=false; errEl.textContent = "Passwords don't match."; return; }
    const permissions = {
      print: document.getElementById("permPrint").checked,
      copy: document.getElementById("permCopy").checked,
      modify: document.getElementById("permModify").checked,
      annotate: document.getElementById("permAnnotate").checked,
    };
    out.innerHTML = statusEl("Reading PDF...");
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
        throw new Error(isEncrypted ? "This PDF already has a password. Use Unlock PDF first if you want to change it." : e.message);
      }
      setStatus("Preparing document...");
      // useObjectStreams:false - pdf-crypto.js's raw-byte rewriter only
      // understands a classic xref table with top-level indirect objects,
      // not PDF 1.5+ compressed object streams. See that file's header.
      const rawBytes = await doc.save({useObjectStreams:false});
      setStatus("Encrypting...");
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
        throw new Error("Something went wrong while protecting this file, so no file was produced. Please try again.");
      }
      setStatus("Preparing download...");
      const blob = new Blob([protectedBytes], {type:"application/pdf"});
      const outName = suffixedName(file, "protected", "pdf");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const previewScale = 220 / verifyPage1.getViewport({scale:1}).height;
      const canvas = document.createElement("canvas");
      const vp = verifyPage1.getViewport({scale: previewScale});
      canvas.width = vp.width; canvas.height = vp.height;
      await verifyPage1.render({canvasContext:canvas.getContext("2d"), viewport:vp}).promise;
      setStatus("Done", true);
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
  let file=null, fileBytes=null;
  openPanel(`
    <div class="panel-head"><h3>Unlock PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="unlockBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Unlock PDF</h2>
        <p class="tool-hero-desc">Remove a password from a PDF you already know the password to.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <div class="tool-content-area" id="unlockFields" style="display:none">
        <div class="status" id="unlockStatus"></div>
        <div class="field" id="unlockPwField" style="display:none">
          <label for="unlockPw">Password</label>
          <input type="password" id="unlockPw" autocomplete="current-password">
        </div>
        <div class="status" id="unlockError" style="color:var(--rose)" hidden></div>
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your file and password are never uploaded anywhere.</p>
      <div class="tool-toolbar" id="unlockToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>Unlock PDF</button>
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
      statusBox.textContent = "This file doesn't appear to be password-protected.";
      goBtn.disabled = true;
    }catch(e){
      if(e && e.name === "PasswordException"){
        needsPassword = true;
        pwField.style.display = "block";
        statusBox.textContent = "This PDF is password-protected. Enter the password to unlock it.";
        goBtn.disabled = false;
        pwInput.focus();
      } else {
        needsPassword = false;
        pwField.style.display = "none";
        statusBox.textContent = "Could not read this file - it may not be a valid PDF.";
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
    statusBox.textContent = "Checking file...";
    pwField.style.display = "none";
    goBtn.disabled = true;
    file.arrayBuffer().then(buf=>{ fileBytes = new Uint8Array(buf); inspectFile(); });
  });
  goBtn.addEventListener("click", withToolOperation(goBtn, async (_event, operation)=>{
    const out = document.getElementById("out");
    errEl.hidden = true;
    const password = needsPassword ? pwInput.value : "";
    if(needsPassword && !password){ errEl.hidden=false; errEl.textContent="Enter the password."; return; }
    out.innerHTML = statusEl("Opening PDF...");
    let pdoc;
    try{
      pdoc = operation.track(await loadPdfJsSafe({data: fileBytes.slice(0), password}));
    }catch(e){
      out.innerHTML = "";
      errEl.hidden = false;
      errEl.textContent = (e && e.name === "PasswordException") ? "Incorrect password. Try again." : "Could not open this PDF.";
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
        setStatus("Rendering pages...");
        outBytes = await flattenPdocToPdfBytes(pdoc, (p,total)=>setStatus("Rendering pages...", false, Math.round((p/total)*100)));
      }
      setStatus("Preparing download...");
      const blob = new Blob([outBytes], {type:"application/pdf"});
      const outName = suffixedName(file, "unlocked", "pdf");
      if(!operation.isCurrent()) return;
      const {url} = downloadBlob(blob, outName);
      const {canvas} = await pdfThumb(outBytes);
      setStatus(flattened ? "Done — pages were flattened to images, so text is no longer selectable" : "Done", true);
      if(!operation.isCurrent()) return;
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not unlock this PDF (${escapeAttr(e.message)}).</div>`;
    }
  }));
};

/* ---- REPAIR PDF (recover a malformed/corrupt file) ---- */
TOOLS.repair = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Repair PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="repairBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Repair PDF</h2>
        <p class="tool-hero-desc">Attempts to recover a PDF that won't open properly or has a broken internal structure.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your file is never uploaded anywhere.</p>
      <div class="tool-toolbar" id="repairToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Repair PDF</button>
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
    out.innerHTML = statusEl("Analyzing PDF...");
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
      setStatus("Rebuilding document structure...");
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
        setStatus("Trying visual recovery...");
        const pdoc = operation.track(await loadPdfJsSafe({data: bytes.slice(0), stopAtErrors:false}));
        if(pdoc.numPages < 1) throw new Error("no pages found");
        outBytes = await flattenPdocToPdfBytes(pdoc, (p,total)=>setStatus("Recovering pages...", false, Math.round((p/total)*100)));
        flattened = true;
      }catch(e){ outBytes = null; }
    }

    if(!outBytes){
      out.innerHTML = `<div class="status" style="color:var(--rose)">This file is too damaged to repair. It may be truncated, corrupted, or not a real PDF.</div>`;
      return;
    }
    setStatus("Preparing download...");
    const blob = new Blob([outBytes], {type:"application/pdf"});
    const outName = suffixedName(file, "repaired", "pdf");
    if(!operation.isCurrent()) return;
    const {url} = downloadBlob(blob, outName);
    const {canvas} = await pdfThumb(outBytes);
    setStatus(flattened ? "Done — recovered as page images, so text is no longer selectable" : "Done", true);
    if(!operation.isCurrent()) return;
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    } finally {
      goBtn.disabled = false;
    }
  }));
};
