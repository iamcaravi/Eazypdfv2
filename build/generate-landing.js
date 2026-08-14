const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const registry = JSON.parse(fs.readFileSync(
  path.join(ROOT, "seo", "tools-registry.json"),
  "utf8"
));
const additional = JSON.parse(fs.readFileSync(
  path.join(ROOT, "seo", "additional-tools.json"),
  "utf8"
));

// Maps registry slug -> this app's actual TOOLS.xxx id (used for ?tool=).
// protect-pdf is intentionally excluded: the registry describes a
// password-protect feature that doesn't exist as a TOOLS.xxx in this
// build (no TOOLS.protect) - generating a page for it would expose a
// route with nothing behind it.
const SLUG_TO_TOOLID = {
  "merge-pdf": "merge",
  "split-pdf": "split",
  "compress-pdf": "compress",
  "edit-pdf": "edit",
  "pdf-to-word": "pdf2word",
  "rotate-pdf": "rotate",
  "delete-pages": "deletepages",
  "extract-pages": "extractpages",
  "organize-pdf": "organize",
  "crop-pdf": "crop",
  "watermark-pdf": "watermark",
  "add-page-numbers": "pagenumbers",
};
for (const t of additional.tools) SLUG_TO_TOOLID[t.slug] = t.toolId;

// additional-tools.json uses a flatter shape (heroValueProp instead of
// landing.hero.valueProp, no whyUse/keyFeatures/useCases) since that
// content is fresh-written for tools with no existing rich copy - reshape
// it to match the registry's structure so renderTool() can treat both
// sources identically.
const additionalNormalized = additional.tools.map(t => ({
  ...t,
  landing: { hero: { valueProp: t.heroValueProp } }
}));

// Combined lookup across both content sources, so relatedSlugs links
// resolve correctly regardless of which file a tool's content lives in.
const ALL_TOOLS = [...registry.tools, ...additionalNormalized];
function findTool(slug){ return ALL_TOOLS.find(t => t.slug === slug); }

// Maps ANY slug appearing in relatedSlugs -> this build's landing filename,
// so "related tools" links only point at pages that actually exist here.
// Derived from each entry's own `file` field rather than assumed
// slug-to-filename patterns - add-page-numbers's own file is actually
// page-numbers.html, not add-page-numbers.html, which a hand-written map
// got wrong once already.
const SLUG_TO_FILE = {};
for (const slug of Object.keys(SLUG_TO_TOOLID)) {
  const t = findTool(slug);
  if (t) SLUG_TO_FILE[slug] = t.file;
}

const DOMAIN = "https://yoyopdf.in";

function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ---------------------------------------------------------------------
 * Architecture: each tool's canonical clean URL (e.g. /merge-pdf) must be
 * BOTH the actual interactive app AND its own SEO landing content on one
 * page - not the interactive app at one URL and a separate marketing page
 * shadowing it at the same URL (the old two-system setup this replaces).
 *
 * Rather than hand-duplicating the app's markup/CSS/JS per tool (which
 * would make index.html and 37 near-copies drift out of sync), this
 * generator takes index.html itself - the single source of truth for the
 * app shell - and, per tool, swaps its homepage-specific <head> metadata/
 * JSON-LD and hero copy for that tool's own, then appends a dedicated
 * SEO content section (why-use/how-it-works/features/use-cases/FAQ/
 * related-tools, built from this same registry data) right before the
 * footer. Everything else - header, tool workspace overlay, the actual
 * TOOLS.xxx implementations in js/app.js, styling - stays byte-identical
 * to index.html, so there is exactly one place tool logic/markup lives.
 * ------------------------------------------------------------------- */

const TEMPLATE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const MARKERS = {
  title: '<title>YOYOPDF — Free Online PDF Tools: Merge, Split, Compress & Convert</title>',
  description: '<meta name="description" content="Merge, split, compress, convert and edit PDF files online — 100% free, no sign-up, no file limits. Every tool runs locally in your browser, so your files never leave your device.">',
  canonical: '<link rel="canonical" href="https://yoyopdf.in/">',
  ogUrl: '<meta property="og:url" content="https://yoyopdf.in/">',
  ogTitle: '<meta property="og:title" content="YOYOPDF — Free Online PDF Tools: Merge, Split, Compress & Convert">',
  ogDescription: '<meta property="og:description" content="Merge, split, compress, convert and edit PDF files online — 100% free, no sign-up, no file limits. Every tool runs locally in your browser, so your files never leave your device.">',
  twitterTitle: '<meta name="twitter:title" content="YOYOPDF — Free Online PDF Tools: Merge, Split, Compress & Convert">',
  twitterDescription: '<meta name="twitter:description" content="Merge, split, compress, convert and edit PDF files online — 100% free, no sign-up, no file limits. Every tool runs locally in your browser.">',
  hero: '<h1><span class="hero-line1">All-in-One <span class="accent">PDF</span></span><span class="hero-line2">Tools. Simple. Fast. Secure.</span></h1>',
  tagline: '<p class="tagline">YOYOPDF makes it easy to edit, convert, compress, merge, split and manage your PDF files online. All tools are free, secure and easy to use.</p>',
  footer: '<footer class="site-footer">',
};

