# Speaker Workbench frontend

The restored HTML, CSS and JavaScript live in `speaker_frontend/static/`.
`speaker_frontend/server.py` serves those assets and streams `/api/*` to the local
backend. It has no access to the media database and no dependency on the backend
Python package, ML packages or a Node runtime/build step.

From the repository root:

```bash
python -m pip install -e ./frontend
voice-frontend --port 8766 --api-url http://127.0.0.1:8767
node --test frontend/tests/workbench_ui.test.cjs
```

The frontend and API keep the browser on one origin. Uploads, byte-range media
playback, downloads and API errors are forwarded without buffering whole files.
The upstream must be a localhost HTTP origin. The backend and inference worker
must be started separately, or use the root one-command launcher.

See [service architecture](../docs/services.md) for the full operating contract.
