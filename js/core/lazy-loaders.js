/* Moved out of index.html's inline <script> into this plain synchronous
   <script src> for the same CSP reason as pretheme.js (see that file's
   header comment) - production's script-src has no 'unsafe-inline',
   which silently blocked this as an inline block, so loadScriptOnce/
   ensurePDFLib/etc. were never defined in production and every lazy-
   loading tool (Split/Extract Pages, PDF to Word, PDF<->Excel, ...)
   threw a ReferenceError the moment it tried to use one of them. Kept
   as a plain synchronous tag (no defer/async) in the exact same
   position as the inline block it replaces, to preserve the existing
   load order/timing exactly.

   jszip/mammoth/xlsx are each only needed by a handful of specific
   tools (Split/Extract Pages, PDF to Word, PDF<->Excel)
   - loaded on demand via ensureJSZip()/ensureMammoth()/ensureXLSX()
   instead of on every single page load regardless of which tool (if
   any) the visitor actually uses. */
function loadScriptOnce(src, integrity){
  window.__scriptLoadPromises = window.__scriptLoadPromises || {};
  if(window.__scriptLoadPromises[src]) return window.__scriptLoadPromises[src];
  window.__scriptLoadPromises[src] = new Promise((resolve, reject)=>{
    const s = document.createElement("script");
    s.src = src;
    // Same SRI reasoning as the route-selected eager CDN scripts above -
    // these dependencies are fetched later, at tool-use time, but trust the CDN
    // exactly as much.
    if(integrity){ s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
  return window.__scriptLoadPromises[src];
}
function ensurePDFLib(){ return typeof PDFLib!=="undefined" ? Promise.resolve() : loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js", "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI"); }
function ensurePDFJS(){
  if(typeof pdfjsLib!=="undefined") return Promise.resolve();
  return loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e").then(()=>{
    if(window.YOYO_VENDOR_ASSETS) pdfjsLib.GlobalWorkerOptions.workerSrc = window.YOYO_VENDOR_ASSETS.pdfjsWorker;
  });
}
function ensureJSZip(){ return typeof JSZip!=="undefined" ? Promise.resolve() : loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", "sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG"); }
function ensureMammoth(){ return typeof mammoth!=="undefined" ? Promise.resolve() : loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js", "sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz"); }
/* Word to PDF Hindi/Devanagari fix: pdf-lib's StandardFonts (Helvetica etc)
   only support WinAnsi encoding, which cannot represent Devanagari at all -
   these two are only loaded when word2pdf actually embeds a custom Unicode
   font (see embedUnicodeFont() in pdf-convert-tools.js), never on plain-
   English conversions. @pdf-lib/fontkit's UMD build calls a Babel-generator
   -compiled function during complex-script shaping without bundling its own
   regeneratorRuntime helper, so that polyfill must load first or shaping
   throws a ReferenceError mid-conversion. */
function ensureRegeneratorRuntime(){ return typeof regeneratorRuntime!=="undefined" ? Promise.resolve() : loadScriptOnce("https://cdn.jsdelivr.net/npm/regenerator-runtime@0.14.1/runtime.js", "sha384-OUN/6TBQWJ0V9kHVpZgUpqrgWENHMWqIBFHq8UEwg41L3EKbh39nX+5wiDPH29A5"); }
function ensureFontkit(){ return typeof fontkit!=="undefined" ? Promise.resolve() : ensureRegeneratorRuntime().then(()=>loadScriptOnce("https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js", "sha384-2p6U+1mmqF10USehFeRiyG2ESG9FwIqN+jxULn5w9jjQIihSn9Pt13dVCn/Hawjn")); }
function ensureXLSX(){ return typeof XLSX!=="undefined" ? Promise.resolve() : loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw"); }
