"""Single local inference worker with a durable queue and exclusive workspace lease."""
from __future__ import annotations

import argparse
import fcntl
import os
import signal
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .runtime import runtime_health
from .service import Workbench


class WorkerLease:
    """OS releases the advisory lock on crash; one worker per local workspace."""
    def __init__(self, root):
        root.mkdir(parents=True, exist_ok=True)
        self.handle = (root / 'worker.lock').open('a+')
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise RuntimeError('An analysis worker already owns this workspace.') from None

    def close(self):
        self.handle.close()


def serve(root: Path, stop: threading.Event, *, backend_loader=None):
    lease = WorkerLease(root)
    app = None
    heartbeat_thread = None
    done = threading.Event()
    worker_id = uuid4().hex
    try:
        # Recovery occurs only after the lease is acquired. API restarts never change jobs.
        app = Workbench(root, execution_mode='worker', **({'backend_loader':backend_loader} if backend_loader else {}))
        def heartbeat(status='ready'):
            return app.store.save('worker', {'id':'worker-service', 'worker_id':worker_id,
                'pid':os.getpid(), 'status':status, 'source_revision':app.source_revision,
                'heartbeat_at':datetime.now(timezone.utc).isoformat(), 'health':runtime_health()})
        heartbeat()
        def pulse():
            while not done.wait(2):
                heartbeat()
        heartbeat_thread = threading.Thread(target=pulse, daemon=True, name='worker-health')
        heartbeat_thread.start()
        print('Speaker worker ready (single local workspace; CPU inference).', flush=True)
        while not stop.is_set():
            job = app.store.claim_job(worker_id)
            if job:
                app._run(job['id'])
            else:
                stop.wait(.25)
    finally:
        done.set()
        if heartbeat_thread:
            heartbeat_thread.join(timeout=3)
        if app:
            heartbeat('stopped')
            app.close()
        lease.close()


def main():
    parser = argparse.ArgumentParser(description='Speaker analysis worker (local SQLite queue)')
    parser.add_argument('--data-dir', type=Path, default=Path('data/workbench'))
    args = parser.parse_args()
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    try:
        serve(args.data_dir.resolve(), stop)
    except RuntimeError as error:
        parser.exit(1, f'Could not start worker: {error}\n')


if __name__ == '__main__':
    main()
