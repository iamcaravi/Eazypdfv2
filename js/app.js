window.YOYO_VENDOR_ASSETS = Object.freeze({
  pdfjsWorker: new URL("assets/vendor/pdfjs/3.11.174/pdf.worker.min.js", document.baseURI).href
});
if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = window.YOYO_VENDOR_ASSETS.pdfjsWorker;
let PDFDocument, degrees, rgb, StandardFonts, ParseSpeeds;
function syncPdfLibBindings(){
  if(!window.PDFLib) return false;
  ({PDFDocument, degrees, rgb, StandardFonts, ParseSpeeds} = window.PDFLib);
  return true;
}
syncPdfLibBindings();
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
  if(!PDFDocument){
    if(typeof ensurePDFLib !== "function") throw new Error("The PDF processing library is unavailable.");
    await ensurePDFLib();
    if(!syncPdfLibBindings()) throw new Error("The PDF processing library could not be initialized.");
  }
  const byteLength = bytes?.byteLength ?? bytes?.length ?? 0;
  if(byteLength > YOYO_RESOURCE_LIMITS.maxPdfBytes){
    throw new ResourceValidationError(
      `This PDF exceeds the ${fmtSize(YOYO_RESOURCE_LIMITS.maxPdfBytes)} in-browser processing limit.`,
      "file-too-large"
    );
  }

  let timeoutId;
  try{
    const doc = await Promise.race([
      PDFDocument.load(bytes, {parseSpeed: ParseSpeeds.Fastest, ...extraOpts}),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("This PDF took too long to open - it may be unusually large or complex")),
          timeoutMs
        );
      })
    ]);
    let pageCount;
    try{ pageCount = doc.getPageCount(); }
    catch(_){ throw new ResourceValidationError("This PDF has no readable page tree.", "invalid-pdf"); }
    if(pageCount < 1) throw new ResourceValidationError("This PDF has no readable pages.", "invalid-pdf");
    if(pageCount > YOYO_RESOURCE_LIMITS.maxPdfPages){
      throw new ResourceValidationError(
        `This PDF has too many pages for safe in-browser processing (maximum ${YOYO_RESOURCE_LIMITS.maxPdfPages}).`,
        "too-many-pages"
      );
    }
    return doc;
  }finally{
    if(timeoutId) clearTimeout(timeoutId);
  }
}
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

/* Magnetic CTAs + Dock-style trust-badge row (homepage-only elements) and
   the header icon buttons' magnetic pull (site-wide, same reasoning as
   the homepage-only elements a few lines down already being wired here).
   All of it no-ops under reduced-motion/touch (see shouldSkipCursorFx in
   each utility) - nothing here needs its own separate guard. */
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

/* "Everything You Need" card + footer columns scroll reveal - same
   fade+rise-once technique as the tool-card grid above (one shared
   ScrollTrigger per group, `once:true`, unconditional-visibility safety
   net if GSAP/ScrollTrigger/reduced-motion means no animation runs),
   applied to the two sections this redesign touches rather than a new
   animation system. */
(function(){
  const ctaCard = document.querySelector(".cta-card");
  const footerCols = [...document.querySelectorAll(".footer-col")];
  const targets = [ctaCard, ...footerCols].filter(Boolean);
  if(!targets.length) return;
  if(!window.gsap || MOTION.reduced){
    if(window.gsap) gsap.set(targets, {opacity:1, visibility:"visible", y:0});
    return;
  }
  gsap.set(targets, {opacity:0, visibility:"hidden", y:24});
  const revealSafety = setTimeout(()=>{
    const stuck = targets.filter(t=>gsap.getProperty(t,"opacity") < 0.95);
    if(stuck.length) gsap.set(stuck, {opacity:1, visibility:"visible", y:0, clearProps:"transform"});
  }, 2000);
  function reveal(el, stagger){
    gsap.to(el, {
      opacity:1, y:0, duration:0.7, ease:"power3.out", stagger,
      scrollTrigger: window.ScrollTrigger ? { trigger:el, start:"top 92%", once:true } : undefined,
      onStart:()=>gsap.set(el, {visibility:"visible"})
    });
  }
  if(window.ScrollTrigger){
    gsap.registerPlugin(ScrollTrigger);
    if(ctaCard) reveal(ctaCard);
    if(footerCols.length) reveal(footerCols, {amount:0.35, from:"start"});
    // revealSafety's own opacity check (above) is what makes it safe to
    // leave running rather than clearing it here - it's a 2s-later no-op
    // once these ScrollTrigger-driven tweens have actually fired, and a
    // real fallback in the rare case a trigger silently never does.
  } else {
    gsap.set(targets, {visibility:"visible"});
    gsap.to(targets, {opacity:1, y:0, duration:0.6, ease:"power3.out", stagger:0.05, onComplete:()=>clearTimeout(revealSafety)});
  }
})();

