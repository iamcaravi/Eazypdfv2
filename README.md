# YOYOPDF

Browser-first PDF/image tools. The homepage and every tool route are static,
classic-script HTML pages; there is no framework runtime or JavaScript bundle.
Shared infrastructure lives in `js/core/`, tool implementations in `js/tools/`,
and the editor in `js/editor/`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the local dev server (`dev-server.py`) on http://localhost:5173, with clean-URL fallback matching production (`/merge-pdf` -> `merge-pdf.html`). Serves static files only — `/api/rating` is not available under this server; see `npm run dev:netlify` below. |
| `npm run dev:netlify` | Starts `netlify dev` on http://localhost:8888, serving the same static files as `npm run dev` plus a working `/api/rating` (Netlify Function + Netlify Blobs, emulated locally to `.netlify/blobs-serve/` — safe to delete to reset local rating data). Use this whenever you need to test ratings. |
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

## Ratings (`netlify/functions/rating.js`)

Tool ratings ("Rate this tool", shown on the result screen after a
download completes) and the website rating (submission logic still in
`js/core/ratings.js`'s `buildRatingWidget`, currently with no mount point
in the UI - see below) are two independent, server-validated aggregates
persisted in Netlify Blobs — no external database, no secrets required to
run. The overall (vote-weighted) tool rating is shown read-only as the 6th
item in the homepage's benefits strip and the 5th item in the About
page's stats strip (`mountTrustStripRating`/`mountAboutStatRating` in
`js/core/ratings.js`) — there is deliberately no rating display in the
footer any more; it was removed once these two placements existed, to
avoid showing the same number twice. Every display degrades to a plain
"Ratings unavailable right now" message (never a fake number) if the API
can't be reached, and never blocks or breaks the PDF tool itself.

- **Local testing:** run `npm run dev:netlify` (starts `netlify dev` on
  http://localhost:8888), not `npm run dev` and not a third-party static
  server / editor "Live Server" extension (e.g. VS Code Live Server on
  127.0.0.1:5500) — none of those serve `/api/rating` at all, so every
  rating request 404s and the UI correctly shows "Ratings unavailable
  right now" / "Unable to submit your rating right now." That is the
  dev server rejecting the request, not a bug in the rating code; check
  the browser console, which logs the real method/URL/HTTP status for
  every failed rating request.
- **Production:** deploy to Netlify as already configured; Netlify Blobs
  needs no setup or credentials on Netlify's own infrastructure.
- **Optional env var:** `RATING_HASH_PEPPER` — a non-secret string that
  widens the hash used to key anonymous voter tokens and rate-limit
  buckets. Works with a built-in default if unset; set your own value in
  Netlify's site environment variables for production if you want it
  distinct from this default. This is not a credential and does not need
  to be kept in this repository.
- **Duplicate-vote protection:** each browser gets one random anonymous id
  in `localStorage` (not a cookie — see `js/core/ratings.js`'s own header
  comment on why, given this site's "no cookies" privacy claim). The
  server is the actual authority: a second vote from the same id updates
  that voter's prior rating instead of counting twice, and a coarse
  per-IP rate limit (IP is hashed, never stored raw) backstops trivial
  storage-clearing abuse.
