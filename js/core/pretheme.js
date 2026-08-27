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
var __savedTheme = "dark";
try { __savedTheme = localStorage.getItem("yoyopdf-theme") || "dark"; } catch(e) {}
document.documentElement.setAttribute("data-theme", __savedTheme);
/* Same root-background value css/site.css's html{} rule already sets,
   applied here too as a plain inline style PROPERTY on the element
   (not a stylesheet block - build/verify-dist.js's production check
   forbids any inline STYLE element, one hashed external stylesheet
   only) so it's active from the very first parsed byte, with zero
   network dependency.
   This used to be load-bearing because this site's cross-document View
   Transitions (@view-transition{navigation:auto}, since REMOVED from
   css/site.css) could reveal a destination page before its external
   stylesheet's render-block resolves - confirmed via a screen
   recording plus a MutationObserver diagnostic (logging data-theme
   with performance.now() timestamps into sessionStorage across a real
   navigation) that data-theme was ALWAYS correct the entire time; the
   flash was never a wrong theme value, it was the correctly-themed
   page rendering with default browser (white) styling because
   css/site.css hadn't loaded yet. Removing cross-document VT means
   ordinary navigation now render-blocks on css/site.css before
   painting anything, so that race no longer exists - this line is kept
   anyway as harmless, zero-network-dependency defense-in-depth (once
   css/site.css does load, its own html{background:var(--paper)} rule
   re-applies the same value - one source of truth either way). */
document.documentElement.style.background = (__savedTheme === "light") ? "#FAFAFA" : "#050505";
