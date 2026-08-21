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
   the moment the pointer leaves that element.
   Phase 6: the one utility this file's own header comment always named
   alongside initMagnetic/initDockMagnify but never actually implemented
   - the other two shipped in an earlier redesign phase, this one was
   left as a documented gap. Driven by gsap.ticker (GSAP's own shared
   rAF loop) rather than a second independent requestAnimationFrame loop,
   per the "avoid unnecessary RAF loops" rule - one tick source for every
   per-frame effect in this file, not two competing ones. Call once,
   anywhere after DOM is ready; no-ops under reduced-motion/touch/no-GSAP
   the same way every other utility here does, so call sites never need
   their own guard. */
function initCursorTrail(opts={}){
  if(shouldSkipCursorFx()) return;
  const count = opts.count ?? 5;
  const pauseSelector = opts.pauseSelector
    ?? "canvas, input, textarea, select, [contenteditable], .editor-canvas, .crop-select-layer, .imgcrop-select-layer, .fillform-field-overlay";

  const trail = document.createElement("div");
  trail.className = "cursor-trail";
  trail.setAttribute("aria-hidden", "true");
  const dots = [];
  for(let i=0; i<count; i++){
    const dot = document.createElement("span");
    dot.className = "cursor-trail-dot";
    trail.appendChild(dot);
    dots.push({
      el: dot, x: 0, y: 0,
      setX: gsap.quickSetter(dot, "x", "px"),
      setY: gsap.quickSetter(dot, "y", "px"),
    });
  }
  document.body.appendChild(trail);

  let mouseX = 0, mouseY = 0, started = false, paused = false;
  function onMove(e){
    mouseX = e.clientX; mouseY = e.clientY;
    if(!started){
      started = true;
      dots.forEach(d=>{ d.x = mouseX; d.y = mouseY; d.setX(mouseX); d.setY(mouseY); });
      trail.classList.add("is-active");
    }
  }
  window.addEventListener("pointermove", onMove, {passive:true});

  // Real content (a PDF canvas, a text field, an editor field overlay)
  // always wins - the trail steps aside rather than drawing on top of
  // something the user is actually working with. Delegated on document
  // (capture, so it still sees the event even if the target itself calls
  // stopPropagation) rather than one listener per matching element,
  // since the set of matches changes as tools/panels open and close.
  document.addEventListener("pointerover", e=>{
    if(e.target.closest && e.target.closest(pauseSelector)){ paused = true; trail.classList.remove("is-active"); }
  }, true);
  document.addEventListener("pointerout", e=>{
    if(e.target.closest && e.target.closest(pauseSelector)){ paused = false; if(started) trail.classList.add("is-active"); }
  }, true);

  gsap.ticker.add(()=>{
    if(paused || !started) return;
    let targetX = mouseX, targetY = mouseY;
    dots.forEach((d, i)=>{
      // Each dot chases the ONE ahead of it, not the raw pointer - that's
      // what produces a trailing line instead of every dot independently
      // (and identically) lagging the cursor. Later dots ease slower
      // (smaller factor, floored) so the line visibly thins/lags toward
      // the tail rather than all dots bunching at the same distance.
      const ease = Math.max(0.35 - i*0.045, 0.14);
      d.x += (targetX - d.x) * ease;
      d.y += (targetY - d.y) * ease;
      d.setX(d.x); d.setY(d.y);
      targetX = d.x; targetY = d.y;
    });
  });
}

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

/* ---------------- Global download-click animation ----------------
   ONE reusable, GSAP-based "premium click receipt" system layered on top
   of every existing download action in the app - it never touches
   href/download attributes, blob URLs, downloadBlob(), or resultBox()
   itself, it just reacts visually to the click. A single delegated
   listener on `document` (capture phase, added once here) detects any
   click landing on/inside an element matching .dl-link -
   resultBox()'s own download <a>, the ONE shared function every tool's
   result screen already funnels through (confirmed: every downloadBlob()
   call site across all 39 tools ends up rendering through resultBox(),
   which always creates `a.dl-link.dl-link-primary` - there is no second,
   parallel download-button implementation anywhere in this file). That
   means this needed zero per-tool changes and automatically covers
   buttons that don't exist yet at page load (dynamically-built result
   screens) via event delegation, not per-element listeners.
   [data-yoyo-download] / [data-action="download"] are also matched, as a
   forward-compatible identifier for any future download control that
   doesn't happen to be a .dl-link, per the brief's own request - unused
   today, costs nothing to support.
   Deliberately uses YOYOPDF's neon green directly (--accent-lime-rgb,
   defined on bare :root, not the theme-flipped --brand-shadow-rgb) so
   this interaction always reads as the site's signature color regardless
   of light/dark theme - same call already made for the hero upload
   panel's glow system. */