// The homepage's own generic JSON-LD (SoftwareApplication + FAQPage) -
// swapped out per tool page for that tool's BreadcrumbList (+ FAQPage
// only where the tool actually has genuine FAQ content), so each
// canonical page provides exactly one set of structured data that
// matches what's actually on it, instead of two competing/duplicate
// blocks.
const SOFTWAREAPP_JSONLD_RE = /<script type="application\/ld\+json">[\s\S]*?"@type":\s*"SoftwareApplication"[\s\S]*?<\/script>\s*/;
const FAQPAGE_JSONLD_RE = /<script type="application\/ld\+json">[\s\S]*?"@type":\s*"FAQPage"[\s\S]*?<\/script>\s*/;

for (const [key, marker] of Object.entries(MARKERS)) {
  if (!TEMPLATE.includes(marker)) {
    throw new Error(`index.html marker not found (page content changed?): ${key}`);
  }
}
if (!SOFTWAREAPP_JSONLD_RE.test(TEMPLATE)) throw new Error("index.html: SoftwareApplication JSON-LD block not found");
if (!FAQPAGE_JSONLD_RE.test(TEMPLATE)) throw new Error("index.html: homepage FAQPage JSON-LD block not found");

function renderSeoSection(tool){
  const l = tool.landing || {};

  const whyBlock = (l.whyUse && l.whyUse.points && l.whyUse.points.length) ? `
  <div class="tool-seo-block">
    <h2>Why use ${esc(tool.name)}?</h2>
    <p class="tool-seo-intro">${esc(l.whyUse.intro || "")}</p>
    <div class="tool-seo-grid">${l.whyUse.points.map(p => `
      <div class="tool-seo-card"><h3>${esc(p.title)}</h3><p>${esc(p.desc)}</p></div>`).join("")}
    </div>
  </div>` : "";

  const howBlock = (l.howItWorks && l.howItWorks.length) ? `
  <div class="tool-seo-block">
    <h2>How it works</h2>
    <div class="tool-seo-steps">${l.howItWorks.map(s => `
      <div class="tool-seo-step"><h3>${esc(s.title)}</h3><p>${esc(s.desc)}</p></div>`).join("")}
    </div>
  </div>` : "";

  const featuresBlock = (l.keyFeatures && l.keyFeatures.length) ? `
  <div class="tool-seo-block">
    <h2>Key features</h2>
    <div class="tool-seo-grid">${l.keyFeatures.map(f => `
      <div class="tool-seo-card"><h3>${esc(f.title)}</h3><p>${esc(f.desc)}</p></div>`).join("")}
    </div>
  </div>` : "";

  const useCasesBlock = (l.useCases && l.useCases.length) ? `
  <div class="tool-seo-block">
    <h2>Who uses ${esc(tool.name)}?</h2>
    <div class="tool-seo-grid">${l.useCases.map(u => `
      <div class="tool-seo-card"><h3>${esc(u.title)}</h3><p>${esc(u.desc)}</p></div>`).join("")}
    </div>
  </div>` : "";

  const faqBlock = (tool.faqs && tool.faqs.length) ? `
  <div class="tool-seo-block">
    <h2>Frequently asked questions</h2>
    ${tool.faqs.map(f => `
    <details class="tool-seo-faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}
  </div>` : "";

  const relatedSlugs = (tool.relatedSlugs || []).filter(s => SLUG_TO_FILE[s] && s !== tool.slug);
  const relatedBlock = relatedSlugs.length ? `
  <div class="tool-seo-block">
    <h2>Related tools</h2>
    <div class="tool-seo-related">${relatedSlugs.map(s => `
      <a href="/${SLUG_TO_FILE[s].replace(/\.html$/, "")}">${esc(findTool(s)?.name || s)}</a>`).join("")}
    </div>
  </div>` : "";

  const body = [whyBlock, howBlock, featuresBlock, useCasesBlock, faqBlock, relatedBlock].join("");
  if (!body.trim()) return "";
  return `\n<section class="tool-seo-content">${body}\n</section>\n\n`;
}

function renderTool(tool){
  const l = tool.landing || {};
  const urlPath = tool.file.replace(/\.html$/, "");
  const canonical = `${DOMAIN}/${urlPath}`;
  const h1 = tool.h1 || tool.name;
  const valueProp = l.hero?.valueProp || tool.description;

  const jsonLdBlocks = [];
  jsonLdBlocks.push(`<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": DOMAIN + "/" },
      { "@type": "ListItem", "position": 2, "name": tool.name, "item": canonical }
    ]
  }, null, 2)}</script>\n`);
  if (tool.faqs && tool.faqs.length){
    jsonLdBlocks.push(`<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": tool.faqs.map(f => ({
        "@type": "Question",
        "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a }
      }))
    }, null, 2)}</script>\n`);
  }

  let out = TEMPLATE;
  out = out.replace(MARKERS.title, `<title>${esc(tool.title)}</title>`);
  out = out.replace(MARKERS.description, `<meta name="description" content="${esc(tool.description)}">`);
  out = out.replace(MARKERS.canonical, `<link rel="canonical" href="${canonical}">`);
  out = out.replace(MARKERS.ogUrl, `<meta property="og:url" content="${canonical}">`);
  out = out.replace(MARKERS.ogTitle, `<meta property="og:title" content="${esc(tool.title)}">`);
  out = out.replace(MARKERS.ogDescription, `<meta property="og:description" content="${esc(tool.description)}">`);
  out = out.replace(MARKERS.twitterTitle, `<meta name="twitter:title" content="${esc(tool.title)}">`);
  out = out.replace(MARKERS.twitterDescription, `<meta name="twitter:description" content="${esc(tool.description)}">`);
  out = out.replace(MARKERS.hero, `<h1>${esc(h1)}</h1>`);
  out = out.replace(MARKERS.tagline, `<p class="tagline">${esc(valueProp)}</p>`);
  out = out.replace(SOFTWAREAPP_JSONLD_RE, "");
  out = out.replace(FAQPAGE_JSONLD_RE, jsonLdBlocks.join(""));
  out = out.replace(MARKERS.footer, renderSeoSection(tool) + MARKERS.footer);
  return out;
}

const slugs = Object.keys(SLUG_TO_TOOLID);
const generated = [];
for (const slug of slugs) {
  let tool = findTool(slug);
  if (!tool || !tool.faqs || !tool.title) { console.log("SKIP (no usable data):", slug); continue; }
  // This registry entry is from before Edit PDF's editor workspace was
  // built - it's "landing-only, coming soon" content for a tool that is
  // now actually fully functional in this build. Correct the parts that
  // claim it isn't live yet; the descriptive content about what editing
  // does is otherwise still accurate.
  if (slug === "edit-pdf") {
    tool = JSON.parse(JSON.stringify(tool));
    tool.title = "Edit PDF Online Free — Add Text & Annotate | YOYOPDF";
    tool.description = "Edit PDF documents directly in your browser — add text, images, shapes, and annotations. Free, no upload, no sign-up.";
    tool.faqs[0] = {
      q: "Is Edit PDF available now?",
      a: "Yes. Edit PDF runs entirely in your browser — no upload, no sign-up, no waiting."
    };
    tool.landing.hero.valueProp = "Edit PDF documents directly in your browser — correct mistakes, add text, images and shapes, without installing anything.";
  }
  // Same fix as edit-pdf above - this tool is also actually live now.
  if (slug === "pdf-to-word") {
    tool = JSON.parse(JSON.stringify(tool));
    tool.title = "PDF to Word Converter Free Online | YOYOPDF";
    tool.description = "Convert PDF into an editable Word document, free and browser-based. No upload, no sign-up.";
    tool.faqs[0] = {
      q: "Is PDF to Word available now?",
      a: "Yes. PDF to Word runs entirely in your browser — no upload, no sign-up, no waiting."
    };
    tool.landing.hero.valueProp = "Convert PDF into an editable Word document directly in your browser — no upload, no sign-up.";
  }

  const html = renderTool(tool);
  fs.writeFileSync(path.join(ROOT, tool.file), html);
  generated.push(tool.file);
  console.log("Generated:", tool.file);
}

console.log(`\nDone. Generated files: ${generated.join(", ")}`);
