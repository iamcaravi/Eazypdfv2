/* Pre-paint theme init. Loaded as a plain synchronous <script src> (no
   defer/async - see index.html) rather than kept as an inline <script>
   block: production's Content-Security-Policy (_headers) sets
   script-src 'self' https://cdnjs.cloudflare.com with no 'unsafe-inline'
   and no nonce/hash, which silently blocks inline <script> EXECUTION
   (a real production bug this was moved out of index.html to fix - it
   never showed up locally because local dev servers don't send that CSP
   header at all). A same-origin external file is allowed by 'self' with
   no CSP maintenance required, ever. Must stay a plain synchronous tag,
   not defer/async, and must stay the very first thing in <head> - it has
   to run and set data-theme before the browser's first paint, which is
   the entire point of it existing. */
var __savedTheme = "light";
try { __savedTheme = localStorage.getItem("yoyopdf-theme") || "light"; } catch(e) {}
document.documentElement.setAttribute("data-theme", __savedTheme);
/* REMOVED: an inline `documentElement.style.background` set here to
   match css/site.css's html{background:var(--paper)} rule for the
   pre-stylesheet-load instant. That inline property is GONE now because
   it was the actual root cause of a real bug, not just redundant: once
   set, a same-property inline style permanently wins the cascade over
   ANY external stylesheet rule, load order notwithstanding - contrary
   to this comment's own previous (incorrect) claim that site.css's rule
   would "re-apply" once loaded. It never does. Concretely: the
   light/dark toggle (js/core/quick-actions.js) only ever updates the
   data-theme ATTRIBUTE, which correctly flips every var(--paper)-based
   background (body, footer, ...) - but with this inline property
   present, <html>'s own background stayed frozen at whatever color this
   line set on the ORIGINAL page load, forever, regardless of later
   toggles. Since browsers paint the viewport's "canvas" (the area below
   short content, and the overscroll/rubber-band region) using the root
   element's background specifically, that stale inline value is exactly
   what showed up as a wrong-theme strip at the bottom of the page after
   toggling. The original justification for this line (cross-document
   View Transitions revealing an unstyled destination page before its
   stylesheet loaded) was already removed from css/site.css - ordinary
   navigation render-blocks on the stylesheet before painting anything,
   so the plain CSS rule (html{background:var(--paper)}, driven by the
   data-theme attribute set synchronously above) is already correct on
   first paint with no inline duplicate needed. */
