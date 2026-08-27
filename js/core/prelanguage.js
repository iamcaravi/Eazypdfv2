/* Moved out of index.html's inline <script> into this plain synchronous
   <script src> for the same CSP reason as pretheme.js (see that file's
   header comment) - production's script-src has no 'unsafe-inline',
   which silently blocked this as an inline block. Must stay synchronous
   (no defer/async) and must run before first paint, same as before.

   Pre-paint language/dir (same technique as the theme script) - avoids
   a flash of English/LTR before js/core/i18n.js finishes loading and
   running its own full I18N.init(). Kept in sync with
   I18N_SUPPORTED_CODES/detect() in i18n.js - duplicated here only
   because this must run before any other script has loaded. */
try {
  var __supportedLangs = ["en","hi","es","fr","de","pt","ja","zh","ko","ar"];
  var __rtlLangs = ["ar"];
  var __savedLang = localStorage.getItem("yoyopdf-lang");
  if(!__savedLang || __supportedLangs.indexOf(__savedLang) === -1){
    var __navLang = ((navigator.language || "en").toLowerCase().slice(0,2));
    __savedLang = __supportedLangs.indexOf(__navLang) !== -1 ? __navLang : "en";
  }
  document.documentElement.setAttribute("lang", __savedLang);
  document.documentElement.setAttribute("dir", __rtlLangs.indexOf(__savedLang) !== -1 ? "rtl" : "ltr");
} catch(e) {}
