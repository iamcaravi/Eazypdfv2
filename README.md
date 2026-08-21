# YOYOPDF

Browser-first PDF/image tools. The homepage and every tool route are static,
classic-script HTML pages; there is no framework runtime or JavaScript bundle.
Shared infrastructure lives in `js/core/`, tool implementations in `js/tools/`,
and the editor in `js/editor/`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the local dev server (`dev-server.py`) on http://localhost:5173, with clean-URL fallback matching production (`/merge-pdf` -> `merge-pdf.html`). |
| `npm run generate` | Regenerates tool pages, runtime route data, sitemap, robots rules, and redirects from the SEO registries. |
| `npm run seo:check` | Confirms all generated SEO files match their registry and template sources. |
| `npm test` | Runs the Vitest smoke test suite (`tests/`) — route/script-tag integrity, SEO registry consistency, and core utility unit tests. |
| `npm run build` | Runs the SEO check, creates the production `dist/` artifact, then verifies its pages, runtime files, SRI, routes, and metadata. |
| `npm run verify:dist` | Verifies an existing `dist/` artifact without rebuilding it. |

## Architecture and deployment

`index.html` is the shared page shell. Tool metadata belongs in
`seo/tools-registry.json` and `seo/additional-tools.json`; do not edit generated
tool HTML directly. Run `npm run generate` after changing the shell or registry.

Production hosting must publish dist/, as enforced by `netlify.toml`. The Vite
build copies the classic scripts, dynamic editor modules, workers, styles,
security headers, route rules, and SEO files that are not part of Vite's module
graph. The post-build verifier makes missing or drifted deployment files a build
failure; do not deploy the repository root.