const DownloadClickFX = (function(){
  const SELECTOR = ".dl-link, [data-yoyo-download], [data-action='download']";

  // Spawns one throwaway FX element at (x,y), driven entirely by the CSS
  // @keyframes animation already declared on `className` (see index.html)
  // rather than a GSAP tween - so it starts rendering the instant it's
  // inserted, with no dependency on GSAP's rAF ticker ticking. Cleanup is
  // double-redundant: the normal path is the 'animationend' event, with
  // a setTimeout as a safety net in case that event is ever missed (e.g.
  // the element gets display:none'd by something else mid-animation) -
  // either way it's removed, never left behind.
  function spawnFx(className, x, y, size, fallbackMs){
    const el = document.createElement("span");
    el.className = className;
    el.style.left = x + "px";
    el.style.top = y + "px";
    // Sized from the BUTTON's own measured rect, not a fixed px value in
    // the stylesheet - the earlier version hardcoded an 18px dot scaled
    // to 3x (54px total) on a ~250px-wide download button, which is why
    // the ripple was technically animating but read as "nothing visibly
    // happened". Scaling to the real control makes it unmistakable on a
    // big primary Download button and still proportionate on a small one.
    el.style.width = size + "px";
    el.style.height = size + "px";
    el.style.marginLeft = (-size/2) + "px";
    el.style.marginTop = (-size/2) + "px";
    document.body.appendChild(el);
    let done = false;
    const cleanup = ()=>{ if(done) return; done = true; el.remove(); };
    el.addEventListener("animationend", cleanup);
    setTimeout(cleanup, fallbackMs);
  }

  function playClickFX(target, clientX, clientY){
    // Tactile press/settle. GSAP (already used throughout the app's own
    // interaction system) drives it when available; a plain CSS
    // transition is the fallback for the otherwise-unreachable case
    // where it isn't, so the press itself never silently no-ops.
    if(window.gsap){
      gsap.killTweensOf(target);
      gsap.timeline()
        .to(target, {scale:0.96, duration:0.07, ease:"power2.out"})
        .to(target, {scale:1, duration:0.18, ease:"back.out(2)"});
    } else {
      target.style.transition = "transform .18s cubic-bezier(.34,1.56,.64,1)";
      target.style.transform = "scale(0.96)";
      requestAnimationFrame(()=>{ target.style.transform = "scale(1)"; });
    }

    if(MOTION.reduced) return;

    const rect = target.getBoundingClientRect();
    // Fixed-position viewport coordinates, NOT relative to the button -
    // these three elements live on document.body rather than inside
    // target, specifically so the ring can expand past the button's own
    // edges instead of being clipped to it (a ripple confined inside a
    // button this small read as barely-there). Falls back to the
    // button's center for a keyboard-triggered Enter/Space activation,
    // which has no real click coordinates.
    const originX = (clientX!=null) ? clientX : rect.left + rect.width/2;
    const originY = (clientY!=null) ? clientY : rect.top + rect.height/2;

    const maxDim = Math.max(rect.width, rect.height, 40);
    spawnFx("dl-click-ripple", originX, originY, maxDim * 1.15, 900);
    spawnFx("dl-click-ring",   originX, originY, maxDim * 1.9,  950);
    spawnFx("dl-click-flash",  originX, originY, maxDim * 1.5,  500);
  }

  // Capture phase so this fires reliably even if some tool-specific
  // handler further down the tree calls stopPropagation() on the bubble
  // phase - never calls preventDefault/stopPropagation itself, so the
  // native download (the <a>'s own default action) always still happens.
  document.addEventListener("click", function(e){
    const target = e.target.closest && e.target.closest(SELECTOR);
    if(!target) return;
    // MouseEvent.detail is 0 for a keyboard-triggered click (Enter/Space)
    // and >=1 for a real mouse/touch click - the standard way to tell
    // them apart on the SAME click event, rather than guessing from
    // clientX/clientY (which keyboard activation sets to 0,0, a value a
    // real click near the viewport corner could also produce).
    const isKeyboard = e.detail === 0;
    playClickFX(target, isKeyboard ? null : e.clientX, isKeyboard ? null : e.clientY);
  }, true);

  return { playClickFX };
})();
