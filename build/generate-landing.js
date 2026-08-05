const fs = require("fs");
const path = require("path");

const registry = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "seo", "tools-registry.json"),
  "utf8"
));

// Maps registry slug -> this app's actual TOOLS.xxx id (used for ?tool=).
// protect-pdf is intentionally excluded: the registry describes a
// password-protect feature that doesn't exist as a TOOLS.xxx in this
// build (no TOOLS.protect) - generating a page whose CTA opens nothing
// would be worse than not generating it at all.
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
// Maps ANY registry slug appearing in relatedSlugs -> our landing page filename,
// so "related tools" links only point at pages that actually exist on this
// build. Derived from each entry's own `file` field rather than assumed
// slug-to-filename patterns - add-page-numbers's own file is actually
// page-numbers.html, not add-page-numbers.html, which a hand-written map
// got wrong once already.
const SLUG_TO_FILE = {};
for (const slug of Object.keys(SLUG_TO_TOOLID)) {
  const t = registry.tools.find(x => x.slug === slug);
  if (t) SLUG_TO_FILE[slug] = t.file;
}

const OUT_DIR = path.join(__dirname, "..");
const DOMAIN = "https://eazypdf.in";

function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function renderTool(tool){
  const toolId = SLUG_TO_TOOLID[tool.slug];
  const l = tool.landing || {};
  // Use tool.file (what actually gets written to disk / served), not
  // tool.slug - they differ for add-page-numbers (file: page-numbers.html,
  // slug: add-page-numbers), and a canonical tag must point at the URL
  // that actually serves this content, not an unrelated slug.
  const urlPath = tool.file.replace(/\.html$/, "");
  const canonical = `${DOMAIN}/${urlPath}`;
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": tool.faqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  };
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": DOMAIN + "/" },
      { "@type": "ListItem", "position": 2, "name": tool.name, "item": canonical }
    ]
  };

  const relatedLinks = (tool.relatedSlugs || [])
    .filter(s => SLUG_TO_FILE[s])
    .map(s => `<a href="/${SLUG_TO_FILE[s]}">${esc(registry.tools.find(t=>t.slug===s)?.name || s)}</a>`)
    .join("\n      ");

  const whyCards = (l.whyUse?.points || []).map(p => `
      <div class="why-card">
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.desc)}</p>
      </div>`).join("");

  const stepCards = (l.howItWorks || []).map(s => `
      <div class="step">
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.desc)}</p>
      </div>`).join("");

  const featureCards = (l.keyFeatures || []).map(f => `
      <div class="feature-card">
        <h3>${esc(f.title)}</h3>
        <p>${esc(f.desc)}</p>
      </div>`).join("");

  const useCards = (l.useCases || []).map(u => `
      <div class="usecase-card">
        <h3>${esc(u.title)}</h3>
        <p>${esc(u.desc)}</p>
      </div>`).join("");

  const faqItems = tool.faqs.map(f => `
    <details class="faq-item">
      <summary>${esc(f.q)}</summary>
      <p>${esc(f.a)}</p>
    </details>`).join("");

  const trustBadges = (l.hero?.trustBadges || []).map(b => `<span>${esc(b)}</span>`).join("\n        ");

  const nextTool = l.cta ? registry.tools.find(t => t.slug === l.cta.targetSlug) : null;
  const nextToolFile = nextTool ? SLUG_TO_FILE[nextTool.slug] : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(tool.title)}</title>
<meta name="description" content="${esc(tool.description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="EazyPDF">
<meta property="og:title" content="${esc(tool.title)}">
<meta property="og:description" content="${esc(tool.description)}">
<meta property="og:image" content="${DOMAIN}/assets/og/eazypdf-default-og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(tool.title)}">
<meta name="twitter:description" content="${esc(tool.description)}">
<meta name="theme-color" content="#6C3CE0">
<link rel="icon" type="image/svg+xml" href="/assets/icons/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/landing.css">
<script type="application/ld+json">${JSON.stringify(faqJsonLd, null, 2)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbJsonLd, null, 2)}</script>
</head>
<body>
<header>
  <a class="brand" href="/"><span class="mark"></span>EazyPDF</a>
  <a class="back-link" href="/">← All PDF Tools</a>
