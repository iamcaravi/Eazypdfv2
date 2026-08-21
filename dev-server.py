"""Local static server with production-like clean URLs and 404 behavior.

An extensionless tool path (for example /merge-pdf) resolves to its matching
generated HTML file. Unknown paths return the project's branded 404 page with
an actual HTTP 404 status instead of serving a soft-200 homepage response.
"""

import http.server
import os
import socketserver
from urllib.parse import unquote, urlsplit

PORT = 5173
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class CleanRouteHandler(http.server.SimpleHTTPRequestHandler):
    def _resolve_local_file(self):
        request_path = unquote(urlsplit(self.path).path)
        local_path = request_path.lstrip("/") or "index.html"
        candidates = (local_path, local_path + ".html", os.path.join(local_path, "index.html"))

        for candidate in candidates:
            absolute_candidate = os.path.abspath(os.path.join(ROOT, candidate))
            try:
                stays_in_root = os.path.commonpath((ROOT, absolute_candidate)) == ROOT
            except ValueError:
                stays_in_root = False
            if stays_in_root and os.path.isfile(absolute_candidate):
                return os.path.relpath(absolute_candidate, ROOT).replace(os.sep, "/")
        return None

    def _send_not_found(self, include_body):
        not_found_path = os.path.join(ROOT, "404.html")
        try:
            with open(not_found_path, "rb") as handle:
                body = handle.read()
        except OSError:
            body = b"404 - Page not found"

        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_GET(self):
        resolved = self._resolve_local_file()
        if resolved:
            self.path = "/" + resolved
            return super().do_GET()
        return self._send_not_found(include_body=True)

    def do_HEAD(self):
        resolved = self._resolve_local_file()
        if resolved:
            self.path = "/" + resolved
            return super().do_HEAD()
        return self._send_not_found(include_body=False)


class ThreadingCleanRouteServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    # Phase 12: plain TCPServer handles one connection at a time. A modern
    # page here loads a dozen-plus resources (CSS, several classic
    # <script> files, images) over HTTP/1.1 keep-alive connections a
    # browser holds open and reuses - under a long sequential Playwright
    # run (many page loads back to back), that single-threaded accept loop
    # increasingly serialized behind those held-open connections, and was
    # observed to eventually stop accepting new ones entirely (connection
    # refused) partway through a long test run. ThreadingMixIn serves each
    # connection on its own thread, which is what this was actually
    # missing - daemon_threads=True keeps a straggling thread from ever
    # blocking process exit.
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with ThreadingCleanRouteServer(("", PORT), CleanRouteHandler) as httpd:
        print(f"Serving YOYOPDF on http://localhost:{PORT}")
        httpd.serve_forever()
