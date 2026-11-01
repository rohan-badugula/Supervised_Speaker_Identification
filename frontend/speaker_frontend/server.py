"""Local static web frontend and bounded-memory same-origin API gateway."""
from __future__ import annotations

import argparse
import http.client
import json
import mimetypes
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import urlsplit

ASSETS = files('speaker_frontend') / 'static'
MAX_BODY = 4 * 1024**3


def backend_address(url: str) -> tuple[str, int]:
    value = urlsplit(url)
    if (value.scheme != 'http' or value.hostname not in {'127.0.0.1', 'localhost'}
            or value.username or value.password or value.path not in {'', '/'}
            or value.query or value.fragment):
        raise ValueError('The API must be an HTTP localhost origin without a path or credentials.')
    port = value.port or 80
    if not 1 <= port <= 65535:
        raise ValueError('Invalid API port.')
    return value.hostname, port


class FrontendServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, api_address):
        self.api_address = api_address
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: FrontendServer

    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def log_message(self, *args):
        pass  # Never log recordings, tokens or request bodies.

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; media-src 'self' blob:; "
                         "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        super().end_headers()

    def _check_local(self):
        host = self.headers.get('Host', '')
        port = self.server.server_address[1]
        if host not in {f'127.0.0.1:{port}', f'localhost:{port}'}:
            raise PermissionError('Only localhost requests are accepted.')
        if self.headers.get('Origin') not in {None, f'http://{host}'}:
            raise PermissionError('Cross-origin requests are not allowed.')
        if self.headers.get('Transfer-Encoding'):
            raise ValueError('Chunked request bodies are not supported. Send Content-Length.')
        if len(self.headers.get_all('Content-Length', [])) > 1:
            raise ValueError('Ambiguous Content-Length.')
        target = urlsplit(self.path)
        if target.scheme or target.netloc:
            raise ValueError('Absolute request targets are not supported.')
        return target.path

    def _json(self, value, status):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _proxy(self):
        if not self.server.api_address:
            self._json({'error': 'The backend API is not ready.'}, 503)
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 <= length <= MAX_BODY:
            raise ValueError('Request body is too large.')
        host, port = self.server.api_address
        connection = http.client.HTTPConnection(host, port, timeout=120)
        try:
            connection.putrequest(self.command, self.path, skip_accept_encoding=True)
            for name in ('Content-Type', 'Content-Length', 'Range', 'X-Workbench-Token'):
                if self.headers.get(name) is not None:
                    connection.putheader(name, self.headers[name])
            # The browser origin was validated above. This hop has its own local origin.
            if self.headers.get('Origin'):
                connection.putheader('Origin', f'http://{host}:{port}')
            connection.endheaders()
            remaining = length
            while remaining:
                block = self.rfile.read(min(1024**2, remaining))
                if not block:
                    raise ValueError('Upload ended early.')
                connection.send(block)
                remaining -= len(block)
            response = connection.getresponse()
            self.send_response(response.status)
            for name in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Disposition'):
                if response.getheader(name) is not None:
                    self.send_header(name, response.getheader(name))
            self.end_headers()
            if self.command != 'HEAD':
                while block := response.read(1024**2):
                    self.wfile.write(block)
        finally:
            connection.close()

    def _handle(self):
        try:
            path = self._check_local()
            if path.startswith('/api/'):
                self._proxy()
            elif self.command in {'GET', 'HEAD'} and path == '/healthz':
                self._json({'service': 'frontend', 'status': 'ok'}, 200)
            elif self.command in {'GET', 'HEAD'} and path in {'/', '/index.html', '/app.js', '/styles.css'}:
                name = 'index.html' if path == '/' else path[1:]
                body = (ASSETS / name).read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', mimetypes.guess_type(name)[0] or 'application/octet-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)
            else:
                self._json({'error': 'Page not found.'}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except PermissionError as error:
            self._json({'error': str(error)}, 403)
        except (ValueError, OverflowError) as error:
            self._json({'error': str(error)}, 400)
        except (OSError, http.client.HTTPException):
            # Only report unavailable before response headers have been sent.
            if not getattr(self, '_response_started', False):
                self._json({'error': 'Backend unavailable. Start or restart the workbench services.'}, 502)

    def send_response(self, code, message=None):
        self._response_started = True
        super().send_response(code, message)

    do_GET = do_HEAD = do_POST = _handle


def main():
    parser = argparse.ArgumentParser(description='Speaker Workbench frontend (local only)')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--api-url', default='http://127.0.0.1:8767')
    args = parser.parse_args()
    try:
        server = FrontendServer(('127.0.0.1', args.port), backend_address(args.api_url))
    except (ValueError, OSError) as error:
        parser.exit(1, f'Could not start frontend: {error}\n')
    print(f'Speaker frontend: http://127.0.0.1:{server.server_address[1]}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