</header>
<div class="wrap">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="/">Home</a> / <span aria-current="page">${esc(tool.name)}</span>
  </nav>

  <section class="hero">
    <h1>${esc(tool.h1)}</h1>
    <p class="value-prop">${esc(l.hero?.valueProp || tool.description)}</p>
    <div class="trust-badges">
        ${trustBadges}
    </div>
    <a class="cta-btn" href="/?tool=${toolId}">${esc(l.hero?.ctaLabel || ("Use " + tool.name))} →</a>
  </section>

  ${l.whyUse ? `<section class="section">
    <h2>Why use ${esc(tool.name)}?</h2>
    <p style="color:var(--ink-soft);margin-bottom:20px;max-width:680px;line-height:1.6">${esc(l.whyUse.intro)}</p>
    <div class="why-grid">${whyCards}
    </div>
  </section>` : ""}

  ${l.howItWorks ? `<section class="section">
    <h2>How it works</h2>
    <div class="steps">${stepCards}
    </div>
  </section>` : ""}

  ${l.keyFeatures ? `<section class="section">
    <h2>Key features</h2>
    <div class="features-grid">${featureCards}
    </div>
  </section>` : ""}

  ${l.useCases ? `<section class="section">
    <h2>Who uses ${esc(tool.name)}?</h2>
    <div class="usecase-grid">${useCards}
    </div>
  </section>` : ""}

  <section class="section">
    <h2>Frequently asked questions</h2>
    ${faqItems}
  </section>

  ${relatedLinks ? `<section class="section">
    <h2>Related tools</h2>
    <div class="related-grid">
      ${relatedLinks}
    </div>
  </section>` : ""}

  <section class="cta-section">
    <h2>Ready to ${esc(tool.name.toLowerCase())}?</h2>
    <a class="cta-btn" href="/?tool=${toolId}">${esc(l.hero?.ctaLabel || ("Use " + tool.name))} →</a>
    ${nextTool ? `<p style="margin-top:24px;color:var(--ink-soft);font-size:.9rem">${esc(l.cta.question)} <a href="/${nextToolFile}" style="color:var(--teal-deep);font-weight:700">${esc(l.cta.label)} →</a></p>` : ""}
  </section>
</div>
<footer>
  <div class="wrap">© ${new Date().getFullYear()} EazyPDF. All processing happens locally in your browser.</div>
</footer>
</body>
</html>
`;
}

const slugs = Object.keys(SLUG_TO_TOOLID);
const generated = [];
for (const slug of slugs) {
  let tool = registry.tools.find(t => t.slug === slug);
  if (!tool || !tool.faqs || !tool.title) { console.log("SKIP (no usable data):", slug); continue; }
  // This registry entry is from before Edit PDF's editor workspace was
  // built - it's "landing-only, coming soon" content for a tool that is
  // now actually fully functional in this build. Correct the parts that
  // claim it isn't live yet; the descriptive content about what editing
  // does is otherwise still accurate.
  if (slug === "edit-pdf") {
    tool = JSON.parse(JSON.stringify(tool));
    tool.title = "Edit PDF Online Free — Add Text & Annotate | EazyPDF";
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
    tool.title = "PDF to Word Converter Free Online | EazyPDF";
    tool.description = "Convert PDF into an editable Word document, free and browser-based. No upload, no sign-up.";
    tool.faqs[0] = {
      q: "Is PDF to Word available now?",
      a: "Yes. PDF to Word runs entirely in your browser — extracted text and images are laid out into a downloadable .docx file, no upload required."
    };
    tool.faqs[1] = {
      q: "Will the converted file be fully editable?",
      a: "Text is extracted as editable content; pages with little extractable text (scans, image-heavy pages) are inserted as images instead, so nothing is lost."
    };
    tool.faqs[2] = {
      q: "Is my file uploaded to convert it?",
      a: "No. Conversion runs in your browser using pdf.js and pdf-lib, with no file upload to any server."
    };
  }
  const html = renderTool(tool);
  const outPath = path.join(OUT_DIR, tool.file);
  fs.writeFileSync(outPath, html, "utf8");
  generated.push(tool.file);
  console.log("Generated:", tool.file);
}
console.log("\nDone. Generated files:", generated.join(", "));
