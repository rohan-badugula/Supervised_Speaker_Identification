"""One-command local supervision of frontend, API and inference worker."""
from __future__ import annotations

import argparse
import errno
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from http.client import HTTPConnection

from speaker_frontend.server import FrontendServer
from .lifecycle import release_workbench_port


def stop_children(children):
    for process in children:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 1.5
    for process in children:
        try:
            process.wait(timeout=max(.01, deadline-time.monotonic()))
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def main():
    parser = argparse.ArgumentParser(description='Run local frontend, API and analysis worker')
    parser.add_argument('--port', type=int, default=8766, help='Browser-facing frontend port')
    parser.add_argument('--api-port', type=int, default=0, help='Private API port; 0 chooses a free port')
    parser.add_argument('--data-dir', type=Path, default=Path('data/workbench'))
    parser.add_argument('--no-restart', action='store_true')
    args = parser.parse_args()
    if not all(0 <= port <= 65535 for port in (args.port, args.api_port)):
        parser.error('Ports must be between 0 and 65535.')
    children = []
    server = None
    monitor_stop = threading.Event()
    root = args.data_dir.resolve()
    # The API subprocess omits HF_TOKEN. The launcher passes its shell environment
    # to the worker; no model token is transmitted by the browser or gateway.
    api_environment = dict(os.environ)
    api_environment.pop('HF_TOKEN', None)
    previous_handlers = {}
    try:
        try:
            server = FrontendServer(('127.0.0.1', args.port), None)
        except OSError as error:
            if error.errno != errno.EADDRINUSE or args.no_restart:
                raise
            release_workbench_port(args.port)
            server = FrontendServer(('127.0.0.1', args.port), None)
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.getsignal(signum)
            def stop(signum, _frame):
                raise SystemExit(128+signum)
            signal.signal(signum, stop)
        with tempfile.TemporaryDirectory(prefix='speaker-services-') as directory:
            ready_path = Path(directory) / 'api-ready.json'
            api = subprocess.Popen([sys.executable, '-m', 'speaker_id.workbench.server',
                '--port', str(args.api_port), '--data-dir', str(root), '--no-restart',
                '--ready-file', str(ready_path)], env=api_environment, start_new_session=True)
            children.append(api)
            deadline = time.monotonic()+15
            while not ready_path.exists():
                if api.poll() is not None:
                    raise RuntimeError('The backend API exited during startup.')
                if time.monotonic()>deadline:
                    raise RuntimeError('The backend API did not become ready in 15 seconds.')
                time.sleep(.05)
            port = json.loads(ready_path.read_text())['port']
            server.api_address = ('127.0.0.1', port)
            worker = subprocess.Popen([sys.executable, '-m', 'speaker_id.workbench.worker',
                '--data-dir', str(root)], start_new_session=True)
            children.append(worker)
            deadline = time.monotonic()+15
            while True:
                if worker.poll() is not None:
                    raise RuntimeError('The analysis worker exited during startup (check its workspace lease).')
                connection = HTTPConnection('127.0.0.1', port, timeout=2)
                try:
                    connection.request('GET', '/api/health')
                    worker_health = json.load(connection.getresponse())['worker']
                finally:
                    connection.close()
                if worker_health.get('ready'):
                    break
                if time.monotonic()>deadline:
                    raise RuntimeError('The analysis worker did not become ready in 15 seconds.')
                time.sleep(.1)
            def monitor():
                reported = set()
                while not monitor_stop.wait(.1):
                    for name, process in zip(('API', 'analysis worker'), children):
                        if process.poll() is not None and name not in reported:
                            reported.add(name)
                            print(f'{name} stopped. The frontend stays available; restart the workbench services to recover.',
                                  file=sys.stderr, flush=True)
            thread = threading.Thread(target=monitor, daemon=True, name='service-supervisor')
            thread.start()
            print(f'Speaker workbench: http://127.0.0.1:{server.server_address[1]}', flush=True)
            print(f'API: 127.0.0.1:{port} · inference worker: separate process', flush=True)
            print(f'Local workspace: {root}', flush=True)
            server.serve_forever(poll_interval=.1)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Could not run workbench: {error}\n')
    finally:
        monitor_stop.set()
        if server:
            server.server_close()
        stop_children(children)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == '__main__':
    main()
