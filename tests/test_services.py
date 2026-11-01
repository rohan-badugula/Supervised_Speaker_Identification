"""Integration checks for the frontend/API/worker boundaries; no real ML weights."""
import concurrent.futures
import http.client
import json
import os
import subprocess
import sys
import threading
import time
import wave
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from speaker_frontend.server import FrontendServer, backend_address
from speaker_id.workbench.server import Server
from speaker_id.workbench.service import Workbench
from speaker_id.workbench.store import Store
from speaker_id.workbench.worker import WorkerLease


@contextmanager
def serving(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def request(server, method, path, body=None, headers=None):
    headers = dict(headers or {})
    if isinstance(body, dict):
        body = json.dumps(body)
        headers['Content-Type'] = 'application/json'
    connection = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


@pytest.mark.parametrize('url', ['https://127.0.0.1:8767', 'http://example.com:8767',
    'http://127.0.0.1:8767/path', 'http://name:secret@localhost:8767', 'http://localhost:8767/?target=x'])
def test_gateway_cannot_target_remote_or_arbitrary_urls(url):
    with pytest.raises(ValueError):
        backend_address(url)


def test_gateway_serves_original_assets_and_proxies_upload_ranges_and_auth(tmp_path):
    with serving(Server(('127.0.0.1', 0), tmp_path, execution_mode='external')) as api:
        with serving(FrontendServer(('127.0.0.1', 0), api.server_address)) as frontend:
            for path in ['/', '/app.js', '/styles.css']:
                status, headers, body = request(frontend, 'GET', path)
                assert status == 200 and body
                assert "frame-ancestors 'none'" in headers['Content-Security-Policy']
            status, _, body = request(frontend, 'GET', '/api/state')
            assert status == 200
            csrf = json.loads(body)['csrf']
            media_bytes = bytes(range(256)) * 16384  # Several gateway blocks, kept byte-exact.
            status, _, body = request(frontend, 'POST', '/api/upload?name=synthetic.mp3&role=meeting',
                media_bytes, {'X-Workbench-Token':csrf, 'Origin':f'http://127.0.0.1:{frontend.server_address[1]}'})
            assert status == 201
            identity = json.loads(body)['id']
            status, headers, body = request(frontend, 'GET', f'/api/media/{identity}', headers={'Range':'bytes=1024-4095'})
            assert status == 206 and body == media_bytes[1024:4096]
            assert headers['Content-Range'] == f'bytes 1024-4095/{len(media_bytes)}'
            status, headers, body = request(frontend, 'HEAD', f'/api/media/{identity}')
            assert status == 200 and not body and int(headers['Content-Length']) == len(media_bytes)
            assert request(frontend, 'POST', '/api/jobs', {})[0] == 403
            assert request(frontend, 'GET', '/api/state', headers={'Origin':'https://untrusted.example'})[0] == 403
            assert request(frontend, 'GET', '/', headers={'Host':'untrusted.example'})[0] == 403
            assert request(frontend, 'GET', '/../backend/pyproject.toml')[0] == 404


def test_frontend_still_serves_when_backend_is_unavailable():
    with serving(FrontendServer(('127.0.0.1', 0), None)) as frontend:
        assert request(frontend, 'GET', '/')[0] == 200
        assert request(frontend, 'GET', '/api/state')[0] == 503


def test_queue_claim_is_atomic_and_fifo(tmp_path):
    store = Store(tmp_path)
    for i in range(8):
        store.save('job', {'id':str(i), 'status':'queued'})
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        claimed = list(pool.map(lambda i: Store(tmp_path).claim_job(str(i)), range(8)))
    assert {job['id'] for job in claimed} == {str(i) for i in range(8)}
    assert store.claim_job('extra') is None
    store.save('job', {'id':'next', 'status':'queued'})
    store.save('job', {'id':'last', 'status':'queued'})
    assert store.claim_job('worker')['id'] == 'next'
    assert store.claim_job('worker')['id'] == 'last'


def test_worker_lease_prevents_second_worker_from_recovering_live_jobs(tmp_path):
    first = WorkerLease(tmp_path)
    try:
        with pytest.raises(RuntimeError, match='already owns'):
            WorkerLease(tmp_path)
    finally:
        first.close()
    second = WorkerLease(tmp_path)
    second.close()


def test_api_restart_does_not_interrupt_worker_jobs_and_stale_worker_is_not_ready(tmp_path):
    store = Store(tmp_path)
    store.save('job', {'id':'active','status':'running'})
    app = Workbench(tmp_path, execution_mode='external')
    try:
        assert app.store.get('job','active')['status'] == 'running'
        assert not app.worker_status()['ready']
        store.save('worker', {'id':'worker-service','status':'ready',
            'heartbeat_at':(datetime.now(timezone.utc)-timedelta(seconds=20)).isoformat()})
        assert not app.worker_status()['ready']
    finally:
        app.close()


# Executes a real separate worker process, with only the inference/decoder stubbed.
WORKER_PROGRAM = r'''
import shutil,sys,threading,time
from pathlib import Path
import numpy as np
from speaker_id.backends import DiarizationResult,Turn,get_model
from speaker_id.workbench import worker,service
root=Path(sys.argv[1])
worker.runtime_health=lambda:{'ffmpeg':True,'audio':True,'ecapa':True,'token':True}
service.resolve_token=lambda _:None
def convert(source,target,**kwargs):
 shutil.copyfile(source,target)
 return target
service.convert_to_wav=convert
class Backend:
 model_id=get_model('community-1').model_id
 def diarize(self,*args,**kwargs):
  while (root/'block').exists():time.sleep(.05)
  return DiarizationResult((Turn(0,1,'A'),),{'A':np.array([1.,0.])})
worker.serve(root,threading.Event(),backend_loader=lambda *args,**kwargs:Backend())
'''


def wait_until(predicate, seconds=10):
    deadline = time.monotonic()+seconds
    while time.monotonic()<deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    pytest.fail('Service condition did not become ready')


def test_separate_worker_executes_durable_queue_and_recovers_after_crash(tmp_path):
    app = Workbench(tmp_path, execution_mode='external')
    source = app.store.path('uploads/synthetic.wav')
    source.parent.mkdir()
    with wave.open(str(source),'wb') as audio:
        audio.setparams((1,2,16000,0,'NONE','not compressed'))
        audio.writeframes(bytes(32000))
    media = app.store.save('media', {'id':'audio','name':'Synthetic.wav','role':'meeting',
        'path':'uploads/synthetic.wav','duration':1,'annotations':[]})
    children=[]
    def launch():
        env=dict(os.environ)
        env.pop('HF_TOKEN',None)
        process=subprocess.Popen([sys.executable,'-c',WORKER_PROGRAM,str(tmp_path)],env=env,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        children.append(process)
        return process
    try:
        (tmp_path/'block').touch()
        first=launch()
        wait_until(lambda:app.worker_status().get('ready'))
        active=app.submit({'kind':'identify','media_id':media['id'],'model':'community-1'})
        wait_until(lambda:app.store.get('job',active['id'])['status']=='running')
        queued=app.submit({'kind':'identify','media_id':media['id'],'model':'community-1'})
        # API still responds and may restart while inference is blocked in another process.
        assert app.state()['jobs'] and app.media_path('audio').exists()
        restarted=Workbench(tmp_path,execution_mode='external')
        assert restarted.store.get('job',active['id'])['status']=='running'
        restarted.close()
        first.kill()
        first.wait(timeout=3)
        (tmp_path/'block').unlink()
        second=launch()
        wait_until(lambda:app.store.get('job',queued['id'])['status']=='completed')
        assert second.poll() is None
        assert app.store.get('job',active['id'])['status']=='interrupted'
        report=app.report(queued['id'])
        assert report['segments'][0]['speaker']=='Person 1'
        assert report['job_id']==queued['id']
    finally:
        for process in children:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=3)
        app.close()
