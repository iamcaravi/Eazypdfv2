/* ---- Quick Action Modal ---- */
const QUICK_ACTIONS = [
  {id:"merge",     cat:"edit"},
  {id:"split",     cat:"edit"},
  {id:"compress",  cat:"optimize"},
  {id:"edit",      cat:"edit"},
  {id:"pdf2word",  cat:"convert"},
  {id:"pdf2excel", cat:"convert"},
  {id:"rotate",    cat:"edit"},
  {id:"sign",      cat:"security"},
  {id:"watermark", cat:"edit"},
  {id:"jpg2pdf",   cat:"convert"},
  {id:"flatten",   cat:"security"},
  {id:"organize",  cat:"edit"},
  {id:"protect",   cat:"security"},
];
const qaOverlay = document.getElementById("qaOverlay");
const qaModal = document.getElementById("qaModal");
let qaLastFocus = null;

function recommendedIdsFor(pageCount){
  if(pageCount===1) return ["edit","compress","pdf2word","pdf2excel"];
  if(pageCount && pageCount>1) return ["merge","split","organize","rotate","compress"];
  return [];
}

function openQuickActionModal(file, pageCount){
  if(!qaOverlay || !qaModal) return;
  const recommended = new Set(recommendedIdsFor(pageCount));
  const cardsHtml = QUICK_ACTIONS.map(({id,cat})=>{
    const desc = DESCRIPTIONS[id] || "";
    const color = (CATEGORY_META[cat] && CATEGORY_META[cat].color) || "#112B5C";
    const label = QA_LABELS[id] || id;
    return `<button type="button" class="qa-card" data-qa-tool="${id}">
      ${recommended.has(id) ? `<span class="qa-badge">Recommended</span>` : ``}
      ${renderIcon(id, color)}
      <span class="qa-name">${label}</span>
      <span class="qa-desc">${desc}</span>
    </button>`;
  }).join("");
  qaModal.innerHTML = `
    <div class="qa-head">
      <div>
        <h3 id="qaTitle">What would you like to do with your PDF?</h3>
        <p>Choose a tool to continue.</p>
      </div>
      <button type="button" class="qa-close" id="qaCloseBtn" aria-label="Close">✕</button>
    </div>
    <div class="qa-file">📄 <strong>${escapeAttr(file.name)}</strong> · ${fmtSize(file.size)}${pageCount ? ` · ${pageCount} page${pageCount>1?"s":""}` : ""}</div>
    <div class="qa-grid" id="qaGrid">${cardsHtml}</div>
  `;
  qaLastFocus = document.activeElement;
  qaOverlay.classList.add("open");
  qaModal.querySelectorAll("[data-qa-tool]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const toolId = btn.dataset.qaTool;
      closeQuickActionModal();
      openTool(toolId, true);
    });
  });
  document.getElementById("qaCloseBtn")?.addEventListener("click", closeQuickActionModal);
  qaModal.querySelector(".qa-card")?.focus();
}
function closeQuickActionModal(){
  if(!qaOverlay) return;
  qaOverlay.classList.remove("open");
  qaModal.innerHTML = "";
  qaLastFocus && qaLastFocus.focus && qaLastFocus.focus();
}
qaOverlay?.addEventListener("click", e=>{ if(e.target===qaOverlay) closeQuickActionModal(); });
document.addEventListener("keydown", e=>{
  if(!qaOverlay || !qaOverlay.classList.contains("open")) return;
  if(e.key==="Escape"){ closeQuickActionModal(); return; }
  if(e.key==="Tab"){
    const focusable = Array.from(qaModal.querySelectorAll("button"));
    if(!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length-1];
    if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
  }
});
/* Friendly labels for the Quick Action cards. */
const QA_LABELS = {
  merge:"Merge PDF", split:"Split PDF", compress:"Compress PDF", edit:"Edit PDF",
  pdf2word:"PDF to Word", pdf2excel:"PDF to Excel", rotate:"Rotate PDF", sign:"Sign PDF",
  watermark:"Add Watermark", jpg2pdf:"JPG to PDF", flatten:"Flatten PDF", organize:"Organize PDF",
  protect:"Protect PDF",
};

/* ---------------- Nav dropdown toggling ----------------
   Click-based toggle (works everywhere, including touch/tablet) plus a shared
   hover-intent behaviour on top for pointer/mouse users (~200ms open delay,
   150ms close delay, cancelled if the pointer re-enters in time — so moving the
   mouse across the trigger and into the panel never flickers or closes it). */
