/* Moved out of index.html's inline <script> into this plain synchronous
   <script src> for the same CSP reason as pretheme.js (see that file's
   header comment) - production's script-src has no 'unsafe-inline',
   which silently blocked this as an inline block (so the static SEO
   content was never hidden on a tool page in production - the original
   header-visible/wrong-content flash this script exists to prevent).
   Must stay synchronous (no defer/async) and must run before first
   paint, same as before.

   Every generated tool page (this same template, re-rendered per tool
   by build/generate-landing.js) ships the identical static hero + tool-
   grid markup as the homepage, for SEO/no-JS. On a real tool page,
   app.js's own bottom IIFE synchronously calls TOOLS[pathToolId]() on
   load, which opens the #overlay tool workspace - but that only
   happens once the page has parsed and every deferred <script> (see
   RUNTIME_LIBRARIES/RUNTIME_SCRIPTS below, all `defer`) has run, so
   without this, the browser paints the raw static hero/grid first and
   THEN swaps to the tool workspace: a visible flash of the "wrong"
   page content. Fixed the same way the theme is - a synchronous
   inline script, before first paint, that hides the static content up
   front instead of letting JS reveal the right content after a
   visible wrong-content frame. Paired with css/site.css's
   html.tool-preload rule and openPanel()'s removal of this class in
   js/core/panel.js (the actual reveal, the instant the real tool
   workspace is ready - not a delay). The setTimeout below is a safety
   net only (same "never stuck forever" pattern as motionEnter's own
   guard in js/core/motion.js), for the edge case of a future SEO-only
   landing page with no matching TOOLS[id] handler, or a blocked
   script - never the primary reveal mechanism. Never applies on the
   homepage itself (bare "/" or "/index.html"), which has no
   auto-opening tool and always shows its grid immediately.

   The inline style.visibility set alongside the class (not just the
   class) exists for the same reason the background above is now also
   inline: css/site.css's own html.tool-preload{visibility:hidden}
   rule needs that external stylesheet loaded to take effect, which -
   back when this site still used a cross-document View Transition
   (see the theme script's comment above; that at-rule is now removed)
   - wasn't always guaranteed before revealing this page. Ordinary
   navigation render-blocks on css/site.css regardless, so the class
   alone is sufficient now, but the inline property is kept as the same
   harmless, zero-network-dependency defense-in-depth - build/
   verify-dist.js forbids an inline STYLE element as the fix, so the
   guarantee is expressed as a plain inline style property instead.
   js/core/panel.js's real reveal and the setTimeout fallback below
   both clear it the same way they already clear the class. */
if(location.pathname !== "/" && !/\/index\.html$/i.test(location.pathname) && location.pathname !== ""){
  document.documentElement.classList.add("tool-preload");
  document.documentElement.style.visibility = "hidden";
  setTimeout(function(){
    document.documentElement.classList.remove("tool-preload");
    document.documentElement.style.visibility = "";
  }, 2500);
}