/* Tool page SEO/FAQ block scroll reveal - same fade+rise-once technique as
   the two groups above, applied to each .tool-seo-block independently
   (rather than batched into one shared trigger like the footer columns)
   because these blocks are spread down the full length of a tool page's
   SEO content, not clustered together - each one needs its own trigger so
   it reveals as the user actually scrolls to it, not all at once when the
   first block enters view. Only tool pages have .tool-seo-block (see
   build/generate-landing.js); this IIFE is a no-op on the homepage. */
(function(){
  const blocks = [...document.querySelectorAll(".tool-seo-block")];
  if(!blocks.length) return;
  if(!window.gsap || MOTION.reduced){
    if(window.gsap) gsap.set(blocks, {opacity:1, visibility:"visible", y:0});
    return;
  }
  gsap.set(blocks, {opacity:0, visibility:"hidden", y:24});
  const revealSafety = setTimeout(()=>{
    const stuck = blocks.filter(b=>gsap.getProperty(b,"opacity") < 0.95);
    if(stuck.length) gsap.set(stuck, {opacity:1, visibility:"visible", y:0, clearProps:"transform"});
  }, 2000);
  if(window.ScrollTrigger){
    gsap.registerPlugin(ScrollTrigger);
    blocks.forEach(block=>{
      gsap.to(block, {
        opacity:1, y:0, duration:0.7, ease:"power3.out",
        scrollTrigger:{ trigger: block, start:"top 92%", once:true },
        onStart:()=>gsap.set(block, {visibility:"visible"})
      });
    });
    // Same reasoning as the footer-columns reveal above: revealSafety's own
    // opacity check makes it safe to leave running rather than clearing it
    // here - a 2s-later no-op once these have fired, a real fallback if one
    // silently never does (e.g. a block already above the fold at load).
  } else {
    gsap.set(blocks, {visibility:"visible"});
    gsap.to(blocks, {opacity:1, y:0, duration:0.6, ease:"power3.out", stagger:0.05, onComplete:()=>clearTimeout(revealSafety)});
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

/* ---------------- Hero upload device: premium glass/glow system ----------------
   Purely decorative layer around the EXISTING heroDropzone/heroFileInput
   upload logic above (setHeroDzState/handleHeroFile) - owns none of the
   drag/drop/click/file handling itself, just reacts to the same state
   machine via the HeroDeviceFX.onDragEnter/onDragLeave/onSuccess hooks
   that function already calls.
   Transform ownership: idle float owns `y` on #heroUploadDevice when no
   drag is in progress; the drag-enter/leave timeline takes over `y` for
   its duration (idle tween is paused first, then killed+recreated fresh
   from the settled y:0 on leave, rather than resumed, so there's no
   position jump from a paused tween's stale internal state). Mouse
   parallax only ever touches rotationX/rotationY on the same element, so
   it never fights either of the above. Scroll-parallax above owns `y` on
   the OUTER .hero-art wrapper, a different element, so no conflict there
   either. */
HeroDeviceFX = (function(){
  const device = document.getElementById("heroUploadDevice");
  const glow = document.querySelector(".hero-upload-glow");
  const reflection = document.querySelector(".hero-upload-reflection");
  const particlesWrap = document.querySelector(".hero-upload-particles");
  const noop = { onDragEnter(){}, onDragLeave(){}, onSuccess(){} };
  if(!device || !window.gsap) return noop;

  const reduced = MOTION.reduced;
  let floatTween = null, glowTween = null, dragTl = null;

  function startIdle(){
    if(reduced) return;
    floatTween && floatTween.kill();
    glowTween && glowTween.kill();
    floatTween = gsap.to(device, {y:-6, duration:5, ease:"sine.inOut", yoyo:true, repeat:-1});
    if(glow) glowTween = gsap.to(glow, {opacity:0.85, scale:1.05, duration:7, ease:"sine.inOut", yoyo:true, repeat:-1});
  }
  startIdle();

  if(!reduced && reflection){
    gsap.fromTo(reflection,
      {xPercent:-130, opacity:0},
      {xPercent:130, opacity:0.45, duration:6.5, ease:"sine.inOut", repeat:-1, repeatDelay:2.5});
  }

  // Sparse floating particles - a handful of real elements, not a canvas/
  // particle-system library, scaled down further on narrower viewports
  // (matches the file's existing 560/980px breakpoints) and skipped
  // entirely on touch devices, where they'd just be dead weight.
  if(!reduced && particlesWrap && !IS_TOUCH_DEVICE){
    const w = window.innerWidth;
    const count = w < 560 ? 0 : (w < 980 ? 5 : 9);
    for(let i=0; i<count; i++){
      const dot = document.createElement("span");
      dot.className = "hero-particle" + (i % 3 === 0 ? " hero-particle--white" : "");
      const size = (2 + Math.random()*2.4).toFixed(1);
      dot.style.width = dot.style.height = size + "px";
      dot.style.left = (6 + Math.random()*86) + "%";
      dot.style.top = (8 + Math.random()*82) + "%";
      particlesWrap.appendChild(dot);
      gsap.to(dot, {
        y: -16 - Math.random()*22, x:(Math.random()-0.5)*18,
        opacity: 0.18 + Math.random()*0.32,
        duration: 4.5 + Math.random()*4, delay: Math.random()*5,
        ease:"sine.inOut", yoyo:true, repeat:-1
      });
    }
  }

  // Mouse parallax on the device only - subtle rotationX/Y tilt, only
  // while the hero section is actually on screen (IntersectionObserver),
  // never a global always-on mousemove tracker.
  if(!reduced && !IS_TOUCH_DEVICE){
    const heroSection = document.querySelector(".hero-v2");
    const rxTo = gsap.quickTo(device, "rotationY", {duration:0.7, ease:"power3.out"});
    const ryTo = gsap.quickTo(device, "rotationX", {duration:0.7, ease:"power3.out"});
    let heroVisible = true;
    if(window.IntersectionObserver && heroSection){
      heroVisible = false;
      new IntersectionObserver(es=>{ heroVisible = es[0].isIntersecting; }, {threshold:0.15}).observe(heroSection);
    }
    document.addEventListener("pointermove", e=>{
      if(!heroVisible) return;
      const r = device.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width/2)) / r.width;
      const dy = (e.clientY - (r.top + r.height/2)) / r.height;
      rxTo(dx*5); ryTo(-dy*5);
    }, {passive:true});
  }

  function onDragEnter(){
    device.classList.add("drag-active");
    if(reduced) return;
    floatTween && floatTween.pause();
    glowTween && glowTween.pause();
    dragTl && dragTl.kill();
    dragTl = gsap.timeline({defaults:{ease:"power2.out", overwrite:"auto"}})
      .to(device, {scale:1.025, y:-8, duration:0.35}, 0)
      .to(glow, {opacity:1, scale:1.1, duration:0.4}, 0.05);
  }
  function onDragLeave(){
    device.classList.remove("drag-active");
    if(reduced) return;
    dragTl && dragTl.kill();
    dragTl = gsap.timeline({defaults:{ease:"power2.out", overwrite:"auto"}})
      .to(device, {scale:1, y:0, duration:0.4, onComplete:startIdle}, 0)
      .to(glow, {opacity:0.85, scale:1.05, duration:0.45}, 0);
  }
  function onSuccess(){
    if(reduced) return;
    device.classList.remove("pulse-success");
    void device.offsetWidth; // restart the CSS keyframe even if it just played
    device.classList.add("pulse-success");
  }

  return { onDragEnter, onDragLeave, onSuccess };
})();

/* Deep-link support, two generations:
   1. Clean dedicated paths (/merge-pdf, /split-pdf, ...) on production,
      or this same tool's own physical .html file under any server
      (Live Server, dev-server.py, file://) - toolIdForPath() matches
      either. Only sets title/meta here, never touches the URL itself
      (see toolIdForPath's own comment) - the page is already sitting at
      whatever URL actually loaded it, real or clean, and that's exactly
      what should stay in the address bar.
   2. Legacy /?tool=merge (the old query-string deep link the 44 static
      SEO pages' CTA buttons used before they linked straight to their own
      clean path) - kept working for any old bookmark/external link still
      pointing at it, via a real openTool() navigation to that tool's page.
   3. ?bridge=1 - set by openTool() when it stashed a file via FileBridge
      before navigating here (an explicit Quick Action/"Continue to..."
      pick, never an ordinary nav click) - consumed once, then the query
      string is stripped so a later reload of this same URL can't
      re-attempt it (harmless either way, since consume() is one-shot). */
(function(){
  const isBridgeLoad = new URLSearchParams(location.search).get("bridge") === "1";
  /* Hard reset of every cross-load file carrier, BEFORE any tool init
     runs. A direct open of a tool page (typed URL, bookmark, double-
     clicked .html, ordinary nav click) must behave exactly like a
     brand-new first visit - so the only sanctioned carrier (FileBridge)
     is emptied unless this specific load is the one explicit "continue
     with this file" hop that stashed it. AppSession is in-memory and
     therefore already empty on a real load, but is cleared here too so
     the bfcache path below (where no script re-runs) gets the same
     guarantee from one place. */
  if(!isBridgeLoad){
    FileBridge.clear();
    AppSession.clear();
  }
  const pathToolId = toolIdForPath(location.pathname);
  if(pathToolId && TOOLS[pathToolId]){
    window.__currentToolId = pathToolId;
    TOOLS[pathToolId]();
    const route = TOOL_ROUTES[pathToolId];
    if(route) setPageMeta(route.title, route.description, route.path);
    /* Browsers restore form-control state (including <input type="file">
       selections) on a soft reload / session restore. TOOLS[id]() above
       renders a fresh #fi so that normally can't apply, but this makes
       the empty starting state explicit and unconditional rather than
       incidental to render order. */
    if(!isBridgeLoad){
      const fi = document.getElementById("fi");
      if(fi) try{ fi.value = ""; }catch(e){}
    }
    if(isBridgeLoad){
      FileBridge.consume().then(files=>{
        if(!files || !files.length) return;
        const fi = document.getElementById("fi");
        if(!fi) return;
        const dt = new DataTransfer();
        files.forEach(f=>dt.items.add(f));
        fi.files = dt.files;
        fi.dispatchEvent(new Event("change"));
      });
      history.replaceState(history.state, '', location.pathname);
    }
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
   Quick Tools Rail - global, macOS-Dock-inspired, horizontal, floating
   bottom-center. #quickDock is one persistent DOM node (index.html,
   outside .overlay/.qa-overlay) so it's never torn down/rebuilt between
   the homepage and any of the 39 tool panels. Reuses rather than
   re-implements: CATEGORIES/CATEGORY_META for icon+color data, iconFor()
   for the glyphs, the existing document-level [data-open] click
   delegation for navigation, goHome() for "More", window.__currentToolId
   for active-state.

   TRANSFORM OWNERSHIP (the first build of this component hit a real bug
   from skipping this): the entrance tween and the hover-proximity
   quickTo must never drive the same transform property, or GSAP's two
   owners of it fight and one silently loses. Entrance holds x/scale/
   autoAlpha exclusively until its own onComplete, and the hover quickTo
   (a small vertical lift toward the page content above the dock, `y`)
   is only *constructed* inside that onComplete - it cannot exist yet
   while entrance is still running, so there is no window where two
   tweens can touch the same property at once. Horizontal centering
   (xPercent:-50) is a third, independent transform component set once
   below and never re-touched by either of those, so all three coexist
   without conflict. Per-icon magnification (scaleX/scaleY) and
   per-icon pop-up movement (y) are likewise two separate quickTo arrays
   on two different properties. */
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
  // Docs isn't a PDF-processing tool, so - like Home/More above - it's
  // hand-built here rather than routed through CATEGORIES/CATEGORY_META
  // (which only describe actual PDF tools) or QUICK_DOCK_IDS. It still
  // uses TOOLS.docs()/data-open="docs" underneath, so it gets the exact
  // same click-delegation, active-state sync (data-tool-id, matched
  // below by the shared syncActiveState()) and hover physics as every
  // other .qd-icon - no new plumbing, just one more of these buttons.
  const docsIconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M9.5 12h5M9.5 15.5h5M9.5 8.5h2"/></svg>`;

  // ---- Desktop/tablet vertical rail ----
  dock.innerHTML = `<button type="button" class="qd-icon qd-home" id="qdHomeBtn" aria-label="Home" style="color:var(--accent-lime)">${homeIconSvg}<span class="qd-tooltip">Home</span></button>
    <div class="qd-divider" aria-hidden="true"></div>`
    + items.map(t=>`
    <button type="button" class="qd-icon" data-open="${t.id}" data-tool-id="${t.id}" aria-label="Open ${escapeAttr(t.name)}" style="background:${t.color}22;color:${t.color}">
      ${iconFor(t.id)}
      <span class="qd-tooltip">${t.name}</span>
    </button>`).join("")
    + `<div class="qd-divider" aria-hidden="true"></div>
    <button type="button" class="qd-icon qd-more" data-open="docs" data-tool-id="docs" aria-label="Open Docs">${docsIconSvg}<span class="qd-tooltip">Docs</span></button>
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
      + `<button type="button" class="qdm-item" data-open="docs" data-tool-id="docs" role="menuitem"><span class="qdm-icon">${docsIconSvg}</span>Docs</button>`
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

  // ---- Reduce (not hide) during the fullscreen editor, fully HIDE on a
  // tool's own upload/landing state (panel open, no file loaded yet) -
  // iLovePDF never shows its floating nav until you're actually inside a
  // workspace, so the dock only belongs on the homepage and on a loaded
  // .tool-workspace. One generic check (.tool-workspace present and
  // missing .is-loaded) rather than each TOOLS.xxx calling in - every
  // tool already toggles .is-loaded on its own panel-body for other
  // reasons (see showWorkspace()/showEmptyState() in each TOOLS.xxx), so
  // observing that single class from here covers all of them for free.
  // Driven via GSAP (reducedOpacityTo) + a direct inline visibility
  // write, not a plain CSS class toggle: a CSS class's opacity would get
  // silently beaten by GSAP's own inline opacity style left behind by
  // the entrance tween below (inline always wins over a class) -
  // confirmed live, the dimming never actually rendered until this was
  // fixed to use the same quickTo-handoff pattern as hoverYTo. Visibility
  // is likewise only ever written here (once entrance hands it off) so
  // there's a single owner for it, same as the transform-ownership rule
  // documented in the file header. ----
  const overlayEl = document.getElementById("overlay");
  let reducedOpacityTo = null;
  function isDockLandingState(){
    if(!overlayEl || !overlayEl.classList.contains("open")) return false; // homepage: dock always shown
    const ws = overlayEl.querySelector(".tool-workspace");
    return !!ws && !ws.classList.contains("is-loaded");
  }
  function syncReducedState(){
    const isFullscreen = !!(overlayEl && overlayEl.classList.contains("panel-fullscreen"));
    const hidden = isDockLandingState();
    dock.classList.toggle("is-reduced", isFullscreen && !hidden);
    dock.classList.toggle("is-hidden", hidden);
    dock.style.visibility = hidden ? "hidden" : "visible";
    const targetOpacity = hidden ? 0 : (isFullscreen ? 0.45 : 1);
    if(reducedOpacityTo) reducedOpacityTo(targetOpacity);
    else dock.style.opacity = String(targetOpacity);
    // Mobile swaps the whole rail for the FAB+menu (see the CSS comment
    // on #quickDockFab) rather than shrinking it - same landing-state
    // rule has to apply there too, plain CSS since the FAB never had a
    // GSAP tween owning its opacity to begin with. Closing the menu on
    // hide covers the "upload finishes while the tool list is still
    // open" edge case rather than leaving an orphaned open menu behind
    // an invisible launcher.
    if(fab){
      fab.classList.toggle("is-hidden", hidden);
      if(hidden) closeMobileMenu();
    }
  }
  // The .tool-side-panel family (Split/Organize/Rotate/Delete/etc, see
  // showWorkspace() in each TOOLS.xxx) has no equivalent of
  // pinSidebarSafeHeight() - .tool-app-workspace's row (main pane +
  // side panel) is pure content-driven height (align-items:stretch just
  // makes the two match EACH OTHER, nothing ties either to the
  // viewport). With a short page-grid (few pages/files), that leaves
  // the side panel - CTA included - stranded near the top of a mostly
  // empty page instead of reaching down toward the dock the way a
  // taller tool's panel naturally does. Giving the row a min-height
  // (measured the same way pinSidebarSafeHeight measures the other
  // system: real top offset, viewport height, dock reserve) is the fix -
  // tall content still grows it further as before, this only raises the
  // floor for short content.
  function syncWorkspaceMinHeight(){
    if(!overlayEl || !overlayEl.classList.contains("open")){ return; }
    const ws = overlayEl.querySelector(".tool-app-workspace");
    if(!ws) return;
    if(getComputedStyle(ws).display === "none"){ ws.style.minHeight = ""; return; }
    const DOCK_RESERVE = 74; // same #quickDock footprint reserve as pinSidebarSafeHeight
    const BOTTOM_BREATHING = 20;
    const top = ws.getBoundingClientRect().top;
    if(top > 0) ws.style.minHeight = `calc(100vh - ${Math.round(top)}px - ${DOCK_RESERVE + BOTTOM_BREATHING}px)`;
    // .tool-side-panel itself has no cap at all (unlike .tool-sidebar,
    // which already gets one from pinSidebarSafeHeight) - a tool with
    // enough fields (Page Numbers: position/format/start-number/preview)
    // can naturally grow taller than the safe area and run its own CTA
    // into the dock, confirmed live on a 1280x720 desktop. Same fix,
    // applied to the other panel type: cap + scroll internally instead
    // of overflowing past the reserved band.
    const panel = ws.querySelector(".tool-side-panel");
    if(panel){
      const panelTop = panel.getBoundingClientRect().top;
      if(panelTop > 0){
        panel.style.maxHeight = `calc(100vh - ${Math.round(panelTop)}px - ${DOCK_RESERVE}px)`;
        panel.style.overflowY = "auto";
      }
    }
  }
  syncReducedState();
  syncWorkspaceMinHeight();
  setTimeout(syncWorkspaceMinHeight, 0); // same first-paint timing gap pinSidebarSafeHeight has to work around
  window.addEventListener("resize", syncWorkspaceMinHeight);
  // subtree+childList: .is-loaded lives on the panel-body deep inside
  // #panel, which openPanel() replaces wholesale (innerHTML) on every
  // tool switch - a shallow attribute-only observer on #overlay itself
  // would miss both that swap and the later is-loaded toggle within it.
  // .tool-app-workspace's own display:flex/none toggle (showWorkspace()/
  // showEmptyState() in each TOOLS.xxx) rides along on the SAME class
  // mutation (body.classList.add("is-loaded") fires in the same call),
  // so this one observer is enough to re-trigger both syncs together.
  if(overlayEl) new MutationObserver(()=>{ syncReducedState(); syncWorkspaceMinHeight(); }).observe(overlayEl, {subtree:true, childList:true, attributes:true, attributeFilter:["class"]});

  dock.classList.add("is-ready");
  // xPercent:-50 is the dock's horizontal-centering half of its
  // transform (left:50% in CSS positions its LEFT edge at center, this
  // pulls it back by half its own width) - set once, here, before any
  // other gsap.set/to touches the dock, so it's established as a
  // permanent baseline. Every later call below only ever specifies x/y/
  // scale/autoAlpha, never xPercent, so GSAP leaves this alone for the
  // dock's entire lifetime - see the file header for why entrance/hover
  // are also kept off each other's properties the same way.
  if(!window.gsap || MOTION.reduced){
    if(window.gsap){
      gsap.set(dock, {xPercent:-50, x:0, scale:1, autoAlpha: isDockLandingState() ? 0 : 1});
      reducedOpacityTo = gsap.quickTo(dock, "opacity", {duration:0.3, ease:"power2.out"});
      syncReducedState();
    }
    return; // no physics under reduced-motion/no-gsap - plain, fully usable buttons
  }

  // Entrance: owns x/scale/autoAlpha, then hands opacity off entirely
  // (see file header) once it completes. Hover-lift takes `y` instead,
  // never `x`, so the two can't fight even though both run soon after.
  // Reveal target respects the landing-state check up front (not just in
  // syncReducedState() afterward) so a tool page loaded straight into its
  // empty upload state never flashes the dock visible before hiding it
  // again - autoAlpha only animates toward 1 when there's actually
  // something to reveal.
  gsap.set(dock, {xPercent:-50, x:-20, scale:0.96, autoAlpha:0});
  gsap.set(icons, {autoAlpha:0, scale:0.9});
  let hoverYTo = null;
  gsap.to(dock, {
    x:0, scale:1, autoAlpha: isDockLandingState() ? 0 : 1, duration:0.6, ease:"power3.out",
    onComplete:()=>{
      hoverYTo = gsap.quickTo(dock, "y", {duration:0.3, ease:"power2.out"});
      reducedOpacityTo = gsap.quickTo(dock, "opacity", {duration:0.3, ease:"power2.out"});
      syncReducedState();
    }
  });
  gsap.to(icons, {autoAlpha:1, scale:1, duration:0.4, stagger:0.025, delay:0.15, ease:"power2.out"});

  if(shouldSkipCursorFx()) return; // touch/reduced-motion: rail still fully clickable, just static

  // FALLOFF/TOOLTIP_DIST stay in px, same values as the vertical rail -
  // only the AXIS they're measured along changes below (X, since icons
  // now sit side by side, not stacked). MAX_ICON_Y is the per-icon
  // pop-UP distance (negative y) instead of the old rail's pop-right
  // (positive x) - real macOS docks pop icons upward toward the content
  // above them, which for a bottom-center dock is "up", not "right".
  // ZONE_TOP (was ZONE_RIGHT) widens the magnetic hit-zone toward that
  // same content-side - up, not right - so the effect still engages
  // naturally as the cursor approaches from where the page content is.
  const MAX_SCALE = 1.55, FALLOFF = 60, TOOLTIP_DIST = 24, MAX_ICON_Y = 10, ZONE_TOP = 60, ZONE_PAD = 12;
  const scaleXTo = icons.map(el=>gsap.quickTo(el, "scaleX", {duration:0.25, ease:"power2.out"}));
  const scaleYTo = icons.map(el=>gsap.quickTo(el, "scaleY", {duration:0.25, ease:"power2.out"}));
  const iconYTo = icons.map(el=>gsap.quickTo(el, "y", {duration:0.25, ease:"power2.out"}));

  // Cache geometry - never read layout inside the pointermove hot path.
  // Recomputed on resize only, per the performance requirement.
  let iconCenters = [], zone = {left:0,right:0,top:0,bottom:0};
  function cacheGeometry(){
    iconCenters = icons.map(el=>{ const r = el.getBoundingClientRect(); return r.left + r.width/2; });
    const r = dock.getBoundingClientRect();
    zone = {left:r.left-ZONE_PAD, right:r.right+ZONE_PAD, top:r.top-ZONE_TOP, bottom:r.bottom+ZONE_PAD};
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
    scaleXTo.forEach(s=>s(1)); scaleYTo.forEach(s=>s(1)); iconYTo.forEach(s=>s(0));
    if(hoverYTo) hoverYTo(0);
    setTooltip(null);
  }
  function onPointerMove(e){
    const inZone = e.clientX>=zone.left && e.clientX<=zone.right && e.clientY>=zone.top && e.clientY<=zone.bottom;
    if(!inZone){ applyIdle(); return; }
    let nearestI = -1, nearestDist = Infinity;
    icons.forEach((el,i)=>{
      const dist = Math.abs(e.clientX - iconCenters[i]);
      const t = Math.max(0, 1 - dist/FALLOFF);
      const scale = 1 + (MAX_SCALE-1) * t*t;
      scaleXTo[i](scale); scaleYTo[i](scale);
      iconYTo[i](-MAX_ICON_Y * t*t);
      if(dist < nearestDist){ nearestDist = dist; nearestI = i; }
    });
    if(hoverYTo) hoverYTo(-3);
    setTooltip(nearestDist < TOOLTIP_DIST ? icons[nearestI] : null);
  }
  window.addEventListener("pointermove", onPointerMove, {passive:true});
})();
