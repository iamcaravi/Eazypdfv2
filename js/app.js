pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const { PDFDocument, degrees, rgb, StandardFonts, ParseSpeeds } = PDFLib;
/**
 * The one entry point for PDFDocument.load() in this app - every call
 * site should go through this helper instead of calling pdf-lib
 * directly, so the whole app gets both fixes below in one place.
 *
 * pdf-lib's PDFDocument.load() defaults to parseSpeed: ParseSpeeds.Slow -
 * a deliberately conservative setting that yields control very frequently
 * while parsing, intended to keep the main thread responsive on large
 * documents. For PDFs with many objects packed into compressed object
 * streams (a standard PDF 1.5+ feature many modern generators use - Word/
 * LibreOffice export, Ghostscript, LaTeX, etc.) this default makes loading
 * dramatically slower - measured up to 38x slower (8.4s vs 219ms on the
 * same real 3.5MB/1570-object file) than parseSpeed: ParseSpeeds.Fastest,
 * which produces the identical parsed object graph, just without yielding
 * as often.
 * @param {ArrayBuffer|Uint8Array} bytes - raw PDF bytes.
 * @param {object} [extraOpts] - extra pdf-lib load options, merged over
 *   the parseSpeed default (a caller can still override it if needed).
 * @param {number} [timeoutMs=20000] - abort with a rejection instead of
 *   hanging forever on some pathological input.
 * @returns {Promise<import("pdf-lib").PDFDocument>}
 */
async function loadPdfSafe(bytes, extraOpts={}, timeoutMs=20000){
  return Promise.race([
    PDFDocument.load(bytes, {parseSpeed: ParseSpeeds.Fastest, ...extraOpts}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("This PDF took too long to open - it may be unusually large or complex")), timeoutMs))
  ]);
}

/* ---------------- Motion system (GSAP) ----------------
   Centralized tokens so animation timing/easing is declared once instead
   of scattered as arbitrary numbers across every call site. Three
   durations only (fast/normal/emphasis) - matches the "don't animate
   everything simultaneously" principle better than a continuum of
   one-off values, and keeps every entrance/exit in the app visually
   related instead of each tool inventing its own pacing.
   prefers-reduced-motion is read live via MOTION.reduced (a getter, so
   a mid-session OS-level toggle is respected on the next call) - every
   helper below still applies the SAME end state when it's set, just with
   duration 0 instead of skipping the code path entirely (skipping would
   leave elements stuck at their pre-animation opacity/position). */
const MOTION = {
  fast: 0.18, normal: 0.28, emphasis: 0.45,
  ease: {enter:"power2.out", exit:"power2.in", standard:"power2.inOut", emphasis:"back.out(1.6)"},
  stagger: {small:0.04, medium:0.08},
  get reduced(){ return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
};
/* Fades+lifts one or more elements into place. Falls back to an instant
   gsap.set() when reduced motion is requested. overwrite:"auto" on the
   real tween matters here: a remove-click landing while a card's OWN
   entrance is still mid-flight (confirmed reachable - a fast/repeated
   add+remove, or just a long staggered list where later cards are still
   entering) would otherwise leave two tweens fighting over the same
   autoAlpha/y properties on the same element with the default
   overwrite:false, since GSAP only auto-kills conflicting tweens when
   asked to. */
function motionEnter(targets, opts={}){
  if(!window.gsap || !targets || (targets.length===0)) return;
  const vars = {autoAlpha:1, y:0, duration: opts.duration ?? MOTION.normal, ease: opts.ease ?? MOTION.ease.enter, stagger: opts.stagger ?? 0, delay: opts.delay ?? 0, overwrite:"auto"};
  if(MOTION.reduced){ gsap.set(targets, {autoAlpha:1, y:0}); return; }
  gsap.set(targets, {autoAlpha:0, y: opts.fromY ?? 14});
  // Same stuck-invisible-forever risk as the homepage entrance timeline -
  // if the tween never completes, force visibility so content is never
  // permanently hidden behind a reveal animation that didn't play.
  const safety = setTimeout(()=>gsap.set(targets, {autoAlpha:1, y:0, clearProps:"transform"}), 2000);
  vars.onComplete = ()=>clearTimeout(safety);
  gsap.to(targets, vars);
}
/* Fades+collapses an element out, then calls onDone (e.g. to actually
   remove it from the DOM) - used for file-card removal so the layout
   reflows smoothly instead of the card just vanishing mid-grid.
   overwrite:"auto" for the same reason as motionEnter above - this is
   the tween that actually needs to win when a card is removed mid-entrance. */
function motionExit(target, onDone){
  if(!window.gsap || !target){ onDone && onDone(); return; }
  if(MOTION.reduced){ onDone && onDone(); return; }
  gsap.to(target, {
    autoAlpha:0, scale:0.92, duration: MOTION.fast, ease: MOTION.ease.exit, overwrite:"auto",
    onComplete: onDone
  });
}

/* ---------------- Redesign: cursor trail / magnetic / dock system ----------------
   Design brief: "black + neon lime primary, GSAP creative-engineering
   polish, 80% usability / 20% motion delight." Three small, reusable
   utilities instead of scattering pointermove handlers per component:
   initCursorTrail (global), initMagnetic (per element), initDockMagnify
   (per icon row). All three share the same ground rules: skip entirely
   under prefers-reduced-motion or on touch devices (coarse pointer - no
   real hover/cursor concept to enhance there), never intercept real
   interaction (pointer-events:none on decorative elements, no
   preventDefault on real inputs/canvas), and drive movement via
   transform only so nothing here triggers layout. */
const IS_TOUCH_DEVICE = matchMedia("(pointer: coarse)").matches;
function shouldSkipCursorFx(){ return MOTION.reduced || IS_TOUCH_DEVICE || !window.gsap; }

/* A handful of lime/accent dots lerping toward the real pointer with a
   staggered delay per dot - not a particle burst, just a soft trailing
   line that thins out (opacity/scale falloff) toward the tail. Lives on
   one fixed, pointer-events:none overlay for the whole app; a single
   quickSetter per dot (not gsap.to() every pointermove) is what keeps
   this at 60fps - gsap.to() on every mousemove would stack/queue
   tweens, quickSetter just writes a transform directly with no
   tween-management overhead. Paused (not destroyed) whenever the
   pointer is over a real PDF canvas/text input/contenteditable, per the
   brief's "PDF editor gets priority over decorative effects" - resumes
   the moment the pointer leaves that element. */
/* Attracts `el` toward the pointer within `radius` px of its own
   center, spring-releases on leave. Movement is capped at `strength` px
   so a button never travels far enough to become hard to click - the
   brief's own explicit ceiling (~6-15px depending on size). Uses one
   quickTo per axis (GSAP's fire-and-forget interpolated setter) rather
   than gsap.to() per pointermove, same performance reasoning as the
   cursor trail. */
function initMagnetic(el, opts={}){
  if(!el || shouldSkipCursorFx()) return;
  const strength = opts.strength ?? 12;
  const radius = opts.radius ?? Math.max(el.offsetWidth, el.offsetHeight) * 1.6;
  const scale = opts.scale ?? 1.03;
  const xTo = gsap.quickTo(el, "x", {duration:0.5, ease:"power3.out"});
  const yTo = gsap.quickTo(el, "y", {duration:0.5, ease:"power3.out"});
  // quickTo doesn't animate the composite "scale" shorthand (GSAP 3.12.5) -
  // drive scaleX/scaleY separately instead.
  const scaleXTo = gsap.quickTo(el, "scaleX", {duration:0.4, ease:"power3.out"});
  const scaleYTo = gsap.quickTo(el, "scaleY", {duration:0.4, ease:"power3.out"});
  function setScale(v){ scaleXTo(v); scaleYTo(v); }
  function onMove(e){
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if(dist > radius){ xTo(0); yTo(0); setScale(1); return; }
    const pull = 1 - dist/radius;
    xTo((dx/radius) * strength * pull);
    yTo((dy/radius) * strength * pull);
    setScale(1 + (scale-1) * pull);
  }
  function onLeave(){ xTo(0); yTo(0); setScale(1); }
  // Listens on document, filtered by radius, rather than a per-element
  // mouseenter/mousemove pair - the whole point of "magnetic" is
  // reacting BEFORE the pointer actually enters the element's own box.
  document.addEventListener("pointermove", onMove, {passive:true});
  el.addEventListener("pointerleave", onLeave, {passive:true});
  return ()=>{ document.removeEventListener("pointermove", onMove); el.removeEventListener("pointerleave", onLeave); };
}

/* macOS Dock-style neighbor magnification for one row of icons. Scale
   falls off by DISTANCE ALONG THE ROW (not just "is this the hovered
   one"), so icons on either side of the one nearest the cursor visibly
   grow too, just less. transform-origin stays centered and only `scale`
   is animated (never width/height) specifically so neighbors growing
   doesn't reflow/shift the row - confirmed this matters: animating any
   box-model property here would make the whole row jitter sideways as
   each icon's neighbors resize out from under it. */
function initDockMagnify(container, itemSelector, opts={}){
  if(!container || shouldSkipCursorFx()) return;
  const items = [...container.querySelectorAll(itemSelector)];
  if(!items.length) return;
  const maxScale = opts.maxScale ?? 1.4;
  const falloff = opts.falloff ?? 90; // px of on-screen distance over which the effect decays to 1.0
  // quickTo doesn't animate the composite "scale" shorthand (GSAP 3.12.5) -
  // drive scaleX/scaleY separately instead.
  const settersX = items.map(it=>gsap.quickTo(it, "scaleX", {duration:0.25, ease:"power2.out"}));
  const settersY = items.map(it=>gsap.quickTo(it, "scaleY", {duration:0.25, ease:"power2.out"}));
  function onMove(e){
    items.forEach((it, i)=>{
      const r = it.getBoundingClientRect();
      const cx = r.left + r.width/2;
      const dist = Math.abs(e.clientX - cx);
      const t = Math.max(0, 1 - dist/falloff);
      const v = 1 + (maxScale-1) * t*t; // squared falloff - sharper peak at center, matches a real Dock more than linear
      settersX[i](v); settersY[i](v);
    });
  }
  function onLeave(){ settersX.forEach(s=>s(1)); settersY.forEach(s=>s(1)); }
  container.addEventListener("pointermove", onMove, {passive:true});
  container.addEventListener("pointerleave", onLeave, {passive:true});
}

/* ---------------- Tool registry ---------------- */
const CATEGORIES = [
  { id:"convert", title:"Convert", tools:[
    ["pdf2word","PDF to Word"],["pdf2excel","PDF to Excel"],["jpg2pdf","JPG to PDF"],
    ["pdf2jpg","PDF to JPG"],["word2pdf","Word to PDF"],["excel2pdf","Excel to PDF"],
    ["html2pdf","HTML to PDF"],["pdf2txt","PDF to TXT"],["txt2pdf","TXT to PDF"],
  ]},
  { id:"edit", title:"Edit", tools:[
    ["merge","Merge PDF"],["split","Split PDF"],["edit","Edit PDF"],
    ["rotate","Rotate PDF"],["watermark","Add Watermark"],
    ["organize","Organize PDF"],["pagenumbers","Add Page Numbers"],["crop","Crop PDF"],
    ["deletepages","Delete Pages"],["extractpages","Extract Pages"],["addblank","Add Blank Page"],
    ["reorder","Reorder Pages"],["headerfooter","Add Header & Footer"],["invertpdf","Invert PDF Colors"],["compare","Compare PDFs"],
  ]},
  { id:"optimize", title:"Optimize", tools:[
    ["compress","Compress PDF"],["imgcompress","Image Compressor"],["repair","Repair PDF"],
    ["metadata","PDF Metadata Editor"],["pagesize","PDF Page Size Converter"],["extractimages","Extract Images"],
  ]},
  { id:"security", title:"Security", tools:[
    ["sign","Sign PDF"],["flatten","Flatten PDF"],["fillform","Fill PDF Form"],
  ]},
  { id:"images", title:"Images", tools:[
    ["imgresize","Resize Image"],["imgcrop","Crop Image"],["imgconvert","Convert Image Format"],
    ["imgwatermark","Add Watermark to Image"],["imginvert","Invert Image Colors"],
  ]},
];

/* Curated "Popular" shortcuts — references existing tool ids only, no duplicated tool data */
const POPULAR_IDS = ["pdf2word","pdf2excel","excel2pdf","jpg2pdf","compress","split","merge"];

const CATEGORY_META = {
  popular:  { color:"#FFD60A" },
  convert:  { color:"#00E5FF" },
  edit:     { color:"#FF7A1A" },
  optimize: { color:"#9CFF00" },
  security: { color:"#A855F7" },
  images:   { color:"#FF3EC9" },
  ai:       { color:"#FFD60A" },
};

/* Small emoji glyphs for mega-menu / mobile-accordion category headers (purely decorative, no new tool data) */
const CATEGORY_ICON_EMOJI = {
  convert:"🔄", edit:"✏️", optimize:"⚡", security:"🔒", images:"🖼️", ai:"✨",
};

/* Single source of truth for the "coming soon" AI tools — reused by the tools grid AND the mega menu / mobile accordion */
const AI_TOOLS = [
  { name:"AI Chat with PDF", icon:"✨", desc:"Ask questions and get answers straight from your document." },
  { name:"AI Summarize",     icon:"📝", desc:"Get a quick summary of long documents in seconds." },
];

const DESCRIPTIONS = {
  merge:"Combine multiple PDFs into one file, in the order you choose.",
  split:"Break a PDF into separate pages or custom page ranges.",
  compress:"Shrink file size down to an exact KB target you set.",
  pdf2jpg:"Turn every page of a PDF into a JPG image.",
  jpg2pdf:"Combine one or more images into a single PDF.",
  html2pdf:"Turn plain text or simple HTML into a formatted PDF.",
  pdf2word:"Pull the text out of a PDF into an editable Word file.",
  word2pdf:"Convert a Word document's text into a clean PDF.",
  pdf2excel:"Extract PDF content into rows and columns in Excel.",
  excel2pdf:"Turn a spreadsheet's first sheet into a table PDF.",
  organize:"Preview every page and drag together a new page order.",
  rotate:"Rotate every page 90°, 180° or 270° in one click.",
  crop:"Trim margins from every page of a PDF.",
  deletepages:"Remove specific pages from a PDF.",
  extractpages:"Pull out only the pages you need into a new PDF.",
  addblank:"Insert a blank page anywhere in your document.",
  reorder:"Rearrange pages into any order you like.",
  pagenumbers:"Stamp page numbers onto every page.",
  watermark:"Overlay custom watermark text across every page.",
  headerfooter:"Add a running header and footer to every page.",
  invertpdf:"Flip every page to a negative / dark-mode style palette.",
  flatten:"Lock form fields permanently into the page content.",
  repair:"Attempt to fix minor structural issues in a damaged PDF.",
  sign:"Draw a signature and place it anywhere on the page.",
  fillform:"Fill out fillable form fields and save the result.",
  compare:"Spot text differences between two PDF files.",
  metadata:"Edit the title, author and subject of a PDF.",
  pagesize:"Change a PDF's page dimensions to a standard size.",
  pdf2txt:"Extract all readable text into a plain .txt file.",
  txt2pdf:"Turn plain text into a formatted PDF document.",
  extractimages:"Save every page of a PDF as a standalone image.",
  imgcompress:"Shrink an image down to an exact KB target.",
  imgresize:"Resize an image to exact width and height.",
  imgcrop:"Crop an image to a precise pixel region.",
  imgconvert:"Convert an image between PNG, JPG and WebP.",
  imgwatermark:"Overlay custom watermark text on an image.",
  imginvert:"Flip an image's colors to a negative palette.",
  edit:"Edit PDF documents directly in your browser — currently under development.",
};
const ICONS = {
  pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/></svg>`,
  img:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-4 4-3-3-5 5"/></svg>`,
};

/* Dedicated, tool-specific icons — single source of truth reused everywhere a tool
   icon is rendered (grid cards, "All PDF Tools" mega menu, "Convert PDF" menu,
   mobile accordion, and search results). Never falls back to a generic document
   icon when a real one is defined here. */
const TOOL_ICONS = {
  merge:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3v7l4 4 4-4V3"/><path d="M4 21h16"/><path d="M9 21v-4M15 21v-4"/></svg>`,
  split:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v6"/><path d="M12 9L6 15v6"/><path d="M12 9l6 6v6"/></svg>`,
  organize:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/></svg>`,
  rotate:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12a9 9 0 1 1 3.2 6.9"/><path d="M3 21v-6h6"/></svg>`,
  crop:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2v14a2 2 0 002 2h14"/><path d="M18 22V8a2 2 0 00-2-2H2"/></svg>`,
  deletepages:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>`,
  extractpages:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M12 17V9"/><path d="M9 12l3-3 3 3"/></svg>`,
  addblank:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M12 11v6M9 14h6"/></svg>`,
  reorder:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  pagenumbers:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M9 15h1.5M9 15v4M9 17h1.5M13 15l1 4M14 15l1 4M13 19l1-4"/></svg>`,
  watermark:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/></svg>`,
  headerfooter:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 7h18M3 17h18"/></svg>`,
  invertpdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 010 18z" fill="currentColor" stroke="none"/></svg>`,
  compare:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="4" width="9" height="16" rx="1.3"/><rect x="12.5" y="4" width="9" height="16" rx="1.3"/><path d="M7 10l1.5 1.5L10 9"/></svg>`,
  compress:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3v4a1 1 0 01-1 1H4M20 8h-4a1 1 0 01-1-1V3M15 21v-4a1 1 0 011-1h4M4 16h4a1 1 0 011 1v4"/></svg>`,
  repair:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2-2z"/></svg>`,
  metadata:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.6 12.6L12 21.2 2.8 12 11.4 3.4H20.6z"/><circle cx="16.5" cy="7.5" r="1.4" fill="currentColor" stroke="none"/></svg>`,
  pagesize:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`,
  extractimages:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8.5" r="1.2"/><path d="M17 20l3-3 3 3M20 17v6" transform="translate(-2,0)"/></svg>`,
  flatten:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>`,
  sign:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17c2-1 3-3 3.5-5C7.5 8 9 6 10.5 8c1 1.4-.5 4-2 5.5 2 1 4-1 5.5-2.7C15.5 9 17.5 8 18 10s-1 3-1 3"/><path d="M14 20l6-6-2-2-6 6z"/></svg>`,
  fillform:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 8h8M8 12h5"/><path d="M8 16.5l1.5 1.5L13 14"/></svg>`,
  pdf2word:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M8 13l1.4 6L11 15l1.6 4L14 13"/></svg>`,
  word2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M8 13l1.4 6L11 15l1.6 4L14 13"/></svg>`,
  pdf2excel:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M8.5 13l6 6M14.5 13l-6 6"/></svg>`,
  excel2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M8.5 13l6 6M14.5 13l-6 6"/></svg>`,
  pdf2jpg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="11" rx="1.5"/><circle cx="7" cy="9" r="1.1"/><path d="M3 14l4-3.5 3 2.5 3.5-3L17 13"/></svg>`,
  jpg2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="11" rx="1.5"/><circle cx="7" cy="9" r="1.1"/><path d="M3 14l4-3.5 3 2.5 3.5-3L17 13"/></svg>`,
  pdf2txt:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M8 13h8M8 16.5h5"/></svg>`,
  txt2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M8 13h8M8 16.5h5"/></svg>`,
  html2pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8.5 9l-3 3 3 3M15.5 9l3 3-3 3M13 7l-2 10"/></svg>`,
  imgresize:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="12" height="12" rx="1.5"/><path d="M14 21l7-7M17 21h4v-4"/></svg>`,
  imgcrop:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2v14a2 2 0 002 2h14"/><path d="M18 22V8a2 2 0 00-2-2H2"/></svg>`,
  imgconvert:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-4 4-3-3-5 5"/></svg>`,
  imgwatermark:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 8.5s3 3 3 5.3a3 3 0 01-6 0c0-2.3 3-5.3 3-5.3z"/></svg>`,
  imginvert:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/></svg>`,
  imgcompress:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 10V8h2M15 14v2h-2" stroke-linecap="round"/><path d="M9 8l3 3M15 16l-3-3"/></svg>`,
};
function iconFor(id){
  if(TOOL_ICONS[id]) return TOOL_ICONS[id];
  if(id.includes("img")) return ICONS.img;
  return ICONS.pdf;
}

/* Distinctive badge icons for format-conversion tools, similar to iLovePDF's stacked file+badge look */
const TOOL_BADGES = {
  pdf2word:  {label:"W",   color:"#2E5FD9"},
  word2pdf:  {label:"W",   color:"#2E5FD9"},
  pdf2excel: {label:"X",   color:"#1E8E3E"},
  excel2pdf: {label:"X",   color:"#1E8E3E"},
  pdf2jpg:   {label:"JPG", color:"#F59E0B"},
  jpg2pdf:   {label:"JPG", color:"#F59E0B"},
  imgconvert:{label:"IMG", color:"#F764B0"},
  pdf2txt:   {label:"TXT", color:"#6B7280"},
  txt2pdf:   {label:"TXT", color:"#6B7280"},
  sign:      {label:"✒",   color:"#0E8C74"},
  fillform:  {label:"✒",   color:"#0E8C74"},
  html2pdf:  {label:"</>", color:"#0E8C74"},
};
/* Bright category swatches (neon lime/yellow) need a dark glyph instead of the
   CSS default white stroke, or the icon disappears into its own background -
   plain WCAG relative-luminance check against a hex color. */
function inkForBg(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if(!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r,g,b] = [(n>>16)&255, (n>>8)&255, n&255].map(c=>{
    c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
  });
  const luminance = 0.2126*r + 0.7152*g + 0.0722*b;
  return luminance > 0.5 ? "#0A0A0A" : "#fff";
}
function renderIcon(id, categoryColor){
  const b = TOOL_BADGES[id];
  if(b){
    const fs = b.label.length>1 ? "8.5px" : "14px";
    return `<div class="icon-stack">
      <div class="icon-base">${iconFor(id)}</div>
      <div class="icon-corner" style="background:${b.color};font-size:${fs};color:${inkForBg(b.color)}">${b.label}</div>
    </div>`;
  }
  return `<div class="icon" style="background:${categoryColor};color:${inkForBg(categoryColor)}">${iconFor(id)}</div>`;
}

/* ---------------- Render tool cards (single master list, one card per tool) ---------------- */
function cardHTML(id, name, color, catId, isPopular){
  const cats = [catId, isPopular ? "popular" : ""].filter(Boolean).join(" ");
  return `
    <div class="card" data-tool="${id}" data-cat="${cats}">
      ${renderIcon(id, color)}
      <div class="name">${name}</div>
      <div class="desc">${DESCRIPTIONS[id]||""}</div>
    </div>`;
}
const toolCategoriesEl = document.getElementById("toolCategories");
const POPULAR_SET = new Set(POPULAR_IDS);

/* Single source of truth: each tool from CATEGORIES is rendered exactly once, tagged with its
   real category (and "popular" too, if applicable) so filtering never has to duplicate a card. */
let gridHtml = "";
CATEGORIES.forEach(cat=>{
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  cat.tools.forEach(([id,name])=>{
    gridHtml += cardHTML(id, name, meta.color, cat.id, POPULAR_SET.has(id));
  });
});

/* AI — future category placeholder, no live tools yet. Rendered from the shared AI_TOOLS list. */
gridHtml += AI_TOOLS.map(t=>`
  <div class="card ai-card" data-cat="ai">
    <div class="icon" style="background:${CATEGORY_META.ai.color}">${t.icon}</div>
    <div class="name">${t.name} <span class="coming-soon-badge">Soon</span></div>
    <div class="desc">${t.desc}</div>
    <div class="open-link">Coming soon</div>
  </div>`).join("");

toolCategoriesEl.innerHTML = `<div class="grid" id="toolsGrid">${gridHtml}</div>`;


/* ---------------- Mega Menu ("All PDF Tools") — desktop hover panel + mobile accordion.
   Both are generated dynamically from CATEGORIES / AI_TOOLS, so any future tool added to the
   registry automatically appears here with zero extra markup. ---------------- */
function megaColumnHTML(cat){
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  const emoji = CATEGORY_ICON_EMOJI[cat.id] || "📄";
  return `
    <div class="mega-col">
      <div class="mega-col-head">
        <span class="mega-col-icon" style="background:${meta.color}">${emoji}</span>
        <h4>${cat.title}</h4>
      </div>
      <div class="mega-col-list">
        ${cat.tools.map(([id,name])=>`<button type="button" data-open="${id}"><span class="mega-tool-icon">${iconFor(id)}</span>${name}</button>`).join("")}
      </div>
    </div>`;
}
function megaAiColumnHTML(){
  const emoji = CATEGORY_ICON_EMOJI.ai;
  return `
    <div class="mega-col">
      <div class="mega-col-head">
        <span class="mega-col-icon" style="background:${CATEGORY_META.ai.color}">${emoji}</span>
        <h4>AI Tools <span class="coming-soon-badge">Soon</span></h4>
      </div>
      <div class="mega-col-list">
        ${AI_TOOLS.map(t=>`<button type="button" disabled title="Coming soon"><span class="mega-tool-icon">${t.icon}</span>${t.name}</button>`).join("")}
      </div>
    </div>`;
}
const megaMenuEl = document.getElementById("megaMenu");
if(megaMenuEl){
  megaMenuEl.innerHTML = `<div class="mega-grid">${CATEGORIES.map(megaColumnHTML).join("")}${megaAiColumnHTML()}</div>`;
}

/* "Convert PDF" menu — sourced from the same CATEGORIES.convert list as the mega
   menu, so adding a conversion tool there automatically shows up here too. */
const convertMenuEl = document.getElementById("convertMenu");
if(convertMenuEl){
  const convertCat = CATEGORIES.find(c=>c.id==="convert");
  if(convertCat){
    convertMenuEl.innerHTML = convertCat.tools.map(([id,name])=>
      `<button type="button" role="menuitem" data-open="${id}"><span class="mega-tool-icon">${iconFor(id)}</span>${name}</button>`
    ).join("");
  }
}

function mobileMegaCatHTML(cat){
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  const emoji = CATEGORY_ICON_EMOJI[cat.id] || "📄";
  return `
    <div class="mm-cat" data-mm-cat="${cat.id}">
      <button type="button" class="mm-cat-head">
        <span class="mm-cat-icon" style="background:${meta.color}">${emoji}</span>
        <span class="mm-cat-title">${cat.title}</span>
        <svg class="mm-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="mm-cat-body">
        <div class="mm-cat-body-inner">
          ${cat.tools.map(([id,name])=>`<button type="button" class="mm-tool" data-open="${id}"><span class="mm-tool-icon">${iconFor(id)}</span>${name}</button>`).join("")}
        </div>
      </div>
    </div>`;
}
function mobileMegaAiHTML(){
  return `
    <div class="mm-cat" data-mm-cat="ai">
      <button type="button" class="mm-cat-head">
        <span class="mm-cat-icon" style="background:${CATEGORY_META.ai.color}">${CATEGORY_ICON_EMOJI.ai}</span>
        <span class="mm-cat-title">AI Tools <span class="coming-soon-badge">Soon</span></span>
        <svg class="mm-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="mm-cat-body">
        <div class="mm-cat-body-inner">
          ${AI_TOOLS.map(t=>`<button type="button" class="mm-tool" disabled>${t.icon} ${t.name}</button>`).join("")}
        </div>
      </div>
    </div>`;
}
const mobileMegaEl = document.getElementById("mobileMega");
if(mobileMegaEl){
  mobileMegaEl.innerHTML = `<div class="mm-inner">${CATEGORIES.map(mobileMegaCatHTML).join("")}${mobileMegaAiHTML()}</div>`;
}

/* Top-level "All PDF Tools" accordion toggle (mobile) */
document.getElementById("mobileAllToolsToggle")?.addEventListener("click", (e)=>{
  e.stopPropagation();
  const btn = e.currentTarget;
  const panel = document.getElementById("mobileMega");
  if(!panel) return;
  const isOpen = panel.classList.toggle("open");
  btn.classList.toggle("expanded", isOpen);
  btn.setAttribute("aria-expanded", String(isOpen));
});

/* Per-category accordion toggles inside the mobile "All PDF Tools" panel */
document.getElementById("mobileMega")?.addEventListener("click", (e)=>{
  const head = e.target.closest(".mm-cat-head");
  if(!head) return;
  head.parentElement.classList.toggle("mm-open");
});

/* ---------------- Live tool search (desktop navbar + mobile menu) ----------------
   Reuses the existing CATEGORIES / DESCRIPTIONS / CATEGORY_META / renderIcon data —
   no separate tool list is created, so the registry stays the single source of truth. */
const CATEGORY_LABELS = {};
document.querySelectorAll("[data-filter]").forEach(btn=>{
  if(btn.dataset.filter && btn.dataset.filter!=="all" && !CATEGORY_LABELS[btn.dataset.filter]){
    CATEGORY_LABELS[btn.dataset.filter] = btn.textContent.trim();
  }
});
const SEARCH_INDEX = [];
CATEGORIES.forEach(cat=>{
  const meta = CATEGORY_META[cat.id] || {color:"linear-gradient(135deg,#FF7A18,#E8291B)"};
  cat.tools.forEach(([id,name])=>{
    SEARCH_INDEX.push({ id, name, cat: cat.id, catLabel: CATEGORY_LABELS[cat.id] || cat.title, desc: DESCRIPTIONS[id]||"", color: meta.color });
  });
});
function searchTools(q){
  q = q.trim().toLowerCase();
  if(!q) return [];
  return SEARCH_INDEX.filter(t =>
    t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)
  ).slice(0, 8);
}
function resultRowHTML(t){
  return `<button type="button" data-search-tool="${t.id}">
    <span class="sr-icon" style="background:${t.color};color:#fff">${iconFor(t.id)}</span>
    <span class="sr-text"><span class="sr-name">${t.name}</span><span class="sr-cat">${t.catLabel}</span></span>
  </button>`;
}
function wireSearchBox(inputId, resultsId, {dropdownStyle}={}){
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);
  if(!input || !results) return;
  function render(){
    const matches = searchTools(input.value);
    if(!input.value.trim()){
      results.innerHTML = "";
      if(dropdownStyle) results.classList.remove("open");
      return;
    }
    results.innerHTML = matches.length
      ? matches.map(resultRowHTML).join("")
      : `<div class="sr-empty">No tools match “${escapeAttr(input.value.trim())}”</div>`;
    if(dropdownStyle) results.classList.add("open");
    results.querySelectorAll("[data-search-tool]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        TOOLS[btn.dataset.searchTool] && TOOLS[btn.dataset.searchTool]();
        input.value = "";
        results.innerHTML = "";
        if(dropdownStyle) results.classList.remove("open");
        document.getElementById("mobileMenu")?.classList.remove("open");
      });
    });
  }
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", e=>{
    if(e.key==="Enter"){
      const first = searchTools(input.value)[0];
      if(first){ TOOLS[first.id] && TOOLS[first.id](); input.value=""; results.innerHTML=""; if(dropdownStyle) results.classList.remove("open"); }
    } else if(e.key==="Escape"){
      input.value=""; results.innerHTML=""; if(dropdownStyle) results.classList.remove("open"); input.blur();
    }
  });
  if(dropdownStyle){
    input.addEventListener("click", e=>e.stopPropagation());
    results.addEventListener("click", e=>e.stopPropagation());
  }
}
wireSearchBox("navSearchInput", "navSearchResults", {dropdownStyle:true});
wireSearchBox("mobileSearchInput", "mobileSearchResults", {});
document.addEventListener("click", ()=>{
  document.getElementById("navSearchResults")?.classList.remove("open");
});

/* ---------------- Category-tab / dropdown / mobile-menu filtering ----------------
   One master grid (#toolsGrid) is the only source of truth: filtering just
   fades individual cards in or out based on their data-cat tag(s). */
function applyFilter(f){
  document.querySelectorAll(".cat-tab").forEach(t=>t.classList.toggle("active", t.dataset.filter===f));

  const grid = document.getElementById("toolsGrid");
  if(!grid) return;

  // Category buttons must stay responsive even mid-animation: cancel any
  // in-flight timers/frames from a previous switch and instantly resolve
  // whatever card was mid fade-out/fade-in, so we always start this switch
  // from a clean, unambiguous baseline (no cards left stuck transparent).
  if(grid._filterTimers){ grid._filterTimers.forEach(clearTimeout); }
  if(grid._filterRafs){ grid._filterRafs.forEach(cancelAnimationFrame); }
  grid._filterTimers = [];
  grid._filterRafs = [];

  const cards = Array.from(grid.querySelectorAll(".card"));
  cards.forEach(card=>{
    if(card.classList.contains("card-hidden")){ card.style.display = "none"; card.classList.remove("card-hidden"); }
    card.classList.remove("card-entering");
  });

  const shouldShow = card=>{
    const cats = (card.dataset.cat||"").split(" ").filter(Boolean);
    return (f==="all") || cats.includes(f);
  };
  const toHide = cards.filter(card=> !shouldShow(card) && card.style.display !== "none");
  const toShow = cards.filter(card=> shouldShow(card) && card.style.display === "none");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(reduceMotion){
    cards.forEach(card=>{ card.style.display = shouldShow(card) ? "" : "none"; });
    grid.style.height = "";
    return;
  }

  if(!toHide.length && !toShow.length) return;

  // Lock the grid at its current on-screen height so removing/adding cards
  // never causes an instant jump — it animates to the new height instead.
  const H1 = grid.getBoundingClientRect().height;
  grid.style.height = H1 + "px";

  // Step 1 — fade out + slide up the cards that are leaving (180ms).
  toHide.forEach(card=> card.classList.add("card-hidden"));

  const afterFadeOut = setTimeout(()=>{
    toHide.forEach(card=>{ card.style.display = "none"; card.classList.remove("card-hidden"); });

    // Reveal the entering cards (still transparent) so the grid's natural
    // height reflects the final visible set, then measure it.
    toShow.forEach(card=>{ card.style.display = ""; card.classList.add("card-entering"); });
    grid.style.height = "auto";
    const H2 = grid.getBoundingClientRect().height;
    grid.style.height = H1 + "px";
    void grid.offsetHeight; // force reflow so the height change below actually transitions

    const raf1 = requestAnimationFrame(()=>{
      grid.style.height = H2 + "px";
      // Step 2 — fade in + slide up the entering cards (180ms), in step with the height animation.
      const raf2 = requestAnimationFrame(()=>{
        toShow.forEach(card=> card.classList.remove("card-entering"));
      });
      grid._filterRafs.push(raf2);
    });
    grid._filterRafs.push(raf1);

    // Release the fixed height once everything has settled so the grid can
    // respond naturally to window resizes / future content changes.
    const afterSettle = setTimeout(()=>{ grid.style.height = ""; }, 260);
    grid._filterTimers.push(afterSettle);
  }, 180);
  grid._filterTimers.push(afterFadeOut);
}
document.querySelectorAll("[data-filter]").forEach(el=>{
  el.addEventListener("click", ()=>{
    applyFilter(el.dataset.filter);
    if(el.closest(".nav-dd-menu") || el.closest(".mobile-menu") || el.closest(".footer-col") || el.hasAttribute("data-scroll-tools")){
      document.getElementById("tools").scrollIntoView({behavior:"smooth", block:"start"});
    }
    document.getElementById("mobileMenu")?.classList.remove("open");
  });
});

/* ---------------- Hero CTAs: "All PDF Tools" scrolls + resets filter; "Choose PDF" opens the picker ---------------- */
document.getElementById("heroAllToolsBtn")?.addEventListener("click", ()=>{
  applyFilter("all");
  document.getElementById("tools").scrollIntoView({behavior:"smooth", block:"start"});
});
document.getElementById("heroChoosePdfBtn")?.addEventListener("click", ()=>{
  document.getElementById("heroFileInput")?.click();
});

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

function setHeroDzState(state){
  if(!heroDropzone) return;
  heroDropzone.classList.remove("drag-hover","state-uploading","state-success");
  if(heroDzOr) heroDzOr.style.display = "";
  if(state==="idle"){ heroDzTitle.textContent = "Drop your PDF here"; }
  else if(state==="hover"){ heroDropzone.classList.add("drag-hover"); heroDzTitle.textContent = "Release to upload PDF"; if(heroDzOr) heroDzOr.style.display="none"; }
  else if(state==="uploading"){ heroDropzone.classList.add("state-uploading"); heroDzTitle.textContent = "Preparing your PDF…"; if(heroDzOr) heroDzOr.style.display="none"; }
  else if(state==="success"){ heroDropzone.classList.add("state-success"); heroDzTitle.textContent = "PDF Ready"; if(heroDzOr) heroDzOr.style.display="none"; }
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
    toast("Please upload a PDF file.");
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

/* ---------------- Shared upload/session manager ----------------
   Single source of truth for "what file(s) the user is currently working
   with". The Hero uploader, the Quick Action modal, the nav/search/mega-menu
   tool links, and the homepage tool cards all funnel through openTool()
   below rather than passing File objects to each other directly — that's
   the only place a File ever gets bridged into a tool. No tool's own code
   is touched or duplicated; this just drives the exact same #fi input each
   tool already listens on (or, for the Edit PDF workspace, the editor's own
   public EditorCanvas.loadFile() API — see TOOLS.edit below).
   Shape is intentionally generic (currentFiles is always an array) so it
   can later support multi-file workflows, a "recent uploads" list, or
   workflow-chaining (tool A's output becoming tool B's input) without a
   rewrite — just extend .set()/.metadata, callers don't change. */
const AppSession = {
  currentFile: null,
  currentFiles: [],
  metadata: {},
  source: null,
  timestamp: null,
  set(files, source){
    const list = Array.isArray(files) ? files.filter(Boolean) : (files ? [files] : []);
    this.currentFiles = list;
    this.currentFile = list[0] || null;
    this.source = source || null;
    this.timestamp = Date.now();
    this.metadata = { count: list.length, names: list.map(f=>f.name) };
  },
  clear(){
    this.currentFile = null; this.currentFiles = []; this.metadata = {}; this.source = null; this.timestamp = null;
  },
};

/* ---------------- Client-side tool routing ----------------
   Real dedicated URLs per tool (/merge-pdf, /split-pdf, ...) instead of
   /?tool=merge, with matching document.title/meta description/canonical,
   browser Back/Forward support, and direct-URL/refresh support (the
   static SEO pages already serve these same paths at build time for
   crawlers; this is what makes the *interactive app* itself answer to
   the same path once JS has loaded, and '_redirects' at the repo root
   already tells the production host to serve index.html for any path
   it doesn't recognize, which is what makes this work on a real refresh). */
const TOOL_ROUTES = {"merge":{"path":"/merge-pdf","title":"Merge PDF Files Free Online — Combine PDFs | YOYOPDF","description":"Combine multiple PDF files into one document in your browser. Drag to reorder, no upload to any server, no file limits, completely free."},"split":{"path":"/split-pdf","title":"Split PDF Files Free Online — Extract Pages | YOYOPDF","description":"Split a PDF into separate files by page range or extract every page individually. Free, browser-based, no file uploads."},"compress":{"path":"/compress-pdf","title":"Compress PDF to Target Size Free Online | YOYOPDF","description":"Shrink a PDF's file size down to an exact KB target you set. Free, fast, entirely in-browser compression."},"edit":{"path":"/edit-pdf","title":"Edit PDF Online Free — Add Text & Annotate | YOYOPDF","description":"Edit PDF documents directly in your browser — add text, images, shapes, and annotations. Free, no upload, no sign-up."},"pdf2word":{"path":"/pdf-to-word","title":"PDF to Word Converter Free Online | YOYOPDF","description":"Convert PDF into an editable Word document, free and browser-based. No upload, no sign-up."},"rotate":{"path":"/rotate-pdf","title":"Rotate PDF Pages Free Online — Fix Orientation | YOYOPDF","description":"Rotate individual pages or the entire PDF 90, 180 or 270 degrees. Free, fast, and processed entirely in your browser."},"deletepages":{"path":"/delete-pages","title":"Delete Pages from PDF Free Online | YOYOPDF","description":"Remove unwanted pages from a PDF in a few clicks. Preview every page first. Free, browser-based, no uploads."},"extractpages":{"path":"/extract-pages","title":"Extract Pages from PDF Free Online | YOYOPDF","description":"Pull specific pages out of a PDF into a new document. Visual page picker, free, and processed locally in your browser."},"organize":{"path":"/organize-pdf","title":"Organize & Reorder PDF Pages Free Online | YOYOPDF","description":"Drag and drop to reorder, rotate, or remove PDF pages in one visual workspace. Free, browser-based, no file uploads."},"crop":{"path":"/crop-pdf","title":"Crop PDF Pages Free Online — Trim Margins | YOYOPDF","description":"Crop margins or unwanted areas from PDF pages with a visual crop box. Apply to one page or the whole document, free."},"watermark":{"path":"/watermark-pdf","title":"Add Watermark to PDF Free Online | YOYOPDF","description":"Add a text watermark to your PDF with live preview — control position, opacity, size and rotation. Free, no uploads."},"pagenumbers":{"path":"/page-numbers","title":"Add Page Numbers to PDF Free Online | YOYOPDF","description":"Insert page numbers into a PDF with control over position, starting number and format. Free, live preview, no uploads."},"word2pdf":{"path":"/word-to-pdf","title":"Word to PDF Converter Free Online | YOYOPDF","description":"Convert a .docx file into a PDF, free and browser-based. No upload, no sign-up, no watermark."},"pdf2jpg":{"path":"/pdf-to-jpg","title":"PDF to JPG Converter Free Online | YOYOPDF","description":"Convert every page of a PDF into a JPG image, free and browser-based. Download all pages as a ZIP."},"jpg2pdf":{"path":"/jpg-to-pdf","title":"JPG to PDF Converter Free Online | YOYOPDF","description":"Combine one or more images into a single PDF file, free and browser-based. No upload, no sign-up."},"pdf2excel":{"path":"/pdf-to-excel","title":"PDF to Excel Converter Free Online | YOYOPDF","description":"Extract text from a PDF into rows and columns in a spreadsheet, free and browser-based. No upload, no sign-up."},"excel2pdf":{"path":"/excel-to-pdf","title":"Excel to PDF Converter Free Online | YOYOPDF","description":"Convert a spreadsheet's first sheet into a table PDF, free and browser-based. No upload, no sign-up."},"sign":{"path":"/sign-pdf","title":"Sign PDF Online Free — Add Your Signature | YOYOPDF","description":"Draw a signature and place it anywhere on a PDF page, free and browser-based. No upload, no account."},"extractimages":{"path":"/extract-images","title":"Extract Images from PDF Free Online | YOYOPDF","description":"Save every page of a PDF as a standalone image, free and browser-based. Download all images as a ZIP."},"compare":{"path":"/compare-pdf","title":"Compare Two PDF Files Free Online | YOYOPDF","description":"Spot text differences between two PDF files, free and browser-based. No upload, no sign-up."},"reorder":{"path":"/reorder-pages","title":"Reorder PDF Pages Free Online | YOYOPDF","description":"Rearrange the pages of a PDF into any order you like, free and browser-based. Drag to reorder."},"addblank":{"path":"/add-blank-page","title":"Add Blank Page to PDF Free Online | YOYOPDF","description":"Insert a blank page anywhere in a PDF document, free and browser-based."},"headerfooter":{"path":"/header-footer","title":"Add Header and Footer to PDF Free Online | YOYOPDF","description":"Add a running header and footer to every page of a PDF, free and browser-based."},"invertpdf":{"path":"/invert-pdf-colors","title":"Invert PDF Colors Free Online — Dark Mode PDF | YOYOPDF","description":"Flip every page of a PDF to a negative / dark-mode style palette, free and browser-based."},"flatten":{"path":"/flatten-pdf","title":"Flatten PDF Form Fields Free Online | YOYOPDF","description":"Lock PDF form fields permanently into the page content, free and browser-based."},"repair":{"path":"/repair-pdf","title":"Repair Corrupted PDF Free Online | YOYOPDF","description":"Attempt to fix minor structural issues in a damaged PDF file, free and browser-based."},"metadata":{"path":"/pdf-metadata-editor","title":"Edit PDF Metadata Free Online | YOYOPDF","description":"Edit the title, author, and subject of a PDF file, free and browser-based."},"pagesize":{"path":"/pdf-page-size-converter","title":"Change PDF Page Size Free Online | YOYOPDF","description":"Change a PDF's page dimensions to a standard size like A4 or Letter, free and browser-based."},"fillform":{"path":"/fill-pdf-form","title":"Fill PDF Form Online Free | YOYOPDF","description":"Fill out fillable form fields in a PDF and save the result, free and browser-based."},"html2pdf":{"path":"/html-to-pdf","title":"HTML/Text to PDF Converter Free Online | YOYOPDF","description":"Turn plain text or simple HTML into a formatted PDF document, free and browser-based."},"pdf2txt":{"path":"/pdf-to-txt","title":"PDF to TXT Converter Free Online | YOYOPDF","description":"Extract all readable text from a PDF into a plain .txt file, free and browser-based."},"txt2pdf":{"path":"/txt-to-pdf","title":"TXT to PDF Converter Free Online | YOYOPDF","description":"Turn plain text into a formatted PDF document, free and browser-based."},"imgcompress":{"path":"/image-compressor","title":"Image Compressor Free Online — Shrink to Exact KB | YOYOPDF","description":"Shrink an image down to an exact KB target, free and browser-based."},"imgresize":{"path":"/resize-image","title":"Resize Image Free Online — Exact Width & Height | YOYOPDF","description":"Resize an image to exact width and height, free and browser-based."},"imgcrop":{"path":"/crop-image","title":"Crop Image Free Online | YOYOPDF","description":"Crop an image to a precise pixel region, free and browser-based."},"imgconvert":{"path":"/convert-image-format","title":"Convert Image Format Free Online — PNG, JPG, WebP | YOYOPDF","description":"Convert an image between PNG, JPG, and WebP formats, free and browser-based."},"imgwatermark":{"path":"/watermark-image","title":"Add Watermark to Image Free Online | YOYOPDF","description":"Overlay custom watermark text on an image, free and browser-based."},"imginvert":{"path":"/invert-image-colors","title":"Invert Image Colors Free Online | YOYOPDF","description":"Flip an image's colors to a negative palette, free and browser-based."}};
const PATH_TO_TOOLID = {};
for(const id in TOOL_ROUTES) PATH_TO_TOOLID[TOOL_ROUTES[id].path] = id;
const HOME_TITLE = document.title;
const HOME_DESCRIPTION = document.querySelector('meta[name="description"]').content;
const HOME_CANONICAL = 'https://yoyopdf.in/';
function setPageMeta(title, description, canonicalPath){
  document.title = title;
  const descTag = document.querySelector('meta[name="description"]');
  if(descTag) descTag.content = description;
  let canonicalTag = document.querySelector('link[rel="canonical"]');
  if(canonicalTag) canonicalTag.href = 'https://yoyopdf.in' + (canonicalPath==='/' ? '/' : canonicalPath);
}
/**
 * Pushes/replaces the browser URL + document title/meta for the given
 * tool, without re-invoking TOOLS[id]() (that stays openTool()'s job) -
 * kept separate so popstate (browser Back/Forward) can restore the URL
 * state alone when the panel-open side is handled elsewhere.
 * @param {string} toolId
 * @param {boolean} [replace] - true for the initial-load/popstate case
 *   (don't add a new history entry for a navigation that already happened).
 */
function syncToolRoute(toolId, replace){
  const route = TOOL_ROUTES[toolId];
  if(!route) return;
  setPageMeta(route.title, route.description, route.path);
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({toolId}, '', route.path);
}
function syncHomeRoute(replace){
  setPageMeta(HOME_TITLE, HOME_DESCRIPTION, '/');
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({}, '', '/');
}
window.addEventListener('popstate', ()=>{
  const id = PATH_TO_TOOLID[location.pathname];
  if(id && TOOLS[id]){
    window.__currentToolId = id;
    TOOLS[id]();
    setPageMeta(TOOL_ROUTES[id].title, TOOL_ROUTES[id].description, TOOL_ROUTES[id].path);
  } else {
    closePanel();
    setPageMeta(HOME_TITLE, HOME_DESCRIPTION, '/');
  }
});

/* The one place that opens a tool AND (if AppSession currently holds a file)
   bridges it in — identical to a user selecting that file inside the tool
   themselves. Every click on a tool anywhere on the homepage (nav, search,
   mega menu, mobile menu, footer, tool grid cards, Quick Action modal) is
   already routed through the single delegated listener below, which now
   calls this instead of invoking TOOLS[id] directly. */
function openTool(toolId){
  if(!TOOLS[toolId]) return;
  window.__currentToolId = toolId;
  TOOLS[toolId]();
  if(TOOL_ROUTES[toolId]) syncToolRoute(toolId);
  if(!AppSession.currentFiles.length) return;
  const files = AppSession.currentFiles;
  requestAnimationFrame(()=>{
    const fi = document.getElementById("fi");
    if(!fi) return;
    const dt = new DataTransfer();
    files.forEach(f=>dt.items.add(f));
    fi.files = dt.files;
    fi.dispatchEvent(new Event("change"));
  });
}

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
      openTool(toolId);
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
/* Friendly labels for the Quick Action cards (Flatten PDF doubles as the closest real
   equivalent to "Protect PDF" since password-encryption isn't implemented yet). */
const QA_LABELS = {
  merge:"Merge PDF", split:"Split PDF", compress:"Compress PDF", edit:"Edit PDF",
  pdf2word:"PDF to Word", pdf2excel:"PDF to Excel", rotate:"Rotate PDF", sign:"Sign PDF",
  watermark:"Add Watermark", jpg2pdf:"JPG to PDF", flatten:"Flatten PDF", organize:"Organize PDF",
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

/* ---------------- Modal plumbing ---------------- */
const overlay = document.getElementById("overlay");
const panel = document.getElementById("panel");
const siteHeader = document.querySelector("header");
let panelLastFocus = null;
/* Detached (never appended to the visible DOM) — just a place for
   TOOLS.edit to park its one persistent shell instance between
   closes/reopens. See closePanel() and TOOLS.edit. */
const editorHoldingArea = document.createElement("div");
/* Splits a tool panel's content into a left "main" column (file drop
   zone, file list, page grid, any instructional text) and a right
   "sidebar" column (option fields + the primary action button) —
   matches iLovePDF's file-management workspace layout. Runs generically
   against whatever openPanel() just rendered rather than requiring every
   TOOLS.xxx template to be rewritten: each column is an independent
   block container (not a shared CSS grid), so mismatched element counts
   between the two sides just stack normally instead of overlapping.
   Panels with no .field/#go (About, Contact, Privacy, TOOLS.edit's own
   fullscreen shell, etc.) have nothing to move into a sidebar and are
   left as a single column, unchanged. */
function layoutTwoColumn(){
  const body = document.querySelector(".panel-body");
  if(!body || body.querySelector(".tool-layout")) return;
  // Opt-out for tools building their own bespoke page-grid + sidebar
  // workspace by hand (Split/Organize/Rotate/etc, marked .tool-app-shell)
  // instead of the shared auto-layout below.
  if(body.classList.contains("no-auto-layout")) return;
  const out = document.getElementById("out");
  const hero = body.querySelector(".tool-hero");
  // Two per-tool authoring styles both end up here: older tools lay out
  // bare .field/.row elements + a bare #go button directly; newer ones
  // (Compress's compression-level picker, every .tool-toolbar's primary
  // button) wrap the same content in a bounded .tool-content-area/
  // .tool-toolbar box for the "inside a defined panel" look. Only
  // considering *direct children* of body (not body.querySelectorAll,
  // which would also match fields nested inside those boxes) and moving
  // whichever level actually is the direct child - the whole box for the
  // newer style, or the bare field/button for the older one - keeps both
  // working without moving a box's children out from under it and
  // leaving an empty shell behind in the main column.
  const isSidebarEl = el => el.matches(".field, .row, .tool-content-area, .tool-toolbar, #go");
  // .tool-privacy-hint duplicates the sidebar's own injected .tool-sidebar-tip
  // (same "everything happens in your browser" message) - drop it rather
  // than showing the same reassurance twice once a sidebar exists.
  body.querySelector(".tool-privacy-hint")?.remove();
  const candidates = [...body.children].filter(el => el!==out && el!==hero);
  const sidebarEls = candidates.filter(isSidebarEl);
  const mainEls = candidates.filter(el => !isSidebarEl(el));
  if(sidebarEls.length === 0) return;
  // Tools with no dropzone (txt2pdf's textarea, compare's two native file
  // inputs) are entirely .field/#go - splitting them would leave main
  // empty and dump everything into a cramped 440px sidebar, which looks
  // worse than just keeping the single centered column.
  if(mainEls.length === 0) return;

  const wrap = document.createElement("div");
  wrap.className = "tool-layout";
  const main = document.createElement("div");
  main.className = "tool-main";
  const sidebar = document.createElement("div");
  sidebar.className = "tool-sidebar";

  // The sidebar owns the tool's title + short instruction (iLovePDF's own
  // hierarchy) instead of duplicating it in a big centered hero above the
  // workspace - .tool-hero already has both (h2 title + description), so
  // it's reused/reparented here (restyled left-aligned+compact via
  // .tool-sidebar-hero in CSS) rather than writing the same copy twice.
  if(hero){ hero.classList.add("tool-sidebar-hero"); sidebar.appendChild(hero); }

  // Flexible spacer: pushes whatever comes after (options + primary
  // action, below) down to the bottom of the sidebar on tall viewports,
  // instead of the button floating right under the instruction text.
  const spacer = document.createElement("div");
  spacer.className = "tool-sidebar-spacer";
  sidebar.appendChild(spacer);

  const footer = document.createElement("div");
  footer.className = "tool-sidebar-footer";
  const tip = document.createElement("div");
  tip.className = "tool-sidebar-tip";
  tip.innerHTML = `<span class="tip-icon" aria-hidden="true">🔒</span><span>Everything happens right here in your browser — your files are never uploaded or stored anywhere.</span>`;
  footer.appendChild(tip);
  sidebarEls.forEach(el=>footer.appendChild(el));
  sidebar.appendChild(footer);

  mainEls.forEach(el=>main.appendChild(el));
  wrap.appendChild(main);
  wrap.appendChild(sidebar);
  body.insertBefore(wrap, out || null);
  // .tool-workspace's 900px cap (right for a single centered column) is
  // too narrow for a 440px sidebar to sit comfortably beside real content
  // - widen only once a .tool-layout actually got built.
  body.classList.add("has-tool-layout");
}
const PANEL_FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
function openPanel(html){
  panelLastFocus = document.activeElement;
  panel.innerHTML = html;
  // Single source of truth for a tool's primary heading. Every tool panel
  // has both a small .panel-head title bar (permanent chrome, shared with
  // the non-tool panels like About/Contact) and its own centered
  // <h2 class="tool-hero-title"> - for actual tools the hero title is the
  // real page heading (centered, in the content flow), so the redundant
  // bar is hidden rather than the other way around - one shared rule
  // instead of a per-tool "no title" hack. Non-tool panels (no
  // .tool-workspace) keep their .panel-head bar since it's their only
  // heading. (Left as h2, not promoted to h1: the homepage hero behind
  // this overlay already has its own h1 in the DOM at all times, so
  // adding a second h1 here would trade one duplicate-heading problem
  // for another rather than fix it.)
  const isToolPanel = panel.querySelector(".tool-workspace") && !panel.classList.contains("panel-fullscreen");
  if(isToolPanel){
    const panelHead = panel.querySelector(".panel-head");
    if(panelHead) panelHead.style.display = "none";
  }
  layoutTwoColumn();
  overlay.classList.add("open");
  document.documentElement.classList.add("panel-open");
  /* Every tool page keeps the site header visible above it (logo, nav,
     search, dark mode) — same pattern iLovePDF uses on its own tool
     pages — instead of covering the entire viewport and hiding all site
     branding/navigation, which read as a bare, disconnected utility
     screen rather than part of a real website. Force the header into its
     solid "scrolled" background since it now always sits above a panel,
     never the transparent hero. */
  siteHeader.classList.add("scrolled");
  overlay.style.top = siteHeader.getBoundingClientRect().height + "px";
  // Same focus-management intent the Quick Action modal already has
  // (qaLastFocus/Tab-trap above) — the tool panel is the app's far more
  // heavily used modal surface and previously had none of this. A plain
  // synchronous call works fine here (panel.innerHTML was already set
  // above, so the target is connected and focusable) and, unlike
  // requestAnimationFrame, doesn't depend on a compositor frame actually
  // being produced - a backgrounded/inactive tab can defer rAF
  // indefinitely, which would otherwise leave focus stuck on the trigger.
  (panel.querySelector(PANEL_FOCUSABLE) || panel).focus();
}
/**
 * @param {boolean} [skipRoute] - true when a tool-to-tool transition
 *   ("Continue to...", result screen "Start over") calls this right
 *   before openTool() opens the next one - without this, the URL would
 *   flash back to "/" for an instant before the next tool's own
 *   syncToolRoute() call overwrote it, and briefly leave a spurious "/"
 *   entry in browser history between the two tools.
 */
function closePanel(skipRoute){
  overlay.classList.remove("open");
  document.documentElement.classList.remove("panel-open");
  overlay.style.top = "";
  siteHeader.classList.toggle("scrolled", window.scrollY > 8);
  /* Strip the fullscreen variant (only ever added by TOOLS.edit) so the
     shared #panel/#overlay elements are back to their default state for
     every other tool the next time openPanel() runs. The editor's own
     workspace DOM is detached (not destroyed) just below, before the
     innerHTML wipe, so its state/listeners survive a close+reopen. */
  overlay.classList.remove("panel-fullscreen");
  panel.classList.remove("panel-fullscreen");
  if (window.__editorShellEl && window.__editorShellEl.parentNode === panel){
    editorHoldingArea.appendChild(window.__editorShellEl);
  }
  panel.innerHTML="";
  // The closed tool's result download / quick-preview / file-card thumbs
  // (if any) are no longer reachable from the DOM - release them now
  // rather than holding their Blobs in memory for the rest of the tab's
  // life. Editor image/signature-placement URLs are deliberately excluded
  // from this tracking (see the comment above downloadBlob()) and aren't
  // touched here.
  if(__activeResultUrl){ URL.revokeObjectURL(__activeResultUrl); __activeResultUrl = null; }
  if(__quickPreviewUrl){ URL.revokeObjectURL(__quickPreviewUrl); __quickPreviewUrl = null; }
  if(__fileCardPreviewUrls.length){ __fileCardPreviewUrls.forEach(u=>URL.revokeObjectURL(u)); __fileCardPreviewUrls = []; }
  panelLastFocus && panelLastFocus.focus && panelLastFocus.focus();
  panelLastFocus = null;
  if(!skipRoute && window.__currentToolId) syncHomeRoute();
  window.__currentToolId = null;
}
function goHome(){
  closePanel();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
/**
 * The YOYOPDF logo/brand link's click handler - a real <a href="/">, so
 * middle-click/Ctrl-click/right-click "open in new tab" and no-JS all
 * still work normally. Only a plain left-click gets intercepted, to go
 * home the same client-side way every other in-app navigation does
 * (no full page reload) instead of the browser's default link navigation.
 * @returns {boolean} false to preventDefault when handled client-side.
 */
function handleLogoClick(e){
  if(e.button!==0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;
  e.preventDefault();
  goHome();
  return false;
}
overlay.addEventListener("click", e=>{ if(e.target===overlay) closePanel(); });
document.addEventListener("keydown", e=>{
  if(!overlay.classList.contains("open")) return;
  // TOOLS.edit's fullscreen editor already owns Escape end-to-end
  // (editor-objects.js cancels a pending placement; navigation-manager.js
  // closes the workspace via editor:requestClose -> closePanel(), with
  // its own stopPropagation() so a mobile overlay panel closes first,
  // not the whole editor). This listener sits on `document`, which sees
  // the bubbling keydown before `window` does, so without this guard
  // Escape would close the entire panel out from under the editor's own
  // handling instead of e.g. just canceling a pending text placement.
  if(e.key==="Escape" && panel.classList.contains("panel-fullscreen")) return;
  if(e.key==="Escape"){ closePanel(); return; }
  if(e.key==="Tab"){
    const focusable = Array.from(panel.querySelectorAll(PANEL_FOCUSABLE)).filter(el=>el.offsetParent!==null);
    if(!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length-1];
    if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
  }
});

document.addEventListener("click", e=>{
  const card = e.target.closest("[data-tool]");
  const opener = e.target.closest("[data-open]");
  const id = card ? card.dataset.tool : (opener ? opener.dataset.open : null);
  if(!id) return;
  if(card && card.classList.contains("card")){
    card.classList.remove("card-glow");
    void card.offsetWidth;
    card.classList.add("card-glow");
  }
  document.getElementById("mobileMenu")?.classList.remove("open");
  closeAllDropdowns();
  openTool(id);
});

/* ---------------- Helpers ---------------- */
/**
 * Sanitizes text before any page.drawText() call with a pdf-lib
 * StandardFont. Those fonts (Helvetica etc.) use WinAnsi encoding, which
 * can't represent many Unicode characters - currency symbols like ₹,
 * smart quotes, em dashes, emoji, non-Latin scripts. Calling
 * page.drawText() with such a character throws, and since that call
 * sits deep inside an async click handler, the error was previously
 * uncaught: the tool just froze on its last status message forever with
 * no explanation (found via real user-submitted documents containing
 * ₹). Replacing the common cases and stripping anything else outside
 * Latin-1 lets the conversion degrade instead of crash.
 * @param {string} s - text about to be drawn with a StandardFont.
 * @returns {string} WinAnsi-safe text.
 */
function winAnsiSafe(s){
  return String(s)
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x00-\xFF]/g, "?");
}
/* Quality floors raised across the board (previously 0.35/0.6/0.85) - at
   quality 0.6 a scanned page's embedded image (where the "image" IS the
   page content, small text included) visibly artifacts, which is what
   "Recommended" being the default was doing to every scanned/photo PDF.
   maxDim raised to match: a Letter/A4 page scanned at even 200 DPI is
   ~1700-2200px on its long edge, so the old 1600 ceiling was already
   downscaling typical scans before quality even entered the picture.
   Readability now wins over squeezing out a few extra percent. */
const COMPRESS_PRESETS = {
  high:      { quality: 0.92, maxDim: 3000, protectDocuments: true },
  recommended: { quality: 0.82, maxDim: 2200, protectDocuments: true },
  max:       { quality: 0.55, maxDim: 1400, protectDocuments: false },
};
// A page scanned at ~200 DPI on Letter/A4 is roughly 1700-2200px on its
// long edge; 2800 gives real headroom above that so a "Recommended"
// compression never drops a genuine scanned page below normal reading
// resolution, even though its own maxDim (2200) would otherwise downscale
// it. Only used for images that *look* like a scanned page (see
// looksLikeDocumentPage below) - a real photo at 2200+ still downscales
// normally, since forcing every large image up to 2800 would defeat the
// point of the "Recommended" tier for photo-heavy PDFs.
const DOC_PAGE_MIN_LONG_EDGE = 2800;
/* Cheap, dependency-free heuristic for "this embedded image is probably a
   scanned document page, not a photo" - just the aspect ratio and
   absolute size, no pixel sampling/OCR. A4 is 1:1.414, Letter 1:1.294,
   Legal 1:1.647; the band below covers all three with margin. Deliberately
   conservative (a real photo shot in portrait A-series-ish proportions is
   a false positive here, which only means it gets treated a bit more
   gently than strictly necessary - never the reverse). */
function looksLikeDocumentPage(width, height){
  const longest = Math.max(width, height), shortest = Math.min(width, height);
  if(shortest < 900) return false; // too small to plausibly be a full-page scan
  const ratio = longest / shortest;
  return ratio > 1.2 && ratio < 1.75;
}
/* Recompresses only the embedded JPEG images inside a PDF, in place, at the
   same object reference - page content streams (text, vector paths, fonts)
   are never touched, so text stays exactly as sharp as the original
   regardless of preset. This is deliberately narrow in scope: only
   DCTDecode (JPEG) images with a plain RGB/Gray color space and no soft
   mask are recompressed; anything else (CMYK/Indexed color, non-JPEG
   filters, images with an alpha channel) is left completely untouched
   rather than risking wrong colors or lost transparency. Real-world "PDF
   is too big" cases are almost always driven by embedded photos/scans, so
   this covers the common case without the risk of a broader rewrite. */
async function recompressPdfImages(pdfBytes, presetName, onImageProgress){
  // Custom mode (below) needs arbitrary {quality, maxDim} pairs that don't
  // correspond to any named preset - accepting an object here directly,
  // alongside the existing named-preset strings every other caller still
  // uses unchanged, avoids inventing a parallel copy of this whole function.
  const preset = typeof presetName === "object" && presetName
    ? presetName
    : (COMPRESS_PRESETS[presetName] || COMPRESS_PRESETS.recommended);
  const doc = await loadPdfSafe(pdfBytes);
  const { PDFName, PDFRawStream, PDFNumber } = PDFLib;
  let touched = 0;
  // Materialized once so onImageProgress can report "image N of M" instead
  // of a silent multi-second loop on image-heavy PDFs, which previously
  // looked identical to a hung tab on large files.
  const allObjects = Array.from(doc.context.enumerateIndirectObjects());
  const imageObjects = allObjects.filter(([,obj])=>{
    if(!(obj instanceof PDFRawStream)) return false;
    const subtype = obj.dict.lookup(PDFName.of("Subtype"));
    return subtype && subtype.asString?.() === "/Image";
  });
  let imageIndex = 0;
  for(const [ref, obj] of allObjects){
    try{
      if(!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      const subtype = dict.lookup(PDFName.of("Subtype"));
      if(!subtype || subtype.asString?.() !== "/Image") continue;
      imageIndex++;
      if(onImageProgress) onImageProgress(imageIndex, imageObjects.length);
      const filter = dict.lookup(PDFName.of("Filter"));
      const filterName = filter && filter.asString ? filter.asString() : (Array.isArray(filter?.array) ? filter.array.map(f=>f.asString?.()).join(",") : "");
      if(!filterName || !filterName.includes("DCTDecode")) continue; // only plain JPEG streams
      if(dict.lookup(PDFName.of("SMask"))) continue; // has transparency - skip, JPEG can't keep it
      const colorSpace = dict.lookup(PDFName.of("ColorSpace"));
      const csName = colorSpace && colorSpace.asString ? colorSpace.asString() : "";
      if(csName && !/DeviceRGB|DeviceGray|CalRGB|CalGray/.test(csName)) continue; // skip CMYK/Indexed etc.

      const blob = new Blob([obj.contents], {type:"image/jpeg"});
      // createImageBitmap() has been observed elsewhere in this app to hang
      // indefinitely (never resolving or rejecting) rather than erroring on
      // some inputs - without a timeout here, one bad image would silently
      // block every remaining image in the PDF forever, since this runs in
      // a sequential loop. Same "skip on failure" philosophy as CMYK/SMask
      // above - a timed-out image just gets left untouched.
      const bitmap = await Promise.race([
        createImageBitmap(blob),
        new Promise((_, reject) => setTimeout(() => reject(new Error("decode timed out")), 8000))
      ]).catch(()=>null);
      if(!bitmap) continue; // not a browser-decodable JPEG (or timed out) - skip rather than guess

      let {width, height} = bitmap;
      const longest = Math.max(width, height);
      // Scanned-page-shaped images get a higher effective ceiling on
      // gentler presets, so a real document page never gets downscaled
      // below normal reading resolution just because "Recommended" was
      // selected - see DOC_PAGE_MIN_LONG_EDGE above.
      const effectiveMaxDim = (preset.protectDocuments && looksLikeDocumentPage(width, height))
        ? Math.max(preset.maxDim, DOC_PAGE_MIN_LONG_EDGE)
        : preset.maxDim;
      if(longest > effectiveMaxDim){
        const scale = effectiveMaxDim / longest;
        width = Math.round(width*scale); height = Math.round(height*scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
      const newDataUrl = canvas.toDataURL("image/jpeg", preset.quality);
      const newBytes = Uint8Array.from(atob(newDataUrl.split(",")[1]), c=>c.charCodeAt(0));
      if(newBytes.length >= obj.contents.length) continue; // no gain - keep original for this image

      const newDict = doc.context.obj({});
      dict.keys().forEach(k=>newDict.set(k, dict.get(k))); // start from a copy of the original dict
      newDict.set(PDFName.of("Width"), PDFNumber.of(width));
      newDict.set(PDFName.of("Height"), PDFNumber.of(height));
      newDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      newDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
      newDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      newDict.set(PDFName.of("Length"), PDFNumber.of(newBytes.length));
      doc.context.assign(ref, PDFRawStream.of(newDict, newBytes));
      touched++;
    }catch(e){ /* leave this one object exactly as it was on any failure */ }
  }
  const outBytes = await doc.save();
  return { bytes: outBytes, imagesRecompressed: touched };
}
/**
 * Custom "target size" compression: binary-searches a single aggressiveness
 * knob (0 = the existing "high" preset's quality/maxDim, 1 = harder than
 * "max") and re-runs recompressPdfImages() at each step, since that's the
 * only compression lever this engine actually has (it only ever touches
 * embedded JPEGs, same as every preset) - this is not a separate
 * compression algorithm, just the existing one driven toward a target
 * instead of a fixed preset. Bounded to MAX_ITERATIONS real compression
 * passes so a stubborn PDF can't spin forever.
 * @param {ArrayBuffer|Uint8Array} pdfBytes
 * @param {number} targetBytes - requested output size ceiling, in bytes.
 * @param {(step:number, total:number, currentSize:number)=>void} [onProgress]
 * @returns {Promise<{bytes:Uint8Array, achieved:boolean, imagesRecompressed:number}>}
 *   achieved is false when even the most aggressive pass this engine can do
 *   still landed above targetBytes - bytes is still the smallest result
 *   found, just not a guarantee of hitting the target.
 */
async function compressToTarget(pdfBytes, targetBytes, onProgress){
  const originalSize = pdfBytes.byteLength ?? pdfBytes.length;
  if(originalSize <= targetBytes){
    return { bytes: new Uint8Array(pdfBytes), achieved:true, imagesRecompressed:0, alreadyUnderTarget:true };
  }
  const MAX_ITERATIONS = 6;
  // t=0 -> same ceiling as the "high" (least-aggressive) preset
  // t=1 -> a floor kept above the point where text-in-scans stops being
  // readable, even though the user explicitly asked for a target size -
  // "as close as possible without destroying image quality" per the UI's
  // own copy, not truly unbounded.
  const presetAt = t => ({
    quality: COMPRESS_PRESETS.high.quality - t*(COMPRESS_PRESETS.high.quality-0.3),
    maxDim: Math.round(COMPRESS_PRESETS.high.maxDim - t*(COMPRESS_PRESETS.high.maxDim-700)),
  });
  let lo=0, hi=1, best=null, bestUnder=null;
  for(let i=0;i<MAX_ITERATIONS;i++){
    const t = (lo+hi)/2;
    const result = await recompressPdfImages(pdfBytes, presetAt(t));
    if(onProgress) onProgress(i+1, MAX_ITERATIONS, result.bytes.length);
    if(!best || result.bytes.length < best.bytes.length) best = result;
    if(result.bytes.length <= targetBytes){ bestUnder = result; hi = t; }
    else { lo = t; }
  }
  const chosen = bestUnder || best;
  return { bytes: chosen.bytes, achieved: chosen.bytes.length <= targetBytes, imagesRecompressed: chosen.imagesRecompressed };
}
function fmtSize(bytes){
  if(bytes < 1024) return bytes+" B";
  if(bytes < 1024*1024) return (bytes/1024).toFixed(1)+" KB";
  return (bytes/1024/1024).toFixed(2)+" MB";
}
/* Object URLs created for the current result download / quick-preview
   strip / file-card thumbnails - tracked here so each is revoked exactly
   once (superseded by a newer one, or the tool workspace closing) instead
   of never. A Blob URL keeps its Blob's bytes alive in memory for as long
   as it stays registered, regardless of whether the DOM node that used it
   is still on the page - removing the <a>/<img> alone doesn't release it.
   window.loadImage() (used by the single-image tools further below, and
   by js/editor/editor-toolbar.js's picked-image/signature placement) is
   deliberately NOT tracked here: editor-toolbar.js keeps that URL alive
   on purpose for as long as the placed image object exists (it becomes
   the object's data.src, re-read on every render and by export), so a
   blanket revoke-on-load would break Edit PDF's "add image"/signature
   feature. See that file's own pendingImageUrl lifecycle for how it's
   handled instead. */
let __activeResultUrl = null;
let __quickPreviewUrl = null;
let __fileCardPreviewUrls = [];
/**
 * Wraps a result Blob as an object URL ready for a `<a download>` link.
 * Revokes the previous result's URL first, if any - a tool that
 * regenerates its output (re-running with new settings without closing
 * the panel) would otherwise leak one URL per run.
 * @param {Blob} blob - the file bytes to offer for download.
 * @param {string} filename - suggested download filename.
 * @returns {{url: string, filename: string}}
 */
function downloadBlob(blob, filename){
  if(__activeResultUrl) URL.revokeObjectURL(__activeResultUrl);
  const url = URL.createObjectURL(blob);
  __activeResultUrl = url;
  return {url, filename};
}
/**
 * Builds "<original-name-without-extension>_<suffix>.<ext>" instead of a
 * generic static name, so a result stays traceable to what the user
 * uploaded (document.pdf -> document_compressed.pdf). Falls back to
 * "document" if the input has no usable name (e.g. a merge/zip output
 * with no single source file).
 * @param {File|null} file - the original uploaded file, if any.
 * @param {string} suffix - tool-specific suffix, e.g. "compressed".
 * @param {string} ext - output extension, without the leading dot.
 * @returns {string}
 */
// Every tool-specific suffix suffixedName() ever appends, so a file that's
// been round-tripped through several tools (download -> re-upload into the
// next one) gets its OWN previous suffixes stripped before a new one is
// added, instead of compounding into
// "name_compressed_pages_removed_merged_compressed.pdf". Sorted longest
// first so a multi-word suffix like "pages_removed" is tried whole before
// any shorter one that could otherwise match a fragment of it.
const KNOWN_FILENAME_SUFFIXES = [
  "split_parts","pages_removed","header_footer","metadata_updated","with_blank",
  "split","compressed","rotated","extracted","reordered","numbered","watermarked",
  "cropped","inverted","organized","flattened","repaired","pages","converted",
  "resized","signed","filled","images","merged",
].sort((a,b)=>b.length-a.length);
function suffixedName(file, suffix, ext){
  const raw = (file && file.name) ? file.name : "document";
  let base = raw.replace(/\.[^./\\]+$/, "") || "document";
  let stripped = true;
  while(stripped){
    stripped = false;
    for(const suf of KNOWN_FILENAME_SUFFIXES){
      if(base.length > suf.length+1 && base.endsWith("_"+suf)){
        base = base.slice(0, -(suf.length+1));
        stripped = true;
        break;
      }
    }
  }
  base = base || "document";
  // Caps the final filename's length so a long original name plus a new
  // suffix can never make the download button's label wrap/overflow.
  const MAX_BASE = 60;
  if(base.length > MAX_BASE) base = base.slice(0, MAX_BASE).replace(/_+$/, "");
  return `${base}_${suffix}.${ext}`;
}
/**
 * Resolves the output raster format for an image tool from its input
 * File's MIME type: PNG stays PNG (to preserve transparency), everything
 * else becomes JPEG. Shared by every image tool that re-encodes via
 * canvas.toBlob() (Resize/Crop/Watermark/Invert), which previously each
 * duplicated this same two-branch ternary independently.
 * @param {File} file - the original uploaded image file.
 * @returns {{mime: "image/png"|"image/jpeg", ext: "png"|"jpg"}}
 */
function imgOutputFormat(file){
  const isPng = file.type.includes("png");
  return {mime: isPng ? "image/png" : "image/jpeg", ext: isPng ? "png" : "jpg"};
}
function fileInputHTML(accept, multiple, label){
  // Same widget renders two different roles: the big empty-state CTA
  // ("Select PDF file") and its own drop target - so the small caption
  // underneath states the second role ("or drop PDF file here") instead
  // of repeating unrelated copy, derived from the one label callers
  // already pass rather than a second parameter every call site would
  // have to keep in sync.
  const noun = (label||"file").replace(/^Select\s+/i, "");
  return `<div class="dropzone" id="dz">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
    <div><strong>${label||'Drag and drop, or click to browse'}</strong></div>
    <div class="hint">or drop ${noun} here · 🔒 stays on this device</div>
    <input type="file" id="fi" class="hidden" accept="${accept}" ${multiple?"multiple":""}>
  </div><div class="filelist" id="flist"></div><div class="thumbs" id="quickPreview"></div>`;
}
async function autoQuickPreview(fs){
  const qp = document.getElementById("quickPreview");
  if(!qp) return;
  if(__quickPreviewUrl){ URL.revokeObjectURL(__quickPreviewUrl); __quickPreviewUrl = null; }
  qp.innerHTML = "";
  // Tools with their own page-grid (Organize/Reorder/Delete/Extract Pages)
  // already render every page as a full interactive thumbnail — this
  // redundant strip would duplicate that render concurrently against the
  // same pdf.js worker, which is wasteful and, in some environments, races.
  if(document.getElementById("pageGrid")) return;
  if(fs.length!==1) return;
  const f = fs[0];
  try{
    if(f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf")){
      const bytes = await f.arrayBuffer();
      // .slice(0) here, not the original `bytes` - pdfjsLib.getDocument()
      // can transfer/detach an ArrayBuffer to its worker, and pdfThumb()
      // below calls getDocument() again on the same `bytes` for each
      // page. Without the copy, that second call silently fails once the
      // buffer's been detached, pdfThumb() returns {canvas:null}, and
      // appendChild(null) throws - caught by this function's own outer
      // catch, so the whole preview silently never rendered anything.
      const pdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
      const maxShow = Math.min(pdoc.numPages, 6);
      for(let i=1;i<=maxShow;i++){
        // Each pdfThumb() call internally does its own getDocument(), which
        // detaches whatever buffer it's given - reusing `bytes` across this
        // loop's iterations would only let page 1 succeed and silently fail
        // every page after it. A fresh slice per call keeps each independent.
        const {canvas} = await pdfThumb(bytes.slice(0), i, 100);
        if(canvas) qp.appendChild(canvas);
      }
      if(pdoc.numPages>maxShow){
        const more = document.createElement("div");
        more.style.cssText="display:flex;align-items:center;color:var(--ink-soft);font-size:.8rem;padding:0 8px;white-space:nowrap;";
        more.textContent = `+${pdoc.numPages-maxShow} more page${pdoc.numPages-maxShow>1?'s':''}`;
        qp.appendChild(more);
      }
    } else if(f.type.startsWith("image/")){
      const url = URL.createObjectURL(f);
      __quickPreviewUrl = url;
      const img = document.createElement("img"); img.src=url;
      qp.appendChild(img);
    }
  }catch(e){ /* preview is best-effort; ignore failures */ }
}
/**
 * Wires the current panel's dropzone/file-input pair (the "#dz"/"#fi"
 * elements fileInputHTML() renders) to a single callback, covering both
 * click-to-browse and drag-and-drop, plus the shared quick-preview strip.
 * @param {(files: File[]) => void} onFiles - called with the picked/
 *   dropped files, once per pick/drop.
 */
function wireDropzone(onFiles){
  const dz = document.getElementById("dz");
  const fi = document.getElementById("fi");
  function handle(fs){ onFiles(fs); autoQuickPreview(fs); }
  dz.addEventListener("click", ()=>fi.click());
  fi.addEventListener("change", ()=>handle([...fi.files]));
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.remove("drag");}));
  dz.addEventListener("drop", e=>{ handle([...e.dataTransfer.files]); });
}
/**
 * Renders the selected-files list as real thumbnail cards (actual PDF
 * page 1 + page count, or the image itself) instead of a plain filename
 * row — matches iLovePDF's file-card look. Placeholder cards render
 * instantly; real thumbnails fill in progressively (sequential, not
 * concurrent, since rendering many PDFs' first pages at once can starve
 * pdf.js's worker).
 * @param {File[]} files - files to render as cards.
 * @param {(index: number) => void} onRemove - called with a file's index
 *   when its card's remove button is clicked.
 */
function renderFileList(files, onRemove){
  const flist = document.getElementById("flist");
  // Every call fully replaces #flist's contents (including any image
  // thumbnails from the previous call, each its own object URL below) -
  // revoke those now rather than leaking one per add/remove/replace cycle.
  if(__fileCardPreviewUrls.length){ __fileCardPreviewUrls.forEach(u=>URL.revokeObjectURL(u)); __fileCardPreviewUrls = []; }
  flist.classList.add("file-grid");
  document.querySelector(".panel-body")?.classList.toggle("has-file", files.length>0);
  flist.innerHTML = files.map((f,i)=>{
    const kind = isPdfFile(f) ? "PDF" : (f.type && f.type.startsWith("image/")) ? "IMG" : (f.name.split(".").pop()||"FILE").toUpperCase().slice(0,4);
    return `<div class="file-card" data-i="${i}">
      <button type="button" class="file-card-remove" data-i="${i}" aria-label="Remove ${escapeAttr(f.name)}">✕</button>
      <div class="file-card-thumb" id="fcThumb${i}"><span class="file-card-kind">${kind}</span></div>
      <div class="file-card-name" title="${escapeAttr(f.name)}">${escapeAttr(f.name)}</div>
      <div class="file-card-meta">
        <span class="file-card-size mono">${fmtSize(f.size)}</span>
        <span class="file-card-pages mono" id="fcPages${i}"></span>
      </div>
    </div>`;
  }).join("");
  /* Centralized removal cleanup: many callers only reset their own tool
     state in onRemove (null the file var, hide a toolbar) without ever
     re-rendering #flist, leaving a stale file-card on screen even though
     the tool's internal state is empty. Removing the card and re-syncing
     .has-file HERE, before calling the tool's own onRemove, means every
     caller gets a correctly-cleared file list for free - no per-tool
     cleanup required. Multi-file tools whose onRemove re-renders the
     whole list anyway (Merge's refresh()) just get an instant, harmless
     no-op re-render on top of this. */
  flist.querySelectorAll(".file-card-remove").forEach(b=>b.addEventListener("click", e=>{
    e.stopPropagation();
    const i = +b.dataset.i;
    const card = b.closest(".file-card");
    // Fade+shrink the card out first, THEN actually remove it and notify
    // the caller - a plain instant .remove() (the old behavior) made
    // whatever grid row below it snap up with no transition, which reads
    // as an abrupt pop on a multi-file grid. motionExit no-ops straight
    // to removal under reduced motion.
    motionExit(card, ()=>{
      card?.remove();
      document.querySelector(".panel-body")?.classList.toggle("has-file", flist.children.length>0);
      // autoQuickPreview()'s strip is a separate sibling element populated
      // independently of #flist - clear it too, otherwise a removed file's
      // preview image/thumbnails linger even though the file list is empty.
      if(flist.children.length===0){
        const qp = document.getElementById("quickPreview");
        if(qp) qp.innerHTML = "";
      }
      onRemove(i);
    });
  }));
  motionEnter(flist.querySelectorAll(".file-card"), {duration:MOTION.fast, stagger:MOTION.stagger.small, fromY:10});
  (async ()=>{
    for(let i=0;i<files.length;i++){
      const f = files[i];
      const slot = document.getElementById("fcThumb"+i);
      if(!slot) return; // list was re-rendered (add/remove) before this finished
      try{
        if(isPdfFile(f)){
          const bytes = await f.arrayBuffer();
          const {canvas, numPages} = await pdfThumb(bytes, 1, 220);
          // pdfThumb() returns {canvas:null, numPages:0} on its own internal
          // timeout (see its own doc comment) rather than throwing - must
          // guard here, since appendChild(null) throws and would otherwise
          // also skip the page-count line below via the shared try/catch.
          if(canvas && document.getElementById("fcThumb"+i)===slot){ slot.innerHTML=""; slot.appendChild(canvas); }
          const pagesEl = document.getElementById("fcPages"+i);
          if(pagesEl && numPages>0) pagesEl.textContent = numPages===1 ? "1 page" : `${numPages} pages`;
        } else if(f.type && f.type.startsWith("image/")){
          const img = document.createElement("img");
          const url = URL.createObjectURL(f);
          __fileCardPreviewUrls.push(url);
          img.src = url;
          slot.innerHTML=""; slot.appendChild(img);
        }
      }catch(e){ /* leave the kind-badge placeholder on any render failure */ }
    }
  })();
}
function escapeAttr(s){ return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
/* Shared drag-to-select crop interaction: supports drawing a new box,
   moving it, and resizing it from any edge/corner via small handles. */
function wireCropCanvas(canvas, state){
  const HANDLE = 9;
  let mode = null, resizeEdge = null, startPt = null, startRect = null;

  function getPos(e){
    const r = canvas.getBoundingClientRect();
    let x = (e.clientX-r.left) * (canvas.width/r.width);
    let y = (e.clientY-r.top) * (canvas.height/r.height);
    x = Math.max(0, Math.min(canvas.width, x));
    y = Math.max(0, Math.min(canvas.height, y));
    return {x,y};
  }
  function handlePoints(r){
    return {
      nw:{x:r.x,y:r.y}, n:{x:r.x+r.w/2,y:r.y}, ne:{x:r.x+r.w,y:r.y},
      e:{x:r.x+r.w,y:r.y+r.h/2}, se:{x:r.x+r.w,y:r.y+r.h}, s:{x:r.x+r.w/2,y:r.y+r.h},
      sw:{x:r.x,y:r.y+r.h}, w:{x:r.x,y:r.y+r.h/2}
    };
  }
  function hitHandle(p){
    const pts = handlePoints(state.rect);
    for(const key in pts){
      if(Math.abs(p.x-pts[key].x)<=HANDLE && Math.abs(p.y-pts[key].y)<=HANDLE) return key;
    }
    return null;
  }
  function inside(p){
    const r = state.rect;
    return p.x>r.x && p.x<r.x+r.w && p.y>r.y && p.y<r.y+r.h;
  }

  canvas.style.touchAction = "none";
  canvas.onpointerdown = e=>{
    canvas.setPointerCapture(e.pointerId);
    const p = getPos(e);
    startPt = p; startRect = {...state.rect};
    const h = hitHandle(p);
    if(h){ mode="resize"; resizeEdge=h; }
    else if(inside(p)){ mode="move"; }
    else { mode="new"; state.rect = {x:p.x, y:p.y, w:0, h:0}; }
    state.redraw();
  };
  canvas.onpointermove = e=>{
    if(!mode) return;
    const p = getPos(e);
    if(mode==="new"){
      state.rect = {x:Math.min(startPt.x,p.x), y:Math.min(startPt.y,p.y), w:Math.abs(p.x-startPt.x), h:Math.abs(p.y-startPt.y)};
    } else if(mode==="move"){
      const dx = p.x-startPt.x, dy = p.y-startPt.y;
      const nx = Math.max(0, Math.min(canvas.width-startRect.w, startRect.x+dx));
      const ny = Math.max(0, Math.min(canvas.height-startRect.h, startRect.y+dy));
      state.rect = {x:nx, y:ny, w:startRect.w, h:startRect.h};
    } else if(mode==="resize"){
      let {x,y,w,h} = startRect;
      let x2=x+w, y2=y+h;
      const dx=p.x-startPt.x, dy=p.y-startPt.y;
      if(resizeEdge.includes("n")) y = Math.min(y+dy, y2-10);
      if(resizeEdge.includes("s")) y2 = Math.max(y2+dy, y+10);
      if(resizeEdge.includes("w")) x = Math.min(x+dx, x2-10);
      if(resizeEdge.includes("e")) x2 = Math.max(x2+dx, x+10);
      x = Math.max(0,x); y = Math.max(0,y);
      x2 = Math.min(canvas.width,x2); y2 = Math.min(canvas.height,y2);
      state.rect = {x, y, w:x2-x, h:y2-y};
    }
    state.redraw();
  };
  canvas.onpointerup = ()=>{ mode=null; resizeEdge=null; };
}
function drawCropHandles(ctx, r){
  const pts = [
    [r.x,r.y],[r.x+r.w/2,r.y],[r.x+r.w,r.y],
    [r.x+r.w,r.y+r.h/2],[r.x+r.w,r.y+r.h],[r.x+r.w/2,r.y+r.h],
    [r.x,r.y+r.h],[r.x,r.y+r.h/2]
  ];
  ctx.save();
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#E8291B"; ctx.lineWidth = 1.5;
  pts.forEach(([px,py])=>{
    ctx.fillRect(px-5, py-5, 10, 10);
    ctx.strokeRect(px-5, py-5, 10, 10);
  });
  ctx.restore();
}
/**
 * Renders one PDF page to a thumbnail canvas, with a hang-proof timeout.
 * pdf.js's page.render() has been observed to hang indefinitely (never
 * resolving or rejecting) rather than erroring out, in some
 * environments. Every result screen across ~25 tools awaits this for
 * its preview thumbnail before showing the download link, so a hang
 * here means the whole tool looks permanently stuck at "Building..."
 * with no way to download a file that was actually already produced
 * successfully. A timeout with a null-canvas fallback means a slow/
 * failed thumbnail degrades to "no preview" instead of blocking the
 * download forever - every caller already handles a falsy canvas
 * (resultBox only renders the preview thumbs wrapper `if(previewNode)`).
 * @param {ArrayBuffer|Uint8Array} bytes - PDF bytes.
 * @param {number} [pageNum=1] - 1-based page to render.
 * @param {number} [maxH=110] - target canvas height in CSS px.
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{canvas: HTMLCanvasElement|null, numPages: number}>}
 *   `canvas` is null and `numPages` is 0 on timeout/failure.
 */
async function pdfThumb(bytes, pageNum=1, maxH=110, timeoutMs=8000){
  try {
    return await Promise.race([
      pdfThumbInner(bytes, pageNum, maxH),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pdfThumb timed out")), timeoutMs))
    ]);
  } catch (e) {
    return { canvas: null, numPages: 0 };
  }
}
async function pdfThumbInner(bytes, pageNum, maxH){
  const doc = await pdfjsLib.getDocument({data:bytes}).promise;
  const page = await doc.getPage(pageNum);
  const vp1 = page.getViewport({scale:1});
  const scale = maxH/vp1.height;
  const vp = page.getViewport({scale});
  const canvas = document.createElement("canvas");
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({canvasContext:canvas.getContext("2d"), viewport:vp}).promise;
  return {canvas, numPages: doc.numPages};
}
/**
 * Renders one PDF page to a canvas at an explicit scale (page-grid
 * thumbnails, image-fallback conversion paths). Unlike pdfThumb(), this
 * throws on timeout rather than swallowing - page.render() has been
 * observed elsewhere in this app to hang indefinitely (never resolving
 * or rejecting) rather than erroring, on some inputs/environments, same
 * category of issue pdfThumb() was fixed for earlier - but some callers
 * here use the rendered image as the actual deliverable, not just an
 * optional preview, so they need to decide how to handle a failure
 * themselves rather than silently getting nothing back.
 * @param {import("pdfjs-dist").PDFDocumentProxy} pdoc
 * @param {number} pageNum - 1-based page to render.
 * @param {number} scale - pdf.js viewport scale.
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<HTMLCanvasElement>} rejects on timeout.
 */
async function renderPdfPageCanvas(pdoc, pageNum, scale, timeoutMs=10000){
  const page = await pdoc.getPage(pageNum);
  const vp = page.getViewport({scale});
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  await Promise.race([
    page.render({canvasContext:canvas.getContext("2d"), viewport:vp}).promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Page render timed out")), timeoutMs))
  ]);
  return canvas;
}

/**
 * Shared iLovePDF-style page-thumbnail grid, backing Delete Pages,
 * Extract Pages, Reorder Pages, Split, Organize, and Rotate. All flags
 * below default to false, so existing callers (Delete Pages, Extract
 * Pages, plain Reorder) are unaffected by ones they don't pass.
 * @param {HTMLElement} container - element to render the grid into.
 * @param {ArrayBuffer|Uint8Array} bytes - PDF bytes to render pages from.
 * @param {object} [opts]
 * @param {"reorder"|"select"} [opts.mode="reorder"] - "reorder": drag
 *   cards to reorder; getOrder() returns the current 0-based original
 *   page indices in on-screen order. "select": click a card to toggle
 *   it; getSelected() returns a Set of 0-based indices currently
 *   selected.
 * @param {boolean} [opts.removable=false] - reorder mode only: shows a
 *   hover ✕ on each card to drop that page entirely.
 * @param {boolean} [opts.rotatable=false] - hover-reveal rotate-left/
 *   right buttons per card, plus a bulk "Rotate Selected" action.
 * @param {boolean} [opts.duplicable=false] - hover-reveal duplicate
 *   button per card, plus a bulk "Duplicate Selected" action.
 * @param {boolean} [opts.multiSelect=false] - reorder mode only: click-
 *   to-select alongside dragging, via an always-visible corner checkbox
 *   (mode "select" already gets click-to-select natively).
 * @param {boolean} [opts.zoomable=false] - adds a Small/Medium/Large
 *   thumbnail-size toggle.
 * @returns {Promise<{getOrder: Function, getSelected: Function,
 *   getPages: Function, getSelectedPages: Function, selectOddEven:
 *   Function, selectAll: Function, clearSelection: Function, rotateAll:
 *   Function}>}
 */
async function buildPageGrid(container, bytesOrSources, {mode="reorder", removable=false, rotatable=false, duplicable=false, multiSelect=false, zoomable=false} = {}){
  // Single-file callers (Split/Rotate/DeletePages/ExtractPages/Reorder/
  // AddBlankPage) pass raw bytes, unchanged from before this function
  // supported multi-file sources - normalized to a 1-item sources array so
  // their behavior/output is bit-for-bit identical (docIndex is always 0,
  // no color border is ever applied). Organize PDF is the only caller that
  // passes an array of {bytes, color, label} to combine multiple files
  // into one grid with a colored border per source, iLovePDF-style.
  const sources = Array.isArray(bytesOrSources) ? bytesOrSources : [{bytes: bytesOrSources}];
  let pdocs = await Promise.all(sources.map(s=>pdfjsLib.getDocument({data:s.bytes.slice(0)}).promise));
  const numPages = pdocs.reduce((sum,p)=>sum+p.numPages, 0);
  const selectionEnabled = mode==="select" || (mode==="reorder" && multiSelect);
  const showBulkBar = selectionEnabled && (rotatable || duplicable || removable);
  container.innerHTML = "";
  container.classList.add("page-grid");
  document.querySelector(".panel-body")?.classList.toggle("has-file", numPages>0);

  const toolbar = document.createElement("div");
  toolbar.className = "page-grid-toolbar";
  let bulkBar = null;
  if(showBulkBar){
    bulkBar = document.createElement("div");
    bulkBar.className = "page-grid-bulkbar";
    toolbar.appendChild(bulkBar);
  }
  // Select all / Deselect all: previously only reachable via the Ctrl+A/
  // Escape keyboard shortcuts below (real, but completely undiscoverable -
  // nothing in the UI hinted they existed). bulkBar itself can't host
  // "Select all" since it only renders once something is ALREADY selected
  // (chicken-and-egg) - this sits in the toolbar proper instead, always
  // visible whenever the grid supports selection at all, mirroring iLovePDF's
  // organize/delete-pages page pickers. "Deselect all" is intentionally
  // the bulk bar's existing "Clear" button, not a second always-visible
  // button here - once anything is selected the bulk bar is already on
  // screen, so a second always-there control would just be redundant.
  let selectCtl = null;
  if(selectionEnabled){
    selectCtl = document.createElement("div");
    selectCtl.className = "page-grid-selectctl";
    selectCtl.innerHTML = `<button type="button" class="bulkbar-btn" data-act="selectAll" draggable="false">Select all</button>`;
    toolbar.appendChild(selectCtl);
  }
  if(zoomable){
    const zoomCtl = document.createElement("div");
    zoomCtl.className = "page-grid-zoom";
    zoomCtl.innerHTML = `<span>Size</span>
      <button type="button" class="zoom-btn" data-zoom="s" draggable="false">S</button>
      <button type="button" class="zoom-btn active" data-zoom="m" draggable="false">M</button>
      <button type="button" class="zoom-btn" data-zoom="l" draggable="false">L</button>`;
    toolbar.appendChild(zoomCtl);
  }
  if(toolbar.children.length) container.appendChild(toolbar);

  const cardsWrap = document.createElement("div");
  cardsWrap.className = "page-grid-cards zoom-m";
  container.appendChild(cardsWrap);

  const firstVp = (await pdocs[0].getPage(1)).getViewport({scale:1});
  const scale = 260 / firstVp.height;

  function rotateCard(card, delta){
    const cur = ((parseInt(card.dataset.rotation||"0") + delta) % 360 + 360) % 360;
    card.dataset.rotation = cur;
    const cv = card.querySelector("canvas");
    if(!cv) return;
    cv.classList.remove("rot-90","rot-180","rot-270");
    if(cur) cv.classList.add("rot-"+cur);
  }

  async function duplicateCard(card){
    await renderCardCanvas(card); // ensure the source has a real canvas before copying its pixels
    const clone = card.cloneNode(true);
    const srcCanvas = card.querySelector("canvas");
    const dstCanvas = clone.querySelector("canvas");
    if(srcCanvas && dstCanvas){
      dstCanvas.width = srcCanvas.width; dstCanvas.height = srcCanvas.height;
      dstCanvas.getContext("2d").drawImage(srcCanvas,0,0);
    }
    clone.classList.remove("selected","dragging","drag-over");
    syncCheckToggle(clone, false);
    const lbl = clone.querySelector(".page-num");
    if(lbl) lbl.textContent += " (copy)";
    wireCard(clone);
    card.after(clone);
    updateBulkBar();
  }

  // Shared by the toolbar's "Select all" button, the Ctrl+A/Escape
  // shortcuts, and the returned gridApi - one implementation instead of
  // three copies of the same querySelectorAll+classList dance.
  function syncCheckToggle(card, selected){ card.querySelector(".page-check-toggle")?.setAttribute("aria-checked", String(selected)); }
  function selectAllPages(){ cardsWrap.querySelectorAll(".page-card").forEach(c=>{ c.classList.add("selected"); syncCheckToggle(c, true); }); updateBulkBar(); }
  function clearAllSelection(){ cardsWrap.querySelectorAll(".page-card.selected").forEach(c=>{ c.classList.remove("selected"); syncCheckToggle(c, false); }); updateBulkBar(); }
  if(selectCtl){
    selectCtl.querySelector('[data-act="selectAll"]').addEventListener("click", selectAllPages);
  }

  function updateBulkBar(){
    if(!bulkBar) return;
    const n = cardsWrap.querySelectorAll(".page-card.selected").length;
    if(n===0){ bulkBar.innerHTML=""; bulkBar.style.display="none"; return; }
    bulkBar.style.display = "flex";
    bulkBar.innerHTML = `<span class="bulkbar-count">${n} selected</span>` +
      (rotatable ? `<button type="button" class="bulkbar-btn" data-act="rotL" draggable="false">⟲ Rotate</button><button type="button" class="bulkbar-btn" data-act="rotR" draggable="false">⟳ Rotate</button>` : "") +
      (duplicable ? `<button type="button" class="bulkbar-btn" data-act="dup" draggable="false">⧉ Duplicate</button>` : "") +
      (removable ? `<button type="button" class="bulkbar-btn bulkbar-danger" data-act="del" draggable="false">✕ Delete</button>` : "") +
      `<button type="button" class="bulkbar-btn" data-act="clear" draggable="false">Clear</button>`;
    bulkBar.querySelectorAll("[data-act]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const act = btn.dataset.act;
        const selected = [...cardsWrap.querySelectorAll(".page-card.selected")];
        if(act==="rotL") selected.forEach(c=>rotateCard(c,-90));
        if(act==="rotR") selected.forEach(c=>rotateCard(c,90));
        if(act==="dup") selected.forEach(c=>duplicateCard(c));
        if(act==="del") selected.forEach(c=>{ c.classList.add("removing"); setTimeout(()=>c.remove(),160); });
        if(act==="clear"){ clearAllSelection(); return; }
        updateBulkBar();
      });
    });
  }

  function wireCard(card){
    if(mode==="select"){
      card.onclick = ()=>{
        const nowSelected = card.classList.toggle("selected");
        card.setAttribute("aria-pressed", String(nowSelected));
        updateBulkBar();
      };
    } else if(multiSelect){
      card.addEventListener("click", e=>{
        if(e.target.closest(".page-thumb-actions,.page-remove,.page-check-toggle")) return;
        const nowSelected = card.classList.toggle("selected");
        syncCheckToggle(card, nowSelected);
        updateBulkBar();
      });
    }
    const chkToggle = card.querySelector(".page-check-toggle");
    if(chkToggle) chkToggle.onclick = e=>{
      e.stopPropagation();
      const nowSelected = card.classList.toggle("selected");
      chkToggle.setAttribute("aria-checked", String(nowSelected));
      updateBulkBar();
    };
    const rotL = card.querySelector(".page-rotate-left");
    const rotR = card.querySelector(".page-rotate-right");
    if(rotL) rotL.onclick = e=>{ e.stopPropagation(); rotateCard(card,-90); };
    if(rotR) rotR.onclick = e=>{ e.stopPropagation(); rotateCard(card,90); };
    const dup = card.querySelector(".page-dup-btn");
    if(dup) dup.onclick = e=>{ e.stopPropagation(); duplicateCard(card); };
    const rm = card.querySelector(".page-remove");
    if(rm) rm.onclick = e=>{ e.stopPropagation(); card.classList.add("removing"); setTimeout(()=>card.remove(),160); };
  }

  /* Phase 7: renders (or re-renders, after a timeout) exactly one card's
     canvas on demand, instead of the old for-loop awaiting every page's
     render up front - that blocked the whole grid behind however many
     pages the PDF had, even the ones scrolled far out of view. Idempotent
     via dataset.rendered, since duplicateCard() and the IntersectionObserver
     below can both ask for the same card. */
  async function renderCardCanvas(card){
    if(card.dataset.rendered === "true") return;
    card.dataset.rendered = "true";
    const pageNum = parseInt(card.dataset.page) + 1;
    const docIdx = parseInt(card.dataset.docIndex || "0");
    const thumb = card.querySelector(".page-thumb");
    const placeholder = thumb && thumb.querySelector(".page-thumb-placeholder");
    try{
      const canvas = await renderPdfPageCanvas(pdocs[docIdx], pageNum, scale);
      const rot = card.dataset.rotation;
      if(rot && rot !== "0") canvas.classList.add("rot-"+rot);
      if(placeholder) placeholder.replaceWith(canvas);
      else if(thumb) thumb.insertBefore(canvas, thumb.firstChild);
    }catch(e){
      card.dataset.rendered = "false"; // let a later intersection retry
      if(placeholder) placeholder.textContent = "⚠";
    }
  }

  /**
   * Builds and appends one page-card, for source `docIdx`'s page `i`
   * (1-based, within that source). Factored out of the original single
   * top-level loop so appendSource() (the "+ Add more files" case) can
   * call the exact same card-building logic for a file added after the
   * initial grid was built, instead of re-implementing it.
   */
  function appendCard(docIdx, i){
    const color = sources[docIdx] && sources[docIdx].color;
    const card = document.createElement("div");
    card.className = "page-card" + (mode==="select" ? " page-card-select" : "");
    card.dataset.page = i-1;
    card.dataset.docIndex = docIdx;
    card.dataset.rotation = "0";
    card.dataset.rendered = "false";
    card.draggable = mode === "reorder";
    if(mode==="select"){
      // A clickable <div> otherwise has no keyboard affordance at all -
      // wireCard()'s onclick toggle already handles the mouse case.
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-pressed", "false");
      card.setAttribute("aria-label", "Page "+i);
      card.addEventListener("keydown", e=>{
        if(e.key===" " || e.key==="Enter"){ e.preventDefault(); card.click(); }
      });
    }

    const thumb = document.createElement("div");
    thumb.className = "page-thumb";
    if(color){ thumb.style.borderColor = color; thumb.style.borderWidth = "3px"; }
    const placeholder = document.createElement("div");
    placeholder.className = "page-thumb-placeholder";
    placeholder.innerHTML = '<span class="page-thumb-spinner" aria-hidden="true"></span>';
    thumb.appendChild(placeholder);
    if(rotatable || duplicable){
      const actions = document.createElement("div");
      actions.className = "page-thumb-actions";
      let html = "";
      if(rotatable) html += `<button type="button" class="page-rotate-left" aria-label="Rotate page ${i} left" draggable="false">⟲</button><button type="button" class="page-rotate-right" aria-label="Rotate page ${i} right" draggable="false">⟳</button>`;
      if(duplicable) html += `<button type="button" class="page-dup-btn" aria-label="Duplicate page ${i}" draggable="false">⧉</button>`;
      actions.innerHTML = html;
      thumb.appendChild(actions);
    }
    card.appendChild(thumb);

    const label = document.createElement("span");
    label.className = "page-num";
    label.textContent = "Page " + i;
    if(color){ label.style.color = color; label.style.fontWeight = "700"; }
    card.appendChild(label);

    if(mode==="select"){
      const chk = document.createElement("span");
      chk.className = "page-check";
      chk.textContent = "✓";
      card.appendChild(chk);
    } else if(multiSelect){
      // Real checkbox semantics on this dedicated toggle (not the whole
      // card, unlike mode==="select" above) - the card itself is also
      // draggable here (reorder+multiSelect, Split/Organize's case), so
      // role="button" on the whole card would collide with drag-reorder
      // semantics and read ambiguously to a screen reader. tabindex is
      // required since a bare <span> isn't keyboard-reachable by default.
      const chk = document.createElement("span");
      chk.className = "page-check page-check-toggle";
      chk.setAttribute("draggable","false");
      chk.setAttribute("role","checkbox");
      chk.setAttribute("tabindex","0");
      chk.setAttribute("aria-checked","false");
      chk.setAttribute("aria-label","Select page "+i);
      chk.textContent = "✓";
      chk.addEventListener("keydown", e=>{
        if(e.key===" " || e.key==="Enter"){ e.preventDefault(); chk.click(); }
      });
      card.appendChild(chk);
    }
    if(mode==="reorder" && removable){
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "page-remove";
      rm.setAttribute("aria-label", "Remove page "+i);
      rm.setAttribute("draggable","false");
      rm.textContent = "✕";
      card.appendChild(rm);
    }
    wireCard(card);
    cardsWrap.appendChild(card);
    renderObserver.observe(card);
    return card;
  }

  // Phase 7 (see renderCardCanvas comment below): only render a card's
  // canvas once it's actually scrolled near view. Declared before the
  // initial build loop (instead of after, as originally) so appendCard()
  // above can register newly-built cards with it too.
  const renderObserver = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(!entry.isIntersecting) return;
      renderCardCanvas(entry.target);
      renderObserver.unobserve(entry.target);
    });
  }, {root:null, rootMargin:"600px 0px 600px 0px", threshold:0});

  pdocs.forEach((pdoc, docIdx)=>{
    for(let i=1;i<=pdoc.numPages;i++) appendCard(docIdx, i);
  });
  if(mode==="reorder") wirePageGridDrag(cardsWrap);

  if(zoomable){
    toolbar.querySelectorAll(".zoom-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        toolbar.querySelectorAll(".zoom-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        cardsWrap.classList.remove("zoom-s","zoom-m","zoom-l");
        cardsWrap.classList.add("zoom-"+btn.dataset.zoom);
      });
    });
  }

  if(selectionEnabled){
    function keyHandler(e){
      if(!document.body.contains(container)){ document.removeEventListener("keydown", keyHandler); return; }
      const active = document.activeElement;
      if(active && /INPUT|TEXTAREA/.test(active.tagName)) return;
      if((e.key==="Delete"||e.key==="Backspace") && removable){
        const sel = cardsWrap.querySelectorAll(".page-card.selected");
        if(sel.length){ e.preventDefault(); sel.forEach(c=>{ c.classList.add("removing"); setTimeout(()=>c.remove(),160); }); updateBulkBar(); }
      } else if(e.key==="a" && (e.ctrlKey||e.metaKey)){
        e.preventDefault();
        selectAllPages();
      } else if(e.key==="Escape"){
        clearAllSelection();
      } else if(rotatable && (e.key==="r"||e.key==="R")){
        const sel = cardsWrap.querySelectorAll(".page-card.selected");
        if(sel.length) sel.forEach(c=>rotateCard(c, e.shiftKey ? -90 : 90));
      }
    }
    document.addEventListener("keydown", keyHandler);
  }

  return {
    getOrder(){ return [...cardsWrap.querySelectorAll(".page-card")].map(c=>parseInt(c.dataset.page)); },
    getSelected(){ return new Set([...cardsWrap.querySelectorAll(".page-card.selected")].map(c=>parseInt(c.dataset.page))); },
    getPages(){ return [...cardsWrap.querySelectorAll(".page-card")].map(c=>({index:parseInt(c.dataset.page), rotation:parseInt(c.dataset.rotation||"0"), docIndex:parseInt(c.dataset.docIndex||"0")})); },
    getSelectedPages(){ return [...cardsWrap.querySelectorAll(".page-card.selected")].map(c=>({index:parseInt(c.dataset.page), rotation:parseInt(c.dataset.rotation||"0"), docIndex:parseInt(c.dataset.docIndex||"0")})); },
    selectOddEven(which){
      [...cardsWrap.querySelectorAll(".page-card")].forEach((c,pos)=>{
        const isOdd = pos % 2 === 0;
        const on = which==="odd" ? isOdd : !isOdd;
        c.classList.toggle("selected", on);
        syncCheckToggle(c, on);
      });
      updateBulkBar();
    },
    selectAll: selectAllPages,
    clearSelection: clearAllSelection,
    rotateAll(delta){ cardsWrap.querySelectorAll(".page-card").forEach(c=>rotateCard(c, delta)); },
    // Rotate PDF's sidebar "Apply Rotation" button needs this - its own
    // hint text already promises "select several pages and use 'Apply to
    // selected/all' below", but rotateAll() above always rotates
    // EVERYTHING regardless of selection, silently contradicting that
    // promise (confirmed: selecting 3 pages and clicking it rotated the
    // whole document). rotateAll() itself is left alone since Split/
    // Organize's own bulk-bar rotate buttons already correctly scope to
    // selection independently, via this same rotateCard() - this just
    // exposes the equivalent for Rotate's separate sidebar control.
    rotateSelected(delta){ cardsWrap.querySelectorAll(".page-card.selected").forEach(c=>rotateCard(c, delta)); },
    /**
     * Appends another file's pages to the end of the existing grid without
     * disturbing any card already placed/reordered/rotated - the "+ Add
     * more files" case in Organize PDF. Returns the new source's docIndex.
     */
    async addSource(bytes, color){
      const docIdx = pdocs.length;
      const pdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
      pdocs.push(pdoc);
      sources.push({bytes, color});
      for(let i=1;i<=pdoc.numPages;i++) appendCard(docIdx, i);
      return docIdx;
    },
    /** Removes every card belonging to the given docIndex (a file removed from the sidebar list). */
    removeSource(docIdx){
      cardsWrap.querySelectorAll(`.page-card[data-doc-index="${docIdx}"]`).forEach(c=>c.remove());
      updateBulkBar();
    }
  };
}
/**
 * Copies pagesSpec into a fresh PDFDocument, applying each entry's extra
 * rotation on top of whatever rotation the source page already had.
 * Shared by Split/Organize/Rotate so none of them duplicate this copy+
 * rotate logic.
 * @param {import("pdf-lib").PDFDocument} srcDoc - source document.
 * @param {{index: number, rotation: number}[]} pagesSpec - pages to
 *   copy, in output order; `index` may repeat (duplicated pages copy
 *   independently, each with its own `rotation`).
 * @returns {Promise<import("pdf-lib").PDFDocument>}
 */
async function buildPdfFromPages(srcDoc, pagesSpec){
  const newDoc = await PDFDocument.create();
  const order = pagesSpec.map(p=>p.index);
  const pages = await newDoc.copyPages(srcDoc, order);
  pages.forEach((p,pos)=>{
    const rot = pagesSpec[pos].rotation || 0;
    if(rot) p.setRotation(degrees((p.getRotation().angle + rot) % 360));
    newDoc.addPage(p);
  });
  return newDoc;
}
/**
 * Same as buildPdfFromPages(), but for a page grid built from multiple
 * source files (Organize PDF's multi-file mode) - each pagesSpec entry
 * also carries a docIndex saying which of srcDocs it came from, since
 * pdf-lib's copyPages() only copies from one source document at a time.
 * @param {PDFDocument[]} srcDocs
 * @param {{index:number, rotation:number, docIndex:number}[]} pagesSpec
 */
async function buildPdfFromMultiDoc(srcDocs, pagesSpec){
  const newDoc = await PDFDocument.create();
  // Copy in per-source batches (fewer copyPages() calls than one-by-one),
  // then re-assemble in the caller's original order.
  const byDoc = new Map();
  pagesSpec.forEach((spec, pos)=>{
    const docIdx = spec.docIndex || 0;
    if(!byDoc.has(docIdx)) byDoc.set(docIdx, []);
    byDoc.get(docIdx).push({pos, index:spec.index, rotation:spec.rotation||0});
  });
  const copiedByPos = new Array(pagesSpec.length);
  for(const [docIdx, entries] of byDoc){
    const pages = await newDoc.copyPages(srcDocs[docIdx], entries.map(e=>e.index));
    pages.forEach((p,i)=>{
      const rot = entries[i].rotation;
      if(rot) p.setRotation(degrees((p.getRotation().angle + rot) % 360));
      copiedByPos[entries[i].pos] = p;
    });
  }
  copiedByPos.forEach(p=>newDoc.addPage(p));
  return newDoc;
}
/**
 * Greedily packs a document's pages into groups whose saved byte size
 * stays under maxBytes, adding one page at a time and closing the current
 * group as soon as the next page would push it over the limit. A single
 * page that alone exceeds maxBytes is still emitted on its own (nothing
 * smaller is possible) rather than looping forever.
 * @param {PDFDocument} srcDoc
 * @param {number} maxBytes
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<{index:number, rotation:number}[][]>}
 */
/**
 * @param {Map<number,number>} [liveIndexRotation] - optional index->rotation
 *   map from the live page grid (TOOLS.split) - when given, a page whose
 *   original index isn't a key (removed by the user) is skipped entirely,
 *   and its current on-screen rotation is used instead of 0. Omitted by
 *   any other future caller, which then gets the old "every original
 *   page, no rotation" behavior unchanged.
 */
async function splitBySize(srcDoc, maxBytes, onProgress, liveIndexRotation){
  const total = srcDoc.getPageCount();
  const liveIndices = liveIndexRotation
    ? Array.from({length:total}, (_,i)=>i).filter(i=>liveIndexRotation.has(i))
    : Array.from({length:total}, (_,i)=>i);
  const groups = [];
  let current = [];
  for(let k=0;k<liveIndices.length;k++){
    const i = liveIndices[k];
    const rotation = liveIndexRotation ? liveIndexRotation.get(i) : 0;
    const candidate = [...current, {index:i, rotation}];
    const doc = await buildPdfFromPages(srcDoc, candidate);
    const bytes = await doc.save();
    if(bytes.length > maxBytes && current.length > 0){
      groups.push(current);
      current = [{index:i, rotation}];
    } else {
      current = candidate;
    }
    if(onProgress) onProgress(k+1, liveIndices.length);
  }
  if(current.length) groups.push(current);
  return groups;
}
function wirePageGridDrag(container){
  let dragEl = null;
  container.addEventListener("dragstart", e=>{
    const card = e.target.closest(".page-card");
    if(!card) return;
    dragEl = card;
    card.classList.add("dragging");
    if(e.dataTransfer){
      e.dataTransfer.effectAllowed = "move";
      try{ e.dataTransfer.setData("text/plain", card.dataset.page); }catch(_){}
    }
  });
  container.addEventListener("dragend", ()=>{
    if(dragEl) dragEl.classList.remove("dragging");
    container.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over"));
    dragEl = null;
  });
  container.addEventListener("dragover", e=>{
    e.preventDefault();
    const card = e.target.closest(".page-card");
    if(!card || card===dragEl) return;
    container.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over"));
    card.classList.add("drag-over");
  });
  container.addEventListener("drop", e=>{
    e.preventDefault();
    const card = e.target.closest(".page-card");
    if(!card || !dragEl || card===dragEl) return;
    card.classList.remove("drag-over");
    const rect = card.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width/2;
    // card.parentElement, not `container` - identical for every caller
    // except Split's Range/Custom mode, where cards sit nested inside a
    // .range-group-cards wrapper (see regroupSplitPages() in TOOLS.split).
    // insertBefore() requires the reference node to be a direct child of
    // whatever element you call it on, so reordering across two different
    // range groups would throw against the outer `container`; the card's
    // own immediate parent is always correct regardless of nesting depth.
    card.parentElement.insertBefore(dragEl, before ? card : card.nextSibling);
  });
}
/**
 * Drag-to-reorder for Merge PDF's #flist file-card grid (separate from
 * wirePageGridDrag() above, which is hardcoded to .page-card/data-page -
 * this instead reads/writes back the caller's File[] array, since
 * renderFileList() re-renders #flist from scratch on every add/remove and
 * needs the reordered array, not just a rearranged DOM).
 * @param {() => File[]} getFiles - returns the current files array.
 * @param {(reordered: File[]) => void} onReorder - called with the new
 *   order once a drag completes, so the caller can refresh() from it.
 * @returns {{rewire(): void}} rewire() is a no-op - listeners are wired
 *   once via delegation on the (never-replaced) #flist container itself.
 */
function wireFileCardDrag(getFiles, onReorder){
  const flist = document.getElementById("flist");
  flist.querySelectorAll(".file-card").forEach(c=>c.draggable=true);
  let dragEl = null;
  const observer = new MutationObserver(()=>{
    flist.querySelectorAll(".file-card").forEach(c=>c.draggable=true);
  });
  observer.observe(flist, {childList:true});
  flist.addEventListener("dragstart", e=>{
    const card = e.target.closest(".file-card");
    if(!card) return;
    dragEl = card;
    card.classList.add("dragging");
    if(e.dataTransfer){
      e.dataTransfer.effectAllowed = "move";
      try{ e.dataTransfer.setData("text/plain", card.dataset.i); }catch(_){}
    }
  });
  flist.addEventListener("dragend", ()=>{
    if(dragEl) dragEl.classList.remove("dragging");
    flist.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over"));
    if(dragEl){
      const files = getFiles();
      const order = [...flist.querySelectorAll(".file-card")].map(c=>parseInt(c.dataset.i));
      onReorder(order.map(i=>files[i]));
    }
    dragEl = null;
  });
  flist.addEventListener("dragover", e=>{
    e.preventDefault();
    const card = e.target.closest(".file-card");
    if(!card || card===dragEl) return;
    flist.querySelectorAll(".drag-over").forEach(c=>c.classList.remove("drag-over"));
    card.classList.add("drag-over");
  });
  flist.addEventListener("drop", e=>{
    e.preventDefault();
    const card = e.target.closest(".file-card");
    if(!card || !dragEl || card===dragEl) return;
    card.classList.remove("drag-over");
    const rect = card.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width/2;
    flist.insertBefore(dragEl, before ? card : card.nextSibling);
  });
  return { rewire(){} };
}
function canvasToPngBase64(canvas){
  return canvas.toDataURL("image/png").split(",")[1];
}
/**
 * Initial processing-state markup for a tool's #out container: the shared
 * compact horizontal progress bar (see .pdf-progress in index.html),
 * inline in the tool's own workspace - no modal, no overlay, no large
 * centered animation. One component used by every tool via this same
 * pair of functions, so redesigning the loader only ever happens here,
 * never per-tool.
 * Pair with setStatus() to update the same status text/progress as work
 * proceeds, and finish with setStatus(msg, true) to mark it done.
 * @param {string} msg - initial status message.
 * @returns {string} HTML to assign into `#out`.
 */
function statusEl(msg){
  return `<div class="pdf-progress" id="pdfLoader" role="status" aria-live="polite">
    <div class="pdf-progress-head">
      <span class="pdf-progress-title" id="statusLine">${escapeAttr(msg)}</span>
      <span class="pdf-progress-dots" aria-hidden="true"><span></span><span></span><span></span></span>
    </div>
    <div class="pdf-progress-sub" id="pdfLoaderSub">Please wait while we process your file.</div>
    <div class="pdf-progress-track"><div class="pdf-progress-fill indeterminate" id="pdfLoaderFill"></div></div>
    <div class="pdf-progress-pct" id="pdfLoaderPct" hidden></div>
  </div>`;
}
/**
 * Updates the status text/progress statusEl() rendered, in place - the
 * standard progress-reporting call every tool's async handler makes
 * repeatedly while working. Only ever real progress: the fill bar and
 * percentage text only appear when the caller passes an actual number -
 * otherwise the bar stays in its indeterminate sweep instead of inventing
 * a percentage.
 * @param {string} msg - current status message.
 * @param {boolean} [done] - true to render the final done state.
 * @param {number} [percent] - 0-100, real progress only.
 */
function setStatus(msg, done, percent){
  const s = document.getElementById("statusLine");
  if(!s) return;
  const loader = document.getElementById("pdfLoader");
  if(done){
    // Every caller's very next line is out.appendChild(resultBox(...)) -
    // the progress bar must be GONE by then, not left sitting above the
    // result at 100%/green. Previously it only got an .is-done class
    // (still rendered, just static), so success looked like "processing
    // bar frozen at Done, then a second result card appended below it"
    // instead of a clean state swap.
    if(loader) loader.remove();
    return;
  }
  s.textContent = msg;
  const fill = document.getElementById("pdfLoaderFill");
  const pct = document.getElementById("pdfLoaderPct");
  const hasPercent = percent!=null && !isNaN(percent);
  const clamped = hasPercent ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  if(fill){
    if(hasPercent){ fill.classList.remove("indeterminate"); fill.style.width = clamped + "%"; }
    else { fill.classList.add("indeterminate"); fill.style.width = ""; }
  }
  if(pct){
    pct.hidden = !hasPercent;
    if(hasPercent) pct.textContent = clamped + "%";
  }
}
/**
 * Full success screen, matching iLovePDF's post-process page: the input
 * form (dropzone/fields/button) is hidden — not just left visible above
 * the result — and replaced by a prominent download + a "Continue to..."
 * grid of other tools, built from the same QUICK_ACTIONS/QA_LABELS/
 * CATEGORY_META/renderIcon data already used by the Quick Action modal,
 * so it needs no per-tool wiring and covers all 39 tools automatically.
 * @param {object} opts
 * @param {string} opts.sizeText - displayed result size, e.g. "1.2 MB".
 * @param {boolean} opts.sizeGood - true renders the size badge as
 *   "good" (green), false as "bad" (e.g. larger than the original).
 * @param {Node} [opts.previewNode] - optional thumbnail/canvas to show.
 * @param {string} opts.url - object URL from downloadBlob().
 * @param {string} opts.filename - suggested download filename.
 * @param {{id: string, label: string, question: string}} [opts.nextTool]
 *   - optional suggested-next-step call to action shown above the
 *   generic "Continue to..." grid.
 * @returns {HTMLElement} the result box, ready to append into `#out`.
 */
function resultBox({sizeText, sizeGood, previewNode, url, filename}){
  const body = document.querySelector(".panel-body");
  const out = document.getElementById("out");
  if(body){
    [...body.children].forEach(el=>{ if(el!==out) el.classList.add("hidden"); });
    body.classList.add("has-file");
  }

  const continueIds = QUICK_ACTIONS.map(q=>q.id).filter(id=>id!==window.__currentToolId && TOOLS[id]).slice(0,6);
  const continueHtml = continueIds.map(id=>{
    const qa = QUICK_ACTIONS.find(q=>q.id===id);
    const color = (CATEGORY_META[qa && qa.cat] && CATEGORY_META[qa.cat].color) || "#112B5C";
    return `<button type="button" class="continue-card" data-continue-tool="${id}">
      ${renderIcon(id, color)}
      <span class="continue-name">${QA_LABELS[id] || id}</span>
    </button>`;
  }).join("");

  const box = document.createElement("div");
  box.className="result-box result-success";
  box.innerHTML = `
    <div class="result-head">
      <button type="button" class="result-back" aria-label="Start over">←</button>
      <h3>✅ All done!</h3>
    </div>
    <div>Result size: <span class="size-badge ${sizeGood?'good':'bad'} mono">${sizeText}</span></div>`;
  if(previewNode){ const wrap=document.createElement("div"); wrap.className="thumbs"; wrap.appendChild(previewNode); box.appendChild(wrap); }
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.className="dl-link dl-link-primary"; a.textContent = "⬇ Download " + filename;
  box.appendChild(a);
  const shareRow = document.createElement("div");
  shareRow.className = "result-share";
  shareRow.innerHTML = `
    <span class="result-share-label">❤️ Enjoyed this? Spread the word!</span>
    <span class="result-share-btns">
      <button type="button" class="share-btn sm whatsapp" onclick="shareOn('whatsapp')" title="Share on WhatsApp" aria-label="Share on WhatsApp">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.29-1.39a9.9 9.9 0 0 0 4.75 1.21h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2zm0 18.02h-.01a8.13 8.13 0 0 1-4.14-1.13l-.3-.18-3.08.81.82-3-.2-.31a8.1 8.1 0 0 1-1.25-4.3c0-4.48 3.65-8.12 8.14-8.12 2.17 0 4.21.85 5.75 2.38a8.06 8.06 0 0 1 2.38 5.75c0 4.48-3.65 8.1-8.11 8.1zm4.45-6.07c-.24-.12-1.44-.71-1.66-.79-.22-.08-.39-.12-.55.12-.16.24-.63.79-.78.95-.14.16-.29.18-.53.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.35-1.67-.14-.24-.02-.37.11-.49.11-.11.24-.29.36-.43.12-.15.16-.25.24-.41.08-.16.04-.31-.02-.43-.06-.12-.55-1.32-.75-1.81-.2-.48-.4-.41-.55-.42h-.47c-.16 0-.43.06-.65.31-.22.24-.86.84-.86 2.05s.88 2.38 1 2.54c.12.16 1.73 2.64 4.2 3.7.59.25 1.05.4 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28z"/></svg>
      </button>
      <button type="button" class="share-btn sm facebook" onclick="shareOn('facebook')" title="Share on Facebook" aria-label="Share on Facebook">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.91h-2.34V22c4.78-.79 8.44-4.94 8.44-9.94z"/></svg>
      </button>
      <button type="button" class="share-btn sm x" onclick="shareOn('x')" title="Share on X" aria-label="Share on X">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.9l-5.4-7.1L4.7 22H1.6l8.1-9.3L1 2h7l4.9 6.5L18.9 2zm-1.2 18h1.9L7.4 4H5.4l12.3 16z"/></svg>
      </button>
    </span>`;
  box.appendChild(shareRow);
  if(continueHtml){
    const section = document.createElement("div");
    section.className = "continue-section";
    section.innerHTML = `<div class="continue-label">Continue to...</div><div class="continue-grid">${continueHtml}</div>`;
    box.appendChild(section);
  }
  box.querySelector(".result-back").addEventListener("click", ()=>{ const id=window.__currentToolId; closePanel(true); openTool(id); });
  box.querySelectorAll("[data-continue-tool]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ closePanel(true); openTool(btn.dataset.continueTool); });
  });
  return box;
}

/* ================= TOOL IMPLEMENTATIONS ================= */
const TOOLS = {};

/* ---- ABOUT ---- */
TOOLS.about = function(){
  openPanel(`
    <div class="panel-head"><h3>About YOYOPDF</h3><div class="panel-head-actions"><button class="panel-close" onclick="closePanel()" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">YOYOPDF is a free, browser-based PDF toolkit — merge, split, compress, convert, sign, and more, all without installing anything or creating an account.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">Every tool runs entirely on your own device using client-side JavaScript. Your files are never uploaded to a server, which means they stay private and the tools keep working even if you lose your connection mid-task.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">Have a feature request or found a bug? Use the Contact link in the footer.</p>
    </div>`);
};

/* ---- EDIT ----------------------------------------------------------------
   Priority 3 (small milestone): mounts the existing editor shell — built
   and QA'd in editor-preview.html, files unchanged here — inside the live
   TOOLS.edit panel. Reuses, unmodified:
     js/editor/render-engine.js, render-queue.js, page-cache.js,
     zoom-manager.js, loading-manager.js, viewport-manager.js,
     thumbnail-engine.js, navigation-manager.js  (Rendering Engine,
       already integrated as of Priority 2)
     js/editor/editor-layout.js, editor-sidebar.js, editor-toolbar.js,
     editor-canvas.js, editor-inspector.js, editor-statusbar.js  (Shell —
       new to this milestone)
     css/editor-workspace.css, css/pdf-viewer.css  (Shell CSS — new to
       this milestone, loaded as-is)
   The shell markup below is copied verbatim from editor-preview.html's
   `.editor-shell` block (minus that file's own demo-only harness bar).
   The init sequence below is copied verbatim from editor-preview.html's
   own inline script. No shell module's logic is changed by any of this.

   The shell is built ONCE and kept alive in a detached holding element
   between opens (see editorHoldingArea / closePanel()) rather than
   rebuilt every time the panel opens — several shell modules register
   window-level listeners (NavigationManager's keydown handler,
   EditorLayout's resize handler) with no corresponding teardown, so
   re-running their init() on every open would silently stack duplicate
   listeners. Reusing the same instance keeps exactly one of each,
   satisfying "close/reopen works correctly" without touching those
   modules to add destroy() methods they don't currently have. */
let editorAssetsLoadPromise = null;
function loadEditorAssets(){
  if (editorAssetsLoadPromise) return editorAssetsLoadPromise;

  // ?v=2: same stale-cache issue js/app.js hit earlier (browsers keep
  // serving an old cached copy of an unversioned <link>/<script> src
  // indefinitely, even across page loads, once one visit has cached it) -
  // these editor stylesheets had no cache-busting param at all, so an
  // edit to any of them (like the --font-body fix below) would silently
  // never reach a browser that had already visited once.
  ["css/editor-workspace.css", "css/pdf-viewer.css", "css/editor-panel.css", "css/editor-inspector.css", "css/editor-viewer-polish.css", "css/editor-objects.css"].forEach(href=>{
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href + "?v=2";
    document.head.appendChild(l);
  });

  const files = [
    // Rendering Engine (Priority 2 — unchanged)
    "js/editor/render-engine.js",
    "js/editor/render-queue.js",
    "js/editor/page-cache.js",
    "js/editor/zoom-manager.js",
    "js/editor/loading-manager.js",
    "js/editor/viewport-manager.js",
    "js/editor/thumbnail-engine.js",
    "js/editor/navigation-manager.js",
    // Shell (this milestone)
    "js/editor/editor-layout.js",
    "js/editor/editor-sidebar.js",
    "js/editor/editor-toolbar.js",
    "js/editor/editor-canvas.js",
    "js/editor/editor-inspector.js",
    "js/editor/editor-statusbar.js",
    // Editing engine (Phase 3 — previously referenced everywhere by name
    // but never actually written; see editor-objects.js's own file header)
    "js/editor/editor-objects.js",
    "js/editor/editor-history.js",
    "js/editor/editor-export.js",
  ];
  editorAssetsLoadPromise = files.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  })), Promise.resolve());
  return editorAssetsLoadPromise;
}

/* Builds the shell markup once — identical structure to editor-preview.html's
   `.editor-shell`, so every editor-*.js selector (`.editor-toolbar`,
   `.editor-sidebar`, `.editor-canvas`, `.editor-inspector`, `.editor-statusbar`,
   the two resize handles, the scrim) finds exactly what it already expects. */
function buildEditorShell(){
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="editor-shell" data-state="empty">
      <div class="editor-toolbar" role="toolbar" aria-label="Editor toolbar"></div>
      <div class="editor-body">
        <aside class="editor-sidebar" aria-label="Page thumbnails">
          <div class="editor-sidebar-head">
            <span class="editor-sidebar-head-title">Pages (<span data-page-count>0</span>)</span>
            <button type="button" class="btn-icon" data-collapse-target=".editor-sidebar" aria-label="Collapse page panel">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <div class="editor-thumb-list" role="list" aria-label="Page thumbnail list"></div>
          <div class="editor-thumb-rail" aria-hidden="true"></div>
        </aside>
        <div class="editor-resize-handle" data-resize="sidebar"></div>
        <main class="editor-canvas" data-state="empty" aria-label="Document canvas">
          <div class="editor-canvas-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5" stroke-linejoin="round"/></svg>
            <div>No document open yet.<br>Use File → Open PDF above.</div>
            <div class="editor-canvas-empty-error" data-canvas-empty-error role="alert" hidden></div>
          </div>
          <div class="editor-canvas-loading">
            <span class="spinner" aria-hidden="true"></span>
            <div>Loading document…</div>
          </div>
          <div class="editor-canvas-page" role="img" aria-label="Placeholder document page"></div>
        </main>
        <div class="editor-resize-handle" data-resize="inspector"></div>
        <aside class="editor-inspector" aria-label="Inspector"></aside>
        <div class="editor-scrim"></div>
      </div>
      <footer class="editor-statusbar" role="status" aria-label="Document status">
        <span class="editor-statusbar-item" data-status="zoom">Zoom: 100%</span>
        <span class="editor-statusbar-item" data-status="page">No document</span>
        <span class="editor-statusbar-item" data-status="size" data-optional="true">No document</span>
        <span class="editor-statusbar-item" data-status="selection" data-optional="true">No selection</span>
        <span class="editor-statusbar-spacer"></span>
        <span class="editor-statusbar-item editor-statusbar-ready"><span class="editor-statusbar-dot" aria-hidden="true"></span>Ready</span>
      </footer>
    </div>`;
  return wrap.firstElementChild;
}

/* Same init sequence as editor-preview.html's own harness script — every
   call below is that file's, unchanged; only the DOM root differs. */
function initEditorShell(shell){
  const canvasEl = shell.querySelector('.editor-canvas');

  ZoomManager.init(
    () => { const r = canvasEl.getBoundingClientRect(); return { width: r.width, height: r.height }; },
    () => window.__currentPageNativeSize || { width: 612, height: 792 }
  );
  ViewportManager.init(shell);
  LoadingManager.init(shell);
  // EditorObjects before NavigationManager: both register a `window`
  // keydown listener for Escape, and listeners on the same target fire
  // in registration order. EditorObjects needs to see Escape first so it
  // can stopPropagation() when it cancels a pending object placement -
  // otherwise NavigationManager's own (correct, by design) "Escape closes
  // the whole workspace" handler fires first and closes the editor out
  // from under an in-progress placement instead of just canceling it.
  EditorObjects.init(shell);
  NavigationManager.init(shell, { getPageCount: () => window.RenderEngine.getNumPages() });

  EditorToolbar.init(shell);
  EditorInspector.init(shell);
  EditorCanvas.init(shell);
  EditorStatusbar.init(shell);
  EditorLayout.init(shell);
  EditorHistory.init();
  EditorExport.init();

  window.addEventListener('editor:pageChange', async (e) => {
    try { window.__currentPageNativeSize = await window.RenderEngine.getPageInfo(e.detail.page); } catch (_) {}
  });

  // Not part of the reused shell modules — this milestone's own, minimal
  // addition, since the shell is normally hosted full-page with no host
  // chrome around it and has no close action of its own here. The YOYOPDF
  // logo in the header is the only "go home" affordance across the whole
  // app now, so this only needs its own close action, not a second home
  // button.
  const toolbar = shell.querySelector('.editor-toolbar');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'editor-toolbar-close';
  closeBtn.setAttribute('aria-label', 'Close editor');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', ()=>closePanel());
  toolbar.appendChild(closeBtn);

  // Priority 3G: navigation-manager.js dispatches this on Escape (when no
  // mobile sidebar/inspector overlay is open) — same event-bus pattern as
  // 'editor:requestPanelToggle' already used elsewhere in this shell.
  // initEditorShell() only runs once (see the `!window.__editorShellEl`
  // guard in TOOLS.edit below), so this listener is registered exactly
  // once too — never stacks a duplicate on subsequent opens.
  window.addEventListener('editor:requestClose', closePanel);
}

TOOLS.edit = function(){
  openPanel(`<div class="panel-body" id="editWorkspaceMount"></div>`);
  panel.classList.add("panel-fullscreen");
  overlay.classList.add("panel-fullscreen");

  const mount = document.getElementById("editWorkspaceMount");
  mount.innerHTML = `<p style="margin:0;padding:20px;color:var(--ink-soft);font-size:.9rem">Loading editor…</p>`;

  loadEditorAssets()
    .then(()=>{
      mount.innerHTML = "";
      if (!window.__editorShellEl){
        window.__editorShellEl = buildEditorShell();
        mount.appendChild(window.__editorShellEl);
        initEditorShell(window.__editorShellEl);
      } else {
        mount.appendChild(window.__editorShellEl);
      }
      // No second upload: reuse whatever file AppSession already holds (e.g. from
      // the Hero quick-start) through the editor's own existing loader API.
      if(AppSession.currentFile && window.EditorCanvas && typeof window.EditorCanvas.loadFile === "function"){
        window.EditorCanvas.loadFile(AppSession.currentFile);
      }
    })
    .catch(err=>{
      mount.innerHTML = `<p style="margin:0;padding:20px;color:var(--ink-soft);font-size:.9rem">Could not load the editor: ${(err && err.message) ? err.message : String(err)}</p>`;
    });
};

/* ---- DONATE ---- */
TOOLS.donate = function(){
  const qrSrc = document.querySelector(".donate-qr-wrap img")?.getAttribute("src") || "";
  openPanel(`
    <div class="panel-head"><h3>❤️ Support YOYOPDF</h3><div class="panel-head-actions"><button class="panel-close" onclick="closePanel()" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body donate-modal-body">
      <p class="donate-modal-desc">YOYOPDF runs completely in your browser and all tools are free. If it saves you time, consider supporting development with a small UPI donation.</p>
      <div class="donate-modal-card">
        <div class="donate-modal-qr-wrap">
          <img src="${qrSrc}" alt="Donate QR code" class="donate-modal-qr">
        </div>
        <div class="upi-logos">
          <span class="upi-badge"><span class="dot" style="background:#4285F4"></span>Google Pay</span>
          <span class="upi-badge"><span class="dot" style="background:#5F259F"></span>PhonePe</span>
          <span class="upi-badge"><span class="dot" style="background:#00BAF2"></span>Paytm</span>
          <span class="upi-badge"><span class="dot" style="background:var(--brand-grad)"></span>BHIM UPI</span>
        </div>
        <p class="upi-caption">Scan with any UPI app</p>
      </div>
    </div>`);
};

/* ---- PRIVACY ---- */
TOOLS.privacy = function(){
  openPanel(`
    <div class="panel-head"><h3>Privacy Policy</h3><div class="panel-head-actions"><button class="panel-close" onclick="closePanel()" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6"><strong style="color:var(--ink)">Your files never leave your device.</strong> Every PDF and image tool on YOYOPDF runs in your browser using JavaScript — nothing is uploaded, stored, or transmitted to any server.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">We don't use tracking cookies or sell personal data. The trust badges shown on this site describe how the tools actually work — none of them are counters or visitor trackers. If you use the Contact form, the information you type is sent directly to our email via your own mail client — we don't store it elsewhere.</p>
    </div>`);
};

/* ---- TERMS ---- */
TOOLS.terms = function(){
  openPanel(`
    <div class="panel-head"><h3>Terms of Use</h3><div class="panel-head-actions"><button class="panel-close" onclick="closePanel()" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">YOYOPDF is provided free of charge, "as is," with no warranty of any kind. While every tool is tested, you're responsible for keeping backups of important files before processing them.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">You may use YOYOPDF for personal or commercial work. Please don't attempt to disrupt the service, scrape it at scale, or use it for unlawful purposes.</p>
      <p style="margin:0;color:var(--ink-soft);font-size:.9rem;line-height:1.6">These terms may be updated occasionally as new tools are added. Continued use of the site after changes means you accept the updated terms.</p>
    </div>`);
};

/* ---- CONTACT US ---- */
TOOLS.contact = function(){
  openPanel(`
    <div class="panel-head"><h3>Contact Us</h3><div class="panel-head-actions"><button class="panel-close" onclick="closePanel()" aria-label="Close panel">✕</button></div></div>
    <div class="panel-body">
      <p style="margin:0;color:var(--ink-soft);font-size:.88rem">Got a question, bug report, or idea for a new tool? Send it over — this opens your email app with everything filled in, addressed straight to us.</p>
      <div class="row">
        <div class="field"><label>First name</label><input type="text" id="cFirst"></div>
        <div class="field"><label>Last name</label><input type="text" id="cLast"></div>
      </div>
      <div class="field"><label>Your email</label><input type="text" id="cEmail" placeholder="you@example.com"></div>
      <div class="field"><label>Message</label><textarea id="cMessage" placeholder="How can we help?"></textarea></div>
      <button class="btn" id="go">Send Message</button>
      <div id="out"></div>
    </div>`);
  document.getElementById("go").addEventListener("click", ()=>{
    const first = document.getElementById("cFirst").value.trim();
    const last = document.getElementById("cLast").value.trim();
    const email = document.getElementById("cEmail").value.trim();
    const message = document.getElementById("cMessage").value.trim();
    if(!message){ toast("Please write a message first"); return; }
    const subject = encodeURIComponent(`YOYOPDF contact form — ${first} ${last}`.trim());
    const body = encodeURIComponent(`Name: ${first} ${last}\nEmail: ${email}\n\n${message}`);
    window.location.href = `mailto:ca.ravimishra5@gmail.com?subject=${subject}&body=${body}`;
    const out = document.getElementById("out");
    out.innerHTML = `<div class="status">Your email app should now open with this message ready to send. If nothing opened, you can email us directly at <strong>ca.ravimishra5@gmail.com</strong>.</div>`;
  });
};

/* ---- MERGE ---- */
TOOLS.merge = function(){
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>Merge PDF</h3></div>
    <div class="panel-body compact tool-workspace merge-workspace" id="mergeBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Merge PDF files</h2>
        <p class="tool-hero-desc">Combine PDFs in the order you want with the easiest PDF merger available.</p>
      </div>
      <div class="tool-upload-wrap workspace-host" id="mergeUploadWrap">
        ${fileInputHTML("application/pdf", true, "Select PDF files")}
        <div class="workspace-action-stack" id="mergeFileToolbar" style="display:none">
          <button type="button" class="workspace-action-btn workspace-action-primary" id="mergeAddFab" aria-label="Add more files" data-tip="Add more files">
            +<span class="workspace-action-badge" id="mergeFileCount" hidden></span>
          </button>
          <button type="button" class="workspace-action-btn" id="mergeSortBtn" aria-label="Sort files alphabetically" data-tip="Sort files alphabetically">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h6M3 12h9M3 18h12"/></svg>
          </button>
        </div>
      </div>
      <div class="tool-content-area merge-info-tip">
        <span class="tip-icon" aria-hidden="true">ℹ️</span><span>To change the order of your PDFs, drag and drop the files as you want.</span>
      </div>
      <div class="tool-toolbar" id="mergeToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>Merge PDFs <span aria-hidden="true">&rarr;</span></button>
      </div>
      <div id="out"></div>
    </div>`);
  const flistDrag = wireFileCardDrag(()=>files, reordered=>{ files = reordered; refresh(); });
  const refresh = ()=>{
    renderFileList(files, i=>{files.splice(i,1); refresh();});
    document.querySelectorAll("#flist .file-card").forEach((card,i)=>{
      let badge = card.querySelector(".file-card-order");
      if(!badge){ badge = document.createElement("span"); badge.className="file-card-order"; card.prepend(badge); }
      badge.textContent = i+1;
    });
    flistDrag.rewire();
    document.getElementById("go").disabled = files.length<2;
    document.getElementById("mergeToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("mergeFileToolbar").style.display = files.length ? "flex" : "none";
    const countBadge = document.getElementById("mergeFileCount");
    if(files.length){ countBadge.hidden=false; countBadge.textContent = files.length; } else countBadge.hidden = true;
    document.getElementById("mergeBody").classList.toggle("is-loaded", files.length>0);
  };
  document.getElementById("mergeSortBtn").addEventListener("click", ()=>{
    files = [...files].sort((a,b)=>a.name.localeCompare(b.name));
    refresh();
  });
  document.getElementById("mergeAddFab").addEventListener("click", ()=>document.getElementById("fi").click());
  wireDropzone(fs=>{ files = files.concat(fs.filter(f=>f.type==="application/pdf"||f.name.endsWith(".pdf"))); refresh(); });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl("Merging...");
    const merged = await PDFDocument.create();
    for(const f of files){
      const bytes = await f.arrayBuffer();
      const src = await loadPdfSafe(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p=>merged.addPage(p));
    }
    const bytes = await merged.save();
    const blob = new Blob([bytes], {type:"application/pdf"});
    const {url} = downloadBlob(blob, "merged.pdf");
    const {canvas} = await pdfThumb(bytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:"merged.pdf", nextTool:{id:"compress", label:"Compress PDF", question:"Need to reduce the merged file's size?"}}));
  });
};

/* ---- SPLIT ---- */
TOOLS.split = function(){
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Split PDF</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="splitBody">
      <div class="tool-hero" id="splitHero">
        <h2 class="tool-hero-title">Split PDF</h2>
        <p class="tool-hero-desc">Separate a PDF into multiple files by page range, or break every page out into its own file.</p>
      </div>
      <div class="tool-upload-wrap" id="splitUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <div class="tool-app-workspace" id="splitWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Drag to reorder, hover a page to rotate or remove it, or click pages to select which ones go into one file.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <div id="splitFileSlot"></div>
          <div class="mode-tabs" role="tablist" aria-label="Split mode">
            <button type="button" class="mode-tab active" data-mode="range" role="tab" aria-selected="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4zM14 14h6v6h-6z"/><path d="M10 7h4M17 10v4M7 17h4"/></svg>
              Range
            </button>
            <button type="button" class="mode-tab" data-mode="pages" role="tab" aria-selected="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l3 3v15H6z"/><path d="M6 9h6M6 13h6M6 17h6"/></svg>
              Pages
            </button>
            <button type="button" class="mode-tab" data-mode="size" role="tab" aria-selected="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg>
              Size
            </button>
          </div>
          <div class="mode-panel" data-mode-panel="range">
            <div class="mode-seg" role="tablist" aria-label="Range mode">
              <button type="button" class="mode-seg-btn active" data-rangemode="custom" role="tab" aria-selected="true">Custom</button>
              <button type="button" class="mode-seg-btn" data-rangemode="fixed" role="tab" aria-selected="false">Fixed</button>
              <button type="button" class="mode-seg-btn" data-rangemode="smart" role="tab" aria-selected="false">Smart</button>
            </div>
            <div data-rangemode-panel="custom">
              <div class="range-rows" id="customRangesList"></div>
              <button type="button" class="add-range-btn" id="addRangeBtn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
                Add Range
              </button>
              <label class="checkbox-row"><input type="checkbox" id="mergeRangesChk"> Merge all ranges in one PDF file.</label>
            </div>
            <div data-rangemode-panel="fixed" hidden>
              <div class="field"><label for="splitEveryN">Split every</label>
                <div class="row"><input type="number" id="splitEveryN" min="1" value="1"><span style="align-self:center;color:var(--ink-soft);font-size:.85rem;white-space:nowrap">page(s) per file</span></div>
              </div>
            </div>
            <div data-rangemode-panel="smart" hidden>
              <p class="mode-info">Detects mostly-blank separator pages and splits your PDF into one file per section — the blank separator pages themselves are dropped from the output.</p>
              <div class="mode-info" id="smartSplitStatus" hidden></div>
              <div class="row" id="quickSelectRow" style="margin-top:8px">
                <button type="button" class="btn secondary btn-sm" id="selOdd">Odd pages</button>
                <button type="button" class="btn secondary btn-sm" id="selEven">Even pages</button>
                <button type="button" class="btn secondary btn-sm" id="selClear">Clear</button>
              </div>
            </div>
          </div>
          <div class="mode-panel" data-mode-panel="pages" hidden>
            <div class="mode-seg" role="tablist" aria-label="Extract mode">
              <button type="button" class="mode-seg-btn" data-extractmode="all" role="tab" aria-selected="false">Extract all pages</button>
              <button type="button" class="mode-seg-btn active" data-extractmode="select" role="tab" aria-selected="true">Select pages</button>
            </div>
            <div data-extractmode-panel="all" hidden>
              <p class="mode-info">Every page in this PDF will be extracted.</p>
            </div>
            <div data-extractmode-panel="select">
              <div class="field"><label for="pagesToExtract">Pages to extract</label><input type="text" id="pagesToExtract" placeholder="e.g. 1,5-8"></div>
              <div class="mode-info" id="pagesSelectedCount">Click pages in the workspace, or type page numbers above.</div>
            </div>
            <label class="checkbox-row"><input type="checkbox" id="mergeExtractedChk"> Merge extracted pages into one PDF file.</label>
          </div>
          <div class="mode-panel" data-mode-panel="size" hidden>
            <div class="size-info-box" id="sizeInfoBox"></div>
            <div class="field"><label for="splitMaxSize">Maximum size per file</label>
              <div class="row">
                <input type="number" id="splitMaxSize" min="1" value="1" step="0.1">
                <select id="splitMaxSizeUnit"><option value="KB">KB</option><option value="MB" selected>MB</option></select>
              </div>
            </div>
            <p class="mode-info">Pages are packed together in order, starting a new file whenever the next page would push it over this limit.</p>
          </div>
          <div class="split-error" id="splitError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">Split PDF</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("splitHero");
  const uploadWrap = document.getElementById("splitUploadWrap");
  const workspace = document.getElementById("splitWorkspace");
  const fileSlot = document.getElementById("splitFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("splitBody");
  const goBtn = document.getElementById("go");
  const errorBox = document.getElementById("splitError");

  let totalPages = 0;
  let customRanges = [{from:1, to:1}];

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden = false; }
    else { errorBox.hidden = true; errorBox.innerHTML = ""; }
  }

  wireDropzone(async fs=>{
    // Guards the two awaits below: if a newer file is picked (or this one
    // removed) while file.arrayBuffer()/buildPageGrid() for THIS one is
    // still in flight, this run's token goes stale and it stops touching
    // shared state/DOM instead of clobbering whatever the newer pick
    // already rendered. Same pattern as Fill PDF Form's loadToken.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; gridApi=null; totalPages=0;
      document.getElementById("pageGrid").innerHTML="";
      gridHint.style.display="none";
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"reorder", removable:true, rotatable:true, multiSelect:true, zoomable:true});
    if(myToken !== loadToken) return;
    gridApi = builtGridApi;
    totalPages = gridApi.getPages().length;
    customRanges = [{from:1, to:totalPages}];
    // Regroups by original page number after any drag - group membership
    // (like the range logic itself) is defined by page number, not by
    // wherever a card currently sits on screen, so a card dropped across
    // a group boundary snaps back to its rightful group instead of the
    // grouping UI silently disagreeing with what Split will actually do.
    document.getElementById("pageGrid").addEventListener("dragend", ()=>{
      if(splitMode==="range" && rangeMode==="custom") regroupSplitPages();
    });
    renderCustomRanges();
    document.getElementById("sizeInfoBox").innerHTML =
      `<span><strong>Original file size:</strong> ${fmtSize(file.size)}</span><span><strong>Total pages:</strong> ${totalPages}</span>`;
    showWorkspace();
    validate();
  });

  // ---- Range / Custom: structured from-to rows ----
  function renderCustomRanges(){
    const list = document.getElementById("customRangesList");
    list.innerHTML = customRanges.map((r,i)=>{
      const invalid = !(r.from>=1 && r.to>=r.from && r.to<=totalPages);
      return `<div class="range-row${invalid?' invalid':''}" data-i="${i}">
        <div class="range-row-head">
          <span class="range-row-label">Range ${i+1}</span>
          ${customRanges.length>1 ? `<button type="button" class="range-row-remove" data-i="${i}" aria-label="Remove range ${i+1}">✕</button>` : ""}
        </div>
        <div class="range-row-fields">
          <div class="range-field"><label for="rangeFrom${i}">from page</label><input type="number" id="rangeFrom${i}" class="range-from" data-i="${i}" min="1" max="${totalPages}" value="${r.from}"></div>
          <div class="range-field"><label for="rangeTo${i}">to</label><input type="number" id="rangeTo${i}" class="range-to" data-i="${i}" min="1" max="${totalPages}" value="${r.to}"></div>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll(".range-from").forEach(inp=>inp.addEventListener("input", ()=>{
      customRanges[+inp.dataset.i].from = parseInt(inp.value)||1;
      regroupSplitPages(); validate();
    }));
    list.querySelectorAll(".range-to").forEach(inp=>inp.addEventListener("input", ()=>{
      customRanges[+inp.dataset.i].to = parseInt(inp.value)||1;
      regroupSplitPages(); validate();
    }));
    list.querySelectorAll(".range-row-remove").forEach(btn=>btn.addEventListener("click", ()=>{
      customRanges.splice(+btn.dataset.i, 1);
      renderCustomRanges(); regroupSplitPages(); validate();
    }));
    regroupSplitPages();
  }
  document.getElementById("addRangeBtn").addEventListener("click", ()=>{
    customRanges.push({from:1, to:totalPages||1});
    renderCustomRanges(); validate();
  });

  /* Visually groups the page grid into one dashed, labeled box per
     user-defined Custom range - iLovePDF's own "which pages become which
     output file" grouping - so the workspace reacts to the sidebar instead
     of Range 1/2/3 only existing as sidebar rows with no visible effect on
     the pages themselves. Only .page-card elements already built by
     buildPageGrid() move around (into/out of .range-group wrappers); none
     are cloned or rebuilt, so drag reorder, selection, rotation and
     removal all keep operating on the exact same nodes. Idempotent and
     safe to call from any state - always flattens back to the plain grid
     first, so it never compounds nested wrappers from a previous call. */
  function regroupSplitPages(){
    if(!gridApi) return;
    const cardsWrap = document.querySelector("#pageGrid .page-grid-cards");
    if(!cardsWrap) return;
    const cards = [...cardsWrap.querySelectorAll(".page-card")];
    cards.forEach(c=>cardsWrap.appendChild(c));
    cardsWrap.querySelectorAll(".range-group").forEach(g=>g.remove());
    if(!(splitMode==="range" && rangeMode==="custom")) return;
    const claimed = new Set();
    customRanges.forEach((r,i)=>{
      if(!(r.from>=1 && r.to>=r.from)) return;
      const members = cards.filter(c=>{
        if(claimed.has(c)) return false;
        const pageNum = parseInt(c.dataset.page)+1;
        return pageNum>=r.from && pageNum<=r.to && pageNum<=totalPages;
      });
      if(!members.length) return;
      members.forEach(c=>claimed.add(c));
      const group = document.createElement("div");
      group.className = "range-group";
      const label = document.createElement("span");
      label.className = "range-group-label";
      label.textContent = "Range " + (i+1);
      const cardsBox = document.createElement("div");
      cardsBox.className = "range-group-cards";
      members.forEach(c=>cardsBox.appendChild(c));
      group.append(label, cardsBox);
      cardsWrap.appendChild(group);
    });
    cards.filter(c=>!claimed.has(c)).forEach(c=>cardsWrap.appendChild(c));
  }

  document.getElementById("selOdd").addEventListener("click", ()=>gridApi && gridApi.selectOddEven("odd"));
  document.getElementById("selEven").addEventListener("click", ()=>gridApi && gridApi.selectOddEven("even"));
  document.getElementById("selClear").addEventListener("click", ()=>gridApi && gridApi.clearSelection());

  let splitMode = "range";
  let rangeMode = "custom";
  let extractMode = "select";

  document.querySelectorAll(".mode-tab").forEach(tab=>{
    tab.addEventListener("click", ()=>{
      splitMode = tab.dataset.mode;
      document.querySelectorAll(".mode-tab").forEach(t=>{
        t.classList.toggle("active", t===tab);
        t.setAttribute("aria-selected", t===tab ? "true" : "false");
      });
      document.querySelectorAll("[data-mode-panel]").forEach(p=>{
        p.hidden = p.dataset.modePanel !== splitMode;
      });
      if(gridApi){
        if(splitMode!=="pages") gridApi.clearSelection();
        regroupSplitPages();
      }
      goBtn.textContent = splitMode==="size" ? "Split by Size" : (splitMode==="pages" ? "Extract Pages" : "Split PDF");
      validate();
    });
  });
  document.querySelectorAll('[data-rangemode]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      rangeMode = btn.dataset.rangemode;
      document.querySelectorAll('[data-rangemode]').forEach(b=>{
        b.classList.toggle("active", b===btn);
        b.setAttribute("aria-selected", b===btn ? "true" : "false");
      });
      document.querySelectorAll('[data-rangemode-panel]').forEach(p=>{ p.hidden = p.dataset.rangemodePanel !== rangeMode; });
      regroupSplitPages();
      validate();
    });
  });
  document.querySelectorAll('[data-extractmode]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      extractMode = btn.dataset.extractmode;
      document.querySelectorAll('[data-extractmode]').forEach(b=>{
        b.classList.toggle("active", b===btn);
        b.setAttribute("aria-selected", b===btn ? "true" : "false");
      });
      document.querySelectorAll('[data-extractmode-panel]').forEach(p=>{ p.hidden = p.dataset.extractmodePanel !== extractMode; });
      validate();
    });
  });
  document.getElementById("pagesToExtract").addEventListener("input", validate);
  document.getElementById("splitEveryN").addEventListener("input", validate);
  document.getElementById("splitMaxSize").addEventListener("input", validate);
  document.getElementById("splitMaxSizeUnit").addEventListener("change", validate);
  document.getElementById("mergeRangesChk").addEventListener("change", validate);
  document.getElementById("mergeExtractedChk").addEventListener("change", validate);

  /** Returns {ok, msg} - whether the current mode's configuration is ready to split. */
  function validateConfig(){
    if(!file) return {ok:false, msg:null};
    if(splitMode==="range"){
      if(rangeMode==="custom"){
        for(const r of customRanges){
          if(!(r.from>=1 && r.to>=r.from && r.to<=totalPages)){
            return {ok:false, msg:`Each range needs "from" ≤ "to", both between 1 and ${totalPages}.`};
          }
        }
        return {ok:true};
      }
      if(rangeMode==="fixed"){
        const n = parseInt(document.getElementById("splitEveryN").value);
        if(!Number.isInteger(n) || n<1) return {ok:false, msg:"Enter how many pages should go in each file."};
        return {ok:true};
      }
      // smart - always allowed to try; real validity is decided at split time
      return {ok:true};
    }
    if(splitMode==="pages"){
      if(extractMode==="all") return {ok:true};
      const text = document.getElementById("pagesToExtract").value.trim();
      if(text){
        const parsed = parsePageList(text, totalPages);
        if(!parsed) return {ok:false, msg:`Enter page numbers between 1 and ${totalPages}, e.g. 1,5-8.`};
        return {ok:true};
      }
      const selected = gridApi ? gridApi.getSelectedPages().length : 0;
      if(selected===0) return {ok:false, msg:"Click pages in the workspace, or type page numbers to extract."};
      return {ok:true};
    }
    if(splitMode==="size"){
      const raw = parseFloat(document.getElementById("splitMaxSize").value);
      if(!(raw>0)) return {ok:false, msg:"Enter a maximum size greater than 0."};
      return {ok:true};
    }
    return {ok:true};
  }
  function validate(){
    const {ok, msg} = validateConfig();
    goBtn.disabled = !file || !ok;
    showError(file ? msg : null);
    if(splitMode==="pages" && extractMode==="select" && gridApi){
      const n = gridApi.getSelectedPages().length;
      document.getElementById("pagesSelectedCount").textContent =
        n>0 ? `${n} page${n>1?'s':''} selected in the workspace.` : "Click pages in the workspace, or type page numbers above.";
    }
  }
  // Re-validate whenever the grid selection changes (Pages/Select relies on it).
  document.getElementById("pageGrid").addEventListener("click", ()=>setTimeout(validate, 0));

  /** Real blank-page detection: renders each page small and measures how
   * much of it is non-white. Pages below the threshold are treated as
   * separator sheets - dropped from the output, with runs of non-blank
   * pages between them becoming one file each. */
  async function detectBlankPages(bytes, onProgress){
    const pdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    const blanks = [];
    for(let i=1;i<=pdoc.numPages;i++){
      try{
        const page = await pdoc.getPage(i);
        const vp = page.getViewport({scale:0.25});
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(vp.width));
        canvas.height = Math.max(1, Math.round(vp.height));
        const ctx = canvas.getContext("2d");
        // A page with literally no content stream (a true blank separator
        // sheet) never gets a background paint from pdf.js - the canvas is
        // left at its default fully-transparent black, which would read as
        // "100% inked" to the pixel check below unless painted white first
        // (real PDF pages are opaque white paper; the canvas needs to
        // start that way too).
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await Promise.race([
          page.render({canvasContext:ctx, viewport:vp}).promise,
          new Promise((_, reject)=>setTimeout(()=>reject(new Error("timeout")), 10000))
        ]);
        const {data} = ctx.getImageData(0,0,canvas.width,canvas.height);
        let nonWhite=0;
        for(let p=0;p<data.length;p+=4){
          if(data[p]<245 || data[p+1]<245 || data[p+2]<245) nonWhite++;
        }
        blanks.push((nonWhite/(data.length/4)) < 0.004);
      }catch(e){ blanks.push(false); }
      if(onProgress) onProgress(i, pdoc.numPages);
    }
    return blanks;
  }
  function groupsFromBlanks(blanks){
    const groups = [];
    let current = [];
    blanks.forEach((isBlank, i)=>{
      if(isBlank){
        if(current.length){ groups.push(current); current=[]; }
      } else {
        current.push({index:i, rotation:0});
      }
    });
    if(current.length) groups.push(current);
    return groups;
  }

  goBtn.addEventListener("click", async ()=>{
    const {ok, msg} = validateConfig();
    if(!ok){ showError(msg); return; }
    const out = document.getElementById("out");
    out.innerHTML = statusEl("Splitting...");
    const bytes = await file.arrayBuffer();
    const src = await loadPdfSafe(bytes);
    let groups;
    let mergeOutput = false;

    // The page grid's own hint text promises "hover a page to rotate or
    // remove it" as a real, effective action - but every mode below used
    // to build its output purely from raw index arithmetic against
    // totalPages/customRanges, never once consulting the live grid.
    // Confirmed by testing: rotating a card 90deg, then splitting in
    // Range mode, produced an export with EVERY page at 0deg rotation;
    // removing a card left it in the DOM count at 3 of 4, but the actual
    // downloaded PDF still had all 4 pages. liveIndexRotation is the
    // single source of truth every mode below now filters/maps through -
    // a removed page's original index is simply absent from this map, so
    // every mode drops it the same way; a rotated page's current
    // rotation replaces the old hardcoded 0.
    const liveIndexRotation = new Map();
    gridApi.getPages().forEach(p=>liveIndexRotation.set(p.index, p.rotation));

    if(splitMode==="range" && rangeMode==="fixed"){
      const n = Math.max(1, parseInt(document.getElementById("splitEveryN").value) || 1);
      const liveOrdered = Array.from({length:totalPages}, (_,i)=>i).filter(i=>liveIndexRotation.has(i));
      groups = [];
      for(let i=0;i<liveOrdered.length;i+=n){
        groups.push(liveOrdered.slice(i, i+n).map(index=>({index, rotation:liveIndexRotation.get(index)})));
      }
    } else if(splitMode==="range" && rangeMode==="smart"){
      setStatus("Scanning pages for blank separators...", false, 0);
      const blanks = await detectBlankPages(bytes, (done,total)=>setStatus("Scanning pages for blank separators...", false, Math.round((done/total)*100)));
      groups = groupsFromBlanks(blanks)
        .map(g=>g.filter(p=>liveIndexRotation.has(p.index)).map(p=>({index:p.index, rotation:liveIndexRotation.get(p.index)})))
        .filter(g=>g.length>0);
      if(groups.length===0) groups = [gridApi.getPages()];
      if(!blanks.some(Boolean)){
        const statusEl2 = document.getElementById("smartSplitStatus");
        statusEl2.hidden = false;
        statusEl2.textContent = "No blank separator pages were detected — the whole document will be kept as one file.";
      }
    } else if(splitMode==="range"){ // custom
      groups = customRanges
        .map(r=>Array.from({length:r.to-r.from+1}, (_,i)=>r.from-1+i).filter(index=>liveIndexRotation.has(index)).map(index=>({index, rotation:liveIndexRotation.get(index)})))
        .filter(g=>g.length>0);
      mergeOutput = document.getElementById("mergeRangesChk").checked;
    } else if(splitMode==="size"){
      const rawSize = parseFloat(document.getElementById("splitMaxSize").value) || 1;
      const unit = document.getElementById("splitMaxSizeUnit").value;
      const maxBytes = Math.round(rawSize * (unit==="MB" ? 1024*1024 : 1024));
      setStatus("Packing pages by size...", false, 0);
      groups = await splitBySize(src, maxBytes, (done,total)=>setStatus("Packing pages by size...", false, Math.round((done/total)*100)), liveIndexRotation);
    } else { // pages
      let pageIndices;
      if(extractMode==="all"){
        pageIndices = Array.from({length:totalPages}, (_,i)=>i).filter(i=>liveIndexRotation.has(i));
      } else {
        const text = document.getElementById("pagesToExtract").value.trim();
        // A typed list keeps ascending numeric order (that's what typing
        // "1,5-8" means); a click-to-select extraction instead follows
        // the grid's own current on-screen order - previously force-
        // sorted back to original page order, silently discarding
        // exactly the drag-to-reorder the hint text advertises. Either
        // way, a page removed from the grid is excluded even if it was
        // explicitly typed, for the same "removal always means removed"
        // consistency as every other mode above.
        pageIndices = text
          ? parsePageList(text, totalPages).filter(i=>liveIndexRotation.has(i))
          : gridApi.getSelectedPages().map(p=>p.index);
      }
      mergeOutput = document.getElementById("mergeExtractedChk").checked;
      groups = mergeOutput
        ? [pageIndices.map(index=>({index, rotation:liveIndexRotation.get(index) ?? 0}))]
        : pageIndices.map(index=>[{index, rotation:liveIndexRotation.get(index) ?? 0}]);
    }
    if(mergeOutput && groups.length>1){
      groups = [groups.flat()];
    }
    if(!groups || groups.length===0 || groups.some(g=>g.length===0)){
      toast("Nothing to split — check your ranges or page selection");
      out.innerHTML="";
      return;
    }
    setStatus("Splitting...", false, 0);
    if(groups.length===1){
      const doc = await buildPdfFromPages(src, groups[0]);
      const b = await doc.save();
      const blob = new Blob([b], {type:"application/pdf"});
      const outName = suffixedName(file, "split", "pdf");
      const {url} = downloadBlob(blob, outName);
      const {canvas} = await pdfThumb(b);
      setStatus("Done", true);
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName, nextTool:{id:"organize", label:"Organize PDF", question:"Need to organize the remaining pages?"}}));
    } else {
      await ensureJSZip();
      const zip = new JSZip();
      for(let i=0;i<groups.length;i++){
        setStatus("Splitting...", false, Math.round((i/groups.length)*100));
        const doc = await buildPdfFromPages(src, groups[i]);
        const b = await doc.save();
        zip.file(`part_${i+1}.pdf`, b);
      }
      const zipBlob = await zip.generateAsync({type:"blob"});
      const outName = suffixedName(file, "split_parts", "zip");
      const {url} = downloadBlob(zipBlob, outName);
      setStatus("Done — "+groups.length+" files", true);
      out.appendChild(resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName, nextTool:{id:"organize", label:"Organize PDF", question:"Need to organize the remaining pages?"}}));
    }
  });
};

/* ---- COMPRESS (asks exact KB target) ---- */
TOOLS.compress = function(){
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>Compress PDF</h3></div>
    <div class="panel-body compact tool-workspace compress-workspace" id="compressBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Compress PDF</h2>
        <p class="tool-hero-desc">Reduce PDF file size while keeping quality as high as possible.</p>
      </div>
      <div class="tool-upload-wrap workspace-host" id="compressUploadWrap">
        ${fileInputHTML("application/pdf", true, "Select PDF files")}
        <div class="workspace-action-stack" id="compressFileToolbar" style="display:none">
          <button type="button" class="workspace-action-btn workspace-action-primary" id="compressAddFab" aria-label="Add more files" title="Add more files">
            +<span class="workspace-action-badge" id="compressFileCount" hidden></span>
          </button>
        </div>
      </div>
      <div class="tool-content-area tool-content-area--flat" id="compressOptions" style="display:none">
        <label class="tool-content-area-label">Compression level</label>
        <div class="level-picker" id="compressLevelPicker" role="radiogroup" aria-label="Compression level">
          <button type="button" class="level-row" data-preset="max" role="radio" aria-checked="false">
            <span class="level-row-text"><span class="level-row-title">Extreme Compression</span><span class="level-row-desc">Less quality, high compression</span></span>
            <span class="level-row-check">✓</span>
          </button>
          <button type="button" class="level-row active" data-preset="recommended" role="radio" aria-checked="true">
            <span class="level-row-text"><span class="level-row-title">Recommended Compression</span><span class="level-row-desc">Good quality, good compression</span></span>
            <span class="level-row-check">✓</span>
          </button>
          <button type="button" class="level-row" data-preset="high" role="radio" aria-checked="false">
            <span class="level-row-text"><span class="level-row-title">Less Compression</span><span class="level-row-desc">High quality, less compression</span></span>
            <span class="level-row-check">✓</span>
          </button>
          <button type="button" class="level-row" data-preset="custom" role="radio" aria-checked="false">
            <span class="level-row-text"><span class="level-row-title">Custom</span><span class="level-row-desc">Set your target PDF size</span></span>
            <span class="level-row-check">✓</span>
          </button>
        </div>
        <div id="customSizePanel" hidden>
          <div class="field"><label for="customTargetKB">Target file size</label>
            <div class="row"><input type="number" id="customTargetKB" min="1" step="1" placeholder="e.g. 500"><span style="align-self:center;color:var(--ink-soft);font-size:.85rem;">KB</span></div>
          </div>
          <p class="mode-info">Try to compress the PDF to approximately this size. Exact sizes can't always be guaranteed — we get as close as possible without destroying image quality.</p>
        </div>
        <div class="split-error" id="compressError" hidden></div>
        <p style="margin:10px 0 0;color:var(--ink-soft);font-size:.78rem;line-height:1.5">Only compresses the images inside your PDF — text stays exactly as sharp as the original at every level.</p>
      </div>
      <div class="tool-toolbar" id="compressToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Compress PDF <span aria-hidden="true">&rarr;</span></button>
      </div>
      <div id="out"></div>
    </div>`);
  let preset = "recommended";
  const customPanel = document.getElementById("customSizePanel");
  const errorBox = document.getElementById("compressError");
  const goBtn = document.getElementById("go");
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function validate(){
    if(files.length===0){ goBtn.disabled = true; return; }
    if(preset==="custom"){
      const raw = document.getElementById("customTargetKB").value;
      const n = parseFloat(raw);
      if(raw.trim()==="" || !(n>0)){
        showError("Enter a target size greater than 0 KB.");
        goBtn.disabled = true;
        return;
      }
    }
    showError(null);
    goBtn.disabled = false;
  }
  document.querySelectorAll("#compressLevelPicker .level-row").forEach(row=>{
    row.addEventListener("click", ()=>{
      preset = row.dataset.preset;
      document.querySelectorAll("#compressLevelPicker .level-row").forEach(r=>{
        r.classList.toggle("active", r===row);
        r.setAttribute("aria-checked", r===row ? "true" : "false");
      });
      customPanel.hidden = preset!=="custom";
      validate();
    });
  });
  document.getElementById("customTargetKB").addEventListener("input", validate);
  const refresh = ()=>{
    renderFileList(files, i=>{ files.splice(i,1); refresh(); });
    document.getElementById("compressOptions").style.display = files.length ? "block" : "none";
    document.getElementById("compressToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("compressFileToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("compressBody").classList.toggle("is-loaded", files.length>0);
    const countBadge = document.getElementById("compressFileCount");
    if(files.length){ countBadge.hidden=false; countBadge.textContent = files.length; } else countBadge.hidden = true;
    validate();
  };
  document.getElementById("compressAddFab").addEventListener("click", ()=>document.getElementById("fi").click());
  wireDropzone(fs=>{
    files = files.concat(fs.filter(f=>f.type==="application/pdf"||f.name.endsWith(".pdf")));
    refresh();
  });
  /** Runs the selected preset/target against one file's bytes, applying the
   * same "never hand back something bigger than the original" safety net
   * every mode already had - shared here so the single- and multi-file
   * paths below both go through identical compression behavior. */
  // Below this, a "successful" compression is not worth showing as one -
  // the size difference is noise, not a meaningful result, so the
  // original is kept and the user is told the PDF was already optimized
  // rather than seeing an inflated-looking "1%  smaller". Target-size
  // mode is exempt: the user explicitly asked for a specific size, so
  // even a small necessary reduction there is the actual point.
  const MIN_MEANINGFUL_SAVINGS_PCT = 4;
  async function compressOne(bytes, onProgress){
    let finalBytes, usedOriginal=false, imagesRecompressed=0, targetMissed=false, alreadyUnderTarget=false, negligibleSavings=false;
    if(preset==="custom"){
      const targetBytes = Math.round(parseFloat(document.getElementById("customTargetKB").value) * 1024);
      const result = await compressToTarget(bytes, targetBytes, onProgress);
      imagesRecompressed = result.imagesRecompressed;
      targetMissed = !result.achieved && !result.alreadyUnderTarget;
      alreadyUnderTarget = !!result.alreadyUnderTarget;
      if(result.bytes.length >= bytes.byteLength){ finalBytes = new Uint8Array(bytes); usedOriginal = true; }
      else finalBytes = result.bytes;
    } else {
      // Per-image progress, not just a spinner - large/image-heavy PDFs
      // previously gave zero feedback during this loop, which was
      // indistinguishable from a hung tab.
      const result = await recompressPdfImages(bytes, preset, onProgress);
      imagesRecompressed = result.imagesRecompressed;
      if(result.bytes.length >= bytes.byteLength){
        finalBytes = new Uint8Array(bytes); usedOriginal = true;
      } else {
        const savedPct = (1 - result.bytes.length/bytes.byteLength) * 100;
        if(savedPct < MIN_MEANINGFUL_SAVINGS_PCT){
          finalBytes = new Uint8Array(bytes); usedOriginal = true; negligibleSavings = true;
        } else {
          finalBytes = result.bytes;
        }
      }
    }
    // Validate before ever calling this a success: reload both the
    // original and the compressed output and require the same page
    // count. A compressed PDF that fails to reload, or silently lost a
    // page, must never be handed to the user as "Done" - fall back to
    // the pristine original instead (the existing "kept the original
    // file" messaging below already covers this path).
    if(!usedOriginal){
      try{
        const [origDoc, newDoc] = await Promise.all([loadPdfSafe(bytes), loadPdfSafe(finalBytes)]);
        if(newDoc.getPageCount() !== origDoc.getPageCount()){
          finalBytes = new Uint8Array(bytes); usedOriginal = true;
        }
      }catch(e){
        finalBytes = new Uint8Array(bytes); usedOriginal = true;
      }
    }
    return {finalBytes, usedOriginal, imagesRecompressed, targetMissed, alreadyUnderTarget, negligibleSavings};
  }
  goBtn.addEventListener("click", async ()=>{
    const out = document.getElementById("out");
    out.innerHTML = statusEl("Analyzing PDF...");
    try {
      if(files.length===1){
        const file = files[0];
        const bytes = await file.arrayBuffer();
        setStatus("Compressing images...", false, 5);
        const onProgress = preset==="custom"
          ? (step,total,size)=> setStatus(`Compressing toward target size... (attempt ${step}/${total}, currently ${fmtSize(size)})`, false, Math.round((step/total)*100))
          : (step,total)=> total>1 && setStatus(`Compressing image ${step} of ${total}...`, false, Math.round((step/total)*90));
        const {finalBytes, usedOriginal, imagesRecompressed, targetMissed, alreadyUnderTarget, negligibleSavings} = await compressOne(bytes, onProgress);
        setStatus("Finalizing...", false, 95);
        const blob = new Blob([finalBytes], {type:"application/pdf"});
        const outName = suffixedName(file, "compressed", "pdf");
        const {url} = downloadBlob(blob, outName);
        const {canvas} = await pdfThumb(finalBytes);
        const savedPct = Math.round((1 - blob.size/bytes.byteLength) * 100);
        if(alreadyUnderTarget){
          setStatus(`This PDF is already smaller than your target size (${fmtSize(bytes.byteLength)}) — no compression was needed.`, true);
        } else if(negligibleSavings){
          setStatus("Your PDF is already well optimized — further compression wouldn't meaningfully reduce its size, so the original quality was preserved.", true);
        } else if(usedOriginal){
          setStatus(imagesRecompressed===0
            ? "No compressible images found in this PDF — kept the original file."
            : "Compressing didn't reduce the size without hurting quality — kept the original file.", true);
        } else if(targetMissed){
          setStatus(`Target size could not be reached without excessive quality loss — created the smallest practical version: ${fmtSize(blob.size)} (target was ${fmtSize(Math.round(parseFloat(document.getElementById("customTargetKB").value)*1024))}).`, true);
        } else {
          setStatus(`Done — ${fmtSize(bytes.byteLength)} → ${fmtSize(blob.size)} (${savedPct}% smaller). Text and document quality preserved.`, true);
        }
        out.appendChild(resultBox({sizeText:`${fmtSize(blob.size)}${usedOriginal?"":` (was ${fmtSize(bytes.byteLength)})`}`, sizeGood:!usedOriginal, previewNode:canvas, url, filename:outName, nextTool:{id:"edit", label:"Edit PDF", question:"Need to change the content before compressing?"}}));
      } else {
        await ensureJSZip();
        const zip = new JSZip();
        let anyMissedTarget = false;
        // Per-file before/after, not just the zip's total size - a batch
        // of 10 PDFs previously only ever showed one opaque zip size, with
        // no way to tell which files actually compressed well (or at all)
        // without opening the zip and comparing manually. Mirrors the
        // single-file path's "X -> Y (Z% smaller)" reporting, per-file.
        const perFileResults = [];
        let totalOriginal = 0, totalCompressed = 0;
        for(let i=0;i<files.length;i++){
          setStatus(`Compressing ${files[i].name}...`, false, Math.round((i/files.length)*100));
          const bytes = await files[i].arrayBuffer();
          const {finalBytes, targetMissed, usedOriginal} = await compressOne(bytes);
          if(targetMissed) anyMissedTarget = true;
          zip.file(suffixedName(files[i], "compressed", "pdf"), finalBytes);
          totalOriginal += bytes.byteLength;
          totalCompressed += finalBytes.length;
          perFileResults.push({name: files[i].name, originalSize: bytes.byteLength, compressedSize: finalBytes.length, usedOriginal});
        }
        const zipBlob = await zip.generateAsync({type:"blob"});
        const outName = "compressed_pdfs.zip";
        const {url} = downloadBlob(zipBlob, outName);
        const totalSavedPct = totalOriginal>0 ? Math.round((1 - totalCompressed/totalOriginal) * 100) : 0;
        setStatus(`Done — ${files.length} files compressed, ${fmtSize(totalOriginal)} → ${fmtSize(totalCompressed)} (${totalSavedPct}% smaller) total${anyMissedTarget ? " (some couldn't fully reach the target size without excessive quality loss)" : ""}`, true);
        const box = resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName});
        const breakdown = document.createElement("div");
        breakdown.className = "compress-batch-breakdown";
        breakdown.innerHTML = perFileResults.map(r=>{
          const pct = r.originalSize>0 ? Math.round((1 - r.compressedSize/r.originalSize) * 100) : 0;
          return `<div class="compress-batch-row">
            <span class="compress-batch-name" title="${escapeAttr(r.name)}">${escapeAttr(r.name)}</span>
            <span class="compress-batch-sizes mono">${r.usedOriginal ? "already optimized" : `${fmtSize(r.originalSize)} → ${fmtSize(r.compressedSize)} (${pct}% smaller)`}</span>
          </div>`;
        }).join("");
        const dlLink = box.querySelector(".dl-link");
        if(dlLink) box.insertBefore(breakdown, dlLink); else box.appendChild(breakdown);
        out.appendChild(box);
      }
    } catch(e) {
      // Encrypted/password-protected input is the one specific, common
      // failure worth naming explicitly (pdf-lib throws EncryptedPDFError
      // for it) - everything else keeps the original generic message
      // rather than guessing at a cause. Either way the user's original
      // file is untouched and still selected, so they can retry or pick
      // a different one.
      const isEncrypted = /encrypt/i.test(e.name||"") || /encrypt/i.test(e.message||"");
      out.innerHTML = `<div class="status" style="color:var(--rose)">${
        isEncrypted
          ? "This PDF is password-protected. Remove the password first, then try compressing again."
          : `Could not compress this PDF (${escapeAttr(e.message)}).`
      }</div>`;
    }
  });
};

/* ---- ROTATE ---- */
TOOLS.rotate = function(){
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Rotate PDF</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="rotateBody">
      <div class="tool-hero" id="rotateHero">
        <h2 class="tool-hero-title">Rotate PDF</h2>
        <p class="tool-hero-desc">Rotate specific pages or the whole document, then download the corrected PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="rotateUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <div class="tool-app-workspace" id="rotateWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Hover any page to rotate it on its own, or select several pages and use "Apply to selected/all" below.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <div id="rotateFileSlot"></div>
          <div class="field"><label>Rotation</label>
            <select id="deg"><option value="90">90° clockwise</option><option value="180">180°</option><option value="270">270° (90° counter-clockwise)</option></select>
          </div>
          <button type="button" class="btn secondary" id="rotAll">Apply Rotation</button>
          <button class="btn tool-toolbar-primary" id="go">Rotate PDF</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("rotateHero");
  const uploadWrap = document.getElementById("rotateUploadWrap");
  const workspace = document.getElementById("rotateWorkspace");
  const fileSlot = document.getElementById("rotateFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("rotateBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard for why: a newer pick (or removal)
    // while this one's arrayBuffer()/buildPageGrid() is still in flight
    // must not let this stale run overwrite it.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; gridApi=null;
      document.getElementById("pageGrid").innerHTML="";
      gridHint.style.display="none";
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"select", rotatable:true, zoomable:true});
    if(myToken !== loadToken) return;
    gridApi = builtGridApi;
    showWorkspace();
  });
  document.getElementById("rotAll").addEventListener("click", ()=>{
    if(!gridApi) return;
    const deg = parseInt(document.getElementById("deg").value);
    // Honor the grid's own selection, matching what the hint text above
    // already promises ("select several pages and use 'Apply to
    // selected/all' below") - rotateAll() unconditionally hits every
    // page regardless of selection, which silently contradicted that
    // promise before this fix.
    if(gridApi.getSelected().size > 0) gridApi.rotateSelected(deg);
    else gridApi.rotateAll(deg);
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Rotating...");
    const bytes=await file.arrayBuffer();
    const src=await loadPdfSafe(bytes);
    const pagesSpec = gridApi.getPages();
    const newDoc = await buildPdfFromPages(src, pagesSpec);
    const outBytes=await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "rotated", "pdf");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done",true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- DELETE PAGES ---- */
TOOLS.deletepages = function(){
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Delete Pages</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="deleteBody">
      <div class="tool-hero" id="deleteHero">
        <h2 class="tool-hero-title">Delete Pages</h2>
        <p class="tool-hero-desc">Select the pages you don't need and remove them from the PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="deleteUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="deletePrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="deleteWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Click the pages you want to delete.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Delete Pages</h3>
          <div id="deleteFileSlot"></div>
          <button class="btn tool-toolbar-primary" id="go">Delete Pages</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("deleteHero");
  const uploadWrap = document.getElementById("deleteUploadWrap");
  const privacyHint = document.getElementById("deletePrivacyHint");
  const workspace = document.getElementById("deleteWorkspace");
  const fileSlot = document.getElementById("deleteFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("deleteBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; file=null; gridApi=null; document.getElementById("pageGrid").innerHTML=""; gridHint.style.display="none"; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"select"});
    if(myToken !== loadToken) return;
    gridApi = builtGridApi;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const del = gridApi.getSelected();
    const keep = doc.getPageIndices().filter(i=>!del.has(i));
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(doc, keep);
    pages.forEach(p=>newDoc.addPage(p));
    const outBytes = await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "pages_removed", "pdf");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done — "+keep.length+" pages remaining", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- EXTRACT PAGES ---- */
TOOLS.extractpages = function(){
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Extract Pages</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="extractBody">
      <div class="tool-hero" id="extractHero">
        <h2 class="tool-hero-title">Extract Pages</h2>
        <p class="tool-hero-desc">Select the pages you want to keep and save them as a new PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="extractUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="extractPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="extractWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Click the pages you want to keep.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Extract Pages</h3>
          <div id="extractFileSlot"></div>
          <button class="btn tool-toolbar-primary" id="go">Extract Pages</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("extractHero");
  const uploadWrap = document.getElementById("extractUploadWrap");
  const privacyHint = document.getElementById("extractPrivacyHint");
  const workspace = document.getElementById("extractWorkspace");
  const fileSlot = document.getElementById("extractFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("extractBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; file=null; gridApi=null; document.getElementById("pageGrid").innerHTML=""; gridHint.style.display="none"; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"select"});
    if(myToken !== loadToken) return;
    gridApi = builtGridApi;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const keep = [...gridApi.getSelected()].sort((a,b)=>a-b);
    if(keep.length===0){ toast("Select at least one page to keep"); out.innerHTML=""; return; }
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(doc, keep);
    pages.forEach(p=>newDoc.addPage(p));
    const outBytes = await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "extracted", "pdf");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- REORDER ---- */
TOOLS.reorder = function(){
  let file=null, gridApi=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Reorder Pages</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="reorderBody">
      <div class="tool-hero" id="reorderHero">
        <h2 class="tool-hero-title">Reorder Pages</h2>
        <p class="tool-hero-desc">Drag pages into the order you want, then download the reordered PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="reorderUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="reorderPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="reorderWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Drag pages into the order you want.</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Reorder Pages</h3>
          <div id="reorderFileSlot"></div>
          <button class="btn tool-toolbar-primary" id="go">Reorder Pages</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("reorderHero");
  const uploadWrap = document.getElementById("reorderUploadWrap");
  const privacyHint = document.getElementById("reorderPrivacyHint");
  const workspace = document.getElementById("reorderWorkspace");
  const fileSlot = document.getElementById("reorderFileSlot");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("reorderBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; file=null; gridApi=null; document.getElementById("pageGrid").innerHTML=""; gridHint.style.display="none"; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    gridHint.style.display="block";
    const builtGridApi = await buildPageGrid(document.getElementById("pageGrid"), bytes, {mode:"reorder"});
    if(myToken !== loadToken) return;
    gridApi = builtGridApi;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const order = gridApi.getOrder();
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(doc, order);
    pages.forEach(p=>newDoc.addPage(p));
    const outBytes = await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "reordered", "pdf");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- ADD BLANK PAGE ---- */
TOOLS.addblank = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Add Blank Page</h3></div>
    <div class="panel-body compact tool-workspace" id="addblankBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Add Blank Page</h2>
        <p class="tool-hero-desc">Insert a blank page anywhere in your PDF.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="addblankToolbar" style="display:none">
        <div class="tool-toolbar-secondary">
          <div class="field" style="margin:0"><label>Position (page number after which to insert, 0 = beginning)</label><input type="number" id="pos" value="0" min="0"></div>
        </div>
        <button class="btn tool-toolbar-primary" id="go">Add Blank Page</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("addblankToolbar").style.display="none"; document.getElementById("addblankBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("addblankToolbar").style.display="flex";
    document.getElementById("addblankBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    setStatus("Adding blank page...");
    const pos = parseInt(document.getElementById("pos").value)||0;
    const ref = doc.getPage(0).getSize();
    doc.insertPage(pos, [ref.width, ref.height]);
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "with_blank", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- PAGE NUMBERS ---- */
/* Builds the actual displayed string for one stamped page - shared by
   the preview and the real export so "Page 3 of 12" in the preview is
   guaranteed to be the same string pdf-lib writes. displayNum already
   has startNumber folded in by the caller (the Nth page actually being
   numbered, not its raw position in the document - front matter before
   the numbering range doesn't shift what "start at 5" means). */
function pageNumberText(format, displayNum, totalPages){
  switch(format){
    case "n": return `${displayNum}`;
    case "page-n": return `Page ${displayNum}`;
    case "page-n-of-total": return `Page ${displayNum} of ${totalPages}`;
    default: return `${displayNum} / ${totalPages}`; // "n-of-total"
  }
}
TOOLS.pagenumbers = function(){
  let file=null, pdoc=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Page Numbers</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="pagenumbersBody">
      <div class="tool-hero" id="pnHero">
        <h2 class="tool-hero-title">Add Page Numbers</h2>
        <p class="tool-hero-desc">Number every page of your PDF, positioned and formatted however you like.</p>
      </div>
      <div class="tool-upload-wrap" id="pnUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="pnPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="pnWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="pnStage">
            <canvas id="pnCanvas"></canvas>
          </div>
          <div class="mono" id="pnReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;">Preview of page 1.</div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Page Numbers</h3>
          <div id="pnFileSlot"></div>
          <div class="field"><label>Position</label>
            <select id="pnpos">
              <option value="bottom-right" selected>Bottom right</option>
              <option value="bottom-center">Bottom center</option>
              <option value="bottom-left">Bottom left</option>
              <option value="top-right">Top right</option>
              <option value="top-center">Top center</option>
              <option value="top-left">Top left</option>
            </select>
          </div>
          <div class="field"><label>Format</label>
            <select id="pnformat">
              <option value="n-of-total" selected>1 / 10</option>
              <option value="n">1</option>
              <option value="page-n">Page 1</option>
              <option value="page-n-of-total">Page 1 of 10</option>
            </select>
          </div>
          <div class="row">
            <div class="field" style="margin:0"><label>Start at</label><input type="number" id="pnstart" value="1" min="1"></div>
            <div class="field" style="margin:0"><label>Font size</label><input type="number" id="pnsize" value="10" min="6" max="24"></div>
          </div>
          <div class="field"><label>Pages (optional)</label><input type="text" id="pnpages" placeholder="e.g. 1,3-5 - leave blank for all pages"></div>
          <div class="split-error" id="pnError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">Add Page Numbers</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("pnHero");
  const uploadWrap = document.getElementById("pnUploadWrap");
  const privacyHint = document.getElementById("pnPrivacyHint");
  const workspace = document.getElementById("pnWorkspace");
  const fileSlot = document.getElementById("pnFileSlot");
  const body = document.getElementById("pagenumbersBody");
  const canvas = document.getElementById("pnCanvas");
  const readout = document.getElementById("pnReadout");
  const errorBox = document.getElementById("pnError");
  const goBtn = document.getElementById("go");
  let dispScale = 1, pageBgImageData = null, page1Size = {width:612,height:792};
  const MARGIN_X = 30, MARGIN_Y = 20;

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function currentSettings(){
    const [vAlign, hAlign] = document.getElementById("pnpos").value.split("-");
    return {
      vAlign, hAlign,
      format: document.getElementById("pnformat").value,
      startNumber: Math.max(1, parseInt(document.getElementById("pnstart").value) || 1),
      fontSize: Math.max(6, parseInt(document.getElementById("pnsize").value) || 10),
    };
  }
  function validate(){
    if(!file){ goBtn.disabled = true; return; }
    const pagesRaw = document.getElementById("pnpages").value.trim();
    if(pagesRaw && pdoc && !parsePageList(pagesRaw, pdoc.numPages)){
      showError(`Enter page numbers between 1 and ${pdoc.numPages}, e.g. 1,3-5.`);
      goBtn.disabled = true;
      return;
    }
    showError(null);
    goBtn.disabled = false;
  }
  function redrawPreview(){
    if(!pageBgImageData) return;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(pageBgImageData, 0, 0);
    const {vAlign, hAlign, format, startNumber, fontSize} = currentSettings();
    // Page 1's own displayed number: startNumber, UNLESS an explicit page
    // range is given and page 1 isn't in it - then show the number it
    // would actually get based on its position among the numbered pages
    // (matches the real export's per-page counting below exactly).
    const pagesRaw = document.getElementById("pnpages").value.trim();
    const totalPages = pdoc ? pdoc.numPages : 1;
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, totalPages) : null;
    let displayNum = startNumber, showOnPage1 = true;
    if(targetIndices){
      const pos = targetIndices.indexOf(0);
      if(pos===-1) showOnPage1 = false; else displayNum = startNumber + pos;
    }
    if(!showOnPage1){ readout.textContent = "Page 1 isn't in the selected range - shown here is where it will NOT appear."; return; }
    readout.textContent = "Preview of page 1.";
    // "of Total" must be the LAST number actually shown, not just a raw
    // page count - with startNumber>1, count alone drifts from what's on
    // the page (start=5 over 5 pages would count up to 9, but a fixed
    // "of 5" would make page 2 read "6 of 5", which is nonsense).
    const numberedCount = targetIndices ? targetIndices.length : totalPages;
    const lastDisplayNum = startNumber + numberedCount - 1;
    const text = pageNumberText(format, displayNum, lastDisplayNum);
    const scaledSize = fontSize * dispScale;
    ctx.font = `${scaledSize}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = "rgb(51,51,51)";
    ctx.textBaseline = "alphabetic";
    const tw = ctx.measureText(text).width / dispScale;
    const x = headerFooterAnchor(hAlign, page1Size.width, tw, MARGIN_X) * dispScale;
    // Same baseline logic as Header & Footer: pdf-lib's y IS the
    // baseline, so canvasY = (pageHeight - pdfBaselineY) * dispScale,
    // which simplifies to MARGIN_Y*dispScale (bottom) or
    // canvas.height - MARGIN_Y*dispScale (top, since pdfY = height-MARGIN_Y there).
    const y = vAlign==="top" ? MARGIN_Y * dispScale : canvas.height - MARGIN_Y * dispScale;
    ctx.fillText(text, x, y);
  }
  ["pnpos","pnformat","pnstart","pnsize"].forEach(id=>{
    document.getElementById(id).addEventListener("input", redrawPreview);
  });
  document.getElementById("pnpages").addEventListener("input", ()=>{ validate(); redrawPreview(); });

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; pdoc=null; pageBgImageData=null;
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    validate();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    const loadedPdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    if(myToken !== loadToken) return;
    pdoc = loadedPdoc;
    const page1 = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    page1Size = {width:vp1.width, height:vp1.height};
    const maxW = 700;
    dispScale = Math.min(1, maxW/vp1.width);
    showWorkspace();
    try{
      const rendered = await renderPdfPageCanvas(pdoc, 1, dispScale);
      if(myToken !== loadToken) return;
      canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext("2d").drawImage(rendered, 0, 0);
      pageBgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
      redrawPreview();
    }catch(e){
      readout.textContent = "Couldn't render a preview, but page numbers will still apply correctly on download.";
    }
    validate();
  });

  goBtn.addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const {vAlign, hAlign, format, startNumber, fontSize} = currentSettings();
    const pagesRaw = document.getElementById("pnpages").value.trim();
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, pages.length) : null;
    // Same "of Total" fix as the preview above - the last number actually
    // reached, not a raw page count that can drift once startNumber>1.
    const numberedCount = targetIndices ? targetIndices.length : pages.length;
    const totalForFormat = startNumber + numberedCount - 1;
    setStatus("Numbering pages...");
    let counter = 0;
    pages.forEach((p,i)=>{
      if(targetIndices && !targetIndices.includes(i)) return;
      const displayNum = startNumber + counter;
      counter++;
      const text = pageNumberText(format, displayNum, totalForFormat);
      const {width, height} = p.getSize();
      const tw = font.widthOfTextAtSize(text, fontSize);
      const x = headerFooterAnchor(hAlign, width, tw, MARGIN_X);
      const y = vAlign==="top" ? height-MARGIN_Y : MARGIN_Y;
      p.drawText(text, {x, y, size:fontSize, font, color:rgb(0.2,0.2,0.2)});
    });
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "numbered", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  });
};

/* ---- WATERMARK ---- */
/* Shared by TOOLS.watermark's live preview canvas AND its real pdf-lib
   export - one formula, not two that could quietly drift apart (the
   previous version had NO preview at all, so this risk didn't exist yet,
   but a preview that used different math than the actual export would
   be worse than no preview - it would show the user something the
   output doesn't match). Returns the text's bottom-left draw anchor in
   PDF-point space (origin bottom-left, y-up), before rotation is
   applied - matches how pdf-lib's own rotate:degrees(...) pivots
   drawText around that same anchor, so a corner placement rotates in
   place exactly the same way on screen and in the exported file. */
/* Shared page-range parser: 1-based comma list + ranges ("1,3-5"),
   returns 0-based indices or null on empty/invalid input. Was duplicated
   locally in Split and Watermark (2 copies, same ~15 lines) - promoted
   here once Header & Footer became the 3rd tool needing it, rather than
   writing a 3rd copy. */
function parsePageList(str, max){
  str = str.trim();
  if(!str) return null;
  const out = [];
  for(const part of str.split(",")){
    const p = part.trim();
    if(!p) continue;
    if(p.includes("-")){
      const [a,b] = p.split("-").map(n=>parseInt(n.trim()));
      if(!Number.isInteger(a) || !Number.isInteger(b) || a<1 || b<a || (max && b>max)) return null;
      for(let i=a;i<=b;i++) out.push(i-1);
    } else {
      const n = parseInt(p);
      if(!Number.isInteger(n) || n<1 || (max && n>max)) return null;
      out.push(n-1);
    }
  }
  return out.length ? out : null;
}
function watermarkAnchor(position, pageWidth, pageHeight, textWidth, fontSize){
  const margin = Math.min(60, pageWidth*0.08, pageHeight*0.08);
  switch(position){
    case "top-left": return {x:margin, y:pageHeight-margin-fontSize};
    case "top-right": return {x:pageWidth-margin-textWidth, y:pageHeight-margin-fontSize};
    case "bottom-left": return {x:margin, y:margin};
    case "bottom-right": return {x:pageWidth-margin-textWidth, y:margin};
    default: return {x:pageWidth/2-textWidth/2, y:pageHeight/2}; // center
  }
}
TOOLS.watermark = function(){
  let file=null, pdoc=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Watermark</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="watermarkBody">
      <div class="tool-hero" id="watermarkHero">
        <h2 class="tool-hero-title">Add Watermark</h2>
        <p class="tool-hero-desc">Stamp text across every page of your PDF - see exactly how it'll look before you download.</p>
      </div>
      <div class="tool-upload-wrap" id="watermarkUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="watermarkPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="watermarkWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="watermarkStage">
            <canvas id="watermarkCanvas"></canvas>
          </div>
          <div class="mono" id="watermarkReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;">Preview of page 1 - every page gets the same watermark.</div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Watermark</h3>
          <div id="watermarkFileSlot"></div>
          <div class="field"><label>Watermark text</label><input type="text" id="wtext" placeholder="e.g. CONFIDENTIAL" value="CONFIDENTIAL"></div>
          <div class="field"><label>Position</label>
            <select id="wposition">
              <option value="center" selected>Center (diagonal)</option>
              <option value="top-left">Top left</option>
              <option value="top-right">Top right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-right">Bottom right</option>
            </select>
          </div>
          <div class="row">
            <div class="field" style="margin:0"><label>Rotation (°)</label><input type="number" id="wrotate" value="45" min="0" max="359" step="5"></div>
            <div class="field" style="margin:0"><label>Opacity</label><input type="number" id="opac" value="0.25" step="0.05" min="0.05" max="1"></div>
          </div>
          <div class="field"><label>Font size</label><input type="number" id="fsize" value="48" min="6" max="200"></div>
          <div class="field"><label>Pages (optional)</label><input type="text" id="wpages" placeholder="e.g. 1,3-5 - leave blank for all pages"></div>
          <div class="split-error" id="watermarkError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">Add Watermark</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("watermarkHero");
  const uploadWrap = document.getElementById("watermarkUploadWrap");
  const privacyHint = document.getElementById("watermarkPrivacyHint");
  const workspace = document.getElementById("watermarkWorkspace");
  const fileSlot = document.getElementById("watermarkFileSlot");
  const body = document.getElementById("watermarkBody");
  const canvas = document.getElementById("watermarkCanvas");
  const readout = document.getElementById("watermarkReadout");
  const errorBox = document.getElementById("watermarkError");
  const goBtn = document.getElementById("go");
  let dispScale = 1, pageBgImageData = null, page1Size = {width:612,height:792};

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function currentSettings(){
    return {
      text: document.getElementById("wtext").value || "WATERMARK",
      position: document.getElementById("wposition").value,
      rotation: parseFloat(document.getElementById("wrotate").value) || 0,
      opacity: Math.max(0.05, Math.min(1, parseFloat(document.getElementById("opac").value) || 0.25)),
      fontSize: Math.max(6, parseInt(document.getElementById("fsize").value) || 48),
    };
  }
  function validate(){
    if(!file){ goBtn.disabled = true; return; }
    const pagesRaw = document.getElementById("wpages").value.trim();
    if(pagesRaw && pdoc && !parsePageList(pagesRaw, pdoc.numPages)){
      showError(`Enter page numbers between 1 and ${pdoc.numPages}, e.g. 1,3-5.`);
      goBtn.disabled = true;
      return;
    }
    showError(null);
    goBtn.disabled = false;
  }
  // Draws the exact same watermark the export will produce, using
  // watermarkAnchor() for position math and a canvas rotate() around
  // that same anchor - the one thing a plain-text config form can't
  // convey on its own is what "45deg, bottom-right, 0.25 opacity" will
  // actually look like on THIS document, so this is the highest-value
  // single addition to this tool (previously: none at all).
  function redrawPreview(){
    if(!pageBgImageData) return;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(pageBgImageData, 0, 0);
    const {text, position, rotation, opacity, fontSize} = currentSettings();
    const safeText = winAnsiSafe(text);
    if(!safeText.trim()) return;
    const scaledSize = fontSize * dispScale;
    ctx.font = `bold ${scaledSize}px Helvetica, Arial, sans-serif`;
    const textWidth = ctx.measureText(safeText).width / dispScale; // back to PDF-point space, matching watermarkAnchor's units
    const anchorPt = watermarkAnchor(position, page1Size.width, page1Size.height, textWidth, fontSize);
    // PDF points (bottom-up) -> canvas px (top-down), then apply the
    // canvas's own displayed scale.
    const ax = anchorPt.x * dispScale;
    const ay = (page1Size.height - anchorPt.y) * dispScale;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = "rgb(128,128,128)";
    ctx.translate(ax, ay);
    ctx.rotate(-rotation * Math.PI/180); // canvas rotates clockwise for +angle; PDF rotates counter-clockwise - negate to match
    ctx.textBaseline = "alphabetic";
    ctx.fillText(safeText, 0, 0);
    ctx.restore();
  }
  ["wtext","wposition","wrotate","opac","fsize"].forEach(id=>{
    document.getElementById(id).addEventListener("input", redrawPreview);
  });
  document.getElementById("wpages").addEventListener("input", validate);

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; pdoc=null; pageBgImageData=null;
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    validate();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    const loadedPdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    if(myToken !== loadToken) return;
    pdoc = loadedPdoc;
    const page1 = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    page1Size = {width:vp1.width, height:vp1.height};
    const maxW = 700;
    dispScale = Math.min(1, maxW/vp1.width);
    showWorkspace();
    try{
      const rendered = await renderPdfPageCanvas(pdoc, 1, dispScale);
      if(myToken !== loadToken) return;
      canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext("2d").drawImage(rendered, 0, 0);
      pageBgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
      redrawPreview();
    }catch(e){
      readout.textContent = "Couldn't render a preview, but the watermark will still apply correctly on download.";
    }
    validate();
  });

  goBtn.addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const {text, position, rotation, opacity, fontSize} = currentSettings();
    const safeText = winAnsiSafe(text);
    const pagesRaw = document.getElementById("wpages").value.trim();
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, doc.getPageCount()) : null;
    setStatus("Adding watermark...");
    const tw = font.widthOfTextAtSize(safeText, fontSize);
    doc.getPages().forEach((p,i)=>{
      if(targetIndices && !targetIndices.includes(i)) return;
      const {width,height} = p.getSize();
      const anchor = watermarkAnchor(position, width, height, tw, fontSize);
      p.drawText(safeText, {x:anchor.x, y:anchor.y, size:fontSize, font, color:rgb(0.5,0.5,0.5), opacity, rotate:degrees(rotation)});
    });
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "watermarked", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  });
};

/* ---- HEADER & FOOTER ---- */
/* Shared by the header/footer preview canvas and the real pdf-lib export
   - same reasoning as watermarkAnchor: one formula for the X position so
   a live preview can't quietly show something the export doesn't match.
   marginX/marginY are fixed (not user-configurable - a running header/
   footer conventionally sits in a fixed top/bottom strip; alignment
   within that strip is the actual "Position" control worth exposing). */
function headerFooterAnchor(align, pageWidth, textWidth, marginX=30){
  if(align==="center") return pageWidth/2 - textWidth/2;
  if(align==="right") return pageWidth - marginX - textWidth;
  return marginX;
}
TOOLS.headerfooter = function(){
  let file=null, pdoc=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Header & Footer</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="headerfooterBody">
      <div class="tool-hero" id="hfHero">
        <h2 class="tool-hero-title">Add Header & Footer</h2>
        <p class="tool-hero-desc">Add repeating text to the top and/or bottom of every page - see it before you download.</p>
      </div>
      <div class="tool-upload-wrap" id="hfUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="hfPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="hfWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="hfStage">
            <canvas id="hfCanvas"></canvas>
          </div>
          <div class="mono" id="hfReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;">Preview of page 1 - every page gets the same header/footer.</div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Header & Footer</h3>
          <div id="hfFileSlot"></div>
          <div class="field"><label>Header text (optional)</label><input type="text" id="htext"></div>
          <div class="field"><label>Header alignment</label>
            <select id="halign"><option value="left" selected>Left</option><option value="center">Center</option><option value="right">Right</option></select>
          </div>
          <div class="field"><label>Footer text (optional)</label><input type="text" id="ftext"></div>
          <div class="field"><label>Footer alignment</label>
            <select id="falign"><option value="left" selected>Left</option><option value="center">Center</option><option value="right">Right</option></select>
          </div>
          <div class="field"><label>Font size</label><input type="number" id="hfsize" value="9" min="6" max="24"></div>
          <div class="field"><label>Pages (optional)</label><input type="text" id="hfpages" placeholder="e.g. 1,3-5 - leave blank for all pages"></div>
          <div class="split-error" id="hfError" hidden></div>
          <button class="btn tool-toolbar-primary" id="go">Add Header & Footer</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("hfHero");
  const uploadWrap = document.getElementById("hfUploadWrap");
  const privacyHint = document.getElementById("hfPrivacyHint");
  const workspace = document.getElementById("hfWorkspace");
  const fileSlot = document.getElementById("hfFileSlot");
  const body = document.getElementById("headerfooterBody");
  const canvas = document.getElementById("hfCanvas");
  const readout = document.getElementById("hfReadout");
  const errorBox = document.getElementById("hfError");
  const goBtn = document.getElementById("go");
  let dispScale = 1, pageBgImageData = null, page1Size = {width:612,height:792};
  const MARGIN_X = 30, HEADER_Y_FROM_TOP = 25, FOOTER_Y = 15;

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }
  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function currentSettings(){
    return {
      headerText: document.getElementById("htext").value,
      footerText: document.getElementById("ftext").value,
      headerAlign: document.getElementById("halign").value,
      footerAlign: document.getElementById("falign").value,
      fontSize: Math.max(6, parseInt(document.getElementById("hfsize").value) || 9),
    };
  }
  function validate(){
    if(!file){ goBtn.disabled = true; return; }
    const pagesRaw = document.getElementById("hfpages").value.trim();
    if(pagesRaw && pdoc && !parsePageList(pagesRaw, pdoc.numPages)){
      showError(`Enter page numbers between 1 and ${pdoc.numPages}, e.g. 1,3-5.`);
      goBtn.disabled = true;
      return;
    }
    showError(null);
    goBtn.disabled = false;
  }
  function redrawPreview(){
    if(!pageBgImageData) return;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(pageBgImageData, 0, 0);
    const {headerText, footerText, headerAlign, footerAlign, fontSize} = currentSettings();
    const scaledSize = fontSize * dispScale;
    ctx.font = `${scaledSize}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = "rgb(77,77,77)";
    ctx.textBaseline = "alphabetic";
    // pdf-lib's drawText y is the text BASELINE directly, in PDF points
    // (origin bottom-left, y-up) - export draws the header baseline at
    // height-HEADER_Y_FROM_TOP and the footer baseline at FOOTER_Y. To
    // place the SAME baseline on this top-down canvas: canvasY = (pageHeight
    // - pdfBaselineY) * dispScale. For the header that simplifies to
    // HEADER_Y_FROM_TOP*dispScale; for the footer, to canvas.height -
    // FOOTER_Y*dispScale. No extra offset belongs here - the PDF y IS the
    // baseline already, unlike a CSS/canvas top-aligned box.
    const h = winAnsiSafe(headerText);
    if(h.trim()){
      const tw = ctx.measureText(h).width / dispScale;
      const x = headerFooterAnchor(headerAlign, page1Size.width, tw, MARGIN_X) * dispScale;
      const y = HEADER_Y_FROM_TOP * dispScale;
      ctx.fillText(h, x, y);
    }
    const f = winAnsiSafe(footerText);
    if(f.trim()){
      const tw = ctx.measureText(f).width / dispScale;
      const x = headerFooterAnchor(footerAlign, page1Size.width, tw, MARGIN_X) * dispScale;
      const y = canvas.height - FOOTER_Y * dispScale;
      ctx.fillText(f, x, y);
    }
  }
  ["htext","ftext","halign","falign","hfsize"].forEach(id=>{
    document.getElementById(id).addEventListener("input", redrawPreview);
  });
  document.getElementById("hfpages").addEventListener("input", validate);

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; pdoc=null; pageBgImageData=null;
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    validate();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    const loadedPdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    if(myToken !== loadToken) return;
    pdoc = loadedPdoc;
    const page1 = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    page1Size = {width:vp1.width, height:vp1.height};
    const maxW = 700;
    dispScale = Math.min(1, maxW/vp1.width);
    showWorkspace();
    try{
      const rendered = await renderPdfPageCanvas(pdoc, 1, dispScale);
      if(myToken !== loadToken) return;
      canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext("2d").drawImage(rendered, 0, 0);
      pageBgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
      redrawPreview();
    }catch(e){
      readout.textContent = "Couldn't render a preview, but the header/footer will still apply correctly on download.";
    }
    validate();
  });

  goBtn.addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const {headerText, footerText, headerAlign, footerAlign, fontSize} = currentSettings();
    const h = winAnsiSafe(headerText);
    const f = winAnsiSafe(footerText);
    const pagesRaw = document.getElementById("hfpages").value.trim();
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, doc.getPageCount()) : null;
    setStatus("Applying header & footer...");
    doc.getPages().forEach((p,i)=>{
      if(targetIndices && !targetIndices.includes(i)) return;
      const {width, height} = p.getSize();
      if(h.trim()){
        const tw = font.widthOfTextAtSize(h, fontSize);
        p.drawText(h, {x:headerFooterAnchor(headerAlign, width, tw, MARGIN_X), y:height-HEADER_Y_FROM_TOP, size:fontSize, font, color:rgb(0.3,0.3,0.3)});
      }
      if(f.trim()){
        const tw = font.widthOfTextAtSize(f, fontSize);
        p.drawText(f, {x:headerFooterAnchor(footerAlign, width, tw, MARGIN_X), y:FOOTER_Y, size:fontSize, font, color:rgb(0.3,0.3,0.3)});
      }
    });
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "header_footer", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  });
};

/* ---- CROP PDF ---- */
TOOLS.crop = function(){
  let file=null, dispScale=1, rect=null, bgImageData=null, fileBytesCache=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Crop PDF</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="cropBody">
      <div class="tool-hero" id="cropHero">
        <h2 class="tool-hero-title">Crop PDF</h2>
        <p class="tool-hero-desc">Drag to draw a selection, then fine-tune it with the corner and edge handles.</p>
      </div>
      <div class="tool-upload-wrap" id="cropUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="cropPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="cropWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="crop-stage tool-content-area" id="cropStage">
            <canvas id="cropCanvas"></canvas>
          </div>
          <div class="mono" id="cropReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Crop PDF</h3>
          <div id="cropFileSlot"></div>
          <div class="mode-info" id="cropMixedSizeWarning" hidden></div>
          <div class="field"><label>Pages (optional)</label><input type="text" id="cropPages" placeholder="e.g. 1,3-5 - leave blank for all pages"></div>
          <div class="split-error" id="cropError" hidden></div>
          <button class="btn secondary" id="resetCrop" type="button">Reset Selection</button>
          <button class="btn tool-toolbar-primary" id="go">Crop PDF</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("cropHero");
  const uploadWrap = document.getElementById("cropUploadWrap");
  const privacyHint = document.getElementById("cropPrivacyHint");
  const workspace = document.getElementById("cropWorkspace");
  const fileSlot = document.getElementById("cropFileSlot");
  const body = document.getElementById("cropBody");
  const mixedSizeWarning = document.getElementById("cropMixedSizeWarning");
  const errorBox = document.getElementById("cropError");
  const goBtn = document.getElementById("go");
  let numPages = 1;

  function showError(msg){
    if(msg){ errorBox.innerHTML = `<span aria-hidden="true">⚠️</span><span>${msg}</span>`; errorBox.hidden=false; }
    else { errorBox.hidden=true; errorBox.innerHTML=""; }
  }
  function validatePages(){
    if(!file){ goBtn.disabled = true; return; }
    const pagesRaw = document.getElementById("cropPages").value.trim();
    if(pagesRaw && !parsePageList(pagesRaw, numPages)){
      showError(`Enter page numbers between 1 and ${numPages}, e.g. 1,3-5.`);
      goBtn.disabled = true;
      return;
    }
    showError(null);
    goBtn.disabled = false;
  }
  document.getElementById("cropPages").addEventListener("input", validatePages);

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  const cropState = {
    rect: null,
    redraw(){
      const canvas = document.getElementById("cropCanvas");
      const ctx = canvas.getContext("2d");
      ctx.putImageData(bgImageData, 0, 0);
      rect = cropState.rect;
      if(rect && rect.w>0 && rect.h>0){
        ctx.save();
        ctx.fillStyle="rgba(0,0,0,0.4)";
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.putImageData(bgImageData, 0, 0, rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle="#E8291B"; ctx.lineWidth=2;
        ctx.strokeRect(rect.x,rect.y,rect.w,rect.h);
        drawCropHandles(ctx, rect);
        ctx.restore();
      }
      const r = document.getElementById("cropReadout");
      if(r){
        r.textContent = (rect && rect.w>0 && rect.h>0)
          ? `Selection: ${Math.round(rect.w/dispScale)} × ${Math.round(rect.h/dispScale)}pt`
          : "Drag on the page above to select an area (defaults to the full page).";
      }
    }
  };

  wireDropzone(async fs=>{
    // See Split PDF's identical guard - this one has an even longer async
    // chain (getDocument -> getPage -> render), so the window for a
    // second upload to land mid-flight is larger, not smaller.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null;
      document.getElementById("cropReadout").textContent="";
      mixedSizeWarning.hidden = true;
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    validatePages();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    fileBytesCache = bytes;
    const qp = document.getElementById("quickPreview"); if(qp) qp.innerHTML = "";
    const pdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    const page = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page.getViewport({scale:1});
    numPages = pdoc.numPages;
    const maxW = 700; // wider cap than before - the main pane has real room now, not a small centered column
    dispScale = Math.min(1, maxW/vp1.width);
    // The crop rectangle the user draws is only ever seen against page 1 -
    // it then gets applied as the SAME absolute-point margins to every
    // page. That's the right, expected behavior for same-size pages (the
    // overwhelming common case), but on a document mixing page sizes
    // (e.g. one landscape table page in an otherwise-portrait report) the
    // same point margins are a very different PROPORTION of a
    // differently-sized page - confirmed by testing: cropping 25% off
    // page 1's width left 87.5% of a double-width page 2 intact instead
    // of the equivalent 75%, with zero indication to the user, who never
    // even sees page 2 while drawing the selection. Rather than silently
    // picking a margin-vs-proportion convention (a real judgment call,
    // not a bug with one right answer), surface it and let "Pages
    // (optional)" scope the crop away from the differently-sized ones if
    // that's not what's wanted.
    let hasMixedSizes = false;
    for(let i=2;i<=numPages && !hasMixedSizes;i++){
      const pg = await pdoc.getPage(i);
      if(myToken !== loadToken) return;
      const w = pg.view[2]-pg.view[0], h = pg.view[3]-pg.view[1];
      if(Math.abs(w-vp1.width)>1 || Math.abs(h-vp1.height)>1) hasMixedSizes = true;
    }
    if(hasMixedSizes){
      mixedSizeWarning.innerHTML = `<span aria-hidden="true">ℹ️</span> This PDF has pages of different sizes. The crop you draw below uses page 1's own margins on every page, which can look different on a differently-sized page - use "Pages" to limit which ones get cropped if needed.`;
      mixedSizeWarning.hidden = false;
    } else {
      mixedSizeWarning.hidden = true;
    }
    const canvas = document.getElementById("cropCanvas");
    // renderPdfPageCanvas() (not a raw page.render() call) - pdf.js's
    // render can hang indefinitely on some inputs/environments (see that
    // function's own doc comment), and this preview is the actual
    // deliverable the user crops against, not a best-effort thumbnail -
    // so a hang here must surface as a recoverable error, not a
    // permanently stuck "Reading PDF..." state.
    let rendered;
    try{
      rendered = await renderPdfPageCanvas(pdoc, 1, dispScale);
    }catch(e){
      if(myToken !== loadToken) return;
      // loadToken alone doesn't catch every stale case: if the whole
      // panel was closed (not just superseded by a newer upload) while
      // this ~10s render was still pending, loadToken is untouched but
      // #cropReadout no longer exists - guard the element lookup itself
      // rather than assuming the panel is still open.
      const readout = document.getElementById("cropReadout");
      if(!readout) return;
      readout.textContent = "Could not render this PDF's preview. Try a different file.";
      showWorkspace();
      return;
    }
    if(myToken !== loadToken) return;
    canvas.width = rendered.width; canvas.height = rendered.height;
    canvas.getContext("2d").drawImage(rendered, 0, 0);
    bgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
    cropState.rect = {x:0, y:0, w:canvas.width, h:canvas.height};
    cropState.redraw();
    showWorkspace();
    wireCropCanvas(canvas, cropState);
    document.getElementById("resetCrop").onclick = ()=>{
      cropState.rect = {x:0, y:0, w:canvas.width, h:canvas.height};
      cropState.redraw();
    };
    validatePages();
  });

  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Applying crop...");
    const pagesRaw = document.getElementById("cropPages").value.trim();
    const targetIndices = pagesRaw ? parsePageList(pagesRaw, numPages) : null;
    const canvas = document.getElementById("cropCanvas");
    const cw=canvas.width, ch=canvas.height;
    const leftPt = rect.x/dispScale;
    const rightPt = (cw-(rect.x+rect.w))/dispScale;
    const topPt = rect.y/dispScale;
    const bottomPt = (ch-(rect.y+rect.h))/dispScale;
    const doc = await loadPdfSafe(fileBytesCache);
    doc.getPages().forEach((p,i)=>{
      if(targetIndices && !targetIndices.includes(i)) return;
      const {width,height} = p.getSize();
      const l = Math.max(0, Math.min(leftPt, width-1));
      const r = Math.max(0, Math.min(rightPt, width-1-l));
      const t = Math.max(0, Math.min(topPt, height-1));
      const b = Math.max(0, Math.min(bottomPt, height-1-t));
      p.setCropBox(l, b, width-l-r, height-t-b);
    });
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "cropped", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  });
};

/* ---- INVERT PDF COLORS ---- */
TOOLS.invertpdf = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Invert PDF Colors</h3></div>
    <div class="panel-body compact tool-workspace" id="invertpdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Invert PDF Colors</h2>
        <p class="tool-hero-desc">Renders each page and inverts its colors — useful for a dark-mode / negative version of a document.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="invertpdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Invert Colors</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("invertpdfToolbar").style.display="none"; document.getElementById("invertpdfBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("invertpdfToolbar").style.display="flex";
    document.getElementById("invertpdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const bytes=await file.arrayBuffer();
    const pdoc = await pdfjsLib.getDocument({data:bytes}).promise;
    const outDoc = await PDFDocument.create();
    const scale = 1.6;
    try{
      for(let i=1;i<=pdoc.numPages;i++){
        setStatus("Inverting pages...", false, Math.round((i/pdoc.numPages)*100));
        // renderPdfPageCanvas(), not a raw page.render() call - every page
        // has to succeed for the output's page count/order to be correct
        // (unlike e.g. PDF to Word's best-effort per-page fallback), so a
        // hang here (pdf.js's render can hang indefinitely on some
        // inputs/environments - see that function's doc comment) needs to
        // surface as a catchable rejection instead of freezing this loop
        // forever with the progress bar stuck mid-way.
        const canvas = await renderPdfPageCanvas(pdoc, i, scale);
        const ctx = canvas.getContext("2d");
        const imgData = ctx.getImageData(0,0,canvas.width,canvas.height);
        const d = imgData.data;
        for(let px=0; px<d.length; px+=4){
          d[px]=255-d[px]; d[px+1]=255-d[px+1]; d[px+2]=255-d[px+2];
        }
        ctx.putImageData(imgData,0,0);
        const jpegUrl = canvas.toDataURL("image/jpeg", 0.9);
        const jpegBytes = Uint8Array.from(atob(jpegUrl.split(",")[1]), c=>c.charCodeAt(0));
        const img = await outDoc.embedJpg(jpegBytes);
        const pageDoc = outDoc.addPage([canvas.width/scale, canvas.height/scale]);
        pageDoc.drawImage(img, {x:0,y:0,width:canvas.width/scale, height:canvas.height/scale});
      }
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not invert this PDF (${escapeAttr(e.message)}). Try a different file.</div>`;
      return;
    }
    const outBytes = await outDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "inverted", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- ORGANIZE ----------------------------------------------------------
   Supports combining pages from MULTIPLE PDFs into one grid, iLovePDF-
   style: each source file gets a distinct color, shown as a border on
   every one of its page thumbnails and as a swatch in the "Files" list,
   so it's obvious at a glance which original file any page came from
   while drag-reordering/mixing pages across files. */
const ORGANIZE_FILE_COLORS = ["#E0201B","#3B82F6","#F5B22D","#8B5CF6","#22C55E","#EC4899","#14B8A6","#F97316"];
TOOLS.organize = function(){
  const entries = []; // {file, color, removed}
  let gridApi=null;
  openPanel(`
    <div class="panel-head"><h3>Organize PDF</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell page-workspace" id="organizeBody">
      <div class="tool-hero" id="organizeHero">
        <h2 class="tool-hero-title">Organize PDF</h2>
        <p class="tool-hero-desc">Reorder, rotate, duplicate, or remove pages across one or more PDFs.</p>
      </div>
      <div class="tool-upload-wrap" id="organizeUploadWrap">
        ${fileInputHTML("application/pdf", true, "Select PDF files")}
      </div>
      <p class="tool-privacy-hint" id="organizePrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="organizeWorkspace" style="display:none">
        <div class="tool-main-pane">
          <p class="page-grid-hint" id="gridHint" style="display:none">Drag pages to reorder — even across files. Hover a page to rotate, duplicate, or remove it. Click to multi-select (Ctrl/Cmd+A select all, Delete to remove, Esc to clear).</p>
          <div class="page-grid tool-content-area" id="pageGrid"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Organize PDF</h3>
          <div class="organize-files" id="organizeFilesList"></div>
          <input type="file" id="organizeAddInput" class="hidden" accept="application/pdf" multiple>
          <button type="button" class="organize-add-btn" id="organizeAddBtn">+ Add more files</button>
          <button class="btn tool-toolbar-primary" id="go">Organize PDF</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("organizeHero");
  const uploadWrap = document.getElementById("organizeUploadWrap");
  const privacyHint = document.getElementById("organizePrivacyHint");
  const workspace = document.getElementById("organizeWorkspace");
  const filesListEl = document.getElementById("organizeFilesList");
  const gridHint = document.getElementById("gridHint");
  const body = document.getElementById("organizeBody");
  const pageGridEl = document.getElementById("pageGrid");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  function renderFilesSidebar(){
    filesListEl.innerHTML = entries.map((e, i)=>{
      if(e.removed) return "";
      const letter = String.fromCharCode(65 + i);
      return `<div class="organize-file-row" data-doc-index="${i}">
        <span class="organize-file-swatch" style="background:${e.color}">${letter}</span>
        <span class="organize-file-name" title="${escapeAttr(e.file.name)}">${escapeAttr(e.file.name)}</span>
        <button type="button" class="organize-file-remove" data-doc-index="${i}" aria-label="Remove ${escapeAttr(e.file.name)}">✕</button>
      </div>`;
    }).join("");
    filesListEl.querySelectorAll(".organize-file-remove").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const idx = parseInt(btn.dataset.docIndex);
        entries[idx].removed = true;
        gridApi && gridApi.removeSource(idx);
        renderFilesSidebar();
        if(entries.every(e=>e.removed)){
          gridApi = null; pageGridEl.innerHTML=""; gridHint.style.display="none"; showEmptyState();
        }
      });
    });
  }

  async function addFiles(fs){
    const newSources = [];
    for(const f of fs){
      const color = ORGANIZE_FILE_COLORS[entries.length % ORGANIZE_FILE_COLORS.length];
      entries.push({file:f, color, removed:false});
      newSources.push({file:f, color});
    }
    renderFilesSidebar();
    if(!gridApi){
      gridHint.style.display="block";
      const sources = await Promise.all(newSources.map(async s=>({bytes:await s.file.arrayBuffer(), color:s.color})));
      gridApi = await buildPageGrid(pageGridEl, sources, {mode:"reorder", removable:true, rotatable:true, duplicable:true, multiSelect:true, zoomable:true});
      showWorkspace();
    } else {
      for(const s of newSources){
        const bytes = await s.file.arrayBuffer();
        await gridApi.addSource(bytes, s.color);
      }
    }
  }

  wireDropzone(fs=>addFiles(fs));
  document.getElementById("organizeAddBtn").addEventListener("click", ()=>document.getElementById("organizeAddInput").click());
  document.getElementById("organizeAddInput").addEventListener("change", e=>{
    addFiles([...e.target.files]);
    e.target.value = "";
  });

  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Applying...");
    const pagesSpec = gridApi.getPages();
    if(pagesSpec.length===0){ toast("At least one page must remain"); out.innerHTML=""; return; }
    const usedDocIndexes = [...new Set(pagesSpec.map(p=>p.docIndex))];
    const srcDocs = [];
    for(const idx of usedDocIndexes){
      const bytes = await entries[idx].file.arrayBuffer();
      srcDocs[idx] = await loadPdfSafe(bytes);
    }
    const newDoc = usedDocIndexes.length>1
      ? await buildPdfFromMultiDoc(srcDocs, pagesSpec)
      : await buildPdfFromPages(srcDocs[usedDocIndexes[0]], pagesSpec);
    const outBytes=await newDoc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const primaryFile = entries[usedDocIndexes[0]].file;
    const outName = usedDocIndexes.length>1 ? "organized.pdf" : suffixedName(primaryFile, "organized", "pdf");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- FLATTEN ---- */
TOOLS.flatten = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Flatten PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="flattenBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Flatten PDF</h2>
        <p class="tool-hero-desc">Any form fields present will be permanently flattened into the page content.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="flattenToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Flatten PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("flattenToolbar").style.display="none"; document.getElementById("flattenBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("flattenToolbar").style.display="flex";
    document.getElementById("flattenBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    setStatus("Flattening document...");
    try{ const form = doc.getForm(); form.flatten(); }catch(e){}
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "flattened", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- REPAIR ---- */
TOOLS.repair = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Repair PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="repairBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Repair PDF</h2>
        <p class="tool-hero-desc">Attempts to recover common structural issues in a PDF.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="repairToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Repair PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("repairToolbar").style.display="none"; document.getElementById("repairBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("repairToolbar").style.display="flex";
    document.getElementById("repairBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Analyzing PDF...");
    try{
      const bytes=await file.arrayBuffer();
      const doc=await loadPdfSafe(bytes, {ignoreEncryption:true, throwOnInvalidObject:false});
      setStatus("Attempting repair...");
      const outBytes=await doc.save({useObjectStreams:false});
      const blob=new Blob([outBytes],{type:"application/pdf"});
      const outName = suffixedName(file, "repaired", "pdf");
      setStatus("Preparing download...");
      const {url}=downloadBlob(blob,outName);
      const {canvas}=await pdfThumb(outBytes);
      setStatus("Done", true);
      out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">This file could not be repaired (${escapeAttr(e.message)}). It may be too severely damaged to recover in-browser.</div>`;
    }
  });
};

/* ---- PDF to JPG ---- */
TOOLS.pdf2jpg = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to JPG</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2jpgBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to JPG</h2>
        <p class="tool-hero-desc">Turn every page of a PDF into a high-quality JPG image.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2jpgToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to JPG</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2jpgToolbar").style.display="none"; document.getElementById("pdf2jpgBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2jpgToolbar").style.display="flex";
    document.getElementById("pdf2jpgBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Rendering PDF pages...");
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    const pdoc = await pdfjsLib.getDocument({data:bytes}).promise;
    const zip = new JSZip();
    let firstBlob=null;
    try{
      for(let i=1;i<=pdoc.numPages;i++){
        setStatus("Rendering PDF pages...", false, Math.round((i/pdoc.numPages)*100));
        // renderPdfPageCanvas(), not a raw page.render() - see Invert PDF
        // Colors' identical comment for why a hang here must reject
        // instead of freezing this loop forever.
        const canvas = await renderPdfPageCanvas(pdoc, i, 2);
        const blob = await new Promise(res=>canvas.toBlob(res,"image/jpeg",0.92));
        if(i===1) firstBlob=blob;
        zip.file(`page_${i}.jpg`, blob);
      }
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not render this PDF (${escapeAttr(e.message)}). Try a different file.</div>`;
      return;
    }
    setStatus("Preparing download...");
    if(pdoc.numPages===1){
      const outName = suffixedName(file, "page1", "jpg");
      const {url}=downloadBlob(firstBlob,outName);
      const img=document.createElement("img"); img.src=url;
      setStatus("Done", true);
      out.appendChild(resultBox({sizeText:fmtSize(firstBlob.size), sizeGood:true, previewNode:img, url, filename:outName}));
    } else {
      const zipBlob = await zip.generateAsync({type:"blob"});
      const outName = suffixedName(file, "pages", "zip");
      const {url}=downloadBlob(zipBlob,outName);
      setStatus("Done", true);
      out.appendChild(resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName}));
    }
  });
};

/* ---- JPG/Image to PDF ---- */
TOOLS.jpg2pdf = function(){
  let files=[];
  openPanel(`
    <div class="panel-head"><h3>JPG to PDF</h3></div>
    <div class="panel-body compact tool-workspace keep-upload" id="jpg2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">JPG to PDF</h2>
        <p class="tool-hero-desc">Combine one or more images into a single PDF, in the order you add them.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("image/*", true, "Select images")}
      </div>
      <div class="tool-toolbar" id="jpg2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go" disabled>JPG to PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  const refresh = ()=>{
    renderFileList(files, i=>{files.splice(i,1); refresh();});
    document.getElementById("go").disabled = files.length<1;
    document.getElementById("jpg2pdfToolbar").style.display = files.length ? "flex" : "none";
    document.getElementById("jpg2pdfBody").classList.toggle("is-loaded", files.length>0);
  };
  wireDropzone(fs=>{ files = files.concat(fs.filter(f=>f.type.startsWith("image/"))); refresh(); });
  /**
   * Embeds one image file into `doc`, returning the embedded image.
   * The dropzone/file input both accept `image/*` broadly, but the old
   * code only ever handled that promise: "PNG -> embedPng, anything else
   * -> embedJpg" - a WEBP (the default format for a huge share of real
   * phone screenshots/exports today), GIF, BMP, or any other real
   * `image/*` file hit embedJpg and threw "SOI not found in JPEG"
   * (confirmed by testing), which wasn't even caught anywhere - the UI
   * was left permanently stuck on "Building PDF..." forever, no error
   * shown at all. Genuine PNG/JPEG still take the fast direct-embed
   * path (pdf-lib natively supports both, no quality loss); anything
   * else is decoded via the browser's own image decoder (createImageBitmap
   * handles WEBP/GIF/BMP/AVIF/etc - whatever this browser can already
   * display) and re-encoded as PNG, so the tool actually delivers on
   * what "Select images" already promised instead of silently failing.
   */
  async function embedImageFile(doc, file){
    const type = (file.type||"").toLowerCase();
    if(type==="image/png") return doc.embedPng(new Uint8Array(await file.arrayBuffer()));
    if(type==="image/jpeg" || type==="image/jpg") return doc.embedJpg(new Uint8Array(await file.arrayBuffer()));
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const pngBlob = await new Promise(res=>canvas.toBlob(res, "image/png"));
    return doc.embedPng(new Uint8Array(await pngBlob.arrayBuffer()));
  }
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading images...");
    const doc = await PDFDocument.create();
    const failed = [];
    for(let i=0;i<files.length;i++){
      setStatus("Building PDF...", false, Math.round(((i+1)/files.length)*100));
      const f = files[i];
      try{
        const img = await embedImageFile(doc, f);
        const page = doc.addPage([img.width, img.height]);
        page.drawImage(img, {x:0,y:0,width:img.width, height:img.height});
      }catch(e){
        // One unreadable/corrupt file shouldn't discard everything else
        // the user already added - skip it and keep going, then report
        // exactly which file(s) didn't make it into the final PDF.
        failed.push(f.name);
      }
    }
    if(doc.getPageCount()===0){
      out.innerHTML = `<div class="status" style="color:var(--rose)">None of the selected files could be read as images. Try a different file.</div>`;
      return;
    }
    setStatus("Preparing download...");
    const outBytes = await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const {url}=downloadBlob(blob,"images.pdf");
    const {canvas}=await pdfThumb(outBytes);
    setStatus(failed.length ? `Done — couldn't read: ${failed.join(", ")}` : "Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:"images.pdf"}));
  });
};

/* ---- HTML to PDF (basic text-based) ---- */
TOOLS.html2pdf = function(){
  openPanel(`
    <div class="panel-head"><h3>HTML to PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="html2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">HTML to PDF</h2>
        <p class="tool-hero-desc">Basic version: paste plain text or simple HTML and it's laid out as a formatted PDF.</p>
      </div>
      <div class="tool-content-area">
        <label class="tool-content-area-label" for="htmlIn">HTML content</label>
        <div class="field" style="margin:0"><textarea id="htmlIn" placeholder="Paste your text or simple HTML here"></textarea></div>
      </div>
      <div class="tool-toolbar">
        <button class="btn tool-toolbar-primary" id="go">Convert to PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Generating...");
    const raw = document.getElementById("htmlIn").value;
    const text = winAnsiSafe(raw.replace(/<[^>]+>/g," ").replace(/\s+\n/g,"\n").replace(/[ \t]+/g," ").trim());
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size=11, margin=50, maxWidth=495, lineHeight=15;
    let page = doc.addPage([595,842]); let y = 842-margin;
    const words = text.split(/\s+/);
    let line="";
    function newPageIfNeeded(){ if(y<margin){ page=doc.addPage([595,842]); y=842-margin; } }
    for(const w of words){
      const test = line? line+" "+w : w;
      if(font.widthOfTextAtSize(test,size) > maxWidth){
        page.drawText(line, {x:margin,y,size,font}); y-=lineHeight; newPageIfNeeded(); line=w;
      } else line=test;
    }
    if(line){ page.drawText(line,{x:margin,y,size,font}); }
    const outBytes = await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const {url}=downloadBlob(blob,"document.pdf");
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:"document.pdf"}));
  });
};

/* ---- Minimal DOCX builder (text-only, no external docx library needed) ---- */
function escapeXml(s){
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
/* Extracts a page's text as structured paragraphs with per-run bold/
   italic/size instead of one flat unstyled string, so PDF to Word can
   preserve real formatting. Bold/italic come from pdf.js's internal font
   objects (page.commonObjs), which expose the actual parsed font
   descriptor's bold/italic flags - NOT content.styles[fontName].fontFamily,
   which was verified empirically to only ever return a generic CSS
   fallback ("sans-serif") regardless of the real embedded font, so it's
   useless for this. Deliberately out of scope here: real table
   reconstruction and precise text alignment (centered/right) detection -
   both need much more structural inference than font/position data alone
   reliably supports; a future pass could add them without touching this
   function's output shape. */
/* Devanagari vowel-sign reordering fix. U+093F (ि, VOWEL SIGN I) is the one
   Devanagari matra that renders to the LEFT of its base consonant while
   Unicode requires it stored AFTER the consonant. This PDF's embedded
   font's ToUnicode CMap emits glyphs in visual (rendering) order, so
   pdf.js's getTextContent() faithfully reproduces the "wrong" order
   (e.g. "तिथि" comes out as "ितिथ"). Swapping every ि back with the
   consonant it precedes restores the correct logical order; verified
   against real extracted text from the source document. */
function fixDevanagari(text){
  if(!text) return text;
  return text.normalize("NFC").replace(/ि([क-हक़-य़])/g, "$1ि");
}

/* Splits one line's items into cells (as item arrays, so per-run bold/
   italic/size survives) wherever a real visual gap exceeds minGap. Two
   distinct gap encodings show up across real-world PDFs, and a table only
   reads correctly if both are checked: (1) a whitespace-only filler item
   whose own width IS the gap - pdf.js inserts these to fill the space
   between two separately-positioned runs (confirmed against this
   document's actual table rows, e.g. a `" "` item with width 160pt sitting
   between a left-column value and the next label - the item's neighbors
   sit flush against it with ~0 positional jump, so the gap is only visible
   via the filler's own width); (2) a direct x-position jump with no filler
   item at all. Checking only positional jumps (as an earlier version of
   this function did) misses case (1) entirely and finds zero table cells
   on this kind of PDF. */
function splitLineIntoCellItems(items, minGap){
  const cells = [];
  let cur = [], runningX = null;
  for(const it of items){
    const gapBefore = runningX != null ? (it.x - runningX) : 0;
    const isFiller = it.str.trim()==="" && it.width > minGap;
    const gap = isFiller ? Math.max(gapBefore, it.width) : gapBefore;
    if(gap >= minGap && cur.some(x=>x.str.trim())){
      cells.push(cur); cur = [];
    }
    if(!isFiller) cur.push(it);
    runningX = it.x + (it.width || 0);
  }
  if(cur.some(x=>x.str.trim())) cells.push(cur);
  return cells;
}
function cellItemsToText(cellItems){
  return cellItems.map(i=>i.str).join("").trim();
}

/* ============================================================
   PDF -> WORD: DOCUMENT MODEL
   ============================================================
   Everything from here down to buildMixedDocx is organized in two
   strictly separate layers that do not call into each other in the wrong
   direction:

   1. DETECTION (this section): linesToParagraphs, extractPageBlocks,
      detectRulingGridTable, buildBorderlessTable, extractPageVisuals,
      detectHeaderFooter. These read PDF geometry (pdf.js text items,
      operator-list shapes/images) and produce plain JS objects - the
      "document model" - with NO OOXML/DOCX knowledge whatsoever. Audited
      directly (grepped for `<w:` inside every one of these functions) to
      confirm none of them emit XML strings - they never did, this section
      just makes that boundary explicit rather than implicit.

   2. RENDERING (below, starting at runFontsXml/runsToXml): consumes the
      document model and is the ONLY place `<w:...>` OOXML strings get
      built. Nothing in this layer re-derives geometry or makes detection
      decisions; it only shapes already-decided content into valid XML.

   The document model's shapes, produced by the detection layer:

     Block (page-level, in reading order) - one of:
       {type:"paragraph", runs:[Run], listItem, align, spacingBeforePt,
        lineSpacingPt, _y}
       {type:"table", rows:[[{text,span}]], shadeHex?, borderHex?, _y}
         - gap-detected, no real column-boundary geometry, auto-width
       {type:"gridtable", nRows, nCols, cells:[Cell], colWidthsPt,
        colBounds, rowBounds, _y}
         - real geometry-backed columns (ruling-line grid OR the
           borderless global-column-band model), real widths, real
           rowSpan/colSpan
         - colBounds/rowBounds: nCols+1/nRows+1 absolute-y-boundary
           arrays used to test which cell an image's center point falls
           into (see embedImagesIntoTableCells); ruling-grid bounds are
           real rule-line positions, borderless bounds are synthesized
           midpoints between line y's (no real row-height evidence)
       {type:"columns", left:[Paragraph], right:[Paragraph], shadeHex?, _y}
       {type:"image", pngBase64, width, height, widthPt?, heightPt?,
        placement:"centered"|"anchored", xPt?, yFromTopPt?, _y}
       {type:"separator", _y}
       {type:"pagebreak", sectionSize?}

     Run: {text, bold, italic, underline, color:[r,g,b]|null, size,
           fontFamily, isBreak?} - isBreak:true is a detected intentional
           hard line break rendered as <w:br/>, not a separate run of text.

     Cell (gridtable only): {r0, c0, rowSpan, colSpan, text, align,
           vAlign?, padLeftPt, runs?, shadeHex?, borderHex?, images?} -
           runs is only present when the cell's source lines came through
           linesToParagraphs (ruling-line path), giving it real per-line
           structure; the borderless path only ever produces single-line
           cells so it has no runs to preserve. images (array of the same
           image-block shape used at page level, minus placement/xPt/
           yFromTopPt) is attached by embedImagesIntoTableCells when a
           page image's center point geometrically falls inside this
           cell's colBounds/rowBounds - such images are consumed and do
           NOT also appear as a separate page-level image block.

   This model is deliberately NOT a set of classes/typed constructors -
   it's plain object literals, matching the rest of this codebase's style
   (no build step, no TypeScript). The schema above is the actual contract;
   changing a shape here means updating every renderer function that reads
   it (grep the field name across runFontsXml..buildMixedDocx). ============================================================ */

/* Groups already Y-clustered lines into paragraphs: a vertical gap
   noticeably larger than the line's own font size means a new paragraph,
   not just a wrapped line. A fully blank line always forces a break.
   When pageWidth is given, also detects real centered/right-aligned
   headings by comparing the line's own text bounding box against the
   page - not by guessing from content (e.g. "numbers are probably
   right-aligned"), only from geometry: a line whose left and right
   margins are both large and roughly equal reads as centered; one flush
   to the right edge reads as right-aligned. Ordinary left-flowing body
   text always has ~0 left margin so this can't misfire on it. */
function linesToParagraphs(lines, pageWidth){
  const sorted = lines.slice().sort((a,b)=> b.y - a.y);
  const paragraphs = [];
  let prevY = null, prevSize = null, current = null, prevLineRightExtent = null;
  for(const line of sorted){
    const items = line.items;
    const lineText = items.map(i=>i.str).join("");
    if(!lineText.trim()){ current = null; prevLineRightExtent = null; continue; }
    const size = (items.find(i=>i.str.trim()) || items[0]).size;
    const gap = prevY != null ? prevY - line.y : 0;
    const realItems = items.filter(it=>it.str.trim());
    const lineRightExtent = realItems.length ? Math.max(...realItems.map(it=>it.x+it.width)) : 0;
    const isNewParagraph = !current || (prevSize && gap > prevSize*1.6);
    if(isNewParagraph){
      current = {type:"paragraph", runs:[], listItem:false, _y: line.y, _lineGaps:[], _maxRightExtent: lineRightExtent};
      // Preserve the actual PDF vertical gap before this paragraph as
      // real w:spacing (converted pt->twips) instead of a single global
      // spacing value or fabricated blank paragraphs. Only meaningful
      // once a previous paragraph exists on the same page/region; capped
      // to guard against one stray huge gap (e.g. a genuine page-section
      // jump) blowing up the visible spacing.
      if(prevY != null && gap > 0) current.spacingBeforePt = Math.min(gap, 200);
      paragraphs.push(current);
      if(/^\s*([•●▪‣\-*]|\d{1,3}[.)])\s+/.test(lineText)) current.listItem = true;
      if(pageWidth){
        const real = realItems;
        if(real.length){
          const minX = Math.min(...real.map(it=>it.x));
          const maxX = Math.max(...real.map(it=>it.x+it.width));
          const leftGap = minX, rightGap = pageWidth - maxX;
          if(rightGap < pageWidth*0.04 && leftGap > pageWidth*0.2) current.align = "right";
          else if(leftGap > pageWidth*0.15 && rightGap > pageWidth*0.15 && Math.abs(leftGap-rightGap) < pageWidth*0.08) current.align = "center";
        }
      }
    } else {
      // Continuing the same paragraph - this gap is a genuine line-to-
      // line (not paragraph-to-paragraph) baseline distance, collected to
      // derive real intra-paragraph line spacing below.
      current._lineGaps.push(gap);
      // Intentional hard line break vs. normal word-wrap: a wrapped line
      // (except the true last one) fills close to the paragraph's own
      // right margin - so the line we're about to append TO reads as a
      // deliberate break if the PREVIOUS line ended noticeably short of
      // the widest line seen so far in this paragraph. This can't fire on
      // a normal wrapped paragraph (every line but the last stays close
      // to the running max by definition); it also can't detect a break
      // between two lines that are BOTH short with nothing wider to
      // compare against (e.g. a pure short-line address block) - a real,
      // disclosed limitation of geometry-only detection.
      // Threshold tuned conservatively (0.65, not the geometrically
      // "tighter-looking" 0.85): natural word-wrap regularly ends a line
      // anywhere from ~70-99% of the paragraph's fill width depending on
      // where word boundaries fall, so a tighter threshold was firing on
      // ordinary wrapped prose (confirmed against the real bill's long
      // Notes sections). 0.65 still catches lines that are CLEARLY short
      // (address-block-style deliberate breaks) while leaving normal
      // wrapping alone.
      if(prevLineRightExtent != null && current._maxRightExtent > 0 && prevLineRightExtent < current._maxRightExtent*0.65){
        current.runs.push({text:"", isBreak:true});
      }
      current._maxRightExtent = Math.max(current._maxRightExtent, lineRightExtent);
    }
    for(const item of items){
      const last = current.runs[current.runs.length-1];
      const colorKey = item.color ? item.color.join(",") : "";
      if(last && !last.isBreak && last.bold===item.bold && last.italic===item.italic && last.size===item.size
         && !!last.underline===!!item.underline && (last.color?last.color.join(","):"")===colorKey
         && last.fontFamily===item.fontFamily){
        last.text += item.str;
      } else {
        current.runs.push({text:item.str, bold:item.bold, italic:item.italic, size:item.size, underline:item.underline, color:item.color, fontFamily:item.fontFamily});
      }
    }
    current.runs.push({text:" ", bold:false, italic:false, size});
    prevY = line.y; prevSize = size; prevLineRightExtent = lineRightExtent;
  }
  // Derive real intra-paragraph line spacing (only meaningful for
  // paragraphs that actually span 2+ visual lines) instead of one global
  // line height, clamped to a sane range so one noisy gap can't produce
  // pathological spacing.
  paragraphs.forEach(p=>{
    if(p._lineGaps && p._lineGaps.length){
      const avg = p._lineGaps.reduce((a,b)=>a+b,0) / p._lineGaps.length;
      p.lineSpacingPt = Math.max(6, Math.min(60, avg));
    }
    delete p._lineGaps; delete p._maxRightExtent;
  });
  return paragraphs;
}

/* Builds structured page blocks (paragraph / two-column / table) instead
   of one flat left-to-right text dump. Root cause of the old layout loss:
   extractStyledParagraphs (now removed) grouped items into lines by Y only
   and sorted every item on a line strictly by X with zero notion of
   column/region boundaries, so a genuine two-column page (e.g. account
   info on the left, division info on the right, both at the same Y) was
   merged into a single run-on line. This function instead classifies each
   line as a table row (>=3 small, consistent gaps), a two-column split
   (one very wide gap), or plain prose, and only then converts runs of
   same-classified lines into the matching DOCX structure. */
async function extractPageBlocks(pdoc, pageNum, visuals){
  const page = await pdoc.getPage(pageNum);
  await page.getOperatorList(); // populates commonObjs with real font descriptors
  const content = await page.getTextContent();
  const viewport = page.view; // [x0,y0,x1,y1] in PDF points
  const pageWidth = viewport[2] - viewport[0];
  const shapes = (visuals && visuals.shapes) || [];
  const colorSpans = (visuals && visuals.colorSpans) || [];

  const fontStyleCache = {};
  async function styleFor(fontName){
    if(fontStyleCache[fontName]) return fontStyleCache[fontName];
    let style = {bold:false, italic:false, fontFamily:null};
    try{
      const f = await page.commonObjs.get(fontName);
      if(f) style = {bold: !!f.bold, italic: !!f.italic, fontFamily: mapFontFamily(f.fallbackName)};
    }catch(e){ /* keep default (unstyled) if the font object isn't resolvable */ }
    fontStyleCache[fontName] = style;
    return style;
  }

  const lineTolerance = 3;
  const lines = [];
  for(const it of content.items){
    if(it.str === undefined) continue;
    const size = Math.abs(it.transform[0]) || Math.abs(it.transform[3]) || 10;
    const x = it.transform[4], y = it.transform[5];
    const style = it.str.trim() ? await styleFor(it.fontName) : {bold:false, italic:false, fontFamily:null};
    const color = it.str.trim() ? nearestColor(colorSpans, x, y, 40) : null;
    let line = lines.find(l => Math.abs(l.y - y) <= lineTolerance);
    if(!line){ line = {y, items:[]}; lines.push(line); }
    line.items.push({str: it.str, x, width: it.width||0, size, bold: style.bold, italic: style.italic, fontFamily: style.fontFamily, color});
  }
  lines.sort((a,b)=> b.y - a.y); // PDF y grows upward - top of page first
  lines.forEach(l => l.items.sort((a,b)=>a.x-b.x));

  // Real ruling-line tables take priority over whitespace-based detection
  // (PDF ruling lines are ground truth when present). Detect and remove
  // repeatedly so multiple separately-bordered tables on one page can each
  // be found, capped to avoid pathological loops on noisy pages.
  const gridTables = [];
  {
    let remainingShapes = shapes, remainingLines = lines;
    for(let guard=0; guard<5; guard++){
      const grid = detectRulingGridTable(remainingShapes, remainingLines);
      if(!grid) break;
      gridTables.push(grid);
      const [yBottom, yTop] = grid.consumedYRange;
      remainingLines = remainingLines.filter(l => l.y > yTop+2 || l.y < yBottom-2);
      remainingShapes = remainingShapes.filter(s => !grid.consumedShapes.includes(s));
    }
    if(remainingLines.length !== lines.length){ lines.length = 0; lines.push(...remainingLines); }
    if(remainingShapes.length !== shapes.length){ shapes.length = 0; shapes.push(...remainingShapes); }
  }

  // Match thin stroked rects (near-zero height, real width) to the text
  // line they sit directly under - those are underlines, not decorative
  // separators. Whatever's left over after that pass is a genuine
  // standalone rule (page/section divider) with no text to attach to.
  const underlineCandidates = shapes.filter(s => s.stroke && s.h < 2.5 && s.w > 3);
  const usedUnderlines = new Set();
  lines.forEach(line=>{
    const realItems = line.items.filter(i=>i.str.trim());
    if(!realItems.length) return;
    const minX = Math.min(...realItems.map(i=>i.x));
    const maxX = Math.max(...realItems.map(i=>i.x+i.width));
    for(let k=0;k<underlineCandidates.length;k++){
      if(usedUnderlines.has(k)) continue;
      const s = underlineCandidates[k];
      const overlap = Math.min(maxX, s.x+s.w) - Math.max(minX, s.x);
      if(Math.abs(s.y - line.y) <= 4 && overlap > 0.4*Math.min(s.w, maxX-minX)){
        usedUnderlines.add(k);
        line.items.forEach(i=>{ if(i.str.trim()) i.underline = true; });
      }
    }
  });
  const standaloneSeparators = underlineCandidates.filter((s,k)=>!usedUnderlines.has(k) && s.w > 30);

  // Large filled/stroked rects are containers/boxes (header bar, amount
  // boxes, notes box, etc.) - approximate them as shading/border color on
  // whichever table/column block falls inside their vertical extent,
  // picking the tightest (smallest-area) enclosing box so a page-wide
  // background rect doesn't win over a nested one.
  const boxCandidates = shapes.filter(s => s.w > 15 && s.h > 15 && (s.fill || s.stroke));
  function isNearWhite(rgb){ return rgb && rgb[0]>=245 && rgb[1]>=245 && rgb[2]>=245; }
  // Cell text is always rendered in its own (usually dark/black) color, so
  // shading a cell with a dark background would make the text unreadable -
  // this codebase has no mechanism to flip text to white for a dark cell,
  // so skip shading rather than risk illegible output.
  function isSafeForShading(rgb){ return rgb && !isNearWhite(rgb) && (0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2]) >= 140; }
  function findEnclosingBox(yTop, yBottom){
    let best=null, bestArea=Infinity;
    for(const b of boxCandidates){
      if(b.y <= yBottom+3 && b.y+b.h >= yTop-3){
        const area = b.w*b.h;
        if(area < bestArea){ bestArea = area; best = b; }
      }
    }
    return best;
  }

  // classify each line: small-gap split for table-cell candidates, a
  // separate much-larger-gap split for two-column candidates
  const bigGapThreshold = Math.max(80, pageWidth*0.14);
  lines.forEach(line=>{
    const anyReal = line.items.find(i=>i.str.trim());
    const size = anyReal ? anyReal.size : 10;
    const smallGapItemCells = splitLineIntoCellItems(line.items, Math.max(9, size*1.15));
    line.cells = smallGapItemCells.map(ci=>({
      text: cellItemsToText(ci),
      x: ci[0] ? ci[0].x : 0,
      xEnd: ci.length ? Math.max(...ci.map(it=>it.x+it.width)) : 0
    }));
    const bigGapItemCells = splitLineIntoCellItems(line.items, bigGapThreshold);
    if(bigGapItemCells.length === 2 && cellItemsToText(bigGapItemCells[0]) && cellItemsToText(bigGapItemCells[1])){
      line.colSplit = {left: bigGapItemCells[0], right: bigGapItemCells[1]};
    }
  });

  // table runs: start at a line with >=3 cells. A run can be EXTENDED by:
  //  (a) another >=3-cell line (updates the established column x-bands);
  //  (b) a line with FEWER cells (even just 1-2) whose cell x-position(s)
  //      geometrically match an already-established column band - this is
  //      what a real table row looks like when the outer table has a
  //      nested Rate/Amount sub-row pair and one sub-row simply has fewer
  //      populated columns than its siblings (confirmed against the real
  //      bill's "Calculation Details" table: a genuine "Fixed/Demand
  //      Charges  1.68" row only has 2 cells but both land squarely on
  //      established column starts, so it belongs in the same table);
  //  (c) the existing big-gap two-part colSplit signature (a genuine
  //      spanning row: one wide label cell + one value);
  //  (d) AT MOST ONE line that matches none of the above, bridged only if
  //      the line immediately after it resumes the table (another >=3
  //      line or a compatible-band line) - this is what a short in-table
  //      sub-header like "Govt Subsidy" looks like: it has no compatible
  //      column of its own, but real table rows continue right after it.
  //      A genuinely unrelated paragraph between two unrelated tables
  //      does NOT get this benefit of the doubt beyond one line, and only
  //      when the table actually resumes immediately after it.
  const isTableLine = l => l.cells.length >= 3;
  const colTolerance = 12;
  // establishedXs is kept as a small, CLUSTERED set of true column bands
  // (via the same clusterVals used elsewhere), not a raw accumulating
  // list of every cell x ever seen - an unbounded/unclustered set was
  // tried first and caused a serious bug: after enough rows, it contained
  // dozens of scattered x values across the whole page width, so ANY new
  // line's x (including ordinary left-flowing paragraph text sharing the
  // same left margin as the table) coincidentally "matched" something in
  // it, swallowing an entire unrelated Notes/legal-text section into one
  // table. Confirmed and fixed before this shipped.
  function xsCompatibleStrict(establishedXs, cellXs){
    // Require EVERY cell in the candidate line to land on a distinct
    // established band, and require at least 2 cells - a single value
    // coincidentally sharing an x with one column (e.g. the page's left
    // margin, which ordinary paragraphs also start at) is not enough
    // evidence on its own; that weaker single-value case is exactly what
    // the separate one-line "bridge" path below exists for, gated by its
    // own tighter check.
    if(cellXs.length < 2) return false;
    const usedBands = new Set();
    for(const x of cellXs){
      const bandIdx = establishedXs.findIndex((ex,bi)=> !usedBands.has(bi) && Math.abs(ex-x) <= colTolerance);
      if(bandIdx === -1) return false;
      usedBands.add(bandIdx);
    }
    return true;
  }
  lines.forEach(l => l.role = null);
  let i = 0;
  while(i < lines.length){
    if(isTableLine(lines[i])){
      let j = i+1;
      let establishedXs = clusterVals(lines[i].cells.map(c=>c.x), colTolerance);
      let bridgedStray = false;
      while(j < lines.length){
        const lj = lines[j];
        const ljXs = lj.cells.map(c=>c.x);
        if(isTableLine(lj)){
          establishedXs = clusterVals(establishedXs.concat(ljXs), colTolerance);
          j++; continue;
        }
        if(xsCompatibleStrict(establishedXs, ljXs)){
          establishedXs = clusterVals(establishedXs.concat(ljXs), colTolerance);
          j++; continue;
        }
        if(lj.colSplit){
          j++; continue;
        }
        if(!bridgedStray && j+1 < lines.length){
          const lnext = lines[j+1];
          const nextXs = lnext.cells.map(c=>c.x);
          const nextResumes = isTableLine(lnext) || xsCompatibleStrict(establishedXs, nextXs);
          if(nextResumes){ bridgedStray = true; j++; continue; }
        }
        break;
      }
      if(j - i >= 2){
        for(let k=i;k<j;k++) lines[k].role = "table";
        i = j; continue;
      }
    }
    i++;
  }
  // column runs (only among lines a table didn't already claim) - a single
  // isolated split line is still kept as a column pair (not required to
  // repeat across consecutive lines), since real-world layouts like
  // bilingual "label: value    label: value" rows often only line up with
  // their counterpart for one row at a time rather than a clean multi-row
  // block (adjacent rows can land on slightly different baselines per
  // script and fail the Y-tolerance grouping that would otherwise chain
  // them together).
  i = 0;
  while(i < lines.length){
    if(!lines[i].role && lines[i].colSplit){
      let j = i+1;
      while(j < lines.length && !lines[j].role && lines[j].colSplit) j++;
      for(let k=i;k<j;k++) lines[k].role = "column";
      i = j; continue;
    }
    i++;
  }

  // walk top-to-bottom emitting blocks
  const blocks = [];
  i = 0;
  while(i < lines.length){
    const role = lines[i].role;
    let j = i+1;
    while(j < lines.length && lines[j].role === role) j++;
    const run = lines.slice(i, j);
    const yTop = run[0].y, yBottom = run[run.length-1].y;
    const box = findEnclosingBox(yTop, yBottom);
    if(role === "table"){
      const borderless = buildBorderlessTable(run, pageWidth);
      if(borderless){
        const block = {type:"gridtable", nRows:borderless.nRows, nCols:borderless.nCols, cells:borderless.cells, colWidthsPt:borderless.colWidthsPt, colBounds:borderless.colBounds, rowBounds:borderless.rowBounds, _y: run[0].y};
        if(box){
          if(isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
          if(box.stroke) block.borderHex = rgbToHex(box.stroke);
        }
        blocks.push(block);
      } else {
        // The cross-row global-band model couldn't build a confident
        // shared column layout (common on very short 2-3 line label:value
        // runs - too few rows for the band statistics to resolve
        // cleanly). That's a real table candidate though - it already
        // passed the region-level gate (>=3 cells, >=2 consecutive
        // lines, stable count) - so fall back to a simple per-line,
        // auto-width table rather than discarding the structure entirely
        // into flat paragraphs.
        const width = run.reduce((m,l)=>Math.max(m, l.cells.length), 0);
        const rows = run.map(l=>{
          const cellTexts = l.cells.map(c=>fixDevanagari(c.text.trim()));
          if(cellTexts.length === 1 && width > 1) return [{text: cellTexts[0], span: width}];
          const padded = cellTexts.slice();
          while(padded.length < width) padded.push("");
          return padded.map(t=>({text:t, span:1}));
        });
        const block = {type:"table", rows, _y: run[0].y};
        if(box){
          if(isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
          if(box.stroke) block.borderHex = rgbToHex(box.stroke);
        }
        blocks.push(block);
      }
    } else if(role === "column"){
      const leftLines = run.map(l=>({y:l.y, items:l.colSplit.left}));
      const rightLines = run.map(l=>({y:l.y, items:l.colSplit.right}));
      const block = {type:"columns", left: linesToParagraphs(leftLines), right: linesToParagraphs(rightLines), _y: run[0].y};
      if(box && isSafeForShading(box.fill)) block.shadeHex = rgbToHex(box.fill);
      blocks.push(block);
    } else {
      blocks.push(...linesToParagraphs(run, pageWidth));
    }
    i = j;
  }
  standaloneSeparators.forEach(s=>{
    blocks.push({type:"separator", _y: s.y});
  });
  gridTables.forEach(g=>{
    blocks.push({type:"gridtable", nRows:g.nRows, nCols:g.nCols, cells:g.cells, colWidthsPt:g.colWidthsPt, colBounds:g.colBounds, rowBounds:g.rowBounds, _y: g._y});
  });
  blocks.sort((a,b)=> (b._y||0) - (a._y||0));
  return blocks;
}

/* Merges nearby 1D values (x or y coordinates) into representative
   cluster centers within tolerance - used both for ruling-line row/column
   positions and for borderless cross-row column-band detection. */
function clusterVals(vals, tol){
  const sorted = vals.slice().sort((a,b)=>a-b);
  const out = [];
  for(const v of sorted){
    if(out.length && v-out[out.length-1]<=tol) out[out.length-1] = (out[out.length-1]+v)/2;
    else out.push(v);
  }
  return out;
}

/* Detects a table from real PDF ruling lines (a grid of horizontal +
   vertical strokes) rather than whitespace gaps - the highest-fidelity
   signal when a PDF actually draws visible borders, and the only way to
   reliably detect merged cells (a missing ruling-line segment where one
   would otherwise be expected). Handles horizontal spans (e.g. a title
   row with no vertical dividers) and vertical spans between cells sharing
   an identical column range with no ruling line between them. This
   document's own tables have no ruling lines at all (verified against the
   real bill - confirmed empirically before building this), so this path
   exists for generality across other PDFs and was validated against a
   synthetic bordered/merged-cell test PDF instead. */
function detectRulingGridTable(shapes, lines){
  const hLines = shapes.filter(s=>s.stroke && s.h<2.5 && s.w>15);
  const vLines = shapes.filter(s=>s.stroke && s.w<2.5 && s.h>15);
  if(hLines.length<2 || vLines.length<2) return null;
  const rowYs = clusterVals(hLines.map(l=>l.y), 2).sort((a,b)=>b-a); // descending, top to bottom
  const colXs = clusterVals(vLines.map(l=>l.x), 2).sort((a,b)=>a-b);
  if(rowYs.length<2 || colXs.length<2) return null;
  const nRows = rowYs.length-1, nCols = colXs.length-1;
  if(nRows<1 || nCols<2) return null; // need a real 2D grid, not a single stray box

  function hasVerticalAt(x, yTop, yBottom){
    return vLines.some(l=> Math.abs(l.x-x)<=2 && l.y<=yBottom+2 && (l.y+l.h)>=yTop-2);
  }
  function hasHorizontalAt(y, xLeft, xRight){
    return hLines.some(l=> Math.abs(l.y-y)<=2 && l.x<=xLeft+2 && (l.x+l.w)>=xRight-2);
  }

  // horizontal spans per row (missing internal vertical divider = colspan)
  const rowSpanMap = [];
  for(let r=0;r<nRows;r++){
    const yTop = rowYs[r], yBottom = rowYs[r+1];
    const segs = []; let c=0;
    while(c<nCols){
      let span=1;
      while(c+span<nCols && !hasVerticalAt(colXs[c+span], yTop, yBottom)) span++;
      segs.push({c0:c, span});
      c += span;
    }
    rowSpanMap.push(segs);
  }
  // vertical spans: extend a segment downward while the row below has an
  // identical column range and no horizontal divider separates them
  const consumed = Array.from({length:nRows}, ()=>new Set());
  const cells = [];
  for(let r=0;r<nRows;r++){
    for(const seg of rowSpanMap[r]){
      if(consumed[r].has(seg.c0)) continue;
      let rowSpan=1, rr=r;
      while(rr+1<nRows){
        const below = rowSpanMap[rr+1].find(s=>s.c0===seg.c0 && s.span===seg.span);
        if(!below) break;
        const xLeft = colXs[seg.c0], xRight = colXs[seg.c0+seg.span];
        if(hasHorizontalAt(rowYs[rr+1], xLeft, xRight)) break; // real divider present - not merged
        consumed[rr+1].add(seg.c0);
        rowSpan++; rr++;
      }
      cells.push({r0:r, c0:seg.c0, rowSpan, colSpan:seg.span});
    }
  }

  const tableTop = rowYs[0], tableBottom = rowYs[rowYs.length-1];
  const relevantLines = lines.filter(l => l.y<=tableTop+2 && l.y>=tableBottom-2);
  cells.forEach(cell=>{
    const xLeft = colXs[cell.c0], xRight = colXs[cell.c0+cell.colSpan];
    const yTop = rowYs[cell.r0], yBottom = rowYs[cell.r0+cell.rowSpan];
    const cellLines = relevantLines
      .filter(l => l.y<=yTop+2 && l.y>=yBottom-2)
      .map(l => ({y:l.y, items: l.items.filter(it => it.x>=xLeft-1 && it.x<xRight+1)}))
      .filter(l => l.items.length);
    const paras = linesToParagraphs(cellLines);
    cell.text = paras.map(p => fixDevanagari(p.runs.map(r=>r.text).join(""))).join(" ").trim();
    // Preserve multiple original PDF lines inside one cell as real line
    // breaks within a single <w:p> (see gridTableBlockXml), instead of
    // flattening them into one space-joined string with no internal
    // structure - a 3-line cell should stay ONE cell, not become 3 rows
    // or lose its line boundaries entirely.
    cell.runs = [];
    paras.forEach((p, pi)=>{
      if(pi>0) cell.runs.push({text:"", isBreak:true});
      cell.runs.push(...p.runs);
    });
    // Real geometric alignment: compare the actual text bounding box to
    // the cell's known bounding box (available here because this is a
    // true ruling-line grid, unlike gap-detected tables which have no
    // real cell width to measure against) - not a content-based guess.
    const allItems = cellLines.flatMap(l=>l.items).filter(it=>it.str.trim());
    cell.align = "left";
    cell.vAlign = "top";
    cell.padLeftPt = 4;
    if(allItems.length){
      const itemMinX = Math.min(...allItems.map(it=>it.x));
      const itemMaxX = Math.max(...allItems.map(it=>it.x+it.width));
      const cellWidth = xRight - xLeft;
      const leftGap = itemMinX - xLeft, rightGap = xRight - itemMaxX;
      if(rightGap < cellWidth*0.08 && leftGap > cellWidth*0.15) cell.align = "right";
      else if(leftGap > cellWidth*0.15 && rightGap > cellWidth*0.15 && Math.abs(leftGap-rightGap) < cellWidth*0.12) cell.align = "center";
      // Real cell padding from the actual gap between the text and the
      // cell's left border, clamped to a sane range so a coincidentally
      // huge gap (e.g. a right/center-aligned cell) doesn't blow up the
      // margin - only trusted for left-aligned cells, where the gap is
      // genuinely the visual padding rather than an alignment artifact.
      if(cell.align === "left") cell.padLeftPt = Math.max(2, Math.min(14, leftGap));
      // Vertical alignment: compare the cell's occupied line-Y range
      // against its full row-band height (only meaningful for
      // multi-line-tall cells - ruling-line tables give a real row
      // height to measure against, unlike borderless/gap tables which
      // have no independent row-boundary geometry).
      const lineYs = cellLines.map(l=>l.y);
      const textTop = Math.max(...lineYs), textBottom = Math.min(...lineYs);
      const cellHeight = yTop - yBottom;
      const topGap = yTop - textTop, bottomGap = textBottom - yBottom;
      if(cellHeight > 4){
        if(bottomGap < cellHeight*0.15 && topGap > cellHeight*0.3) cell.vAlign = "bottom";
        else if(topGap > cellHeight*0.25 && bottomGap > cellHeight*0.25 && Math.abs(topGap-bottomGap) < cellHeight*0.15) cell.vAlign = "center";
      }
    }
  });

  return {
    _y: tableTop, nRows, nCols, cells,
    colWidthsPt: colXs.slice(0,-1).map((x,i)=>colXs[i+1]-x),
    colBounds: colXs, rowBounds: rowYs, // real cell boundaries, nCols+1/nRows+1 entries - lets an image's (x,y) be matched to the exact cell it visually sits in
    consumedYRange: [tableBottom, tableTop],
    consumedShapes: [...hLines, ...vLines]
  };
}

/* Builds a real cross-row column-band model for a borderless (no ruling
   lines) table candidate - the primary path for documents like the real
   bill, which has zero vector table borders anywhere in it (verified
   empirically). This replaces determining columns independently per line
   (the previous approach's core weakness: a row with fewer gaps than its
   neighbors just got padded with fabricated blank cells instead of being
   recognized as a genuine colSpan).
     1. Collect every whitespace-split cell from every line in the run.
     2. Cluster their start-x positions into GLOBAL column bands shared by
        the whole run, not computed per line.
     3. Re-assign each line's cells to those bands; a cell whose text
        extends past its band's right edge into the next band(s) becomes a
        real gridSpan instead of an isolated one-off cell.
     4. Bands with no content on a given row still get an empty <w:tc> -
        never silently dropped.
     5. Score confidence from (a) how many rows assign cleanly with no
        overlap collisions and (b) how many bands are actually reused
        across most rows (guards against a couple of coincidentally
        wide-spaced lines - e.g. a normal paragraph with aligned numbers -
        being mistaken for a table). Below threshold, return null so the
        caller falls back to ordinary paragraphs.
   No vertical-merge inference here (unlike the ruling-line path): a blank
   borderless cell has no positive evidence distinguishing "genuinely
   empty" from "merged with the cell above," and guessing wrong would
   corrupt real tabular data, so it's always left as an empty cell. */
function buildBorderlessTable(run, pageWidth){
  if(run.length < 2) return null;
  const allCells = [];
  run.forEach((line, li)=>{
    line.cells.forEach(c=>{ if(c.text) allCells.push({text:c.text, x:c.x, xEnd:c.xEnd, li}); });
  });
  if(allCells.length < 4) return null;

  const avgSize = run.reduce((s,l)=>{ const it=l.items.find(i=>i.str.trim()); return s+(it?it.size:10); }, 0) / run.length;
  const tolerance = Math.max(10, avgSize*1.3);
  const bandXs = clusterVals(allCells.map(c=>c.x), tolerance).sort((a,b)=>a-b);
  if(bandXs.length < 2) return null;
  const nCols = bandXs.length;
  const bandRight = bandXs.map((x,i)=>{
    if(i+1 < bandXs.length) return (x + bandXs[i+1]) / 2;
    const inBand = allCells.filter(c=>c.x >= x-tolerance);
    return Math.max(x+20, ...inBand.map(c=>c.xEnd));
  });
  function bandIndexForX(x){
    let best=0, bestD=Infinity;
    bandXs.forEach((bx,i)=>{ const d=Math.abs(bx-x); if(d<bestD){ bestD=d; best=i; } });
    return best;
  }

  const rowSlotsAll = []; // per row: array[nCols] of null | "SPANNED" | {text,span,x,xEnd}
  let cleanRows = 0;
  const bandUsedInRow = bandXs.map(()=>0);
  run.forEach((line, li)=>{
    const lineCells = allCells.filter(c=>c.li===li).sort((a,b)=>a.x-b.x);
    const rowSlots = new Array(nCols).fill(null);
    let collision = false;
    const usedBandsThisRow = new Set();
    lineCells.forEach(c=>{
      const startIdx = bandIndexForX(c.x);
      let endIdx = startIdx;
      for(let k=startIdx+1; k<nCols; k++){
        if(c.xEnd > bandRight[k-1] + tolerance*0.3) endIdx = k; else break;
      }
      const existing = rowSlots[startIdx];
      if(existing === "SPANNED"){
        // This band is already claimed by an earlier cell's colSpan (e.g.
        // an unusually long value that visually bleeds into the next
        // column) - never silently discard the real text that landed
        // here, even though it means this one row's structure isn't
        // perfectly clean. Append it to whichever cell actually owns the
        // span.
        for(let k=startIdx-1; k>=0; k--){
          if(rowSlots[k] && rowSlots[k]!=="SPANNED"){ rowSlots[k].text += " " + c.text; rowSlots[k].xEnd = Math.max(rowSlots[k].xEnd, c.xEnd); break; }
        }
        collision = true;
        return;
      }
      if(existing){
        // Two cells resolved to the same band start - again, keep both
        // texts rather than dropping one.
        existing.text += " " + c.text;
        existing.xEnd = Math.max(existing.xEnd, c.xEnd);
        collision = true;
        return;
      }
      rowSlots[startIdx] = {text:c.text, span: endIdx-startIdx+1, x:c.x, xEnd:c.xEnd};
      for(let k=startIdx+1; k<=endIdx; k++){ rowSlots[k] = "SPANNED"; usedBandsThisRow.add(k); }
      usedBandsThisRow.add(startIdx);
    });
    if(!collision) cleanRows++;
    usedBandsThisRow.forEach(b=>bandUsedInRow[b]++);
    rowSlotsAll.push(rowSlots);
  });

  const collisionFreeFraction = cleanRows / run.length;
  const bandsWellUsed = bandUsedInRow.filter(count => count >= run.length*0.5).length;
  const bandCoverageScore = bandsWellUsed / nCols;
  const confidence = collisionFreeFraction * Math.max(bandCoverageScore, bandsWellUsed>=2 ? 0.6 : 0);
  if(confidence < 0.55 || bandsWellUsed < 2) return null;

  // Safe vertical-merge detection. Borderless tables have no ruling-line
  // evidence, so a blank cell alone is NEVER enough (it's usually just a
  // genuinely empty value) - a merge is only inferred when ALL of these
  // independent signals agree simultaneously:
  //   1. the upper cell has real text;
  //   2. the lower cell is a TRUE empty slot (not text, not a colSpan
  //      continuation);
  //   3. the row below is not fully blank elsewhere (rules out merging
  //      across a genuinely blank row);
  //   4. the row above is a genuine data row too (has other content);
  //   5. the column behaves like a label column - left-positioned and/or
  //      predominantly non-numeric across the whole table (a blank in a
  //      numeric value column needs the same evidence bar, but is
  //      structurally rare to satisfy honestly since numeric columns
  //      seldom repeat identical unrelated values);
  //   6. both rows share real, DIFFERING content in some OTHER column -
  //      proof they're two distinct genuine data rows forming a matched
  //      pair (e.g. a "Rate" row and an "Amount" row), not coincidence.
  // Conservative on purpose: only ever merges one row into the row
  // immediately below it, never chains multiple rows, and a row that is
  // itself a merge continuation can never become a new merge owner.
  function isNumericText(t){ return /^-?[\d,]+\.?\d*%?$/.test((t||"").trim()); }
  const colStats = bandXs.map((_,c)=>{
    const texts = rowSlotsAll.map(row => (row[c] && row[c]!=="SPANNED") ? row[c].text : null).filter(t=>t!=null && t.trim());
    const numeric = texts.filter(isNumericText).length;
    return {nonNumericFraction: texts.length ? 1-(numeric/texts.length) : 0, populatedFraction: texts.length/rowSlotsAll.length};
  });
  function isLabelLikeColumn(c){
    const positionRatio = nCols>1 ? c/(nCols-1) : 0;
    const labelish = positionRatio <= 0.35 || colStats[c].nonNumericFraction >= 0.6;
    if(!labelish) return false;
    // A column used in only a handful of rows out of a much larger table
    // is not an established, trustworthy label column - it's more likely
    // a one-off artifact from a single oddly-positioned line (confirmed:
    // a real false positive on the real bill's 12-row "Calculation
    // Details" table came from a column populated in exactly 1 of 12
    // rows - a fragment of a multi-row bilingual header, not a genuine
    // repeating label column like the real Energy Charges/Fixed Demand
    // Charges cases, which are populated across roughly half the table's
    // rows). Fraction-based (not an absolute row count) so this doesn't
    // penalize small tables, where even a genuine 2-row label/continuation
    // pair only ever populates the label column in 1 of 2 rows (50%).
    //
    // Symmetric upper bound: a column populated in MOST rows is a column
    // where every entry normally carries its own label - an isolated blank
    // in that column is more likely a genuine data gap (missing/unreadable
    // value on an otherwise-standalone row) than evidence of a repeating
    // label-spans-2-rows pattern. Confirmed with a synthetic stress test
    // (5 independent single-row entries, one deliberately missing its own
    // label for an unrelated reason): without this bound, the row above it
    // gets a false rowSpan, silently absorbing an unrelated row's data
    // under the wrong label. Every genuine merge case measured so far
    // (single pairs and repeating pairs alike) sits at exactly 50% -
    // label populated in 1 of every 2 rows, by construction of the
    // label-row/continuation-row pattern itself - so 0.7 leaves real
    // headroom above that while still excluding the ~0.83 false case.
    // Not a claim this generalizes to every possible mixed table (a table
    // interleaving many standalone rows with a few genuine merges could
    // still push the fraction past 0.7) - only that it's strictly safer
    // than no upper bound at all, on every case tested.
    return colStats[c].populatedFraction >= 0.15 && colStats[c].populatedFraction <= 0.7;
  }
  const mergedFrom = rowSlotsAll.map(()=>new Array(nCols).fill(false));
  const ownerRowSpan = rowSlotsAll.map(()=>new Array(nCols).fill(1));
  for(let r=0; r<rowSlotsAll.length-1; r++){
    // Collect ALL merge-eligible columns for this row pair first, then
    // only commit them if the count is sparse (<=2). A genuine "one label
    // spans a 2-row entry" pattern (Energy Charges, Fixed/Demand Charges)
    // only ever affects the label column(s) - a row pair where MANY
    // columns simultaneously look mergeable is a sign of something else
    // entirely: a messy multi-row bilingual header block sharing an
    // interleaved row-split (confirmed against this exact table's header,
    // which triggered 4 simultaneous column "matches" purely as an
    // artifact of Hindi/English baseline splitting, not a real vertical
    // merge - caught by inspection and blocked by this cap rather than by
    // hardcoding anything about headers specifically).
    const candidates = [];
    for(let c=0; c<nCols; c++){
      if(mergedFrom[r][c]) continue; // a continuation row can't itself own a further merge (no chaining)
      const upper = rowSlotsAll[r][c];
      const lower = rowSlotsAll[r+1][c];
      if(!upper || upper==="SPANNED" || !upper.text || !upper.text.trim()) continue;
      if(lower !== null) continue;
      if(!isLabelLikeColumn(c)) continue;
      const rowBelowHasOther = rowSlotsAll[r+1].some((s,ci)=> ci!==c && s && s!=="SPANNED" && s.text && s.text.trim());
      if(!rowBelowHasOther) continue;
      const rowAboveHasOther = rowSlotsAll[r].some((s,ci)=> ci!==c && s && s!=="SPANNED" && s.text && s.text.trim());
      if(!rowAboveHasOther) continue;
      // Decisive signal: the row below must NOT have its own content in
      // the table's primary (leftmost) label column - if it does, it's
      // clearly an independent new entry with its own label (e.g. the
      // next charge type's row), not a continuation of this one, no
      // matter what else lines up. This single check is what actually
      // separates the real cases from a false one: an earlier version of
      // this algorithm instead required the two rows to share differing
      // text in some other overlapping column as "proof" of a genuine
      // pair - that fired on totally unrelated adjacent rows whenever
      // their numeric columns happened to overlap (nearly always true,
      // since amounts differ row to row) while MISSING the real Energy
      // Charges / Fixed Demand Charges cases (their Rate row and Amount
      // row populate different column positions by table design, so they
      // never share an overlapping populated column at all). Caught by
      // direct inspection against the real bill before shipping.
      const rowBelowOwnLabel = rowSlotsAll[r+1][0];
      const rowBelowHasOwnLabel = rowBelowOwnLabel && rowBelowOwnLabel!=="SPANNED" && rowBelowOwnLabel.text && rowBelowOwnLabel.text.trim();
      if(rowBelowHasOwnLabel) continue;
      candidates.push(c);
    }
    // Only ever commit the single LEFTMOST candidate (the primary/
    // description column) - a genuine label-spans-2-rows entry has
    // exactly one such column; a secondary early column that also
    // technically qualifies (e.g. a "sub-label" like "Energy" sitting
    // next to the real label, or a short numeric value that happens to
    // sit in the first ~35% of the table width) is real evidence for the
    // primary label but not independently trustworthy on its own, so it's
    // left unmerged rather than guessed at - safe, not lossy, just less
    // complete. A row pair with an implausibly large number of
    // simultaneous candidates (>3) skips merging entirely, since that
    // pattern only showed up on this table's messy multi-row bilingual
    // header block, never on a genuine data-row pair (confirmed by
    // inspection: real cases always produced 1-2 candidates, the header
    // produced 4).
    if(candidates.length >= 1 && candidates.length <= 3){
      const c = candidates[0];
      mergedFrom[r+1][c] = true;
      ownerRowSpan[r][c] = 2;
    }
  }

  const cells = [];
  rowSlotsAll.forEach((rowSlots, r)=>{
    for(let c=0; c<nCols; c++){
      if(mergedFrom[r][c]) continue; // swallowed into the owner cell directly above
      const slot = rowSlots[c];
      if(slot === "SPANNED") continue;
      if(slot === null){ cells.push({r0:r, c0:c, rowSpan:1, colSpan:1, text:"", align:"left", padLeftPt:4}); continue; }
      const bandLeft = bandXs[c], bandRightEdge = bandRight[c+slot.span-1];
      const cellWidth = bandRightEdge - bandLeft;
      const leftGap = slot.x - bandLeft, rightGap = bandRightEdge - slot.xEnd;
      let align = "left";
      if(rightGap < cellWidth*0.08 && leftGap > cellWidth*0.15) align = "right";
      else if(leftGap > cellWidth*0.15 && rightGap > cellWidth*0.15 && Math.abs(leftGap-rightGap) < cellWidth*0.12) align = "center";
      // No independent row-height geometry exists for borderless/gap
      // tables (unlike ruling-line tables, which have real row
      // boundaries), so vertical alignment can't be measured here -
      // left unset, which renders as Word's own default (top).
      const padLeftPt = align === "left" ? Math.max(2, Math.min(14, leftGap)) : 4;
      cells.push({r0:r, c0:c, rowSpan: ownerRowSpan[r][c], colSpan:slot.span, text: fixDevanagari(slot.text), align, padLeftPt});
    }
  });

  // Approximate row boundaries for cell-image matching. Borderless tables
  // have no independent row-height geometry (unlike ruling-line tables,
  // which have real horizontal rules) - each row is really just "the line
  // at this y", so boundaries are synthesized as the midpoint between
  // consecutive line y's, with the top/bottom edges extrapolated by the
  // same gap as the nearest real gap. Good enough to classify which row
  // an image's vertical center falls into; not claimed to be the PDF's
  // actual (nonexistent) row-height geometry.
  const rowYCenters = run.map(l=>l.y);
  let rowBounds;
  if(rowYCenters.length === 1){
    rowBounds = [rowYCenters[0]+8, rowYCenters[0]-8];
  } else {
    rowBounds = [rowYCenters[0] + (rowYCenters[0]-rowYCenters[1])];
    for(let r=0;r<rowYCenters.length-1;r++) rowBounds.push((rowYCenters[r]+rowYCenters[r+1])/2);
    rowBounds.push(rowYCenters[rowYCenters.length-1] - (rowYCenters[rowYCenters.length-2]-rowYCenters[rowYCenters.length-1]));
  }

  return {
    nRows: rowSlotsAll.length, nCols, cells,
    colWidthsPt: bandXs.map((x,i)=>bandRight[i]-x),
    colBounds: bandXs.concat([bandRight[bandRight.length-1]]), rowBounds,
    confidence
  };
}

/* Single pass over the page's operator list that tracks the CTM plus the
   current fill/stroke color and line width, extracting three things at
   once (one getOperatorList() walk instead of three separate ones):
     - images: embedded raster images (logo, QR codes) with placement.
     - shapes: filled/stroked rectangles - real vector boxes/borders/
       separator lines/underlines drawn as thin rects, not text.
     - colorSpans: the fill color active at each text-matrix-set point
       (Tm x CTM), i.e. the same (x,y) space getTextContent() itself
       reports per item, so a run's real color can later be found by
       proximity - getTextContent() has no color info of its own since
       PDF text color is graphics-state, not a text-content property. */
async function extractPageVisuals(pdoc, pageNum){
  const page = await pdoc.getPage(pageNum);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const images = [], shapes = [], colorSpans = [];
  let stack = [[1,0,0,1,0,0]];
  let fillColor = [0,0,0], strokeColor = [0,0,0], lineWidth = 1, pendingPath = null, inTextObject = false;
  function mul(m, cur){
    return [
      m[0]*cur[0]+m[1]*cur[2], m[0]*cur[1]+m[1]*cur[3],
      m[2]*cur[0]+m[3]*cur[2], m[2]*cur[1]+m[3]*cur[3],
      m[4]*cur[0]+m[5]*cur[2]+cur[4], m[4]*cur[1]+m[5]*cur[3]+cur[5]
    ];
  }
  function apply(m, x, y){ return [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]]; }
  for(let idx=0; idx<opList.fnArray.length; idx++){
    const fn = opList.fnArray[idx];
    const args = opList.argsArray[idx];
    if(fn === OPS.save){ stack.push(stack[stack.length-1].slice()); }
    else if(fn === OPS.restore){ if(stack.length>1) stack.pop(); }
    else if(fn === OPS.transform){ stack[stack.length-1] = mul(args, stack[stack.length-1]); }
    else if(fn === OPS.setFillRGBColor){ fillColor = [args[0],args[1],args[2]]; }
    else if(fn === OPS.setStrokeRGBColor){ strokeColor = [args[0],args[1],args[2]]; }
    else if(fn === OPS.setLineWidth){ lineWidth = args[0]; }
    else if(fn === OPS.beginText){ inTextObject = true; }
    else if(fn === OPS.endText){ inTextObject = false; }
    else if(fn === OPS.setTextMatrix){
      const m = mul(args, stack[stack.length-1]);
      colorSpans.push({x:m[4], y:m[5], color:fillColor.slice()});
    }
    else if(fn === OPS.constructPath){ pendingPath = args; }
    else if(fn===OPS.fill || fn===OPS.eoFill || fn===OPS.stroke || fn===OPS.fillStroke || fn===OPS.eoFillStroke){
      // Some PDFs (this bill's Devanagari included) render glyphs as
      // filled vector paths inside a BT/ET text object rather than as
      // standard font glyphs - those show up in the operator list as
      // ordinary constructPath+fill calls, indistinguishable from a real
      // background box at the OPS level alone. Skip anything drawn while
      // inside a text object so glyph outlines never get misread as
      // decorative boxes (confirmed root cause of large solid-black
      // "boxes" showing up on pages with vector-drawn Devanagari text).
      if(pendingPath){
        if(!inTextObject){
          const coords = pendingPath[1];
          const m = stack[stack.length-1];
          let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
          for(let k=0; k+1<coords.length; k+=2){
            const [px,py] = apply(m, coords[k], coords[k+1]);
            if(px<minX) minX=px; if(px>maxX) maxX=px; if(py<minY) minY=py; if(py>maxY) maxY=py;
          }
          if(isFinite(minX) && maxX>=minX && maxY>=minY){
            const doFill = fn===OPS.fill||fn===OPS.eoFill||fn===OPS.fillStroke||fn===OPS.eoFillStroke;
            const doStroke = fn===OPS.stroke||fn===OPS.fillStroke||fn===OPS.eoFillStroke;
            shapes.push({x:minX, y:minY, w:maxX-minX, h:maxY-minY, fill: doFill?fillColor.slice():null, stroke: doStroke?strokeColor.slice():null, lineWidth});
          }
        }
        pendingPath = null;
      }
    }
    else if(fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject){
      const objId = args[0];
      const m = stack[stack.length-1];
      const w = Math.hypot(m[0], m[1]), h = Math.hypot(m[2], m[3]);
      if(w < 8 || h < 8) continue; // skip tiny/decorative artifacts
      try{
        const img = await page.objs.get(objId);
        if(img && (img.data || img.bitmap)) images.push({x:m[4], y:m[5], width:w, height:h, raw:img});
      }catch(e){ /* unresolved image object - skip it */ }
    }
  }
  return {images, shapes, colorSpans};
}
function rgbToHex(rgb){
  return rgb.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0")).join("").toUpperCase();
}
function nearestColor(colorSpans, x, y, maxDist){
  let best=null, bestD=maxDist*maxDist;
  for(const c of colorSpans){
    const dx=c.x-x, dy=c.y-y, d=dx*dx+dy*dy;
    if(d<=bestD){ bestD=d; best=c.color; }
  }
  return best;
}
/* page.commonObjs font descriptors expose a reliable generic family via
   .fallbackName ("serif"/"sans-serif"/"monospace") even when the real
   embedded font can't be identified/embedded - map that to a Word-safe
   equivalent instead of forcing every run onto one generic font. */
function mapFontFamily(fallbackName){
  if(fallbackName === "serif") return "Times New Roman";
  if(fallbackName === "monospace") return "Consolas";
  return "Calibri";
}
function pdfImageToPngBase64(img){
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if(img.bitmap){
    ctx.drawImage(img.bitmap, 0, 0, img.width, img.height);
  } else {
    const imgData = ctx.createImageData(img.width, img.height);
    const src = img.data;
    if(img.kind === 3){ // RGBA_32BPP
      imgData.data.set(src);
    } else if(img.kind === 2){ // RGB_24BPP
      for(let p=0, s=0; p<imgData.data.length; p+=4, s+=3){
        imgData.data[p]=src[s]; imgData.data[p+1]=src[s+1]; imgData.data[p+2]=src[s+2]; imgData.data[p+3]=255;
      }
    } else { // grayscale/unknown - best-effort
      for(let p=0, s=0; p<imgData.data.length; p+=4, s++){
        const v = src[s]||0; imgData.data[p]=v; imgData.data[p+1]=v; imgData.data[p+2]=v; imgData.data[p+3]=255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }
  return canvasToPngBase64(canvas);
}

/* Matches page-level images against gridtable cells by pure geometry: an
   image whose center point falls within a cell's colBounds/rowBounds
   range (both derived from real table geometry - ruling-line rules or
   the borderless column-band model) is visually "inside" that cell, so
   it's moved from the flat page-image list into cell.images and
   rendered as part of the table instead of floating as a separate
   anchored/centered block. Only gridtable blocks that expose colBounds/
   rowBounds are considered; images that don't land inside any cell are
   returned unchanged for the existing page-level placement path.
   pageImages entries are the {type:"image", xPt, _y, widthPt, heightPt,
   ...} shape built by TOOLS.pdf2word/test harnesses - xPt/_y are the
   PDF-space (y-up) bottom-left corner, matching colBounds/rowBounds'
   coordinate space. */
function embedImagesIntoTableCells(pageBlocks, pageImages){
  const gridtables = pageBlocks.filter(b=>b.type==="gridtable" && b.colBounds && b.rowBounds);
  const unmatched = [];
  for(const im of pageImages){
    const cx = im.xPt + im.widthPt/2;
    const cy = im._y + im.heightPt/2;
    let placed = false;
    for(const tbl of gridtables){
      const {colBounds, rowBounds, nCols, nRows, cells} = tbl;
      if(cx < colBounds[0] || cx > colBounds[nCols]) continue;
      if(cy > rowBounds[0] || cy < rowBounds[nRows]) continue;
      let c = -1;
      for(let i=0;i<nCols;i++){ if(cx >= colBounds[i] && cx <= colBounds[i+1]){ c=i; break; } }
      let r = -1;
      for(let i=0;i<nRows;i++){ if(cy <= rowBounds[i] && cy >= rowBounds[i+1]){ r=i; break; } }
      if(c===-1 || r===-1) continue;
      const cell = cells.find(cl=> r>=cl.r0 && r<cl.r0+cl.rowSpan && c>=cl.c0 && c<cl.c0+cl.colSpan);
      if(!cell) continue;
      // A center point landing inside a cell isn't enough on its own - a
      // large background/watermark graphic spanning the whole table can
      // have its center coincidentally fall inside one cell's bounds
      // without actually being "inside" that cell at all (real-bill page
      // 1 has exactly this: a 561x155pt background wash behind the entire
      // summary table, center landing in one cell). Require the image to
      // actually fit within (a modest margin over) the matched cell's own
      // real geometry, not just have a center point that lands there.
      const cellWidthPt = colBounds[cell.c0+cell.colSpan] - colBounds[cell.c0];
      const cellHeightPt = rowBounds[cell.r0] - rowBounds[cell.r0+cell.rowSpan];
      if(im.widthPt > cellWidthPt*1.3 || im.heightPt > cellHeightPt*1.3) continue;
      if(!cell.images) cell.images = [];
      cell.images.push({pngBase64: im.pngBase64, width: im.width, height: im.height, widthPt: im.widthPt, heightPt: im.heightPt});
      placed = true;
      break;
    }
    if(!placed) unmatched.push(im);
  }
  return unmatched;
}

/* ============================================================
   PDF -> WORD: DOCX RENDERING LAYER
   ============================================================
   Everything from here to buildMixedDocx consumes the document model
   described in the DOCUMENT MODEL comment above linesToParagraphs and
   turns it into OOXML strings. This is the ONLY part of the pipeline that
   knows DOCX exists - no function above this point (in the detection
   layer) should be modified to fix a rendering problem, and no function
   here should be modified to fix a geometry/detection problem. If a bug
   spans both (e.g. a field the detection layer forgot to set), fix the
   detection layer's output shape, not this layer's handling of a missing
   field. ============================================================ */

/* Word's default document font (Calibri, and most other Latin fonts) has
   no Devanagari glyphs, so any run containing Devanagari codepoints needs
   an explicit complex-script font declared or it can render as tofu/boxes
   in some Word installations. Nirmala UI ships with Windows 10+ and Office
   and is the standard system font for Devanagari, so it's a safe default
   without needing to embed the source PDF's actual (likely unlicensed for
   embedding) font. */
function runFontsXml(text, fontFamily){
  const isDev = DEVANAGARI_RE.test(text);
  if(isDev && fontFamily) return `<w:rFonts w:ascii="${fontFamily}" w:hAnsi="Nirmala UI" w:cs="Nirmala UI"/>`;
  if(isDev) return `<w:rFonts w:cs="Nirmala UI" w:hAnsi="Nirmala UI"/>`;
  if(fontFamily) return `<w:rFonts w:ascii="${fontFamily}" w:hAnsi="${fontFamily}"/>`;
  return "";
}
/* Shared run renderer used both by top-level paragraphs and by table
   cells that contain multiple original PDF lines (see gridTableBlockXml)
   - a run with isBreak:true is a detected intentional hard line break
   (see linesToParagraphs), rendered as a real <w:br/> inside the SAME
   paragraph/cell rather than as a separate paragraph. */
function runsToXml(runs){
  return runs.map(r=>{
    if(r.isBreak) return `<w:r><w:br/></w:r>`;
    if(!r.text) return "";
    const fixed = fixDevanagari(r.text);
    const rPr = [runFontsXml(fixed, r.fontFamily)];
    if(r.bold) rPr.push("<w:b/>");
    if(r.italic) rPr.push("<w:i/>");
    if(r.underline) rPr.push(`<w:u w:val="single"/>`);
    // Skip near-black (nothing gained, it's the default) and near-white
    // (would render as invisible text on the page's white background,
    // since a matching dark cell shading isn't guaranteed to line up).
    if(r.color && !(r.color[0]<20 && r.color[1]<20 && r.color[2]<20) && !(r.color[0]>235 && r.color[1]>235 && r.color[2]>235)){
      rPr.push(`<w:color w:val="${rgbToHex(r.color)}"/>`);
    }
    if(r.size) rPr.push(`<w:sz w:val="${Math.max(2, Math.round(r.size*2))}"/>`); // DOCX sizes are half-points
    const rPrXml = rPr.join("") ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
    return `<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(fixed)}</w:t></w:r>`;
  }).join("");
}
function styledParagraphXml(block){
  const runsXml = runsToXml(block.runs);
  const pPrParts = [];
  if(block.listItem) pPrParts.push(`<w:ind w:left="720"/>`);
  if(block.align && block.align!=="left") pPrParts.push(`<w:jc w:val="${block.align}"/>`);
  // Both paragraph-to-paragraph spacing (before) and intra-paragraph
  // line spacing (line/lineRule) live on the SAME <w:spacing> element -
  // OOXML only allows one per pPr, so they're merged here rather than
  // emitted as two separate elements (which would be invalid).
  const spacingAttrs = [];
  if(block.spacingBeforePt) spacingAttrs.push(`w:before="${Math.round(block.spacingBeforePt*20)}"`);
  if(block.lineSpacingPt) spacingAttrs.push(`w:line="${Math.max(1, Math.round(block.lineSpacingPt*20))}" w:lineRule="atLeast"`);
  if(spacingAttrs.length) pPrParts.push(`<w:spacing ${spacingAttrs.join(" ")}/>`);
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runsXml}</w:p>`;
}
/* block.rows is an array of rows, each row an array of {text, span} cells
   (span>1 = a real gridSpan, e.g. a section-title row spanning the whole
   table width - see extractPageBlocks). */
function tableBlockXml(block){
  const cols = block.rows.reduce((m,r)=>Math.max(m, r.reduce((s,c)=>s+(c.span||1),0)), 1);
  const gridCols = Array.from({length:cols}).map(()=>`<w:gridCol/>`).join("");
  const borderColor = block.borderHex || "BFBFBF";
  const border = `<w:top w:val="single" w:sz="4" w:color="${borderColor}"/><w:left w:val="single" w:sz="4" w:color="${borderColor}"/><w:bottom w:val="single" w:sz="4" w:color="${borderColor}"/><w:right w:val="single" w:sz="4" w:color="${borderColor}"/>`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";
  const rowsXml = block.rows.map(row=>{
    const cellsXml = row.map(cell=>{
      const cellText = cell.text || "";
      const t = escapeXml(cellText);
      const spanXml = cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : "";
      return `<w:tc><w:tcPr><w:tcBorders>${border}</w:tcBorders>${shd}${spanXml}<w:tcMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:r><w:rPr>${runFontsXml(cellText, null)}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p></w:tc>`;
    }).join("");
    return `<w:tr>${cellsXml}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}<w:insideH w:val="single" w:sz="4" w:color="${borderColor}"/><w:insideV w:val="single" w:sz="4" w:color="${borderColor}"/></w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}
/* Real ruling-line table with true row/col spans (see
   detectRulingGridTable). Unlike tableBlockXml's auto-width gap-detected
   tables, this one carries real column widths from the PDF geometry and
   uses fixed layout so Word doesn't freely resize columns, plus true
   <w:vMerge> for vertical spans (tableBlockXml only ever produces
   horizontal gridSpan, since gap-detection alone can't reliably tell
   "genuinely blank cell" apart from "vertically merged cell"). */
/* Shared by buildMixedDocx's top-level image blocks AND gridTableBlockXml's
   cell-embedded images: registers one image into the zip's media folder +
   relationships list and returns the <pic:pic> XML plus its final EMU
   size. zipCtx = {mediaFolder, relEntries, counters:{relCounter,
   imgCounter}} - counters is a mutable object (not primitives) so both
   call sites share one running id sequence, which is required since
   relationship ids must be unique across the whole document.xml.rels. */
function buildPictureXml(im, zipCtx, maxWidthEmu){
  zipCtx.counters.imgCounter++; zipCtx.counters.relCounter++;
  const relId = "rId"+zipCtx.counters.relCounter;
  const imgCounter = zipCtx.counters.imgCounter;
  const fname = `image${imgCounter}.png`;
  zipCtx.mediaFolder.file(fname, im.pngBase64, {base64:true});
  zipCtx.relEntries.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fname}"/>`);
  let cx = im.widthPt!=null ? Math.round(im.widthPt*12700) : pxToEmu(im.width);
  let cy = im.heightPt!=null ? Math.round(im.heightPt*12700) : pxToEmu(im.height);
  if(maxWidthEmu && cx > maxWidthEmu){ const ratio = maxWidthEmu/cx; cx = maxWidthEmu; cy = Math.round(cy*ratio); }
  const picXml = `<pic:pic><pic:nvPicPr><pic:cNvPr id="${imgCounter}" name="Picture ${imgCounter}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`;
  return {picXml, cx, cy, imgCounter, relId};
}
function inlinePictureParagraphXml(im, zipCtx, maxWidthEmu){
  const {picXml, cx, cy, imgCounter} = buildPictureXml(im, zipCtx, maxWidthEmu);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function gridTableBlockXml(block, zipCtx){
  const colWidthsTwips = block.colWidthsPt.map(w=>Math.max(1, Math.round(w*20)));
  const totalTwips = colWidthsTwips.reduce((a,b)=>a+b, 0);
  const gridCols = colWidthsTwips.map(w=>`<w:gridCol w:w="${w}"/>`).join("");
  const borderColor = block.borderHex || "000000";
  const border = `<w:top w:val="single" w:sz="4" w:color="${borderColor}"/><w:left w:val="single" w:sz="4" w:color="${borderColor}"/><w:bottom w:val="single" w:sz="4" w:color="${borderColor}"/><w:right w:val="single" w:sz="4" w:color="${borderColor}"/>`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";

  const occ = Array.from({length:block.nRows}, ()=>new Array(block.nCols).fill(null));
  block.cells.forEach(cell=>{
    for(let r=cell.r0; r<cell.r0+cell.rowSpan; r++)
      for(let c=cell.c0; c<cell.c0+cell.colSpan; c++)
        occ[r][c] = cell;
  });

  let rowsXml = "";
  for(let r=0; r<block.nRows; r++){
    let rowXml = "";
    let c = 0;
    while(c < block.nCols){
      const cell = occ[r][c];
      if(!cell || cell.c0 !== c){ c++; continue; }
      const cellWidthTwips = colWidthsTwips.slice(cell.c0, cell.c0+cell.colSpan).reduce((a,b)=>a+b, 0);
      const tcW = `<w:tcW w:w="${cellWidthTwips}" w:type="dxa"/>`;
      const spanXml = cell.colSpan > 1 ? `<w:gridSpan w:val="${cell.colSpan}"/>` : "";
      if(cell.r0 === r){
        const vMergeXml = cell.rowSpan > 1 ? `<w:vMerge w:val="restart"/>` : "";
        const t = escapeXml(cell.text || "");
        const jcXml = cell.align && cell.align!=="left" ? `<w:jc w:val="${cell.align}"/>` : "";
        const vAlignXml = cell.vAlign && cell.vAlign!=="top" ? `<w:vAlign w:val="${cell.vAlign}"/>` : "";
        const padLeftTwips = Math.round((cell.padLeftPt!=null ? cell.padLeftPt : 4) * 20);
        // Ruling-grid cells carry real per-line runs (built by
        // linesToParagraphs, including any detected hard line breaks
        // between original PDF lines) - use those directly instead of
        // the flattened plain-text fallback (only used by borderless/
        // gap-detected cells, which are always single-line by
        // construction so there's no line structure to preserve there).
        const cellContentXml = (cell.runs && cell.runs.length) ? runsToXml(cell.runs) : `<w:r><w:rPr>${runFontsXml(cell.text||"", null)}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
        // A cell with matched images (embedImagesIntoTableCells) renders
        // them as their own inline paragraph(s) after the text paragraph,
        // capped to the cell's own width in EMU so a real-size photo
        // doesn't blow out the column - a plain visual constraint, not a
        // content-specific rule.
        let cellImagesXml = "";
        if(zipCtx && cell.images && cell.images.length){
          const cellMaxWidthEmu = Math.max(1, cellWidthTwips - 8) * 635;
          cellImagesXml = cell.images.map(im=>inlinePictureParagraphXml(im, zipCtx, cellMaxWidthEmu)).join("");
        }
        rowXml += `<w:tc><w:tcPr>${tcW}<w:tcBorders>${border}</w:tcBorders>${shd}${spanXml}${vMergeXml}${vAlignXml}<w:tcMar><w:left w:w="${padLeftTwips}" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr><w:p>${jcXml?`<w:pPr>${jcXml}</w:pPr>`:""}${cellContentXml}</w:p>${cellImagesXml}</w:tc>`;
      } else {
        rowXml += `<w:tc><w:tcPr>${tcW}<w:tcBorders>${border}</w:tcBorders>${shd}${spanXml}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
      }
      c += cell.colSpan;
    }
    rowsXml += `<w:tr>${rowXml}</w:tr>`;
  }
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalTwips}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}<w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}
function columnsBlockXml(block){
  const leftXml = block.left.map(styledParagraphXml).join("") || "<w:p/>";
  const rightXml = block.right.map(styledParagraphXml).join("") || "<w:p/>";
  const noBorder = `<w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/>`;
  const shd = block.shadeHex ? `<w:shd w:val="clear" w:fill="${block.shadeHex}"/>` : "";
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${noBorder}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr>${shd}</w:tcPr>${leftXml}</w:tc><w:tc><w:tcPr>${shd}</w:tcPr>${rightXml}</w:tc></w:tr></w:tbl>`;
}
/* A vector-drawn rule with no text attached to it (page/section divider,
   e.g. the line under a heading or between report sections) - approximated
   as a paragraph-level bottom border since DOCX has no bare "draw a line
   here" primitive outside of drawing canvases/shapes. */
function separatorBlockXml(){
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>`;
}
/* Detects table columns using pdf.js's synthetic whitespace items rather
   than joining all text into one string and guessing from literal
   multi-space characters (the old approach - unreliable, since many
   table-generating PDFs never embed literal multi-space runs; the visual
   gap between columns comes purely from each cell's text being positioned
   separately, not from spacing characters). Verified empirically first:
   pdf.js inserts a space-only text item to fill the gap between two
   separately-positioned runs, and that item's own `width` IS the actual
   visual gap size in PDF points - a gap noticeably wider than normal
   single/double inter-word spacing reliably signals a real column
   boundary. */
function extractTableRows(content){
  const lineTolerance = 3;
  const lines = [];
  for(const it of content.items){
    const x = it.transform[4], y = it.transform[5];
    let line = lines.find(l => Math.abs(l.y - y) <= lineTolerance);
    if(!line){ line = {y, items:[]}; lines.push(line); }
    line.items.push({str: it.str, x, width: it.width || 0, size: Math.abs(it.transform[0]) || 10});
  }
  lines.sort((a,b)=> b.y - a.y); // PDF y grows upward - top of page first
  lines.forEach(l => l.items.sort((a,b)=>a.x-b.x));

  return lines.map(line => {
    const cells = [];
    let current = "";
    for(const item of line.items){
      const isColumnGap = item.str.trim()==="" && item.width > Math.max(10, item.size*1.2);
      if(isColumnGap && current.trim()){
        cells.push(current.trim());
        current = "";
      } else {
        current += item.str;
      }
    }
    if(current.trim()) cells.push(current.trim());
    return cells.length ? cells : [""];
  });
}
async function buildBasicDocx(paragraphs){
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const bodyParas = paragraphs.map(p=>{
    if(!p.trim()) return `<w:p/>`;
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`;
  }).join("");
  zip.folder("word").file("document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyParas}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body>
</w:document>`);
  zip.folder("word").folder("_rels").file("document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

/* ---- DOCX builder that mixes embedded page images ---- */
function pxToEmu(px, dpi=96){ return Math.round(px * 914400 / dpi); }
const DEVANAGARI_RE = /[ऀ-ॿ]/;
/* DOCX page size mirrors the source PDF's actual page dimensions (1pt =
   20 twips) instead of always forcing A4, so Letter/Legal/custom sized
   (and landscape) PDFs don't get silently reflowed onto the wrong paper
   size. Margins scale down on very small custom pages so they can't
   exceed half the page in either dimension. Used both for the document's
   final (body-level) section and for any mid-document section breaks
   inserted where the source PDF's page size actually changes.
   headerRid/footerRid (when given) wire that section to the shared
   header1.xml/footer1.xml parts - DOCX only supports ONE header/footer
   pair per document in this implementation (applied to every section),
   which matches the common case (a header/footer that's the same content
   repeated on every page) rather than per-section headers. */
function sectPrXml(sizeObj, headerRid, footerRid){
  let pgW = 11906, pgH = 16838, orient = "";
  if(sizeObj && sizeObj.widthPt && sizeObj.heightPt){
    pgW = Math.round(sizeObj.widthPt*20);
    pgH = Math.round(sizeObj.heightPt*20);
    if(pgW > pgH) orient = ' w:orient="landscape"';
  }
  const margin = Math.max(360, Math.min(1417, Math.floor(Math.min(pgW,pgH)/2) - 200));
  const refs = (headerRid ? `<w:headerReference w:type="default" r:id="${headerRid}"/>` : "")
    + (footerRid ? `<w:footerReference w:type="default" r:id="${footerRid}"/>` : "");
  return `<w:sectPr>${refs}<w:pgSz w:w="${pgW}" w:h="${pgH}"${orient}/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}"/></w:sectPr>`;
}

/* Whether a block (of ANY type - paragraph, table, gridtable, columns)
   carries real, non-whitespace text. Used to decide whether a page has
   extractable content at all (vs. needing the whole-page-screenshot
   fallback) - checking only paragraph-type blocks here was a real bug,
   since a page whose entire content is a table has no paragraph blocks
   at all despite having plenty of real text. */
function blockHasRealText(b){
  if(!b) return false;
  if(b.type === "paragraph") return b.runs.some(r=>r.text && r.text.trim());
  if(b.type === "table") return b.rows.some(row=>row.some(c=>c.text && c.text.trim()));
  if(b.type === "gridtable") return b.cells.some(c=>c.text && c.text.trim());
  if(b.type === "columns") return [...b.left, ...b.right].some(p=>p.runs.some(r=>r.text && r.text.trim()));
  return false;
}

/* Detects genuine repeating headers/footers across pages - promoted to
   real DOCX header/footer parts only when the exact same literal text
   (whitespace/case normalized, but NOT digit-masked) appears as the
   first (header candidate) or last (footer candidate) paragraph on a
   strong majority (>=60%, min 2) of pages. Ordinary one-off page content
   can never satisfy this - it requires real repetition across pages,
   not just position on one page.

   Deliberately requires LITERAL text equality, not a digit-masked
   pattern match ("Page 1 of 4" vs "Page 2 of 4" no longer count as "the
   same"). A real DOCX <w:ftr>/<w:hdr> can only ever hold ONE fixed,
   static text repeated verbatim on every page - there is no per-page
   substitution. Digit-masking was tried first (so genuine pagination
   footers would still be recognized as "repeating"), but it silently
   corrupts any per-page-varying content that happens to share a
   template: confirmed both on the intended pagination case itself (a
   real "Page 1 of 2"/"Page 2 of 2" footer pair got collapsed to a
   static footer reading "Page 1 of 2" on BOTH pages - page 2's real
   footer was deleted and replaced with the wrong page's text) and on a
   more damaging case (three pages with genuinely different subtotal
   amounts - "$120.00"/"$340.00"/"$275.50" - collapsed to a static
   footer showing "$120.00" on every page, silently overwriting two
   pages' real financial values). Requiring literal equality means a
   genuine pagination footer no longer gets auto-promoted to a running
   footer (a minor convenience loss), but no page's real, correct text
   can ever be silently deleted or replaced with another page's value -
   the right trade given data loss/corruption outranks a cosmetic
   nicety. */
function headerFooterNormText(block){
  if(!block || block.type !== "paragraph") return null;
  const t = block.runs.map(r=>r.text).join("").trim().toLowerCase();
  return t || null;
}
function detectHeaderFooter(pageBlocksList){
  if(pageBlocksList.length < 2) return {headerRuns:null, footerRuns:null};
  function majorityBlock(candidates){
    const counts = {};
    candidates.forEach(b=>{ const t=headerFooterNormText(b); if(t) counts[t]=(counts[t]||0)+1; });
    let best=null, bestCount=0;
    for(const k in counts){ if(counts[k]>bestCount){ bestCount=counts[k]; best=k; } }
    const threshold = Math.max(2, Math.ceil(candidates.length*0.6));
    if(!best || bestCount < threshold) return null;
    return candidates.find(b=>headerFooterNormText(b)===best);
  }
  const firsts = pageBlocksList.map(pb => pb.find(b=>b.type==="paragraph") || null);
  const lasts = pageBlocksList.map(pb => { const paras=pb.filter(b=>b.type==="paragraph"); return paras.length?paras[paras.length-1]:null; });
  const headerBlock = majorityBlock(firsts);
  const footerBlock = majorityBlock(lasts);
  // Remove the matched instances from every page's block list so the
  // content isn't duplicated in both the header/footer part AND the body.
  if(headerBlock){
    const pattern = headerFooterNormText(headerBlock);
    pageBlocksList.forEach(pb=>{ const idx=pb.findIndex(b=>headerFooterNormText(b)===pattern); if(idx>=0) pb.splice(idx,1); });
  }
  if(footerBlock){
    const pattern = headerFooterNormText(footerBlock);
    pageBlocksList.forEach(pb=>{ const idx=pb.findIndex(b=>headerFooterNormText(b)===pattern); if(idx>=0) pb.splice(idx,1); });
  }
  return {headerRuns: headerBlock ? headerBlock.runs : null, footerRuns: footerBlock ? footerBlock.runs : null};
}
async function buildMixedDocx(blocks, pageSize, headerFooter){
  const zip = new JSZip();
  const hasImages = blocks.some(b=>b.type==="image" || (b.type==="gridtable" && b.cells.some(c=>c.images && c.images.length)));
  const headerRuns = headerFooter && headerFooter.headerRuns;
  const footerRuns = headerFooter && headerFooter.footerRuns;

  const mediaFolder = zip.folder("word").folder("media");
  const maxWidthEmu = 5760000; // ~6.3in usable page width
  const relEntries = [];
  // Shared counter state so top-level image blocks AND table-cell-embedded
  // images (rendered from inside gridTableBlockXml) draw relationship/image
  // ids from one running sequence - required since rIds must be unique
  // across the whole document.xml.rels, and header/footer also consume one
  // each before any image is registered.
  const zipCtx = {mediaFolder, relEntries, counters:{relCounter:1, imgCounter:0}};
  let headerRid = null, footerRid = null;
  if(headerRuns){
    zipCtx.counters.relCounter++; headerRid = "rId"+zipCtx.counters.relCounter;
    relEntries.push(`<Relationship Id="${headerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`);
    zip.folder("word").file("header1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styledParagraphXml({runs:headerRuns})}</w:hdr>`);
  }
  if(footerRuns){
    zipCtx.counters.relCounter++; footerRid = "rId"+zipCtx.counters.relCounter;
    relEntries.push(`<Relationship Id="${footerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`);
    zip.folder("word").file("footer1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styledParagraphXml({runs:footerRuns})}</w:ftr>`);
  }

  zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${hasImages ? '<Default Extension="png" ContentType="image/png"/>' : ''}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
${headerRuns ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
${footerRuns ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}
</Types>`);
  zip.folder("_rels").file(".rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  const bodyParts = blocks.map(b=>{
    if(b.type === "image"){
      // Images extracted from real embedded PDF image objects carry their
      // true size in PDF points (1pt = 12700 EMU); the whole-page-screenshot
      // fallback only has pixel dimensions, sized via pxToEmu as before -
      // buildPictureXml handles both via widthPt/heightPt vs width/height.
      const {picXml, cx, cy, imgCounter} = buildPictureXml(b, zipCtx, maxWidthEmu);
      if(b.placement === "anchored" && b.xPt != null){
        // Independently-positioned image (QR code, stamp, small logo) -
        // anchored at its real page-relative x/y (measured from the page
        // edge, matching the page's own dimensions exactly since the
        // DOCX page size mirrors the PDF's) with square text wrap, rather
        // than dropped inline wherever its Y-sort position happens to
        // land. relativeHeight must be unique per anchored image so Word
        // doesn't collapse their z-order.
        const xEmu = Math.max(0, Math.round(b.xPt*12700));
        const yEmu = Math.max(0, Math.round(b.yFromTopPt*12700));
        return `<w:p><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${1000+imgCounter}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${xEmu}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${yEmu}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
      }
      // Wide banner/logo images behave as normal centered inline content.
      const jc = b.placement === "centered" ? `<w:pPr><w:jc w:val="center"/></w:pPr>` : "";
      return `<w:p>${jc}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    if(b.type === "pagebreak"){
      // A plain page break can't change paper size/orientation - only a
      // real section break can. sectionSize is only set when the PDF's
      // NEXT page actually has a different size, so this stays a simple
      // <w:br> for the overwhelming majority of documents (including the
      // real bill, which is 4 uniform A4 pages) and only pays for a
      // section break where the source genuinely needs one (e.g. a
      // landscape page inserted between portrait pages).
      if(b.sectionSize) return `<w:p><w:pPr>${sectPrXml(b.sectionSize, headerRid, footerRid)}</w:pPr></w:p>`;
      return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    }
    if(b.type === "paragraph"){ return styledParagraphXml(b); }
    if(b.type === "table"){ return tableBlockXml(b); }
    if(b.type === "gridtable"){ return gridTableBlockXml(b, zipCtx); }
    if(b.type === "columns"){ return columnsBlockXml(b); }
    if(b.type === "separator"){ return separatorBlockXml(); }
    if(!b.text || !b.text.trim()) return `<w:p/>`;
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(fixDevanagari(b.text))}</w:t></w:r></w:p>`;
  }).join("");

  // Final section's properties describe the LAST PDF page's size (mid-
  // document size changes are handled per-pagebreak above via sectPrXml).
  zip.folder("word").file("document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${bodyParts}${sectPrXml(pageSize, headerRid, footerRid)}</w:body>
</w:document>`);
  zip.folder("word").folder("_rels").file("document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries.join("")}</Relationships>`);
  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

/* ---- XLSX post-processor that anchors page images into the sheet (JSZip augments the SheetJS output) ---- */
async function embedImagesInXlsx(wbArray, placements){
  if(!placements.length) return new Blob([wbArray], {type:"application/octet-stream"});
  const zip = await JSZip.loadAsync(wbArray);

  let ct = await zip.file("[Content_Types].xml").async("string");
  if(!/Extension="png"/.test(ct)) ct = ct.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>');
  ct = ct.replace("</Types>", '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
  zip.file("[Content_Types].xml", ct);

  let drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  let anchors = "";
  placements.forEach((p, idx)=>{
    const n = idx+1;
    zip.folder("xl").folder("media").file(`image${n}.png`, p.pngBase64, {base64:true});
    drawingRels += `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/>`;
    const widthCols = Math.max(2, Math.round(p.widthPx/64));
    const heightRows = Math.max(4, Math.round(p.heightPx/20));
    anchors += `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${p.col+widthCols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row+heightRows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${n+1}" name="Picture ${n}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${n}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
  });
  drawingRels += `</Relationships>`;
  zip.folder("xl").folder("drawings").folder("_rels").file("drawing1.xml.rels", drawingRels);
  zip.folder("xl").folder("drawings").file("drawing1.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`);

  const sheetPath = "xl/worksheets/sheet1.xml";
  let sheetXml = await zip.file(sheetPath).async("string");
  if(!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  sheetXml = sheetXml.replace("</worksheet>", '<drawing r:id="rIdDrawing1"/></worksheet>');
  zip.file(sheetPath, sheetXml);

  const relsPath = "xl/worksheets/_rels/sheet1.xml.rels";
  const existingRels = zip.file(relsPath);
  let sheetRels;
  if(existingRels){
    sheetRels = await existingRels.async("string");
    sheetRels = sheetRels.replace("</Relationships>", '<Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
  } else {
    sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  }
  zip.file(relsPath, sheetRels);

  return await zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}

/* ---- PDF to Word (basic, text-only) ---- */
TOOLS.pdf2word = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to Word</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2wordBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to Word</h2>
        <p class="tool-hero-desc">Extracts editable text with real formatting (font size, bold, italic, paragraphs, lists) preserved.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2wordToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to Word</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2wordToolbar").style.display="none"; document.getElementById("pdf2wordBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2wordToolbar").style.display="flex";
    document.getElementById("pdf2wordBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    const pdoc = await pdfjsLib.getDocument({data:bytes}).promise;
    const pageBlocksList = [];
    const pageSizesArr = [];
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus("Extracting content...", false, Math.round((i/pdoc.numPages)*100));
      const page_i = await pdoc.getPage(i);
      pageSizesArr.push({widthPt: page_i.view[2]-page_i.view[0], heightPt: page_i.view[3]-page_i.view[1]});
      let visuals = {images:[], shapes:[], colorSpans:[]};
      try{ visuals = await extractPageVisuals(pdoc, i); }catch(e){ /* no vector/image/color data - text still extracts fine */ }
      let pageBlocks = [];
      try{ pageBlocks = await extractPageBlocks(pdoc, i, visuals); }catch(e){ /* fall through to page-image fallback below */ }
      // A page whose entire content is a table (no separate title/body
      // paragraph anywhere on it) has real, extractable text too - only
      // checking "paragraph"-type blocks here was a real bug: a
      // table-only page would incorrectly read as textless and get
      // replaced with a flat page screenshot, discarding the actual
      // editable table structure entirely. Found via a dedicated
      // "image inside table, no surrounding heading" test case that
      // exposed it - every real-bill page happens to have a title
      // paragraph alongside its tables, so this never surfaced before.
      const pageHasText = pageBlocks.some(blockHasRealText);
      let thisPageBlocks = [];
      if(!pageHasText){
        try{
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.6);
          thisPageBlocks = [{type:"image", pngBase64:canvasToPngBase64(canvas), width:canvas.width, height:canvas.height}];
        }catch(e){ /* nothing extractable and nothing renderable - leave this page out */ }
      } else {
        // Merge real embedded images (logo, QR) into the text flow by
        // approximate vertical position instead of only ever falling back
        // to a whole-page screenshot. Wide images (banners/logos spanning
        // most of the page width) render centered inline with the text
        // flow, matching how they actually behave visually. Narrow images
        // (QR codes, stamps, small logos) are independently positioned in
        // the source - not part of any text line - so they're anchored at
        // their real page-relative x/y instead of just being dropped into
        // the flow whenever their Y-sort position happens to fall, which
        // is the only way to keep e.g. a QR code sitting next to its
        // "Scan & Pay" label rather than drifting to wherever text
        // ordering puts it.
        const pageWidthPt = pageSizesArr[pageSizesArr.length-1].widthPt;
        const pageHeightPt = pageSizesArr[pageSizesArr.length-1].heightPt;
        const wideThreshold = pageWidthPt * 0.35;
        const pageImages = visuals.images.map(im=>{
          const wide = im.width >= wideThreshold;
          return {
            type:"image", pngBase64: pdfImageToPngBase64(im.raw),
            width: im.width, height: im.height,
            widthPt: im.width, heightPt: im.height, _y: im.y,
            placement: wide ? "centered" : "anchored",
            xPt: im.x, yFromTopPt: pageHeightPt - (im.y + im.height),
            pageWidthPt, pageHeightPt
          };
        });
        // Geometrically test every image against gridtable cell bounds
        // first - an image genuinely inside a table cell (e.g. a product
        // photo in an "Image" column) should render as part of that
        // cell, not float as a separately-anchored page block. Only
        // images that don't land inside any cell fall through to the
        // existing centered/anchored placement below.
        const unmatchedImages = embedImagesIntoTableCells(pageBlocks, pageImages);
        thisPageBlocks = pageBlocks.concat(unmatchedImages).sort((a,b)=> (b._y||0) - (a._y||0));
      }
      pageBlocksList.push(thisPageBlocks);
    }

    // Detect real repeating headers/footers (e.g. a company name at the
    // top of every page, a legal footer at the bottom) - only promoted
    // to actual DOCX header/footer parts when the SAME normalized text
    // (digits masked, so "Page 1 of 4" / "Page 2 of 4" still match)
    // appears at the top/bottom of a strong majority of pages. Ordinary
    // one-off content near a page edge never matches this bar, since it
    // requires repetition, not just position.
    const {headerRuns, footerRuns} = detectHeaderFooter(pageBlocksList);

    setStatus("Building Word document...");
    let prevPageSize = pageSizesArr[0];
    const blocks = [];
    pageBlocksList.forEach((pb, idx)=>{
      blocks.push(...pb);
      if(idx < pageBlocksList.length-1){
        const nextSize = pageSizesArr[idx+1];
        // A plain page break can't change paper size/orientation mid
        // document - only a real DOCX section break can. Only pay that
        // cost when the next page's size actually differs (rounded to
        // avoid a section break firing on sub-point PDF measurement
        // noise between otherwise-identical pages).
        const changed = Math.round(nextSize.widthPt) !== Math.round(prevPageSize.widthPt) || Math.round(nextSize.heightPt) !== Math.round(prevPageSize.heightPt);
        blocks.push(changed ? {type:"pagebreak", sectionSize: prevPageSize} : {type:"pagebreak"});
        prevPageSize = nextSize;
      }
    });
    const finalPageSize = pageSizesArr[pageSizesArr.length-1];
    const blob = await buildMixedDocx(blocks, finalPageSize, {headerRuns, footerRuns});
    const outName = suffixedName(file, "converted", "docx");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
  });
};

/* ---- Word to PDF (basic, text-only via mammoth) ---- */
TOOLS.word2pdf = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Word to PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="word2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Word to PDF</h2>
        <p class="tool-hero-desc">Basic version: reads the text from your .docx file and lays it out as a PDF.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".docx", false, "Select .docx file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="word2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("word2pdfToolbar").style.display="none"; document.getElementById("word2pdfBody").classList.remove("is-loaded"); });
    document.getElementById("word2pdfToolbar").style.display="flex";
    document.getElementById("word2pdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading Word document...");
    await ensureMammoth();
    const arrayBuffer = await file.arrayBuffer();
    let result;
    try {
      /* mammoth.extractRawText() has been observed to hang indefinitely
         (never resolving or rejecting) rather than erroring, in some
         environments - without this timeout, that leaves the tool stuck
         on "Reading document..." forever with no way forward, unlike
         pdfThumb's failures elsewhere which can degrade gracefully (no
         text extracted means there's nothing to build a PDF from, so
         this one has to surface as a real error, not a silent skip). */
      result = await Promise.race([
        mammoth.extractRawText({arrayBuffer}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Reading the document took too long")), 15000))
      ]);
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not read this document (${escapeAttr(e.message)}). Try a different .docx file.</div>`;
      return;
    }
    const text = winAnsiSafe(result.value);
    setStatus("Rendering pages...");
    let outBytes;
    try {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const size=11, margin=50, maxWidth=495, lineHeight=15;
      let page = doc.addPage([595,842]); let y = 842-margin;
      function newPageIfNeeded(){ if(y<margin){ page=doc.addPage([595,842]); y=842-margin; } }
      text.split("\n").forEach(para=>{
        const words = para.split(/\s+/);
        let line="";
        for(const w of words){
          const test = line? line+" "+w : w;
          if(font.widthOfTextAtSize(test,size) > maxWidth){
            page.drawText(line, {x:margin,y,size,font}); y-=lineHeight; newPageIfNeeded(); line=w;
          } else line=test;
        }
        page.drawText(line,{x:margin,y,size,font}); y-=lineHeight; newPageIfNeeded();
      });
      outBytes = await doc.save();
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not build the PDF (${escapeAttr(e.message)}).</div>`;
      return;
    }
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- PDF to Excel (basic, one line of text per row) ---- */
TOOLS.pdf2excel = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to Excel</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2excelBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to Excel</h2>
        <p class="tool-hero-desc">Extracts text into rows and columns, approximating the table layout from spacing.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2excelToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to Excel</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2excelToolbar").style.display="none"; document.getElementById("pdf2excelBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2excelToolbar").style.display="flex";
    document.getElementById("pdf2excelBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    await Promise.all([ensureXLSX(), ensureJSZip()]);
    const bytes=await file.arrayBuffer();
    const pdoc = await pdfjsLib.getDocument({data:bytes}).promise;
    const rows=[];
    const imagePlacements=[];
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus("Detecting tables...", false, Math.round((i/pdoc.numPages)*100));
      const page = await pdoc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(it=>it.str).join(" ").trim();
      if(pageText.length < 6){
        rows.push([`Page ${i} (image content — see embedded image below)`]);
        try{
          const canvas = await renderPdfPageCanvas(pdoc, i, 1.3);
          const rowFrom = rows.length;
          imagePlacements.push({row: rowFrom, col: 0, pngBase64: canvasToPngBase64(canvas), widthPx: canvas.width, heightPx: canvas.height});
          const heightRows = Math.max(4, Math.round(canvas.height/20));
          for(let r=0;r<heightRows;r++) rows.push([]);
        }catch(e){ /* keep the text-only row if rendering fails */ }
      } else {
        rows.push(...extractTableRows(content));
      }
      rows.push([]);
    }
    setStatus("Building Excel workbook...");
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
    const blob = imagePlacements.length ? await embedImagesInXlsx(wbout, imagePlacements) : new Blob([wbout], {type:"application/octet-stream"});
    const outName = suffixedName(file, "converted", "xlsx");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
  });
};

/* ---- Excel to PDF (basic table layout) ---- */
TOOLS.excel2pdf = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Excel to PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="excel2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Excel to PDF</h2>
        <p class="tool-hero-desc">Basic version: converts the first sheet into a simple table PDF.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML(".xlsx,.xls,.csv", false, "Select spreadsheet")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="excel2pdfToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("excel2pdfToolbar").style.display="none"; document.getElementById("excel2pdfBody").classList.remove("is-loaded"); });
    document.getElementById("excel2pdfToolbar").style.display="flex";
    document.getElementById("excel2pdfBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading spreadsheet...");
    await ensureXLSX();
    let outBytes;
    try {
      const bytes = await file.arrayBuffer();
      const wb = XLSX.read(bytes, {type:"array"});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:""});
      setStatus("Generating PDF pages...");
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
      const margin=36, size=9, rowHeight=18;
      const pageWidth=842, pageHeight=595; // landscape for wide tables
      let page = doc.addPage([pageWidth,pageHeight]); let y = pageHeight-margin;
      const colCount = Math.max(1, ...rows.map(r=>r.length));
      const colWidth = Math.min(110, (pageWidth-margin*2)/colCount);
      function newPageIfNeeded(){ if(y < margin+rowHeight){ page=doc.addPage([pageWidth,pageHeight]); y=pageHeight-margin; } }
      rows.forEach((row,ri)=>{
        newPageIfNeeded();
        row.forEach((cell,ci)=>{
          const text = winAnsiSafe(String(cell).slice(0,20));
          page.drawText(text, {x:margin+ci*colWidth, y, size, font: ri===0?boldFont:font, color:rgb(0.1,0.1,0.1)});
        });
        y -= rowHeight;
      });
      outBytes = await doc.save();
    } catch(e) {
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not convert this spreadsheet (${escapeAttr(e.message)}).</div>`;
      return;
    }
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "converted", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- PDF to TXT ---- */
TOOLS.pdf2txt = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF to TXT</h3></div>
    <div class="panel-body compact tool-workspace" id="pdf2txtBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF to TXT</h2>
        <p class="tool-hero-desc">Extract the plain text content of a PDF into a .txt file.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pdf2txtToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Convert to TXT</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pdf2txtToolbar").style.display="none"; document.getElementById("pdf2txtBody").classList.remove("is-loaded"); });
    document.getElementById("pdf2txtToolbar").style.display="flex";
    document.getElementById("pdf2txtBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const bytes=await file.arrayBuffer();
    const pdoc = await pdfjsLib.getDocument({data:bytes}).promise;
    let text="";
    for(let i=1;i<=pdoc.numPages;i++){
      setStatus("Extracting text...", false, Math.round((i/pdoc.numPages)*100));
      const page = await pdoc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it=>it.str).join(" ") + "\n\n";
    }
    const blob = new Blob([text], {type:"text/plain"});
    const outName = suffixedName(file, "extracted", "txt");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
  });
};

/* ---- TXT to PDF ---- */
TOOLS.txt2pdf = function(){
  openPanel(`
    <div class="panel-head"><h3>TXT to PDF</h3></div>
    <div class="panel-body compact tool-workspace" id="txt2pdfBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">TXT to PDF</h2>
        <p class="tool-hero-desc">Convert plain text into a PDF document.</p>
      </div>
      <div class="tool-content-area">
        <label class="tool-content-area-label" for="txtIn">Plain text</label>
        <div class="field" style="margin:0"><textarea id="txtIn" placeholder="Type or paste your text here"></textarea></div>
      </div>
      <div class="tool-toolbar">
        <button class="btn tool-toolbar-primary" id="go">Convert to PDF</button>
      </div>
      <div id="out"></div>
    </div>`);
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Generating...");
    const text = winAnsiSafe(document.getElementById("txtIn").value);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size=11, margin=50, maxWidth=495, lineHeight=15;
    let page = doc.addPage([595,842]); let y = 842-margin;
    const paragraphs = text.split("\n");
    function newPageIfNeeded(){ if(y<margin){ page=doc.addPage([595,842]); y=842-margin; } }
    for(const para of paragraphs){
      const words = para.split(/\s+/);
      let line="";
      for(const w of words){
        const test = line? line+" "+w : w;
        if(font.widthOfTextAtSize(test,size) > maxWidth){
          page.drawText(line, {x:margin,y,size,font}); y-=lineHeight; newPageIfNeeded(); line=w;
        } else line=test;
      }
      page.drawText(line,{x:margin,y,size,font}); y-=lineHeight; newPageIfNeeded();
    }
    const outBytes = await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const {url}=downloadBlob(blob,"document.pdf");
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:"document.pdf"}));
  });
};

/* ---- METADATA EDITOR ---- */
TOOLS.metadata = function(){
  let file=null, doc=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>PDF Metadata Editor</h3></div>
    <div class="panel-body compact tool-workspace" id="metadataBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF Metadata Editor</h2>
        <p class="tool-hero-desc">View and edit a PDF's title, author, and subject.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="metadataToolbar" style="display:none">
        <div class="tool-toolbar-secondary">
          <div class="field" style="margin:0"><label>Title</label><input type="text" id="mtitle"></div>
          <div class="field" style="margin:0"><label>Author</label><input type="text" id="mauthor"></div>
          <div class="field" style="margin:0"><label>Subject</label><input type="text" id="msubject"></div>
        </div>
        <button class="btn tool-toolbar-primary" id="go">Save</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(async fs=>{
    // See Split PDF's identical guard - without it, uploading A then B
    // quickly could let A's metadata land in the form fields after doc
    // already points at B, so Save would write A's title/author/subject
    // onto B's bytes.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; doc=null;
      document.getElementById("metadataToolbar").style.display="none";
      document.getElementById("metadataBody").classList.remove("is-loaded");
    });
    const bytes = await file.arrayBuffer();
    const parsedDoc = await loadPdfSafe(bytes);
    if(myToken !== loadToken) return;
    doc = parsedDoc;
    document.getElementById("mtitle").value = doc.getTitle()||"";
    document.getElementById("mauthor").value = doc.getAuthor()||"";
    document.getElementById("msubject").value = doc.getSubject()||"";
    document.getElementById("metadataToolbar").style.display="flex";
    document.getElementById("metadataBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Saving...");
    doc.setTitle(document.getElementById("mtitle").value);
    doc.setAuthor(document.getElementById("mauthor").value);
    doc.setSubject(document.getElementById("msubject").value);
    const outBytes = await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "metadata_updated", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
  });
};

/* ---- PAGE SIZE CONVERTER ---- */
TOOLS.pagesize = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>PDF Page Size Converter</h3></div>
    <div class="panel-body compact tool-workspace" id="pagesizeBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">PDF Page Size Converter</h2>
        <p class="tool-hero-desc">Changes the page canvas size (content position stays fixed and does not automatically rescale).</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="pagesizeToolbar" style="display:none">
        <div class="tool-toolbar-secondary">
          <div class="field" style="margin:0"><label>Target size</label>
            <select id="size">
              <option value="595,842">A4</option><option value="612,792">Letter</option>
              <option value="420,595">A5</option><option value="842,1191">A3</option>
            </select>
          </div>
        </div>
        <button class="btn tool-toolbar-primary" id="go">Convert Page Size</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("pagesizeToolbar").style.display="none"; document.getElementById("pagesizeBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("pagesizeToolbar").style.display="flex";
    document.getElementById("pagesizeBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    const [w,h] = document.getElementById("size").value.split(",").map(Number);
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    setStatus("Resizing pages...");
    doc.getPages().forEach(p=>p.setSize(w,h));
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "resized", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas}=await pdfThumb(outBytes);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:canvas, url, filename:outName}));
  });
};

/* ---- COMPARE PDFS (basic text diff) ---- */
TOOLS.compare = function(){
  openPanel(`
    <div class="panel-head"><h3>Compare PDFs</h3></div>
    <div class="panel-body compact tool-workspace" id="compareBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Compare two PDF files</h2>
        <p class="tool-hero-desc">See the differences between two versions of a document side by side.</p>
      </div>
      <div class="compare-upload-grid" id="compareGrid">
        <div class="tool-content-area compare-upload-card">
          <label class="tool-content-area-label" for="fa">PDF A</label>
          <input type="file" id="fa" accept="application/pdf" class="compare-file-input">
          <div class="compare-filename" id="faName">No file selected</div>
        </div>
        <div class="compare-vs" aria-hidden="true">VS</div>
        <div class="tool-content-area compare-upload-card">
          <label class="tool-content-area-label" for="fb">PDF B</label>
          <input type="file" id="fb" accept="application/pdf" class="compare-file-input">
          <div class="compare-filename" id="fbName">No file selected</div>
        </div>
      </div>
      <div class="tool-toolbar" id="compareToolbar">
        <button class="btn tool-toolbar-primary" id="go" disabled>Compare PDF</button>
      </div>
      <div id="out"></div>
    </div>`);

  const compareGrid = document.getElementById("compareGrid");
  const compareToolbar = document.getElementById("compareToolbar");
  const out = document.getElementById("out");
  const faInput = document.getElementById("fa"), fbInput = document.getElementById("fb");
  const faName = document.getElementById("faName"), fbName = document.getElementById("fbName");
  const goBtn = document.getElementById("go");

  function syncFileLabel(input, label){
    const f = input.files[0];
    label.textContent = f ? f.name : "No file selected";
    label.classList.toggle("has-file", !!f);
  }
  function syncGoEnabled(){
    goBtn.disabled = !(faInput.files[0] && fbInput.files[0]);
  }
  faInput.addEventListener("change", ()=>{ syncFileLabel(faInput, faName); syncGoEnabled(); });
  fbInput.addEventListener("change", ()=>{ syncFileLabel(fbInput, fbName); syncGoEnabled(); });

  function resetAll(){
    faInput.value = ""; fbInput.value = "";
    syncFileLabel(faInput, faName); syncFileLabel(fbInput, fbName);
    syncGoEnabled();
    out.innerHTML = "";
    compareGrid.classList.remove("hidden");
    compareToolbar.classList.remove("hidden");
  }

  goBtn.addEventListener("click", async ()=>{
    const fA = faInput.files[0], fB = fbInput.files[0];
    if(!fA||!fB){ toast("Select both PDFs first"); return; }
    out.innerHTML = statusEl("Extracting text...");
    async function extractLines(f){
      const bytes = await f.arrayBuffer();
      const pdoc = await pdfjsLib.getDocument({data:bytes}).promise;
      let lines=[];
      for(let i=1;i<=pdoc.numPages;i++){
        const page = await pdoc.getPage(i);
        const content = await page.getTextContent();
        lines.push(...content.items.map(it=>it.str).join(" ").split(/(?<=[.?!])\s+/));
      }
      return lines.filter(l=>l.trim());
    }
    let linesA, linesB;
    try{
      [linesA, linesB] = await Promise.all([extractLines(fA), extractLines(fB)]);
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not read one of these PDFs (${escapeAttr(e.message)}). Try different files.</div>`;
      return;
    }
    const setB = new Set(linesB);
    const setA = new Set(linesA);
    const onlyA = linesA.filter(l=>!setB.has(l)).slice(0,25);
    const onlyB = linesB.filter(l=>!setA.has(l)).slice(0,25);
    setStatus("Done", true);
    compareGrid.classList.add("hidden");
    compareToolbar.classList.add("hidden");
    const box = document.createElement("div"); box.className="result-box result-success";
    box.innerHTML = `<div class="result-head"><button type="button" class="result-back" aria-label="Start over">←</button><h3>✅ Comparison complete</h3></div>
      <div><strong>Only in ${escapeAttr(fA.name)} (${onlyA.length}${onlyA.length===25?'+':''}):</strong><div class="mono" style="font-size:.78rem;max-height:120px;overflow-y:auto;margin-top:6px;color:var(--rose)">${onlyA.map(l=>escapeAttr(l.slice(0,90))).join("<br>")||'—'}</div></div>
      <div style="margin-top:12px"><strong>Only in ${escapeAttr(fB.name)} (${onlyB.length}${onlyB.length===25?'+':''}):</strong><div class="mono" style="font-size:.78rem;max-height:120px;overflow-y:auto;margin-top:6px;color:var(--teal)">${onlyB.map(l=>escapeAttr(l.slice(0,90))).join("<br>")||'—'}</div></div>`;
    box.querySelector(".result-back").addEventListener("click", resetAll);
    out.appendChild(box);
  });
};

/* ---- SIGN PDF ----
   Main pane shows the actual page (renderPdfPageCanvas() - same
   hang-proof renderer Crop PDF already uses, not a raw page.render()
   call) instead of just a blind page-number field; the drawn signature
   is composited onto that same canvas as a draggable stamp, using the
   exact "restore background ImageData, redraw overlay" technique
   wireCropCanvas()/cropState already established, so exporting can
   convert the stamp's on-screen position back into real PDF points via
   the same dispScale math Crop PDF uses - the signature lands where it
   was actually dragged, not at one of a fixed set of corners. */
TOOLS.sign = function(){
  let file=null, pdoc=null, currentPage=1, dispScale=1, pageBgImageData=null, loadToken=0;
  // Reusable signature ASSETS (created once via draw/type/upload) each
  // carrying a default placement plus optional per-page overrides,
  // instead of one independent stamp per page - so a signature is
  // available on every page the moment it's created, without the user
  // repeating "Add Signature" per page. Position/size are stored as
  // fractions of the page's own width/height (not raw canvas px), so
  // the same asset renders/exports correctly regardless of zoom, or of
  // different pages having different dimensions:
  //   asset = { id, img, pngDataUrl, ratio,
  //     defaultPlacement: {xFrac,yFrac,wFrac},   // top-left origin, wFrac of page width
  //     pageOverrides: { [pageNum]: {xFrac,yFrac,wFrac} },
  //     hiddenPages: Set<pageNum> }               // "remove from this page", non-destructive
  // Height is always derived (w/ratio) at render/export time rather than
  // stored, so the signature's true aspect ratio is preserved even on a
  // page whose own aspect ratio differs from the one it was placed on.
  let assets=[], selectedAssetId=null, assetIdCounter=0, panelState="default";
  let dragMode=null, dragAsset=null, dragStart=null, dragStartRect=null, resizeCorner=-1, resizeAnchor=null;
  openPanel(`
    <div class="panel-head"><h3>Sign PDF</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="signBody">
      <div class="tool-hero" id="signHero">
        <h2 class="tool-hero-title">Sign PDF</h2>
        <p class="tool-hero-desc">Draw, type, or upload a signature — it's applied to every page, drag to reposition, then download the signed PDF.</p>
      </div>
      <div class="tool-upload-wrap" id="signUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="signPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="signWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="signStage">
            <canvas id="signPageCanvas"></canvas>
          </div>
          <div class="mono" id="signReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Sign PDF</h3>
          <div id="signFileSlot"></div>
          <div class="tool-content-area" id="sigPanelArea"></div>
          <div class="field" id="signPageField" style="display:none">
            <label>Page</label>
            <div class="row">
              <button class="btn secondary btn-sm" id="sigPrevPage" type="button" aria-label="Previous page">‹</button>
              <input type="number" id="pageNum" value="1" min="1" style="text-align:center">
              <button class="btn secondary btn-sm" id="sigNextPage" type="button" aria-label="Next page">›</button>
            </div>
          </div>
          <button class="btn tool-toolbar-primary" id="go">Sign PDF</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("signHero");
  const uploadWrap = document.getElementById("signUploadWrap");
  const privacyHint = document.getElementById("signPrivacyHint");
  const workspace = document.getElementById("signWorkspace");
  const fileSlot = document.getElementById("signFileSlot");
  const body = document.getElementById("signBody");
  const pageCanvas = document.getElementById("signPageCanvas");
  const pageField = document.getElementById("signPageField");
  const pageNumInput = document.getElementById("pageNum");
  const readout = document.getElementById("signReadout");
  const sigPanelArea = document.getElementById("sigPanelArea");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  // ---- Sidebar: default view (signature list + per-signature controls
  // + "+ Add Signature") ----
  function effectivePlacement(asset, page){ return asset.pageOverrides[page] || asset.defaultPlacement; }
  function hasOtherPageOverrides(asset){
    return Object.keys(asset.pageOverrides).some(p=>parseInt(p,10)!==currentPage);
  }
  function placementStatusText(asset){
    if(asset.hiddenPages.has(currentPage)) return "Hidden on this page";
    if(asset.pageOverrides[currentPage]) return "Custom position on this page";
    return "Same position on every page";
  }
  function renderSigListRows(){
    if(assets.length===0) return `<p class="mode-info">No signatures added yet.</p>`;
    // role="button"/tabindex here (not just the delete button) - this
    // row is otherwise the only way to select a signature at all, and a
    // bare click-only <div> is invisible to keyboard/screen-reader use.
    // Once selected, the canvas keydown handler below (nudge/resize/
    // delete) picks up from here.
    return `<div class="sig-list">` + assets.map(a=>`
      <div class="sig-list-item ${a.id===selectedAssetId?"active":""}" data-asset-id="${a.id}" role="button" tabindex="0" aria-pressed="${a.id===selectedAssetId}" aria-label="Signature, ${placementStatusText(a)}">
        <img src="${a.pngDataUrl}" alt="Signature" class="sig-list-thumb">
        <span class="sig-list-meta">${placementStatusText(a)}</span>
        <button type="button" class="sig-list-del" data-del-id="${a.id}" aria-label="Delete signature">✕</button>
      </div>`).join("") + `</div>`;
  }
  function showSigDefault(){
    panelState = "default";
    const selected = assets.find(a=>a.id===selectedAssetId);
    sigPanelArea.innerHTML = `
      <label class="tool-content-area-label">Signatures</label>
      ${renderSigListRows()}
      ${selected ? `
      <div class="sig-active-controls" id="sigActiveControls">
        <button class="btn secondary btn-sm" id="applyAllBtn" type="button" style="width:100%">Apply to all pages</button>
        <button class="btn secondary btn-sm" id="toggleHideBtn" type="button" style="width:100%;margin-top:6px">${selected.hiddenPages.has(currentPage) ? "Show on this page" : "Hide on this page"}</button>
      </div>` : ``}
      <button class="btn" id="addSigBtn" type="button" style="margin-top:10px;width:100%">+ Add Signature</button>
    `;
    document.getElementById("addSigBtn").addEventListener("click", showMethodPicker);
    sigPanelArea.querySelectorAll("[data-asset-id]").forEach(row=>{
      row.addEventListener("click", e=>{
        if(e.target.closest("[data-del-id]")) return;
        selectedAssetId = parseInt(row.dataset.assetId, 10);
        redrawStage();
        showSigDefault();
      });
      row.addEventListener("keydown", e=>{
        if(e.key===" " || e.key==="Enter"){ e.preventDefault(); row.click(); }
      });
    });
    sigPanelArea.querySelectorAll("[data-del-id]").forEach(btn=>{
      btn.addEventListener("click", e=>{ e.stopPropagation(); deleteAsset(parseInt(btn.dataset.delId, 10)); });
    });
    if(selected){
      document.getElementById("applyAllBtn").addEventListener("click", ()=>{
        if(hasOtherPageOverrides(selected)) showApplyAllConfirm(selected);
        else applyToAllPages(selected);
      });
      document.getElementById("toggleHideBtn").addEventListener("click", ()=> toggleHidden(selected));
    }
  }
  function showApplyAllConfirm(asset){
    const controls = document.getElementById("sigActiveControls");
    if(!controls) return;
    controls.innerHTML = `
      <p class="mode-info" style="margin-bottom:8px">Apply this position and size to all pages? This replaces any custom placements on other pages.</p>
      <div class="row">
        <button class="btn secondary btn-sm" id="cancelApplyAll" type="button">Cancel</button>
        <button class="btn btn-sm" id="confirmApplyAll" type="button">Apply to all pages</button>
      </div>
    `;
    document.getElementById("cancelApplyAll").addEventListener("click", showSigDefault);
    document.getElementById("confirmApplyAll").addEventListener("click", ()=> applyToAllPages(asset));
  }
  function applyToAllPages(asset){
    asset.defaultPlacement = {...effectivePlacement(asset, currentPage)};
    asset.pageOverrides = {};
    redrawStage();
    showSigDefault();
  }
  function toggleHidden(asset){
    if(asset.hiddenPages.has(currentPage)){ asset.hiddenPages.delete(currentPage); }
    else{
      asset.hiddenPages.add(currentPage);
      if(selectedAssetId===asset.id) selectedAssetId=null;
    }
    redrawStage();
    showSigDefault();
  }
  function refreshSigListIfIdle(){ if(panelState==="default") showSigDefault(); }

  // ---- Sidebar: method picker ----
  function showMethodPicker(){
    panelState = "picker";
    sigPanelArea.innerHTML = `
      <label class="tool-content-area-label">Add Signature</label>
      <div class="sig-method-list">
        <button type="button" class="sig-method-btn" data-method="draw">
          <strong>Draw Signature</strong><span>Create your signature manually</span>
        </button>
        <button type="button" class="sig-method-btn" data-method="type">
          <strong>Type Signature</strong><span>Type your name as a signature</span>
        </button>
        <button type="button" class="sig-method-btn" data-method="upload">
          <strong>Upload Signature</strong><span>Upload an existing signature image</span>
        </button>
      </div>
      <button class="btn secondary" id="cancelAddSig" type="button" style="margin-top:10px;width:100%">Cancel</button>
    `;
    sigPanelArea.querySelectorAll("[data-method]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const m = btn.dataset.method;
        if(m==="draw") showDrawMethod();
        else if(m==="type") showTypeMethod();
        else showUploadMethod();
      });
    });
    document.getElementById("cancelAddSig").addEventListener("click", showSigDefault);
  }

  // ---- Sidebar: draw method ----
  function showDrawMethod(){
    panelState = "draw";
    sigPanelArea.innerHTML = `
      <label class="tool-content-area-label">Draw Signature</label>
      <div class="canvas-wrap"><canvas id="sigDrawCanvas" width="260" height="100"></canvas></div>
      <button class="btn secondary btn-sm" id="clearDrawSig" type="button" style="margin-top:8px">Clear</button>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="cancelDrawSig" type="button">Cancel</button>
        <button class="btn" id="useDrawSig" type="button">Use Signature</button>
      </div>
    `;
    const canvas = document.getElementById("sigDrawCanvas");
    const ctx = canvas.getContext("2d");
    ctx.lineWidth=2.4; ctx.lineCap="round"; ctx.strokeStyle="#15181A";
    let drawing=false, hasDrawInk=false;
    function pos(e){ const r=canvas.getBoundingClientRect(); const t=e.touches?e.touches[0]:e; return {x:t.clientX-r.left, y:t.clientY-r.top}; }
    function start(e){ drawing=true; hasDrawInk=true; const p=pos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); e.preventDefault(); }
    function move(e){ if(!drawing) return; const p=pos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); e.preventDefault(); }
    function end(){ drawing=false; }
    canvas.addEventListener("mousedown",start); canvas.addEventListener("mousemove",move); window.addEventListener("mouseup",end);
    canvas.addEventListener("touchstart",start); canvas.addEventListener("touchmove",move); canvas.addEventListener("touchend",end);
    document.getElementById("clearDrawSig").addEventListener("click", ()=>{ ctx.clearRect(0,0,canvas.width,canvas.height); hasDrawInk=false; });
    document.getElementById("cancelDrawSig").addEventListener("click", showSigDefault);
    document.getElementById("useDrawSig").addEventListener("click", ()=>{
      if(!hasDrawInk){ toast("Draw a signature first"); return; }
      const img = new Image();
      img.onload = ()=> addSignature(img);
      img.src = canvas.toDataURL("image/png");
    });
  }

  // ---- Sidebar: type method ----
  function showTypeMethod(){
    panelState = "type";
    sigPanelArea.innerHTML = `
      <label class="tool-content-area-label">Type Signature</label>
      <div class="field"><input type="text" id="typeSigInput" placeholder="Type your name" maxlength="40"></div>
      <div class="field"><label>Style</label>
        <select id="typeSigFont">
          <option value="'Brush Script MT', cursive" selected>Script</option>
          <option value="'Plus Jakarta Sans', sans-serif">Sans</option>
          <option value="Georgia, serif">Serif</option>
        </select>
      </div>
      <div class="canvas-wrap"><canvas id="typeSigPreview" width="260" height="100"></canvas></div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="cancelTypeSig" type="button">Cancel</button>
        <button class="btn" id="useTypeSig" type="button">Use Signature</button>
      </div>
    `;
    const input = document.getElementById("typeSigInput");
    const fontSel = document.getElementById("typeSigFont");
    const preview = document.getElementById("typeSigPreview");
    const pctx = preview.getContext("2d");
    function draw(){
      pctx.clearRect(0,0,preview.width,preview.height);
      const text = input.value.trim();
      if(!text) return;
      pctx.fillStyle="#15181A"; pctx.textAlign="center"; pctx.textBaseline="middle";
      let size=44;
      pctx.font = `${size}px ${fontSel.value}`;
      while(pctx.measureText(text).width > preview.width-20 && size>16){ size-=2; pctx.font = `${size}px ${fontSel.value}`; }
      pctx.fillText(text, preview.width/2, preview.height/2);
    }
    input.addEventListener("input", draw);
    fontSel.addEventListener("change", draw);
    document.getElementById("cancelTypeSig").addEventListener("click", showSigDefault);
    document.getElementById("useTypeSig").addEventListener("click", ()=>{
      if(!input.value.trim()){ toast("Type your name first"); return; }
      const img = new Image();
      img.onload = ()=> addSignature(img);
      img.src = preview.toDataURL("image/png");
    });
  }

  // ---- Sidebar: upload method ----
  function showUploadMethod(){
    panelState = "upload";
    sigPanelArea.innerHTML = `
      <label class="tool-content-area-label">Upload Signature</label>
      <div class="dropzone" id="sigUploadDz" style="padding:20px 12px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="28" height="28"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
        <div><strong>Choose file</strong></div>
        <div class="hint">PNG, JPG or WEBP · stays on this device</div>
        <input type="file" id="sigUploadInput" class="hidden" accept="image/png,image/jpeg,image/webp">
      </div>
      <div id="sigUploadPreviewWrap" style="display:none;margin-top:10px;text-align:center">
        <div class="canvas-wrap sig-transparency-bg"><img id="sigUploadPreview" alt="Signature preview" style="max-width:100%;max-height:140px;display:block;margin:0 auto"></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="cancelUploadSig" type="button">Cancel</button>
        <button class="btn" id="useUploadSig" type="button" disabled>Use Signature</button>
      </div>
    `;
    const dz = document.getElementById("sigUploadDz");
    const input = document.getElementById("sigUploadInput");
    const previewWrap = document.getElementById("sigUploadPreviewWrap");
    const previewImg = document.getElementById("sigUploadPreview");
    const useBtn = document.getElementById("useUploadSig");
    let uploadedImg = null;
    function handleFile(f){
      if(!f) return;
      if(!/^image\/(png|jpeg|webp)$/.test(f.type)){ toast("Please choose a PNG, JPG or WEBP image"); return; }
      const reader = new FileReader();
      reader.onload = ()=>{
        const img = new Image();
        img.onload = ()=>{
          uploadedImg = img;
          previewImg.src = img.src;
          previewWrap.style.display = "";
          useBtn.disabled = false;
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(f);
    }
    dz.addEventListener("click", ()=>input.click());
    input.addEventListener("change", ()=>handleFile(input.files[0]));
    ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.add("drag");}));
    ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault(); dz.classList.remove("drag");}));
    dz.addEventListener("drop", e=>handleFile(e.dataTransfer.files[0]));
    document.getElementById("cancelUploadSig").addEventListener("click", showSigDefault);
    useBtn.addEventListener("click", ()=>{ if(uploadedImg) addSignature(uploadedImg); });
  }

  // Normalizes any source (canvas-drawn, typed, or an uploaded PNG/JPG/
  // WEBP) into one PNG data URL up front - preserves transparency where
  // the source has it, and means export only ever needs doc.embedPng(),
  // regardless of which of the 3 methods created the signature.
  function toPngDataUrl(img){
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img,0,0);
    return c.toDataURL("image/png");
  }
  function addSignature(img){
    if(!pageBgImageData){ toast("Page isn't ready yet - try again in a moment"); return; }
    const pngDataUrl = toPngDataUrl(img);
    const ratio = img.naturalWidth/img.naturalHeight;
    // Default placement: bottom-right, safe margins, moderate size -
    // computed once against whichever page is on screen right now, then
    // stored as page-relative fractions so it's immediately valid for
    // every page (including ones not rendered yet).
    const wPx = Math.min(180, pageCanvas.width*0.42);
    const hPx = wPx/ratio;
    const margin = 20;
    const xPx = pageCanvas.width - wPx - margin;
    const yPx = pageCanvas.height - hPx - margin;
    const defaultPlacement = { xFrac: xPx/pageCanvas.width, yFrac: yPx/pageCanvas.height, wFrac: wPx/pageCanvas.width };
    const id = ++assetIdCounter;
    assets.push({id, img, pngDataUrl, ratio, defaultPlacement, pageOverrides:{}, hiddenPages:new Set()});
    selectedAssetId = id;
    redrawStage();
    showSigDefault();
  }
  function deleteAsset(id){
    assets = assets.filter(a=>a.id!==id);
    if(selectedAssetId===id) selectedAssetId=null;
    redrawStage();
    refreshSigListIfIdle();
  }

  // ---- Main stage: render + drag/resize/delete. Every asset not
  // hidden on the current page is drawn automatically - a signature
  // never needs re-adding per page. ----
  function placementToRect(asset, placement){
    const w = placement.wFrac * pageCanvas.width;
    return { x: placement.xFrac*pageCanvas.width, y: placement.yFrac*pageCanvas.height, w, h: w/asset.ratio };
  }
  function redrawStage(){
    if(!pageBgImageData) return;
    const ctx = pageCanvas.getContext("2d");
    ctx.putImageData(pageBgImageData, 0, 0);
    assets.forEach(asset=>{
      if(asset.hiddenPages.has(currentPage)) return;
      const rect = placementToRect(asset, effectivePlacement(asset, currentPage));
      ctx.drawImage(asset.img, rect.x, rect.y, rect.w, rect.h);
      if(asset.id === selectedAssetId){
        ctx.save();
        ctx.strokeStyle = "#E8291B"; ctx.lineWidth = 1.5; ctx.setLineDash([5,4]);
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
        const hs = 5;
        ctx.fillStyle = "#E8291B";
        [[rect.x,rect.y],[rect.x+rect.w,rect.y],[rect.x+rect.w,rect.y+rect.h],[rect.x,rect.y+rect.h]].forEach(([cx,cy])=>{
          ctx.fillRect(cx-hs, cy-hs, hs*2, hs*2);
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(cx-hs, cy-hs, hs*2, hs*2);
        });
        const dbx = rect.x+rect.w+2, dby = rect.y-2;
        ctx.beginPath(); ctx.arc(dbx, dby, 9, 0, Math.PI*2); ctx.fillStyle = "#15181A"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(dbx-3,dby-3); ctx.lineTo(dbx+3,dby+3); ctx.moveTo(dbx+3,dby-3); ctx.lineTo(dbx-3,dby+3); ctx.stroke();
      }
    });
    readout.textContent = assets.length===0
      ? "Add a signature - it appears on every page automatically."
      : selectedAssetId
        ? "Drag to move, use the corner handles to resize, or the × to delete. Arrow keys move, +/- resize, Delete removes."
        : "Drag to move, use the corner handles to resize, or the × to delete.";
  }

  pageCanvas.style.touchAction = "none";
  // Every placement interaction above (drag to move, corner-handle
  // resize, click the × to delete) was pointer-only - a keyboard/screen-
  // reader user could add a signature but then had no way at all to
  // reposition, resize, or remove it. Mirrors the same operations via
  // the keyboard once a signature is selected (from the sidebar list or
  // by tabbing to the canvas itself): arrows nudge, Shift+arrow nudges
  // further, +/- resizes (anchored top-left, aspect ratio preserved,
  // same clamping the mouse resize/move paths already use so a keyboard
  // user can't push a signature off the page either), Delete/Backspace
  // removes it, Escape deselects.
  pageCanvas.tabIndex = 0;
  pageCanvas.setAttribute("role", "application");
  pageCanvas.setAttribute("aria-label", "PDF page with signature placement - use arrow keys to move the selected signature, plus/minus to resize, Delete to remove");
  pageCanvas.addEventListener("keydown", e=>{
    const selected = assets.find(a=>a.id===selectedAssetId && !a.hiddenPages.has(currentPage));
    if(!selected) return;
    const rect = placementToRect(selected, effectivePlacement(selected, currentPage));
    const step = e.shiftKey ? 20 : 4;
    let handled = true;
    if(e.key==="ArrowLeft" || e.key==="ArrowRight" || e.key==="ArrowUp" || e.key==="ArrowDown"){
      const dx = e.key==="ArrowLeft" ? -step : e.key==="ArrowRight" ? step : 0;
      const dy = e.key==="ArrowUp" ? -step : e.key==="ArrowDown" ? step : 0;
      commitRect(selected, {
        x: Math.max(0, Math.min(pageCanvas.width-rect.w, rect.x+dx)),
        y: Math.max(0, Math.min(pageCanvas.height-rect.h, rect.y+dy)),
        w: rect.w, h: rect.h
      });
    } else if(e.key==="+" || e.key==="=" || e.key==="-" || e.key==="_"){
      const grow = (e.key==="+" || e.key==="=");
      const factor = grow ? 1.1 : 0.9;
      let newW = Math.max(24, rect.w*factor);
      newW = Math.min(newW, pageCanvas.width-rect.x);
      let newH = newW/selected.ratio;
      newH = Math.min(newH, pageCanvas.height-rect.y);
      newW = newH*selected.ratio;
      commitRect(selected, {x:rect.x, y:rect.y, w:newW, h:newH});
    } else if(e.key==="Delete" || e.key==="Backspace"){
      e.preventDefault(); e.stopPropagation();
      deleteAsset(selected.id); // already calls redrawStage() + refreshes the list itself
      return;
    } else if(e.key==="Escape"){
      // Must stop this from bubbling to document's own Escape handler
      // (closePanel() - see its comment for the identical conflict
      // TOOLS.edit already had to guard against) - without this, Escape
      // while the canvas is focused doesn't just deselect the signature,
      // it closes the ENTIRE Sign PDF panel and discards all of the
      // user's in-progress signature placement. Confirmed by testing:
      // this is exactly what happened before this stopPropagation() was
      // added.
      e.preventDefault(); e.stopPropagation();
      selectedAssetId = null;
      redrawStage();
      refreshSigListIfIdle();
      return;
    } else {
      handled = false;
    }
    if(handled){ e.preventDefault(); e.stopPropagation(); redrawStage(); }
  });
  function stagePos(e){
    const r = pageCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(pageCanvas.width, (e.clientX-r.left)*(pageCanvas.width/r.width)));
    const y = Math.max(0, Math.min(pageCanvas.height, (e.clientY-r.top)*(pageCanvas.height/r.height)));
    return {x,y};
  }
  function hitTestHandle(rect, p){
    const hs=8;
    const corners=[{i:0,x:rect.x,y:rect.y},{i:1,x:rect.x+rect.w,y:rect.y},{i:2,x:rect.x+rect.w,y:rect.y+rect.h},{i:3,x:rect.x,y:rect.y+rect.h}];
    for(const c of corners){ if(Math.abs(p.x-c.x)<=hs && Math.abs(p.y-c.y)<=hs) return c.i; }
    return -1;
  }
  function hitTestDelete(rect, p){
    return Math.hypot(p.x-(rect.x+rect.w+2), p.y-(rect.y-2)) <= 11;
  }
  function assetAtPoint(p){
    for(let i=assets.length-1;i>=0;i--){
      const a=assets[i];
      if(a.hiddenPages.has(currentPage)) continue;
      const rect = placementToRect(a, effectivePlacement(a, currentPage));
      if(p.x>=rect.x && p.x<=rect.x+rect.w && p.y>=rect.y && p.y<=rect.y+rect.h) return a;
    }
    return null;
  }
  function cornerAnchor(rect, corner){
    switch(corner){
      case 0: return {x:rect.x+rect.w, y:rect.y+rect.h};
      case 1: return {x:rect.x, y:rect.y+rect.h};
      case 2: return {x:rect.x, y:rect.y};
      default: return {x:rect.x+rect.w, y:rect.y};
    }
  }
  function commitRect(asset, rect){
    asset.pageOverrides[currentPage] = { xFrac: rect.x/pageCanvas.width, yFrac: rect.y/pageCanvas.height, wFrac: rect.w/pageCanvas.width };
  }
  pageCanvas.onpointerdown = e=>{
    const p = stagePos(e);
    const selected = assets.find(a=>a.id===selectedAssetId && !a.hiddenPages.has(currentPage));
    if(selected){
      const rect = placementToRect(selected, effectivePlacement(selected, currentPage));
      if(hitTestDelete(rect,p)){ deleteAsset(selected.id); return; }
      const corner = hitTestHandle(rect,p);
      if(corner>=0){
        pageCanvas.setPointerCapture(e.pointerId);
        dragMode="resize"; dragAsset=selected; resizeCorner=corner; dragStartRect=rect;
        resizeAnchor = cornerAnchor(rect, corner);
        return;
      }
      if(p.x>=rect.x && p.x<=rect.x+rect.w && p.y>=rect.y && p.y<=rect.y+rect.h){
        pageCanvas.setPointerCapture(e.pointerId);
        dragMode="move"; dragAsset=selected; dragStart=p; dragStartRect=rect;
        return;
      }
    }
    const hit = assetAtPoint(p);
    if(hit){
      selectedAssetId = hit.id;
      refreshSigListIfIdle();
      redrawStage();
      return;
    }
    if(selectedAssetId!==null){ selectedAssetId=null; redrawStage(); refreshSigListIfIdle(); }
  };
  pageCanvas.onpointermove = e=>{
    if(!dragMode || !dragAsset) return;
    const p = stagePos(e);
    let rect;
    if(dragMode==="move"){
      const dx = p.x-dragStart.x, dy = p.y-dragStart.y;
      rect = {
        x: Math.max(0, Math.min(pageCanvas.width-dragStartRect.w, dragStartRect.x+dx)),
        y: Math.max(0, Math.min(pageCanvas.height-dragStartRect.h, dragStartRect.y+dy)),
        w: dragStartRect.w, h: dragStartRect.h
      };
    } else {
      const ratio = dragAsset.ratio;
      const dx = p.x-resizeAnchor.x, dy = p.y-resizeAnchor.y;
      let newW = Math.max(24, Math.abs(dx));
      let newH = newW/ratio;
      if(newH < 24){ newH=24; newW=newH*ratio; }
      const growRight = resizeCorner===1||resizeCorner===2;
      const growDown = resizeCorner===2||resizeCorner===3;
      newW = Math.min(newW, growRight ? pageCanvas.width-resizeAnchor.x : resizeAnchor.x);
      newH = newW/ratio;
      newH = Math.min(newH, growDown ? pageCanvas.height-resizeAnchor.y : resizeAnchor.y);
      newW = newH*ratio;
      rect = { w:newW, h:newH, x: growRight?resizeAnchor.x:resizeAnchor.x-newW, y: growDown?resizeAnchor.y:resizeAnchor.y-newH };
    }
    commitRect(dragAsset, rect);
    redrawStage();
  };
  pageCanvas.onpointerup = ()=>{
    if(dragAsset) refreshSigListIfIdle();
    dragMode=null; dragAsset=null;
  };

  async function renderPage(pageNum, myToken){
    readout.textContent = "Rendering page…";
    let rendered;
    try{
      rendered = await renderPdfPageCanvas(pdoc, pageNum, dispScale);
    }catch(e){
      if(myToken !== loadToken) return false;
      readout.textContent = "Could not render this page. Try a different file.";
      return false;
    }
    if(myToken !== loadToken) return false;
    pageCanvas.width = rendered.width; pageCanvas.height = rendered.height;
    pageCanvas.getContext("2d").drawImage(rendered, 0, 0);
    pageBgImageData = pageCanvas.getContext("2d").getImageData(0,0,pageCanvas.width,pageCanvas.height);
    currentPage = pageNum;
    pageNumInput.value = pageNum;
    redrawStage();
    return true;
  }

  async function goToPage(n){
    const myToken = loadToken;
    const clamped = Math.min(Math.max(n,1), pdoc.numPages);
    if(clamped === currentPage) return;
    await renderPage(clamped, myToken);
  }
  document.getElementById("sigPrevPage").addEventListener("click", ()=>goToPage(currentPage-1));
  document.getElementById("sigNextPage").addEventListener("click", ()=>goToPage(currentPage+1));
  pageNumInput.addEventListener("change", ()=>goToPage(parseInt(pageNumInput.value)||1));

  showSigDefault();

  wireDropzone(async fs=>{
    // Same loadToken guard as every other async wireDropzone tool - a
    // second upload landing mid-render must not let the first one's
    // stale render overwrite it.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; pdoc=null; assets=[]; selectedAssetId=null; pageBgImageData=null;
      showSigDefault();
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    assets=[]; selectedAssetId=null;
    showSigDefault();
    const bytes = await file.arrayBuffer();
    if(myToken !== loadToken) return;
    const loadedPdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    if(myToken !== loadToken) return;
    pdoc = loadedPdoc;
    const page1 = await pdoc.getPage(1);
    if(myToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    const maxW = 700;
    dispScale = Math.min(1, maxW/vp1.width);
    pageField.style.display = pdoc.numPages>1 ? "block" : "none";
    pageNumInput.max = pdoc.numPages;
    showWorkspace();
    await renderPage(1, myToken);
  });

  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out");
    if(assets.length===0){ toast("Add a signature first"); return; }
    out.innerHTML=statusEl("Placing signature"+(assets.length>1?"s":"")+"...");
    const bytes=await file.arrayBuffer();
    const doc=await loadPdfSafe(bytes);
    const pageCount = doc.getPageCount();
    // Identical assets only need to be embedded into the PDF once, then
    // reused for every placement across every page - keyed by the
    // normalized PNG data URL.
    const embedCache = new Map();
    let firstPlacedPage = null;
    // Every page gets every non-hidden asset automatically (this is the
    // whole point: one signature, created once, ends up on every page
    // without the user repeating anything) - each page's own real
    // width/height (from pdf-lib, not the on-screen preview) is used so
    // placement and aspect ratio stay correct even if pages differ in
    // size, and a page-specific override (if the user customized that
    // page) wins over the asset's shared default placement.
    for(let pn=0; pn<pageCount; pn++){
      const pageNum = pn+1;
      const page = doc.getPage(pn);
      const {width,height} = page.getSize();
      for(const asset of assets){
        if(asset.hiddenPages.has(pageNum)) continue;
        const placement = asset.pageOverrides[pageNum] || asset.defaultPlacement;
        let embedded = embedCache.get(asset.pngDataUrl);
        if(!embedded){
          const sigBytes = Uint8Array.from(atob(asset.pngDataUrl.split(",")[1]), c=>c.charCodeAt(0));
          embedded = await doc.embedPng(sigBytes);
          embedCache.set(asset.pngDataUrl, embedded);
        }
        const w = placement.wFrac * width;
        const h = w / asset.ratio;
        const x = Math.max(0, Math.min(placement.xFrac*width, width-w));
        const y = Math.max(0, Math.min(height - placement.yFrac*height - h, height-h));
        page.drawImage(embedded, {x, y, width:w, height:h});
        if(firstPlacedPage===null) firstPlacedPage = pageNum;
      }
    }
    const outBytes=await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "signed", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const {canvas:thumb}=await pdfThumb(outBytes, firstPlacedPage || 1);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:thumb, url, filename:outName}));
  });
};

/* ---- FILL PDF FORM ---- */
/* ---- FILL PDF FORM ----
   Same page-canvas rendering (renderPdfPageCanvas) and dispScale
   coordinate math Sign PDF/Crop PDF already use. Fields are collected
   once via pdf-lib (already loaded, already used for export - no second
   PDF engine) using each field's widget rectangle (AcroForm position, in
   PDF points) and the widget's page reference matched against
   doc.getPages(), then rendered as real <input>s absolutely positioned
   over the matching page's canvas instead of a plain field-name list
   with no visual connection to the document. */
TOOLS.fillform = function(){
  let file=null, doc=null, pdoc=null, currentPage=1, dispScale=1, loadToken=0;
  let fieldsByPage={}, totalFieldCount=0;
  // Field overlays only exist in the DOM for whichever page is currently
  // rendered (renderFieldOverlays() clears+rebuilds them on every page
  // change) - values must be captured into this map as the user types/
  // checks, not read back from the DOM at export time, or navigating
  // to page 2 and filling it would silently discard whatever was
  // entered on page 1. Keyed by field name; radio entries store the
  // selected option's value (or are absent if nothing was chosen).
  let fieldValues={}, fieldTypeByName={};
  openPanel(`
    <div class="panel-head"><h3>Fill PDF Form</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="fillformBody">
      <div class="tool-hero" id="fillformHero">
        <h2 class="tool-hero-title">Fill PDF Form</h2>
        <p class="tool-hero-desc">Fill in interactive fields directly on the page, then download the completed document.</p>
      </div>
      <div class="tool-upload-wrap" id="fillformUploadWrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint" id="fillformPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="fillformWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="tool-content-area crop-stage" id="fillformStage">
            <div class="fillform-canvas-wrap" id="fillformCanvasWrap">
              <canvas id="fillformPageCanvas"></canvas>
            </div>
          </div>
          <div class="mono" id="fillformReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Fill PDF Form</h3>
          <div id="fillformFileSlot"></div>
          <div class="field" id="fillformPageField" style="display:none">
            <label>Page</label>
            <div class="row">
              <button class="btn secondary btn-sm" id="fillformPrevPage" type="button" aria-label="Previous page">‹</button>
              <input type="number" id="fillformPageNum" value="1" min="1" style="text-align:center">
              <button class="btn secondary btn-sm" id="fillformNextPage" type="button" aria-label="Next page">›</button>
            </div>
          </div>
          <div id="fillformActions" style="display:none">
            <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;margin-bottom:14px;"><input type="checkbox" id="flat"> Flatten after filling (locks the values in)</label>
            <button class="btn tool-toolbar-primary" id="go">Fill PDF Form</button>
          </div>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("fillformHero");
  const uploadWrap = document.getElementById("fillformUploadWrap");
  const privacyHint = document.getElementById("fillformPrivacyHint");
  const workspace = document.getElementById("fillformWorkspace");
  const fileSlot = document.getElementById("fillformFileSlot");
  const actions = document.getElementById("fillformActions");
  const body = document.getElementById("fillformBody");
  const pageCanvas = document.getElementById("fillformPageCanvas");
  const canvasWrap = document.getElementById("fillformCanvasWrap");
  const pageField = document.getElementById("fillformPageField");
  const pageNumInput = document.getElementById("fillformPageNum");
  const readout = document.getElementById("fillformReadout");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  /* Bumping loadToken invalidates any still-in-flight parse from a
     previous file (upload A -> remove A -> upload B, or upload A ->
     upload B before A finishes parsing): async callbacks below check
     their own captured token against the current one before touching
     the DOM, so a slow/late A can never overwrite B's fields. */
  function resetFormUI(){
    loadToken++;
    doc = null; pdoc = null; fieldsByPage = {}; totalFieldCount = 0;
    fieldValues = {}; fieldTypeByName = {};
    canvasWrap.querySelectorAll(".fillform-field-overlay").forEach(el=>el.remove());
    actions.style.display = "none";
    pageField.style.display = "none";
    showEmptyState();
  }

  /* Collects every AcroForm field's widget(s) - name, type, PDF-point
     rectangle, and (for radio options) which value that widget
     represents - grouped by the 0-based page index each widget actually
     sits on, using pdf-lib's own widget.P() page reference matched
     against doc.getPages(). Runs once per upload, entirely off the
     already-loaded pdf-lib doc - no second parse, no new dependency. */
  function collectFieldsByPage(pdfLibDoc){
    const pageRefs = pdfLibDoc.getPages().map(p=>p.ref);
    const byPage = {};
    let count = 0;
    pdfLibDoc.getForm().getFields().forEach(f=>{
      const isCheckbox = f instanceof PDFLib.PDFCheckBox;
      const isRadio = f instanceof PDFLib.PDFRadioGroup;
      // Radio option values (getOptions()) aren't individually tagged on
      // each widget by pdf-lib's public API - matching by index assumes
      // getWidgets() and getOptions() stay in the same append order,
      // which holds for every PDF this app itself can produce (Sign/
      // Fill are the only tools that create radio groups) and for
      // standard well-formed AcroForms generally.
      const options = isRadio ? f.getOptions() : null;
      f.acroField.getWidgets().forEach((w, i)=>{
        const pageIndex = pageRefs.findIndex(r => r === w.P());
        if(pageIndex === -1) return;
        if(!byPage[pageIndex]) byPage[pageIndex] = [];
        byPage[pageIndex].push({
          name: f.getName(),
          type: isCheckbox ? "check" : (isRadio ? "radio" : "text"),
          rect: w.getRectangle(),
          radioValue: isRadio ? (options[i] || "") : undefined
        });
        fieldTypeByName[f.getName()] = isCheckbox ? "check" : (isRadio ? "radio" : "text");
        count++;
      });
    });
    return {byPage, count};
  }

  function renderFieldOverlays(pageIndex){
    canvasWrap.querySelectorAll(".fillform-field-overlay").forEach(el=>el.remove());
    const fields = fieldsByPage[pageIndex] || [];
    const cw = pageCanvas.width, ch = pageCanvas.height;
    // Percentages of the canvas's own intrinsic size, not fixed px: the
    // canvas is CSS-scaled down (max-width:100%) on narrow viewports so
    // it never causes horizontal overflow, and .fillform-canvas-wrap
    // (position:relative, sized to the canvas's rendered box) shrinks
    // right along with it - percentage-positioned children then track
    // that same scaling automatically. Fixed-px overlays would have
    // stayed put at their unscaled coordinates and drifted off the
    // actual field position the moment the canvas got scaled down.
    fields.forEach(f=>{
      const leftPct = (f.rect.x*dispScale/cw)*100, wPct = (f.rect.width*dispScale/cw)*100;
      const topPct = ((ch-(f.rect.y+f.rect.height)*dispScale)/ch)*100, hPct = (f.rect.height*dispScale/ch)*100;
      const style = `position:absolute;left:${leftPct}%;top:${topPct}%;width:${wPct}%;height:${hPct}%;`;
      let el;
      if(f.type==="check"){
        el = document.createElement("input");
        el.type = "checkbox"; el.style.cssText = style+"margin:0;accent-color:var(--red);";
        el.checked = !!fieldValues[f.name];
        el.addEventListener("change", ()=>{ fieldValues[f.name] = el.checked; });
      } else if(f.type==="radio"){
        el = document.createElement("input");
        el.type = "radio"; el.name = "fillform_rg_"+f.name; el.dataset.value = f.radioValue;
        el.style.cssText = style+"margin:0;accent-color:var(--red);";
        el.checked = fieldValues[f.name] === f.radioValue;
        el.addEventListener("change", ()=>{ if(el.checked) fieldValues[f.name] = f.radioValue; });
      } else {
        el = document.createElement("input");
        el.type = "text";
        el.style.cssText = style+"box-sizing:border-box;padding:0 4px;";
        el.value = fieldValues[f.name] || "";
        el.addEventListener("input", ()=>{ fieldValues[f.name] = el.value; });
      }
      el.className = "fillform-field-overlay";
      el.dataset.fname = f.name; el.dataset.ftype = f.type;
      canvasWrap.appendChild(el);
    });
    readout.textContent = fields.length
      ? `${fields.length} field${fields.length>1?"s":""} on this page — click to fill.`
      : "No fillable fields on this page.";
  }

  async function renderPage(pageNum, myToken){
    readout.textContent = "Rendering page…";
    let rendered;
    try{
      rendered = await renderPdfPageCanvas(pdoc, pageNum, dispScale);
    }catch(e){
      if(myToken !== loadToken) return false;
      readout.textContent = "Could not render this page. Try a different file.";
      return false;
    }
    if(myToken !== loadToken) return false;
    pageCanvas.width = rendered.width; pageCanvas.height = rendered.height;
    pageCanvas.getContext("2d").drawImage(rendered, 0, 0);
    currentPage = pageNum;
    pageNumInput.value = pageNum;
    renderFieldOverlays(pageNum-1);
    return true;
  }

  async function goToPage(n){
    const myToken = loadToken;
    const clamped = Math.min(Math.max(n,1), pdoc.numPages);
    if(clamped === currentPage) return;
    await renderPage(clamped, myToken);
  }
  document.getElementById("fillformPrevPage").addEventListener("click", ()=>goToPage(currentPage-1));
  document.getElementById("fillformNextPage").addEventListener("click", ()=>goToPage(currentPage+1));
  pageNumInput.addEventListener("change", ()=>goToPage(parseInt(pageNumInput.value)||1));

  wireDropzone(async fs=>{
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ file=null; resetFormUI(); });
    resetFormUI();
    // resetFormUI() bumped loadToken again - recapture so this run's own
    // guard checks below compare against the right value.
    const runToken = loadToken;
    fileSlot.appendChild(document.getElementById("flist"));
    readout.textContent = "Reading PDF…";
    showWorkspace();

    let parsedDoc, loadedPdoc, collected;
    try{
      const bytes = await file.arrayBuffer();
      parsedDoc = await loadPdfSafe(bytes);
      collected = collectFieldsByPage(parsedDoc);
      loadedPdoc = await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    }catch(e){
      if(runToken !== loadToken) return;
      readout.textContent = `Could not read this PDF (${e.message}).`;
      return;
    }
    if(runToken !== loadToken) return;
    doc = parsedDoc; pdoc = loadedPdoc;
    fieldsByPage = collected.byPage; totalFieldCount = collected.count;

    const page1 = await pdoc.getPage(1);
    if(runToken !== loadToken) return;
    const vp1 = page1.getViewport({scale:1});
    dispScale = Math.min(1, 700/vp1.width);
    pageField.style.display = pdoc.numPages>1 ? "block" : "none";
    pageNumInput.max = pdoc.numPages;

    await renderPage(1, runToken);
    if(runToken !== loadToken) return;
    actions.style.display = totalFieldCount>0 ? "block" : "none";
    if(totalFieldCount===0){
      readout.textContent = "This PDF does not contain any fillable form fields.";
    }
  });

  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Filling form...");
    const form = doc.getForm();
    // Reads from fieldValues (kept in sync by each overlay input's own
    // change/input listener), not the live DOM - only the current page's
    // overlay inputs exist in the DOM at any moment, so a multi-page form
    // filled across several pages would otherwise lose every page but
    // the one visible at export time.
    Object.keys(fieldValues).forEach(name=>{
      const type = fieldTypeByName[name];
      const value = fieldValues[name];
      try{
        if(type==="check"){
          const cb = form.getCheckBox(name);
          value ? cb.check() : cb.uncheck();
        } else if(type==="radio"){
          if(value) form.getRadioGroup(name).select(value);
        } else {
          form.getTextField(name).setText(value);
        }
      }catch(e){}
    });
    if(document.getElementById("flat").checked) form.flatten();
    const outBytes = await doc.save();
    const blob=new Blob([outBytes],{type:"application/pdf"});
    const outName = suffixedName(file, "filled", "pdf");
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, url, filename:outName}));
  });
};

/* ---- Extract images from PDF (page renders) ---- */
TOOLS.extractimages = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Extract Images</h3></div>
    <div class="panel-body compact tool-workspace" id="extractimagesBody">
      <div class="tool-hero">
        <h2 class="tool-hero-title">Extract Images from PDF</h2>
        <p class="tool-hero-desc">Renders each page of your PDF as a full image you can download.</p>
      </div>
      <div class="tool-upload-wrap">
        ${fileInputHTML("application/pdf", false, "Select PDF file")}
      </div>
      <p class="tool-privacy-hint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-toolbar" id="extractimagesToolbar" style="display:none">
        <button class="btn tool-toolbar-primary" id="go">Extract Images</button>
      </div>
      <div id="out"></div>
    </div>`);
  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; document.getElementById("extractimagesToolbar").style.display="none"; document.getElementById("extractimagesBody").classList.remove("is-loaded"); renderFileList([], ()=>{}); });
    document.getElementById("extractimagesToolbar").style.display="flex";
    document.getElementById("extractimagesBody").classList.add("is-loaded");
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading PDF...");
    await ensureJSZip();
    const bytes=await file.arrayBuffer();
    const pdoc = await pdfjsLib.getDocument({data:bytes}).promise;
    const zip = new JSZip();
    try{
      for(let i=1;i<=pdoc.numPages;i++){
        setStatus("Extracting images...", false, Math.round((i/pdoc.numPages)*100));
        // renderPdfPageCanvas(), not a raw page.render() - see Invert PDF
        // Colors' identical comment for why a hang here must reject
        // instead of freezing this loop forever.
        const canvas = await renderPdfPageCanvas(pdoc, i, 2);
        const blob = await new Promise(res=>canvas.toBlob(res,"image/png"));
        zip.file(`page_${i}.png`, blob);
      }
    }catch(e){
      out.innerHTML = `<div class="status" style="color:var(--rose)">Could not render this PDF (${escapeAttr(e.message)}). Try a different file.</div>`;
      return;
    }
    setStatus("Preparing download...");
    const zipBlob = await zip.generateAsync({type:"blob"});
    const outName = suffixedName(file, "images", "zip");
    const {url}=downloadBlob(zipBlob,outName);
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(zipBlob.size), sizeGood:true, url, filename:outName}));
  });
};

/* ---- Image tools ---- */
/* Shared by all 6 image tools (compress/resize/crop/convert/watermark/
   invert). A failed <img> load rejects with a raw DOM Event, not an
   Error - left as-is, that surfaces to the user (via the app's global
   unhandledrejection safety net, none of these 6 call sites wrap this
   in their own try/catch) as the literal text "Something went wrong
   ([object Event])" - confirmed by testing a corrupt file through
   Convert Image Format. Wrapping it in a real Error with a clear
   message here fixes the message everywhere this is called from at
   once, rather than patching 6 separate call sites. */
function loadImage(file){
  return new Promise((res,rej)=>{
    const img=new Image(); const url=URL.createObjectURL(file);
    img.onload=()=>res(img);
    img.onerror=()=>rej(new Error(`Could not read "${file.name}" as an image - it may be corrupt or an unsupported format.`));
    img.src=url;
  });
}

TOOLS.imgcompress = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Image Compressor</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgcompressBody">
      <div class="tool-hero" id="imgcompressHero">
        <h2 class="tool-hero-title">Image Compressor</h2>
        <p class="tool-hero-desc">Shrink an image toward a target file size, right in your browser.</p>
      </div>
      <div class="tool-upload-wrap" id="imgcompressUploadWrap">
        ${fileInputHTML("image/*", false, "Select image")}
      </div>
      <p class="tool-privacy-hint" id="imgcompressPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="imgcompressWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgcompressPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Image Compressor</h3>
          <div id="imgcompressFileSlot"></div>
          <div class="field"><label>Target size in KB</label><input type="number" id="targetKb" placeholder="e.g. 100"></div>
          <button class="btn tool-toolbar-primary" id="go">Compress Image</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgcompressHero");
  const uploadWrap = document.getElementById("imgcompressUploadWrap");
  const privacyHint = document.getElementById("imgcompressPrivacyHint");
  const workspace = document.getElementById("imgcompressWorkspace");
  const fileSlot = document.getElementById("imgcompressFileSlot");
  const previewPane = document.getElementById("imgcompressPreviewPane");
  const body = document.getElementById("imgcompressBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out");
    const targetKb = parseInt(document.getElementById("targetKb").value);
    if(!targetKb){ toast("Enter a target size in KB"); return; }
    const targetBytes = targetKb*1024;
    out.innerHTML=statusEl("Reading image...");
    const img = await loadImage(file);
    let quality=0.85, scale=1;
    let best=null;
    for(let i=0;i<10;i++){
      const refSize = best ? best.size : file.size;
      setStatus("Compressing...", false, Math.min(99, Math.round((targetBytes/refSize)*100)));
      const canvas=document.createElement("canvas");
      canvas.width=img.width*scale; canvas.height=img.height*scale;
      canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
      const blob = await new Promise(res=>canvas.toBlob(res,"image/jpeg",quality));
      if(!best || blob.size<best.size) best=blob;
      setStatus("Compressing...", false, Math.min(99, Math.round((targetBytes/blob.size)*100)));
      if(blob.size<=targetBytes) break;
      if(quality>0.3) quality-=0.1; else if(scale>0.4) {scale-=0.15; quality=0.7;} else break;
    }
    let usedOriginal=false;
    if(best.size >= file.size){ best = file; usedOriginal = true; }
    const outName = suffixedName(file, "compressed", "jpg");
    setStatus("Preparing download...");
    const {url}=downloadBlob(best,outName);
    const im=document.createElement("img"); im.src=url;
    const reached = best.size<=targetBytes;
    setStatus(usedOriginal ? `This image is already efficiently encoded — we kept the original (${fmtSize(best.size)}).` : (reached?"Target reached":`Best possible result: ${fmtSize(best.size)}`), true);
    out.appendChild(resultBox({sizeText:`${fmtSize(best.size)} (target ${targetKb} KB)`, sizeGood:reached, previewNode:im, url, filename:outName}));
  });
};

TOOLS.imgresize = function(){
  let file=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Resize Image</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgresizeBody">
      <div class="tool-hero" id="imgresizeHero">
        <h2 class="tool-hero-title">Resize Image</h2>
        <p class="tool-hero-desc">Change an image's dimensions, in your browser.</p>
      </div>
      <div class="tool-upload-wrap" id="imgresizeUploadWrap">
        ${fileInputHTML("image/*", false, "Select image")}
      </div>
      <p class="tool-privacy-hint" id="imgresizePrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="imgresizeWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgresizePreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Resize Image</h3>
          <div id="imgresizeFileSlot"></div>
          <div class="field"><label>Width (px)</label><input type="number" id="rw" placeholder="800"></div>
          <div class="field"><label>Height (px)</label><input type="number" id="rh" placeholder="600"></div>
          <label style="font-size:.85rem;display:flex;gap:6px;align-items:center;"><input type="checkbox" id="keepRatio" checked> Maintain aspect ratio</label>
          <button class="btn tool-toolbar-primary" id="go">Resize Image</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgresizeHero");
  const uploadWrap = document.getElementById("imgresizeUploadWrap");
  const privacyHint = document.getElementById("imgresizePrivacyHint");
  const workspace = document.getElementById("imgresizeWorkspace");
  const fileSlot = document.getElementById("imgresizeFileSlot");
  const previewPane = document.getElementById("imgresizePreviewPane");
  const body = document.getElementById("imgresizeBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  let imgRef=null;
  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; file=null; imgRef=null; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    // Was unguarded: a corrupt/unreadable file rejected here with
    // nothing catching it - the file card still appeared (renderFileList
    // above already ran), but the workspace never showed and nothing
    // told the user why. Confirmed by testing: the panel just sat there
    // silently forever. Every one of this tool's siblings that loads the
    // image at drop-time (Crop/Watermark/Invert Image) has the identical
    // pattern, fixed the same way.
    let loadedImg;
    try{ loadedImg = await loadImage(file); }
    catch(e){
      if(myToken !== loadToken) return;
      toast(e.message || "Could not read this image file");
      file=null; imgRef=null; showEmptyState();
      return;
    }
    if(myToken !== loadToken) return;
    imgRef = loadedImg;
    document.getElementById("rw").value=imgRef.width;
    document.getElementById("rh").value=imgRef.height;
    showWorkspace();
  });
  document.getElementById("rw").addEventListener("input", ()=>{
    if(document.getElementById("keepRatio").checked && imgRef){
      document.getElementById("rh").value = Math.round(document.getElementById("rw").value * imgRef.height/imgRef.width);
    }
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Resizing...");
    const w=+document.getElementById("rw").value, h=+document.getElementById("rh").value;
    const canvas=document.createElement("canvas"); canvas.width=w; canvas.height=h;
    canvas.getContext("2d").drawImage(imgRef,0,0,w,h);
    const {mime, ext} = imgOutputFormat(file);
    const blob = await new Promise(res=>canvas.toBlob(res, mime, 0.92));
    const outName = suffixedName(file, "resized", ext);
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const im=document.createElement("img"); im.src=url;
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:im, url, filename:outName}));
  });
};

TOOLS.imgcrop = function(){
  let file=null, imgRef=null, dispScale=1, rect=null, bgImageData=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Crop Image</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgcropBody">
      <div class="tool-hero" id="imgcropHero">
        <h2 class="tool-hero-title">Crop Image</h2>
        <p class="tool-hero-desc">Drag to draw a selection, then use the corner/edge handles to fine-tune it.</p>
      </div>
      <div class="tool-upload-wrap" id="imgcropUploadWrap">
        ${fileInputHTML("image/*", false, "Select image")}
      </div>
      <p class="tool-privacy-hint" id="imgcropPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="imgcropWorkspace" style="display:none">
        <div class="tool-main-pane">
          <div class="crop-stage tool-content-area" id="cropStage">
            <canvas id="cropCanvas"></canvas>
          </div>
          <div class="mono" id="cropReadout" style="font-size:.78rem;color:var(--ink-soft);text-align:center;margin:6px 0;"></div>
        </div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Crop Image</h3>
          <div id="imgcropFileSlot"></div>
          <button class="btn secondary" id="resetCrop" type="button">Reset Selection</button>
          <button class="btn tool-toolbar-primary" id="go">Crop Image</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgcropHero");
  const uploadWrap = document.getElementById("imgcropUploadWrap");
  const privacyHint = document.getElementById("imgcropPrivacyHint");
  const workspace = document.getElementById("imgcropWorkspace");
  const fileSlot = document.getElementById("imgcropFileSlot");
  const body = document.getElementById("imgcropBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  const cropState = {
    rect: null,
    redraw(){
      const canvas = document.getElementById("cropCanvas");
      const ctx = canvas.getContext("2d");
      ctx.putImageData(bgImageData, 0, 0);
      rect = cropState.rect;
      if(rect && rect.w>0 && rect.h>0){
        ctx.save();
        ctx.fillStyle="rgba(0,0,0,0.4)";
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.putImageData(bgImageData, 0, 0, rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle="#E8291B"; ctx.lineWidth=2;
        ctx.strokeRect(rect.x,rect.y,rect.w,rect.h);
        drawCropHandles(ctx, rect);
        ctx.restore();
      }
      const r = document.getElementById("cropReadout");
      if(r){
        if(rect && rect.w>0 && rect.h>0){
          const ow=Math.round(rect.w/dispScale), oh=Math.round(rect.h/dispScale);
          const ox=Math.round(rect.x/dispScale), oy=Math.round(rect.y/dispScale);
          r.textContent = `Selection: ${ow} × ${oh}px at (${ox}, ${oy})`;
        } else {
          r.textContent = "Drag on the image above to select an area (defaults to the full image).";
        }
      }
    }
  };

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{
      loadToken++;
      file=null; imgRef=null;
      document.getElementById("cropReadout").textContent="";
      showEmptyState();
    });
    fileSlot.appendChild(document.getElementById("flist"));
    // See Resize Image's identical fix - was unguarded, silently stuck
    // the panel forever on a corrupt/unreadable file.
    let loadedImg;
    try{ loadedImg = await loadImage(file); }
    catch(e){
      if(myToken !== loadToken) return;
      toast(e.message || "Could not read this image file");
      file=null; imgRef=null;
      document.getElementById("cropReadout").textContent="";
      showEmptyState();
      return;
    }
    if(myToken !== loadToken) return;
    imgRef = loadedImg;
    const qp = document.getElementById("quickPreview"); if(qp) qp.innerHTML = "";
    const canvas = document.getElementById("cropCanvas");
    const maxW = 700; // wider cap than before - the main pane has real room now, not a small centered column
    dispScale = Math.min(1, maxW/imgRef.width);
    canvas.width = Math.round(imgRef.width*dispScale);
    canvas.height = Math.round(imgRef.height*dispScale);
    canvas.getContext("2d").drawImage(imgRef, 0, 0, canvas.width, canvas.height);
    bgImageData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
    cropState.rect = {x:0, y:0, w:canvas.width, h:canvas.height};
    cropState.redraw();
    showWorkspace();
    wireCropCanvas(canvas, cropState);
    document.getElementById("resetCrop").onclick = ()=>{
      cropState.rect = {x:0, y:0, w:canvas.width, h:canvas.height};
      cropState.redraw();
    };
  });

  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Cropping...");
    const cx=Math.round(rect.x/dispScale), cy=Math.round(rect.y/dispScale);
    const cw=Math.max(1,Math.round(rect.w/dispScale)), ch=Math.max(1,Math.round(rect.h/dispScale));
    const canvas=document.createElement("canvas"); canvas.width=cw; canvas.height=ch;
    canvas.getContext("2d").drawImage(imgRef, cx,cy,cw,ch, 0,0,cw,ch);
    const {mime, ext} = imgOutputFormat(file);
    const blob = await new Promise(res=>canvas.toBlob(res, mime, 0.92));
    const outName = suffixedName(file, "cropped", ext);
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const im=document.createElement("img"); im.src=url;
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:im, url, filename:outName}));
  });
};

TOOLS.imgconvert = function(){
  let file=null;
  openPanel(`
    <div class="panel-head"><h3>Convert Image Format</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgconvertBody">
      <div class="tool-hero" id="imgconvertHero">
        <h2 class="tool-hero-title">Convert Image Format</h2>
        <p class="tool-hero-desc">Convert an image between PNG, JPG, and WebP.</p>
      </div>
      <div class="tool-upload-wrap" id="imgconvertUploadWrap">
        ${fileInputHTML("image/*", false, "Select image")}
      </div>
      <p class="tool-privacy-hint" id="imgconvertPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="imgconvertWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgconvertPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Convert Image Format</h3>
          <div id="imgconvertFileSlot"></div>
          <div class="field"><label>Target format</label>
            <select id="fmt"><option value="image/png">PNG</option><option value="image/jpeg">JPG</option><option value="image/webp">WebP</option></select>
          </div>
          <button class="btn tool-toolbar-primary" id="go">Convert Image</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgconvertHero");
  const uploadWrap = document.getElementById("imgconvertUploadWrap");
  const privacyHint = document.getElementById("imgconvertPrivacyHint");
  const workspace = document.getElementById("imgconvertWorkspace");
  const fileSlot = document.getElementById("imgconvertFileSlot");
  const previewPane = document.getElementById("imgconvertPreviewPane");
  const body = document.getElementById("imgconvertBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(fs=>{
    file=fs[0];
    renderFileList([file], ()=>{ file=null; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Reading image...");
    const img = await loadImage(file);
    const canvas=document.createElement("canvas"); canvas.width=img.width; canvas.height=img.height;
    canvas.getContext("2d").drawImage(img,0,0);
    setStatus("Converting...");
    const fmt = document.getElementById("fmt").value;
    const ext = fmt.split("/")[1];
    const blob = await new Promise(res=>canvas.toBlob(res, fmt, 0.92));
    const outName = suffixedName(file, "converted", ext);
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const im=document.createElement("img"); im.src=url;
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:im, url, filename:outName}));
  });
};

TOOLS.imgwatermark = function(){
  let file=null, imgRef=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Add Watermark to Image</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imgwatermarkBody">
      <div class="tool-hero" id="imgwatermarkHero">
        <h2 class="tool-hero-title">Add Watermark to Image</h2>
        <p class="tool-hero-desc">Stamp diagonal text across an image, right in your browser.</p>
      </div>
      <div class="tool-upload-wrap" id="imgwatermarkUploadWrap">
        ${fileInputHTML("image/*", false, "Select image")}
      </div>
      <p class="tool-privacy-hint" id="imgwatermarkPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="imgwatermarkWorkspace" style="display:none">
        <div class="tool-main-pane" id="imgwatermarkPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Add Watermark</h3>
          <div id="imgwatermarkFileSlot"></div>
          <div class="field"><label>Watermark text</label><input type="text" id="wtext" placeholder="e.g. SAMPLE"></div>
          <div class="field"><label>Opacity</label><input type="number" id="opac" value="0.4" step="0.05" min="0.05" max="1"></div>
          <div class="field"><label>Font size (px)</label><input type="number" id="fsize" value="36"></div>
          <button class="btn tool-toolbar-primary" id="go">Add Watermark</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imgwatermarkHero");
  const uploadWrap = document.getElementById("imgwatermarkUploadWrap");
  const privacyHint = document.getElementById("imgwatermarkPrivacyHint");
  const workspace = document.getElementById("imgwatermarkWorkspace");
  const fileSlot = document.getElementById("imgwatermarkFileSlot");
  const previewPane = document.getElementById("imgwatermarkPreviewPane");
  const body = document.getElementById("imgwatermarkBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; file=null; imgRef=null; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    // See Resize Image's identical fix - was unguarded, silently stuck
    // the panel forever on a corrupt/unreadable file.
    let loadedImg;
    try{ loadedImg = await loadImage(file); }
    catch(e){
      if(myToken !== loadToken) return;
      toast(e.message || "Could not read this image file");
      file=null; imgRef=null; showEmptyState();
      return;
    }
    if(myToken !== loadToken) return;
    imgRef = loadedImg;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing image...");
    const canvas=document.createElement("canvas"); canvas.width=imgRef.width; canvas.height=imgRef.height;
    const ctx=canvas.getContext("2d"); ctx.drawImage(imgRef,0,0);
    const text = document.getElementById("wtext").value || "WATERMARK";
    const opac = parseFloat(document.getElementById("opac").value)||0.4;
    const fsize = parseInt(document.getElementById("fsize").value)||36;
    ctx.save();
    ctx.globalAlpha = opac;
    ctx.fillStyle="#ffffff"; ctx.strokeStyle="rgba(0,0,0,0.3)"; ctx.lineWidth=2;
    ctx.font = `700 ${fsize}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.translate(canvas.width/2, canvas.height/2);
    ctx.rotate(-Math.PI/8);
    ctx.strokeText(text,0,0); ctx.fillText(text,0,0);
    ctx.restore();
    const {mime, ext} = imgOutputFormat(file);
    const blob = await new Promise(res=>canvas.toBlob(res, mime, 0.92));
    const outName = suffixedName(file, "watermarked", ext);
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const im=document.createElement("img"); im.src=url;
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:im, url, filename:outName}));
  });
};

TOOLS.imginvert = function(){
  let file=null, imgRef=null, loadToken=0;
  openPanel(`
    <div class="panel-head"><h3>Invert Image Colors</h3></div>
    <div class="panel-body compact no-auto-layout tool-workspace tool-app-shell" id="imginvertBody">
      <div class="tool-hero" id="imginvertHero">
        <h2 class="tool-hero-title">Invert Image Colors</h2>
        <p class="tool-hero-desc">Flip an image to its color negative.</p>
      </div>
      <div class="tool-upload-wrap" id="imginvertUploadWrap">
        ${fileInputHTML("image/*", false, "Select image")}
      </div>
      <p class="tool-privacy-hint" id="imginvertPrivacyHint">🔒 Everything happens right here in your browser — your files are never uploaded or stored anywhere.</p>
      <div class="tool-app-workspace" id="imginvertWorkspace" style="display:none">
        <div class="tool-main-pane" id="imginvertPreviewPane"></div>
        <aside class="tool-side-panel">
          <h3 class="tool-side-panel-title">Invert Image Colors</h3>
          <div id="imginvertFileSlot"></div>
          <button class="btn tool-toolbar-primary" id="go">Invert Image</button>
        </aside>
      </div>
      <div id="out"></div>
    </div>`);

  const hero = document.getElementById("imginvertHero");
  const uploadWrap = document.getElementById("imginvertUploadWrap");
  const privacyHint = document.getElementById("imginvertPrivacyHint");
  const workspace = document.getElementById("imginvertWorkspace");
  const fileSlot = document.getElementById("imginvertFileSlot");
  const previewPane = document.getElementById("imginvertPreviewPane");
  const body = document.getElementById("imginvertBody");

  function showEmptyState(){
    hero.style.display=""; uploadWrap.style.display=""; privacyHint.style.display="";
    workspace.style.display="none";
    body.classList.remove("is-loaded");
  }
  function showWorkspace(){
    hero.style.display="none"; uploadWrap.style.display="none"; privacyHint.style.display="none";
    workspace.style.display="flex";
    body.classList.add("is-loaded");
  }

  wireDropzone(async fs=>{
    // See Split PDF's identical guard.
    const myToken = ++loadToken;
    file=fs[0];
    renderFileList([file], ()=>{ loadToken++; file=null; showEmptyState(); });
    fileSlot.appendChild(document.getElementById("flist"));
    previewPane.appendChild(document.getElementById("quickPreview"));
    // See Resize Image's identical fix - was unguarded, silently stuck
    // the panel forever on a corrupt/unreadable file.
    let loadedImg;
    try{ loadedImg = await loadImage(file); }
    catch(e){
      if(myToken !== loadToken) return;
      toast(e.message || "Could not read this image file");
      file=null; imgRef=null; showEmptyState();
      return;
    }
    if(myToken !== loadToken) return;
    imgRef = loadedImg;
    showWorkspace();
  });
  document.getElementById("go").addEventListener("click", async ()=>{
    const out=document.getElementById("out"); out.innerHTML=statusEl("Processing image...");
    const canvas=document.createElement("canvas"); canvas.width=imgRef.width; canvas.height=imgRef.height;
    const ctx=canvas.getContext("2d"); ctx.drawImage(imgRef,0,0);
    const imgData = ctx.getImageData(0,0,canvas.width,canvas.height);
    const d = imgData.data;
    for(let px=0; px<d.length; px+=4){ d[px]=255-d[px]; d[px+1]=255-d[px+1]; d[px+2]=255-d[px+2]; }
    ctx.putImageData(imgData,0,0);
    const {mime, ext} = imgOutputFormat(file);
    const blob = await new Promise(res=>canvas.toBlob(res, mime, 0.92));
    const outName = suffixedName(file, "inverted", ext);
    setStatus("Preparing download...");
    const {url}=downloadBlob(blob,outName);
    const im=document.createElement("img"); im.src=url;
    setStatus("Done", true);
    out.appendChild(resultBox({sizeText:fmtSize(blob.size), sizeGood:true, previewNode:im, url, filename:outName}));
  });
};


/* Homepage-only entrance choreography: header -> hero copy (staggered) ->
   hero upload mock -> tool category grid (single small stagger, capped
   total spread via stagger.amount rather than stagger.each so it stays
   short regardless of how many tools the registry grows to). Deliberately
   sequenced, not simultaneous - see MOTION comment above for why. Runs
   once at load; a tool panel opening over the hero afterward (deep-link
   or user click) is unaffected since this only touches homepage elements
   and finishes well before any click could happen. */
(function(){
  if(!window.gsap) return;
  const header = document.querySelector("header");
  const heroBadge = document.querySelector(".hero-badge");
  const heroLines = document.querySelectorAll(".hero-line1, .hero-line2");
  const heroTagline = document.querySelector(".hero-copy .tagline");
  const heroCta = document.querySelector(".hero-cta");
  const heroArt = document.querySelector(".hero-art");
  const sectionHead = document.querySelector("#tools .section-head");
  // Tool cards are deliberately NOT in this entrance timeline - they're
  // owned entirely by the ScrollTrigger-based reveal further down (see
  // "Tool card scroll reveal"), so the two systems never fight over the
  // same cards' autoAlpha/y at once, same lesson as the quick-tools rail.
  const entranceTargets = [header, heroBadge, ...heroLines, heroTagline, heroCta, heroArt, sectionHead].filter(Boolean);
  if(MOTION.reduced){
    gsap.set(entranceTargets, {autoAlpha:1, y:0, scale:1});
    return;
  }
  // Unconditional safety net: force full visibility after a fixed delay no
  // matter what GSAP itself reports - confirmed in the field that a
  // staggered tween can report onComplete via a lag-smoothing time-jump on
  // a throttled/backgrounded tab WITHOUT ever actually rendering the final
  // visible state, so this must not be gated on the timeline's own
  // onComplete. Real page content can never depend solely on an
  // animation's own "done" signal being trustworthy.
  setTimeout(()=>{
    gsap.set(entranceTargets, {autoAlpha:1, y:0, scale:1, clearProps:"transform"});
  }, 1600);
  const tl = gsap.timeline({defaults:{ease:MOTION.ease.enter}});
  if(header) tl.from(header, {autoAlpha:0, y:-16, duration:MOTION.fast});
  tl.set([heroBadge, ...heroLines, heroTagline, heroCta].filter(Boolean), {autoAlpha:0, y:14});
  tl.to([heroBadge, ...heroLines, heroTagline, heroCta].filter(Boolean), {autoAlpha:1, y:0, duration:MOTION.normal, stagger:MOTION.stagger.medium}, "-=0.05");
  if(heroArt) tl.from(heroArt, {autoAlpha:0, scale:0.94, duration:MOTION.normal}, "-=0.2");
  if(sectionHead) tl.from(sectionHead, {autoAlpha:0, y:14, duration:MOTION.normal}, "-=0.05");
})();

/* Homepage-only: sticky navbar transparent-at-top -> solid-on-scroll. No app/tool logic touched. */
(function(){
  const header = document.querySelector("header");
  if(!header) return;
  function syncHeaderScroll(){
    header.classList.toggle("scrolled", window.scrollY > 8);
  }
  syncHeaderScroll();
  window.addEventListener("scroll", syncHeaderScroll, { passive:true });
})();

/* Homepage-only: cursor trail + magnetic CTAs + Dock-style trust-badge
   row. All three no-op under reduced-motion/touch (see shouldSkipCursorFx
   in each utility) - nothing here needs its own separate guard. */
(function(){
  if(!window.gsap) return;
  const heroPrimary = document.getElementById("heroChoosePdfBtn");
  const heroSecondary = document.querySelector(".btn-cta-secondary");
  if(heroPrimary){ heroPrimary.classList.add("magnetic"); initMagnetic(heroPrimary, {strength:14, scale:1.04}); }
  if(heroSecondary){ heroSecondary.classList.add("magnetic"); initMagnetic(heroSecondary, {strength:10, scale:1.03}); }
  const trustRow = document.querySelector(".trust-strip-inner");
  if(trustRow){
    trustRow.querySelectorAll(".trust-item").forEach(it=>it.classList.add("dock-item"));
    initDockMagnify(trustRow, ".trust-item", {maxScale:1.22, falloff:110});
  }
  // Header icon buttons: lighter magnetic pull (small radius/strength) -
  // present on every page, not just the homepage, since the header is shared.
  const themeToggleBtn = document.getElementById("themeToggle");
  const hamburgerBtn = document.getElementById("hamburgerBtn");
  const donateBtn = document.querySelector(".nav-actions .btn-donate-nav");
  if(themeToggleBtn){ themeToggleBtn.classList.add("magnetic"); initMagnetic(themeToggleBtn, {strength:7, radius:40, scale:1.08}); }
  if(hamburgerBtn){ hamburgerBtn.classList.add("magnetic"); initMagnetic(hamburgerBtn, {strength:7, radius:40, scale:1.08}); }
  if(donateBtn){ donateBtn.classList.add("magnetic"); initMagnetic(donateBtn, {strength:8, scale:1.03}); }
  // Tool card hover: scale/lift, subtle cursor-tilt, and icon
  // micro-animation, all via one delegated pointermove listener on the
  // grid (not one listener per card - 40+ would be wasteful) with a
  // per-card set of quickTo setters created once up front (cheap,
  // reused every hover - not recreated per pointermove). Also still
  // sets --mx/--my for the existing CSS-driven radial spotlight
  // (.card::after above) - same listener, no duplicate.
  // Transform ownership: this is the ONLY code that ever touches a
  // .card's transform once JS runs (see the CSS comment on .card:hover -
  // the transform was deliberately removed from CSS to avoid the same
  // fight the quick-tools rail hit between a CSS pseudo-class and GSAP).
  /* Shared "physical card" hover controller - ONE implementation reused
     for both the tool-cards grid and the four feature cards (Safe &
     Secure / Blazing Fast / Works on Any Device / Always Free), rather
     than a second competing system. ONE controller owns every transform-
     related property any card (or its icon/title/desc) ever gets touched
     by - scaleX/scaleY/x/y/z/rotationX/Y/Z on the card, scaleX/scaleY/y/z
     on the icon, z on title/desc, opacity for sibling recession. No CSS
     transition on any of these (see each card class's own CSS comment) -
     every one of these was a real, confirmed-live conflict earlier and is
     deliberately avoided here from the start. */
  function initPhysicalCardHover(container, opts={}){
    if(!container) return;
    const cardSel = opts.cardSelector || ".card";
    const allCards = [...container.querySelectorAll(cardSel)];
    if(!allCards.length) return;
    const iconSel = opts.iconSelector || ".icon, .icon-stack";
    const nameSel = opts.nameSelector || ".name";
    const descSel = opts.descSelector || ".desc";
    const cardFx = new Map();
    allCards.forEach(card=>{
      const icon = card.querySelector(iconSel);
      const nameEl = card.querySelector(nameSel);
      const descEl = card.querySelector(descSel);
      const opt = {overwrite:"auto"};
      const fx = {
        scaleXTo: gsap.quickTo(card, "scaleX", {duration:0.28, ease:"power3.out", ...opt}),
        scaleYTo: gsap.quickTo(card, "scaleY", {duration:0.28, ease:"power3.out", ...opt}),
        xTo: gsap.quickTo(card, "x", {duration:0.28, ease:"power3.out", ...opt}),
        yTo: gsap.quickTo(card, "y", {duration:0.28, ease:"power3.out", ...opt}),
        zTo: gsap.quickTo(card, "z", {duration:0.28, ease:"power3.out", ...opt}),
        rxTo: shouldSkipCursorFx() ? null : gsap.quickTo(card, "rotationX", {duration:0.24, ease:"power3.out", ...opt}),
        ryTo: shouldSkipCursorFx() ? null : gsap.quickTo(card, "rotationY", {duration:0.24, ease:"power3.out", ...opt}),
        rzTo: shouldSkipCursorFx() ? null : gsap.quickTo(card, "rotationZ", {duration:0.28, ease:"power3.out", ...opt}),
        iconScaleXTo: icon ? gsap.quickTo(icon, "scaleX", {duration:0.32, ease:"power2.out", ...opt}) : null,
        iconScaleYTo: icon ? gsap.quickTo(icon, "scaleY", {duration:0.32, ease:"power2.out", ...opt}) : null,
        iconYTo: icon ? gsap.quickTo(icon, "y", {duration:0.32, ease:"power2.out", ...opt}) : null,
        iconZTo: icon ? gsap.quickTo(icon, "z", {duration:0.32, ease:"power2.out", ...opt}) : null,
        nameZTo: nameEl ? gsap.quickTo(nameEl, "z", {duration:0.32, ease:"power2.out", ...opt}) : null,
        descZTo: descEl ? gsap.quickTo(descEl, "z", {duration:0.32, ease:"power2.out", ...opt}) : null,
        // opacity (not autoAlpha - a reveal tween elsewhere may use
        // autoAlpha, a distinct alias GSAP doesn't treat as "the same
        // property" as plain opacity for overwrite purposes) for sibling
        // de-emphasis.
        opacityTo: gsap.quickTo(card, "opacity", {duration:0.4, ease:"power2.out", ...opt}),
      };
      cardFx.set(card, fx);
    });
    function resetCardFx(card){
      const fx = cardFx.get(card);
      if(!fx) return;
      fx.scaleXTo(1); fx.scaleYTo(1); fx.xTo(0); fx.yTo(0); fx.zTo(0);
      if(fx.rxTo){ fx.rxTo(0); fx.ryTo(0); fx.rzTo(0); }
      if(fx.iconScaleXTo){ fx.iconScaleXTo(1); fx.iconScaleYTo(1); fx.iconYTo(0); fx.iconZTo(0); }
      if(fx.nameZTo) fx.nameZTo(0);
      if(fx.descZTo) fx.descZTo(0);
    }
    // Direct, explicit kill of any scroll-reveal tween's remaining portion
    // on first interaction, rather than relying on GSAP's overwrite
    // heuristics - confirmed live, over several rounds, that matching
    // property names plus overwrite:"auto" still did not reliably stop a
    // stagger-batched .to() tween's per-card portion from continuing to
    // write opacity/y/scale alongside a quickTo targeting the same
    // properties. Identifies a reveal tween specifically by its unique
    // `stagger` var (no other tween touching cards ever sets that), so
    // this can't accidentally kill an unrelated tween - harmless no-op on
    // a grid (like the feature cards) that never had a reveal tween.
    let revealPurged = false;
    function purgeRevealTweens(){
      if(revealPurged) return;
      revealPurged = true;
      allCards.forEach(c=>{
        gsap.getTweensOf(c).forEach(t=>{ if(t.vars && t.vars.stagger !== undefined){ t.progress(1); t.kill(); } });
      });
    }
    // Directional recession: siblings shift a few px AWAY from the
    // hovered card (not just dim+shrink) so the hovered card visually
    // "pops out" of the grid rather than just sitting brighter than flat
    // neighbors. Geometry read once per hover-target-change (not per
    // pointermove).
    function dimSiblings(hoveredCard){
      const hr = hoveredCard.getBoundingClientRect();
      const hcx = hr.left + hr.width/2, hcy = hr.top + hr.height/2;
      allCards.forEach(c=>{
        const fx = cardFx.get(c);
        if(!fx) return;
        if(c===hoveredCard){ fx.opacityTo(1); return; }
        fx.opacityTo(0.8); fx.scaleXTo(0.99); fx.scaleYTo(0.99);
        const cr = c.getBoundingClientRect();
        const ccx = cr.left + cr.width/2, ccy = cr.top + cr.height/2;
        const dx = ccx - hcx, dy = ccy - hcy;
        fx.xTo(dx===0 ? 0 : Math.sign(dx)*4);
        fx.yTo(dy===0 ? 0 : Math.sign(dy)*3);
      });
    }
    function undimAll(){
      allCards.forEach(c=>{
        const fx = cardFx.get(c);
        if(!fx) return;
        fx.opacityTo(1);
        if(c!==activeHoverCard){ fx.scaleXTo(1); fx.scaleYTo(1); fx.xTo(0); fx.yTo(0); }
      });
    }
    let activeHoverCard = null;
    if(!shouldSkipCursorFx() && !MOTION.reduced){
      container.addEventListener("pointermove", e=>{
        purgeRevealTweens();
        const card = e.target.closest(cardSel);
        if(!card){
          if(activeHoverCard){ resetCardFx(activeHoverCard); activeHoverCard = null; undimAll(); }
          return;
        }
        const r = card.getBoundingClientRect();
        const px = (e.clientX-r.left)/r.width, py = (e.clientY-r.top)/r.height; // 0..1
        const nx = px - 0.5, ny = py - 0.5; // -0.5..0.5
        card.style.setProperty("--mx", (px*100)+"%");
        card.style.setProperty("--my", (py*100)+"%");
        if(activeHoverCard !== card){
          if(activeHoverCard) resetCardFx(activeHoverCard);
          activeHoverCard = card;
          dimSiblings(card);
        }
        const fx = cardFx.get(card);
        if(!fx) return;
        // "Physical tile pulled toward the cursor" - stronger lift/tilt/
        // magnetic pull than a flat CSS hover, plus a small asymmetric
        // scaleX/scaleY skew (not identical scale on both axes) so the
        // card doesn't read as a uniform, static enlargement - all still
        // clamped well short of anything that looks broken.
        const sx = 1.05 + Math.abs(nx)*0.02;   // ~1.05-1.065
        const sy = 1.055 + Math.abs(ny)*0.025; // ~1.055-1.0675
        fx.scaleXTo(sx); fx.scaleYTo(sy);
        fx.xTo(nx*10);
        fx.yTo(-12 + (-ny*5));
        fx.zTo(20 + (Math.abs(nx)+Math.abs(ny))*15); // ~20-35
        if(fx.rxTo){
          fx.rxTo(-ny*8);
          fx.ryTo(nx*10);
          fx.rzTo(nx*1.2);
        }
        if(fx.iconScaleXTo){ fx.iconScaleXTo(1.08); fx.iconScaleYTo(1.08); fx.iconYTo(-3); fx.iconZTo(42); }
        if(fx.nameZTo) fx.nameZTo(15);
        if(fx.descZTo) fx.descZTo(8);
      }, {passive:true});
      container.addEventListener("pointerleave", ()=>{
        if(activeHoverCard){ resetCardFx(activeHoverCard); activeHoverCard = null; undimAll(); }
      }, {passive:true});
    }
    return allCards;
  }

  const toolsGrid = document.getElementById("toolsGrid");
  const toolCards = initPhysicalCardHover(toolsGrid);
  if(toolCards){
    // Active-tool card state - same window.__currentToolId source of truth
    // the quick-tools rail already uses, kept in sync at the same trigger
    // points (load/click/popstate) so there's one active-state rule, not two.
    function syncActiveCard(){
      const id = window.__currentToolId;
      toolCards.forEach(c=>c.classList.toggle("card-active", c.dataset.tool === id));
    }
    syncActiveCard();
    window.addEventListener("popstate", ()=>setTimeout(syncActiveCard, 0));
    // [data-tool] (cards) OR [data-open] (dock icons, any other opener) -
    // navigation can be triggered from either, both must resync this.
    document.addEventListener("click", e=>{ if(e.target.closest("[data-tool], [data-open]")) setTimeout(syncActiveCard, 0); });
    // The click listener alone misses "closed back to home" (closing the
    // panel isn't a [data-tool]/[data-open] click) - confirmed live: the
    // active card stayed highlighted after Merge PDF was closed via
    // goHome(). Observing .overlay's open/close directly catches every
    // path that changes window.__currentToolId, not just navigation-in.
    const overlayForCards = document.getElementById("overlay");
    if(overlayForCards) new MutationObserver(()=>setTimeout(syncActiveCard, 0)).observe(overlayForCards, {attributes:true, attributeFilter:["class"]});
  }

  // Feature cards (Safe & Secure / Blazing Fast / Works on Any Device /
  // Always Free) get the same physical-card interaction language, just
  // with their own icon/title selectors (.ficon, no .desc class - it's a
  // plain <p>) and no active-state/reveal-purge concerns (no nav, no
  // scroll-reveal system on this grid).
  const featuresGrid = document.querySelector(".features-grid");
  initPhysicalCardHover(featuresGrid, {cardSelector:".feature-card", iconSelector:".ficon", nameSelector:"h3", descSelector:"p"});
})();

/* Tool card scroll reveal - ONE ScrollTrigger for the whole grid (not one
   per card, per the brief's own "avoid dozens of independent
   ScrollTriggers" note), with a staggered child tween and `once:true` so
   it reveals a single time rather than re-triggering on every scroll
   direction change. Doubles as this content's own unconditional
   visibility safety net (same lesson as the homepage entrance bug this
   session already hit): if reduced-motion, GSAP, or the ScrollTrigger
   plugin isn't available for any reason, cards are set fully visible
   immediately/via a fixed timeout rather than ever staying hidden. */
(function(){
  const toolsGrid = document.getElementById("toolsGrid");
  if(!toolsGrid) return;
  const cards = [...toolsGrid.querySelectorAll(".card")];
  if(!cards.length) return;
  if(!window.gsap || MOTION.reduced){
    if(window.gsap) gsap.set(cards, {opacity:1, visibility:"visible", y:0, scaleX:1, scaleY:1});
    return;
  }
  // scaleX/scaleY (not composite "scale") AND plain opacity+visibility
  // (not the autoAlpha alias) here - the card-hover/sibling-dim system
  // above drives scaleX/scaleY and opacity individually (quickTo doesn't
  // support the "scale" shorthand, see initMagnetic's comment), and
  // GSAP's overwrite logic only recognizes two tweens as conflicting when
  // they target the EXACT same property name - "scale" vs "scaleX", and
  // "autoAlpha" vs "opacity", are each treated as different properties
  // for that purpose despite visually overlapping. Mismatching either
  // left this reveal tween and a hover/dim started on the same card BOTH
  // actively writing the same visual property every tick - confirmed
  // live via gsap.getTweensOf() both times, not a guess.
  gsap.set(cards, {opacity:0, visibility:"hidden", y:40, scaleX:0.96, scaleY:0.96});
  // Only force-show cards still actually invisible when this fires - a
  // blanket gsap.set(cards,{...clearProps:"transform"}) would also stomp
  // any card a user is already hovering/siblings-dimming by then (those
  // own the exact same y/scale/opacity properties), killing that
  // in-progress interaction.
  const revealSafety = setTimeout(()=>{
    const stuck = cards.filter(c=>gsap.getProperty(c,"opacity") < 0.95);
    if(stuck.length) gsap.set(stuck, {opacity:1, visibility:"visible", y:0, scaleX:1, scaleY:1, clearProps:"transform"});
  }, 2000);
  if(window.ScrollTrigger){
    gsap.registerPlugin(ScrollTrigger);
    gsap.to(cards, {
      opacity:1, y:0, scaleX:1, scaleY:1, duration:0.85, ease:"power3.out",
      stagger:{amount:0.6, from:"start"},
      scrollTrigger:{ trigger: toolsGrid, start:"top 92%", once:true },
      onStart:()=>gsap.set(cards, {visibility:"visible"}),
      onComplete:()=>clearTimeout(revealSafety)
    });
  } else {
    // ScrollTrigger CDN unreachable for whatever reason - reveal on a
    // plain stagger instead of leaving cards permanently hidden.
    gsap.set(cards, {visibility:"visible"});
    gsap.to(cards, {opacity:1, y:0, scaleX:1, scaleY:1, duration:0.6, ease:"power3.out", stagger:0.02, onComplete:()=>clearTimeout(revealSafety)});
  }
})();

/* Subtle scroll parallax on the hero's decorative art (the laptop
   mockup) - genuinely barely-noticeable per the brief, scrubbed (tied
   directly to scroll position, not an independent timed animation) so it
   can never drift out of sync. Does not touch the functional dropzone's
   hit-testing in any meaningful way (a few px of translateY). Skipped
   under reduced-motion/touch same as every other pointer/scroll effect. */
(function(){
  if(!window.gsap || !window.ScrollTrigger || MOTION.reduced) return;
  const heroArt = document.querySelector(".hero-art");
  if(!heroArt) return;
  gsap.to(heroArt, {
    y: 28, ease:"none",
    scrollTrigger:{ trigger: ".hero-v2", start:"top top", end:"bottom top", scrub:0.6 }
  });
})();

/* Deep-link support, two generations:
   1. Clean dedicated paths (/merge-pdf, /split-pdf, ...) - what every
      "Merge PDF" link/button in the app now navigates to via openTool()'s
      pushState. Loading one of these paths directly (typed URL, bookmark,
      refresh) opens straight into that tool, replacing history instead of
      pushing so a subsequent Back goes to wherever the user actually came
      from, not back to this same tool page.
   2. Legacy /?tool=merge (the old query-string deep link the 44 static
      SEO pages' CTA buttons used before they linked straight to their own
      clean path) - kept working for any old bookmark/external link still
      pointing at it, but immediately replaced with the clean URL so it
      doesn't linger in the address bar. */
(function(){
  const pathToolId = PATH_TO_TOOLID[location.pathname];
  if(pathToolId && TOOLS[pathToolId]){
    window.__currentToolId = pathToolId;
    TOOLS[pathToolId]();
    syncToolRoute(pathToolId, true);
    return;
  }
  const queryToolId = new URLSearchParams(location.search).get("tool");
  if(queryToolId && TOOLS[queryToolId]) openTool(queryToolId);
})();

/* Safety net: if any tool's click handler throws/rejects partway through
   (loadPdfSafe's timeout, a pdf-lib error on a malformed file, anything
   unexpected) and nothing local caught it, the UI would otherwise just
   freeze forever on whatever processing state was last shown, with no
   feedback. Only intervenes when #out still shows the in-progress loader
   AND it hasn't already been marked done (never overwrites an
   already-successful result). */
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled error:", event.reason);
  const out = document.getElementById("out");
  const loader = out && out.querySelector("#pdfLoader");
  if(loader && !loader.classList.contains("is-done")){
    const msg = (event.reason && event.reason.message) ? event.reason.message : String(event.reason);
    out.innerHTML = `<div class="status" style="color:var(--rose)">Something went wrong (${escapeAttr(msg)}). Please try again.</div>`;
  }
});

/* ==================================================================
   Quick Tools Rail - global, macOS-Dock-inspired, vertical. #quickDock
   is one persistent DOM node (index.html, outside .overlay/.qa-overlay)
   so it's never torn down/rebuilt between the homepage and any of the
   39 tool panels. Reuses rather than re-implements: CATEGORIES/
   CATEGORY_META for icon+color data, iconFor() for the glyphs, the
   existing document-level [data-open] click delegation for navigation,
   goHome() for "More", window.__currentToolId for active-state.

   TRANSFORM OWNERSHIP (the first, horizontal build of this component hit
   a real bug from skipping this): the entrance tween and the hover-
   proximity quickTo both wanted to drive #quickDock's `x`, and because
   they can both be alive in the same instant right after load, GSAP's
   two owners of one property fought and the hover nudge silently lost.
   Fixed here by strict sequencing, not by luck: entrance holds x/scale/
   autoAlpha exclusively until its own onComplete, and the hover-x
   quickTo is only *constructed* inside that onComplete - it cannot exist
   yet while entrance is still running, so there is no window where two
   tweens can touch #quickDock's x at once. Per-icon, magnification
   (scaleX/scaleY) and proximity movement (x) are two separate quickTo
   arrays on two different properties, so they never conflict with each
   other either. */
(function(){
  const dock = document.getElementById("quickDock");
  const fab = document.getElementById("quickDockFab");
  const menu = document.getElementById("quickDockMenu");
  if(!dock || typeof CATEGORIES === "undefined") return;

  const QUICK_DOCK_IDS = ["merge","split","compress","pdf2word","pdf2jpg","jpg2pdf","rotate","sign","watermark","organize"];
  const idToMeta = {};
  CATEGORIES.forEach(cat=>{
    const color = (CATEGORY_META[cat.id]||{}).color || "#112B5C";
    cat.tools.forEach(([id,name])=>{ idToMeta[id] = {name, color}; });
  });
  const items = QUICK_DOCK_IDS.filter(id=>TOOLS[id] && idToMeta[id]).map(id=>({id, ...idToMeta[id]}));
  if(!items.length) return;

  const moreIconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>`;
  const homeIconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/></svg>`;

  // ---- Desktop/tablet vertical rail ----
  dock.innerHTML = `<button type="button" class="qd-icon qd-home" id="qdHomeBtn" aria-label="Home" style="color:var(--accent-lime)">${homeIconSvg}<span class="qd-tooltip">Home</span></button>
    <div class="qd-divider" aria-hidden="true"></div>`
    + items.map(t=>`
    <button type="button" class="qd-icon" data-open="${t.id}" data-tool-id="${t.id}" aria-label="Open ${escapeAttr(t.name)}" style="background:${t.color}22;color:${t.color}">
      ${iconFor(t.id)}
      <span class="qd-tooltip">${t.name}</span>
    </button>`).join("")
    + `<div class="qd-divider" aria-hidden="true"></div>
    <button type="button" class="qd-icon qd-more" id="qdMoreBtn" aria-label="More tools">${moreIconSvg}<span class="qd-tooltip">More tools</span></button>`;
  const icons = [...dock.querySelectorAll(".qd-icon")];
  document.getElementById("qdHomeBtn")?.addEventListener("click", ()=>goHome());

  // ---- Mobile/tablet: compact FAB + tap-open tool list (not a shrunk
  // rail - see the CSS comment for why) ----
  if(menu){
    menu.innerHTML = `<button type="button" class="qdm-item" id="qdHomeBtnMobile" role="menuitem"><span class="qdm-icon" style="color:var(--accent-lime)">${homeIconSvg}</span>Home</button>`
      + items.map(t=>`
      <button type="button" class="qdm-item" data-open="${t.id}" data-tool-id="${t.id}" role="menuitem">
        <span class="qdm-icon" style="color:${t.color}">${iconFor(t.id)}</span>${t.name}
      </button>`).join("")
      + `<button type="button" class="qdm-item" id="qdMoreBtnMobile" role="menuitem"><span class="qdm-icon">${moreIconSvg}</span>More tools</button>`;
  }
  const menuItems = menu ? [...menu.querySelectorAll(".qdm-item")] : [];
  function closeMobileMenu(){
    if(!menu) return;
    menu.classList.remove("open");
    fab && fab.setAttribute("aria-expanded", "false");
  }
  if(fab && menu){
    fab.addEventListener("click", ()=>{
      fab.setAttribute("aria-expanded", String(menu.classList.toggle("open")));
    });
    menu.addEventListener("click", e=>{ if(e.target.closest("[data-open]")) closeMobileMenu(); });
    document.addEventListener("click", e=>{
      if(menu.classList.contains("open") && !menu.contains(e.target) && e.target!==fab) closeMobileMenu();
    });
    fab.classList.add("is-ready");
  }

  // ---- Active-tool state, shared by rail + mobile menu ----
  const homeBtn = document.getElementById("qdHomeBtn");
  const homeBtnMobile = document.getElementById("qdHomeBtnMobile");
  function syncActiveState(){
    const id = window.__currentToolId;
    icons.forEach(el=>el.classList.toggle("qd-active", el.dataset.toolId === id));
    menuItems.forEach(el=>el.classList.toggle("qd-active", el.dataset.toolId === id));
    homeBtn?.classList.toggle("qd-active", !id);
    homeBtnMobile?.classList.toggle("qd-active", !id);
  }
  syncActiveState();
  window.addEventListener("popstate", ()=>setTimeout(syncActiveState, 0));
  // [data-tool-id] (dock/menu) OR [data-tool] (grid cards) - either can
  // trigger navigation, both must resync this.
  document.addEventListener("click", e=>{ if(e.target.closest("[data-tool-id], [data-tool]")) setTimeout(syncActiveState, 0); });
  // Click alone misses "closed back to home" (not a [data-tool-id] click) -
  // observing .overlay's open/close catches every path that changes
  // window.__currentToolId, same fix applied to the grid cards' own sync.
  const overlayForDock = document.getElementById("overlay");
  if(overlayForDock) new MutationObserver(()=>setTimeout(syncActiveState, 0)).observe(overlayForDock, {attributes:true, attributeFilter:["class"]});

  // ---- "More tools" -> home, scrolled to the tools grid ----
  function goToAllTools(){
    goHome();
    setTimeout(()=>{
      document.getElementById("tools")?.scrollIntoView({behavior: MOTION.reduced ? "auto" : "smooth", block:"start"});
    }, MOTION.reduced ? 0 : 350);
  }
  document.getElementById("qdMoreBtn")?.addEventListener("click", goToAllTools);
  document.getElementById("qdMoreBtnMobile")?.addEventListener("click", ()=>{ closeMobileMenu(); goToAllTools(); });
  homeBtnMobile?.addEventListener("click", ()=>{ closeMobileMenu(); goHome(); });

  // ---- Reduce (not hide) during the fullscreen editor - its own
  // controls live top/right, not far-left, so the rail usually stays
  // clear; dimming it is enough to keep it visually secondary there.
  // Driven via GSAP (reducedOpacityTo), not a plain CSS class toggle: a
  // CSS class's opacity would get silently beaten by GSAP's own inline
  // opacity style left behind by the entrance tween below (inline always
  // wins over a class) - confirmed live, the dimming never actually
  // rendered until this was fixed to use the same quickTo-handoff pattern
  // as hoverXTo. ----
  const overlayEl = document.getElementById("overlay");
  let reducedOpacityTo = null;
  function syncReducedState(){
    const isFullscreen = !!(overlayEl && overlayEl.classList.contains("panel-fullscreen"));
    dock.classList.toggle("is-reduced", isFullscreen);
    if(reducedOpacityTo) reducedOpacityTo(isFullscreen ? 0.45 : 1);
    else dock.style.opacity = isFullscreen ? "0.45" : "";
  }
  syncReducedState();
  if(overlayEl) new MutationObserver(syncReducedState).observe(overlayEl, {attributes:true, attributeFilter:["class"]});

  dock.classList.add("is-ready");
  if(!window.gsap || MOTION.reduced){
    if(window.gsap){
      gsap.set(dock, {x:0, scale:1, autoAlpha:1});
      reducedOpacityTo = gsap.quickTo(dock, "opacity", {duration:0.3, ease:"power2.out"});
      syncReducedState();
    }
    return; // no physics under reduced-motion/no-gsap - plain, fully usable buttons
  }

  // Entrance: owns x/scale/autoAlpha, then hands x and opacity off
  // entirely (see file header) once it completes.
  gsap.set(dock, {x:-20, scale:0.96, autoAlpha:0});
  gsap.set(icons, {autoAlpha:0, scale:0.9});
  let hoverXTo = null;
  gsap.to(dock, {
    x:0, scale:1, autoAlpha:1, duration:0.6, ease:"power3.out",
    onComplete:()=>{
      hoverXTo = gsap.quickTo(dock, "x", {duration:0.3, ease:"power2.out"});
      reducedOpacityTo = gsap.quickTo(dock, "opacity", {duration:0.3, ease:"power2.out"});
      syncReducedState();
    }
  });
  gsap.to(icons, {autoAlpha:1, scale:1, duration:0.4, stagger:0.025, delay:0.15, ease:"power2.out"});

  if(shouldSkipCursorFx()) return; // touch/reduced-motion: rail still fully clickable, just static

  const MAX_SCALE = 1.55, FALLOFF = 60, TOOLTIP_DIST = 24, MAX_ICON_X = 10, ZONE_RIGHT = 60, ZONE_PAD = 12;
  const scaleXTo = icons.map(el=>gsap.quickTo(el, "scaleX", {duration:0.25, ease:"power2.out"}));
  const scaleYTo = icons.map(el=>gsap.quickTo(el, "scaleY", {duration:0.25, ease:"power2.out"}));
  const iconXTo = icons.map(el=>gsap.quickTo(el, "x", {duration:0.25, ease:"power2.out"}));

  // Cache geometry - never read layout inside the pointermove hot path.
  // Recomputed on resize only, per the performance requirement.
  let iconCenters = [], zone = {left:0,right:0,top:0,bottom:0};
  function cacheGeometry(){
    iconCenters = icons.map(el=>{ const r = el.getBoundingClientRect(); return r.top + r.height/2; });
    const r = dock.getBoundingClientRect();
    zone = {left:r.left-ZONE_PAD, right:r.right+ZONE_RIGHT, top:r.top-ZONE_PAD, bottom:r.bottom+ZONE_PAD};
  }
  cacheGeometry();
  window.addEventListener("resize", cacheGeometry, {passive:true});

  let tooltipEl = null;
  function setTooltip(el){
    if(tooltipEl === el) return;
    if(tooltipEl) tooltipEl.classList.remove("qd-tooltip-show");
    tooltipEl = el;
    if(tooltipEl) tooltipEl.classList.add("qd-tooltip-show");
  }
  function applyIdle(){
    scaleXTo.forEach(s=>s(1)); scaleYTo.forEach(s=>s(1)); iconXTo.forEach(s=>s(0));
    if(hoverXTo) hoverXTo(0);
    setTooltip(null);
  }
  function onPointerMove(e){
    const inZone = e.clientX>=zone.left && e.clientX<=zone.right && e.clientY>=zone.top && e.clientY<=zone.bottom;
    if(!inZone){ applyIdle(); return; }
    let nearestI = -1, nearestDist = Infinity;
    icons.forEach((el,i)=>{
      const dist = Math.abs(e.clientY - iconCenters[i]);
      const t = Math.max(0, 1 - dist/FALLOFF);
      const scale = 1 + (MAX_SCALE-1) * t*t;
      scaleXTo[i](scale); scaleYTo[i](scale);
      iconXTo[i](MAX_ICON_X * t*t);
      if(dist < nearestDist){ nearestDist = dist; nearestI = i; }
    });
    if(hoverXTo) hoverXTo(3);
    setTooltip(nearestDist < TOOLTIP_DIST ? icons[nearestI] : null);
  }
  window.addEventListener("pointermove", onPointerMove, {passive:true});
})();
