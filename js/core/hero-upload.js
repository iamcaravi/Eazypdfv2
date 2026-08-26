/* ---------------- Real Quick Start dropzone (the laptop illustration) ----------------
   Reuses the existing TOOLS[] registry, openPanel(), toast(), renderIcon(), DESCRIPTIONS,
   and PDFLib (already loaded for every other tool) — no new upload logic, no tool-page
   files touched. Bridges the already-picked File into whichever tool the user chooses by
   assigning it to that tool's own #fi input and dispatching a change event, exactly as if
   the user had selected it there themselves. */
const heroDropzone = document.getElementById("heroDropzone");
const heroFileInput = document.getElementById("heroFileInput");
const heroDzTitle = document.getElementById("heroDzTitle");
const heroDzOr = document.getElementById("heroDzOr");
const heroMockChooseBtn = document.getElementById("heroMockChooseBtn");

function isPdfFile(f){ return !!f && (f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf")); }

/* Populated further down (see HeroDeviceFX near the other hero decorative
   GSAP effects) - declared as a no-op stub here so setHeroDzState below
   can safely call it regardless of definition order; by the time a user
   actually drags/drops anything the real controller is already assigned. */
let HeroDeviceFX = { onDragEnter(){}, onDragLeave(){}, onSuccess(){} };

function heroT(key){ return window.I18N ? I18N.t(key) : ({
  "hero.dropHere":"Drop your PDF here",
  "hero.releaseToUpload":"Release to upload PDF",
  "hero.preparingPdf":"Preparing your PDF…",
  "hero.pdfReady":"PDF Ready",
  "hero.pleaseUploadPdf":"Please upload a PDF file."
})[key]; }

function setHeroDzState(state){
  if(!heroDropzone) return;
  heroDropzone.classList.remove("drag-hover","state-uploading","state-success");
  if(heroDzOr) heroDzOr.style.display = "";
  if(state==="idle"){ heroDzTitle.textContent = heroT("hero.dropHere"); HeroDeviceFX.onDragLeave(); }
  else if(state==="hover"){ heroDropzone.classList.add("drag-hover"); heroDzTitle.textContent = heroT("hero.releaseToUpload"); if(heroDzOr) heroDzOr.style.display="none"; HeroDeviceFX.onDragEnter(); }
  else if(state==="uploading"){ heroDropzone.classList.add("state-uploading"); heroDzTitle.textContent = heroT("hero.preparingPdf"); if(heroDzOr) heroDzOr.style.display="none"; }
  else if(state==="success"){ heroDropzone.classList.add("state-success"); heroDzTitle.textContent = heroT("hero.pdfReady"); if(heroDzOr) heroDzOr.style.display="none"; HeroDeviceFX.onSuccess(); }
}

if(heroDropzone && heroFileInput){
  heroMockChooseBtn?.addEventListener("click", e=>{ e.stopPropagation(); heroFileInput.click(); });
  heroDropzone.addEventListener("click", ()=> heroFileInput.click());
  heroDropzone.addEventListener("keydown", e=>{
    if(e.key==="Enter" || e.key===" "){ e.preventDefault(); heroFileInput.click(); }
  });
  heroFileInput.addEventListener("change", function(){
    const file = this.files && this.files[0];
    this.value = "";
    if(file) handleHeroFile(file);
  });

  let dragDepth = 0;
  ["dragenter","dragover"].forEach(ev=>{
    heroDropzone.addEventListener(ev, e=>{
      e.preventDefault(); e.stopPropagation();
      if(ev==="dragenter") dragDepth++;
      setHeroDzState("hover");
    });
  });
  heroDropzone.addEventListener("dragleave", e=>{
    e.preventDefault(); e.stopPropagation();
    dragDepth = Math.max(0, dragDepth-1);
    if(dragDepth===0) setHeroDzState("idle");
  });
  heroDropzone.addEventListener("drop", e=>{
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if(file) handleHeroFile(file); else setHeroDzState("idle");
  });
}
/* Safety net: stop the browser from navigating to/opening a dropped file anywhere else on
   the page (the bug where a missed drop opens the PDF in a new tab). Doesn't touch the
   handling that #dz / heroDropzone already do for their own drops. */
["dragover","drop"].forEach(ev=>{
  window.addEventListener(ev, e=>{
    if(e.dataTransfer && Array.from(e.dataTransfer.types||[]).includes("Files") &&
       !e.target.closest("#heroDropzone") && !e.target.closest("#dz")){
      e.preventDefault();
    }
  });
});

async function handleHeroFile(file){
  if(!isPdfFile(file)){
    setHeroDzState("idle");
    toast(heroT("hero.pleaseUploadPdf"));
    return;
  }
  setHeroDzState("uploading");
  let pageCount = null;
  try{
    const buf = await file.arrayBuffer();
    const doc = await loadPdfSafe(buf, {ignoreEncryption:true});
    pageCount = doc.getPageCount();
  }catch(err){ pageCount = null; }
  AppSession.set([file], "hero");
  setHeroDzState("success");
  setTimeout(()=>{ setHeroDzState("idle"); openQuickActionModal(file, pageCount); }, 500);
}