function syncDropdownAria(dd){
  const trigger = dd.querySelector(".nav-dd-trigger");
  const isOpen = dd.classList.contains("open") || dd.classList.contains("hover-open");
  if(trigger) trigger.setAttribute("aria-expanded", String(isOpen));
}
function closeAllDropdowns(){
  document.querySelectorAll(".nav-dropdown").forEach(d=>{
    d.classList.remove("open", "hover-open");
    syncDropdownAria(d);
  });
}
document.querySelectorAll(".nav-dd-trigger").forEach(trigger=>{
  trigger.addEventListener("click", (e)=>{
    e.stopPropagation();
    const dd = trigger.parentElement;
    const willOpen = !(dd.classList.contains("open") || dd.classList.contains("hover-open"));
    closeAllDropdowns();
    if(willOpen){ dd.classList.add("open"); syncDropdownAria(dd); }
  });
});
document.addEventListener("click", ()=> closeAllDropdowns());

if(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches){
  document.querySelectorAll(".nav-dropdown").forEach(dd=>{
    let openTimer=null, closeTimer=null;
    dd.addEventListener("mouseenter", ()=>{
      clearTimeout(closeTimer);
      openTimer = setTimeout(()=>{
        document.querySelectorAll(".nav-dropdown").forEach(d=>{ if(d!==dd){ d.classList.remove("open","hover-open"); syncDropdownAria(d); } });
        dd.classList.add("hover-open");
        syncDropdownAria(dd);
      }, 200);
    });
    dd.addEventListener("mouseleave", ()=>{
      clearTimeout(openTimer);
      closeTimer = setTimeout(()=>{
        dd.classList.remove("hover-open");
        syncDropdownAria(dd);
      }, 150);
    });
  });
}

/* Keyboard accessibility: Escape closes the open menu and returns focus to its
   trigger; Up/Down arrows move focus between items while a menu is open. */
document.querySelectorAll(".nav-dropdown").forEach(dd=>{
  const trigger = dd.querySelector(".nav-dd-trigger");
  dd.addEventListener("keydown", (e)=>{
    const items = Array.from(dd.querySelectorAll(".nav-dd-menu button:not([disabled])"));
    if(e.key === "Escape"){
      dd.classList.remove("open","hover-open");
      syncDropdownAria(dd);
      trigger?.focus();
    } else if(e.key === "ArrowDown" || e.key === "ArrowUp"){
      if(!items.length) return;
      e.preventDefault();
      const isOpen = dd.classList.contains("open") || dd.classList.contains("hover-open");
      if(!isOpen && document.activeElement === trigger){
        closeAllDropdowns();
        dd.classList.add("open");
        syncDropdownAria(dd);
        items[e.key === "ArrowDown" ? 0 : items.length-1].focus();
        return;
      }
      const idx = items.indexOf(document.activeElement);
      const next = e.key === "ArrowDown"
        ? items[(idx+1) % items.length]
        : items[(idx-1+items.length) % items.length];
      next.focus();
    }
  });
});

/* ---------------- Hamburger / mobile menu ---------------- */
document.getElementById("hamburgerBtn")?.addEventListener("click", (e)=>{
  e.stopPropagation();
  document.getElementById("mobileMenu")?.classList.toggle("open");
});

/* ---------------- Footer year ---------------- */
const footerYearEl = document.getElementById("footerYear");
if(footerYearEl) footerYearEl.textContent = new Date().getFullYear();

/* ---------------- Theme toggle ---------------- */
const themeToggle = document.getElementById("themeToggle");
let currentTheme = "dark";
try { currentTheme = localStorage.getItem("yoyopdf-theme") || "dark"; } catch(e) {}
document.documentElement.setAttribute("data-theme", currentTheme);
themeToggle.textContent = currentTheme === "light" ? "🌙" : "☀️";
themeToggle.addEventListener("click", ()=>{
  currentTheme = currentTheme === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", currentTheme);
  themeToggle.textContent = currentTheme === "light" ? "🌙" : "☀️";
  try { localStorage.setItem("yoyopdf-theme", currentTheme); } catch(e) {}
});


/* ---------------- Share buttons ---------------- */
function shareOn(network){
  const url = encodeURIComponent(window.location.href);
  const text = encodeURIComponent("Check out YOYOPDF — free browser-based PDF tools!");
  // noopener/noreferrer: the opened tab would otherwise get a `window.opener`
  // reference back to this page - harmless against these specific hardcoded
  // domains, but cheap, standard hardening for any window.open(..., "_blank").
  if(network==="whatsapp") window.open(`https://wa.me/?text=${text}%20${url}`, "_blank", "noopener,noreferrer");
  else if(network==="facebook") window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, "_blank", "width=600,height=500,noopener,noreferrer");
  else if(network==="x") window.open(`https://twitter.com/intent/tweet?url=${url}&text=${text}`, "_blank", "width=600,height=500,noopener,noreferrer");
  else if(network==="instagram"){
    navigator.clipboard.writeText(window.location.href).then(()=>toast("Link copied! Paste it in your Instagram bio or story."));
  }
}
document.querySelectorAll("[data-share]").forEach(btn=>{
  btn.addEventListener("click", ()=>shareOn(btn.dataset.share));
});

/* ---------------- Toast ---------------- */
function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg; t.classList.add("show");
  clearTimeout(t._h);
  t._h=setTimeout(()=>t.classList.remove("show"), 2600);
}
