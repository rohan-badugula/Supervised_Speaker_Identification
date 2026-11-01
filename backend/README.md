# Speaker identification backend

`src/speaker_id/` contains the model adapters, shared inference/matching pipeline,
profiles, reports and local application services. The API does not serve UI assets
and defaults to enqueueing work for a separate inference process.

From the repository root, install standalone with:

```bash
python -m pip install -e './backend[audio,dev]'
```

Run the API with `voice-api --data-dir /absolute/private/workspace`; run the worker
in another terminal with `voice-worker --data-dir /absolute/private/workspace`.
Configure `HF_TOKEN` in the worker terminal. Both services share the same local
SQLite catalog and private files. The API defaults to localhost port 8767; the
worker has no network listener and holds an exclusive workspace lease.

See [service architecture](../docs/services.md) for independent startup, recovery,
constraints and the one-command development launcher.
