"""Local dev server with the same clean-URL behavior the production host's
_redirects file provides: an extensionless path (e.g. /merge-pdf) resolves
to its matching .html file when one exists (build/generate-landing.js
generates one per tool - each is now the full app shell plus that tool's
own SEO content, not a separate marketing page, so this IS the interactive
tool); anything with no matching file falls back to index.html for the
homepage/any other in-app route. Plain `python -m http.server` 404s on a
path like /merge-pdf, which made it impossible to test direct-URL-entry/
refresh locally.
"""
import http.server
import os
import socketserver

PORT = 5173
# Always serve from this script's own directory, regardless of the cwd it
# was launched from (the harness's launch.json runs it from the repo
# root, one level up).
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class SpaFallbackHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        local = path.lstrip("/")
        if local:
            for candidate in (local, local + ".html", os.path.join(local, "index.html")):
                if os.path.isfile(candidate):
                    self.path = "/" + candidate.replace(os.sep, "/")
                    return super().do_GET()
        self.path = "/index.html"
        return super().do_GET()


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), SpaFallbackHandler) as httpd:
        print(f"Serving with SPA fallback on http://localhost:{PORT}")
        httpd.serve_forever()
