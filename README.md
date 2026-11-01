# Supervised Speaker Identification

## Why I started this

I work at a startup where our weekly hybrid meetings are recorded through Google
Meet on a shared conference-room device. Remote teammates join individually,
while everyone in the room speaks into a central microphone on the table. In
our setup, different people's contributions in the room were attributed to the
same meeting participant, making it difficult to recover who said what.

I started this project to add that missing context: a named timeline of who spoke
when, including periods where multiple people speak simultaneously. Version one
does not transcribe speech. Its intended output is a timestamp file that can be
provided alongside the original recording to Gemini for downstream transcription
and summarization. That handoff is planned, not implemented. Speaker timestamps
alone do not recover each person's words during overlapping speech.

## Local media workbench

The local web UI includes a meeting library, reference-voice labeling, saved
profile collections, background processing and an interactive speaker timeline.
It plays the original MP3/MP4 while the models process extracted mono 16 kHz WAV;
there is no intermediate MP3 compression step.

From this project folder, start the UI with the existing virtual environment:

```bash
.venv/bin/python tools/run_workbench.py
```

Open **http://127.0.0.1:8766**. After installing the package, `voice-workbench`
starts the same app. This launches the frontend, API and inference worker in separate processes.
Stop all three with Ctrl+C. `--port`, `--api-port` and `--data-dir` are available.
Running the same command again automatically replaces an existing workbench on
that port (macOS/Linux, using `lsof`). It checks the listener's process entry point
before sending termination signals; unrelated applications are left running.
Use `--no-restart` to disable replacement or `--port 8767` to use another port.
Restarting stops active work. Running jobs become interrupted when the worker
restarts; queued jobs persist and are picked up in order. An interrupted analysis
is never silently retried.

1. Open **Reference room** and upload a separate reference MP3/MP4.
2. Mark clean in/out points with the buttons or I/O shortcuts, assign dummy labels
   such as Person 1 and Person 2, and **Save labels**. Quality flags and inclusion
   checkboxes keep questionable clips out of enrollment.
3. Open **Configure run**, choose a model and collection name, then **Build profiles**. The resulting
   voiceprints and source-label metadata are retained locally across sessions.
4. Open **Sessions**, import the target recording, open **Configure run**, select
   that model and collection, and **Analyze speakers**. Alternatively, choose anonymous mode without profiles;
   anonymous Person 1/2 labels only have meaning within that recording.
5. Click speaker tracks or timestamps in the review log to seek. Overlapping speakers have
   separate tracks and appear together over playback. Zoom, filter, correct labels,
   and export JSON/CSV. Corrections preserve the original model report separately.

The session editor keeps the playback canvas and speaker tracks together on the
left, with an editable speaker log on the right. A dedicated transport provides
play/pause, ten-second jumps, scrubbing, speed and video fullscreen. Run settings
open in a separate dialog. The archive, reference room, voice bank and run history
are available from the top navigation; smaller screens stack the editor panels.

For a quick test of a long meeting, open **Configure run → Analysis range**.
Choose Full recording, the first 5/10/15/30 minutes, the first hour, or a custom
section with a start and length in minutes. **Start a 10-minute preview here**
uses the current playback position. Full recording remains the default.

Only the selected section is extracted and sent to the model. The original video
is unchanged, and output timestamps are offset back to the original recording.
For example, a five-minute section starting at minute 20 produces timestamps from
20:00 to 25:00. Reports explicitly mark partial runs and record the actual decoded
range; the rest of the video is unprocessed, not classified as silence. Bounds
longer than the remaining recording stop at the end of the source. Start at zero
with Full recording for an unlimited run; a zero-length section is rejected.
Anonymous Person 1/2 labels can change between preview sections or runs; use saved
voice profiles when comparing identities across them.

Upload progress reports transferred bytes. Background jobs show processing stages,
not an estimated inference percentage. One CPU worker processes jobs in order,
with at most four active/queued jobs. The API queues jobs durably; a separate
worker claims them. Interrupted jobs are marked after worker restart;
retry by starting a new run. Running inference cannot currently be cancelled.

Uploads, playback and labeling need only the lightweight core. Processing requires
the appropriate audio extras and `HF_TOKEN` model access as described
below. The audio extra includes a packaged FFmpeg binary used when system FFmpeg
is unavailable. **Local setup** in the UI shows what is missing. Common MP3 and MP4/H.264
files are recommended for playback; other browser codecs vary. Unsupported media
may still be processable by FFmpeg even when the browser cannot play it.

All runtime records are stored under the Git-ignored `data/workbench/` directory:

```text
data/workbench/
├── catalog.sqlite3                 # media catalog and job states
├── media/                          # original uploads, stored under generated IDs
├── annotations/<media-id>.json      # saved reference labels
├── profiles/<collection-id>/
│   ├── voiceprints.npz              # reusable numerical embeddings
│   └── metadata.json               # labels, durations, source and model identity
└── reports/                        # timelines, CSV, preserved original predictions
```

The optional SpeechBrain model cache is under ignored `artifacts/model-cache/`;
other model caches use framework defaults. Keep custom `--data-dir` locations out
of Git too. Gitignore does not encrypt these files or remove already tracked data.
The server binds to localhost and rejects foreign origins; it is a single-user
local application, not an authenticated public deployment. Nothing is published.

See [local workbench architecture](docs/workbench.md) for the API and verification
boundary. The older standalone labeling tool remains in `tools/clip_labeler/` for
R&D; the workbench is the integrated workflow.

## Learning mode and delivery plan

Anonymous analysis performs diarization/clustering without our identity labels at
inference time, using pretrained networks. Saved-profile mode adds labeled voice
enrollment for identity matching; it does not currently train model weights.
The end-to-end system is therefore not wholly unsupervised training.

The [ordered roadmap](docs/roadmap.md) prioritizes UX visibility and readability,
then workflow/review usability, trustworthy evaluation data, benchmarks, targeted
training experiments, reliability and delivery. We work through these one milestone
at a time; current accuracy claims require measured evidence.

## Approach and model selection

The initial backend is
[`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1).
It provides local diarization; this project adds named enrollment profiles and
cosine-similarity matching of speaker embeddings. Enrollment uses a pretrained
model without changing its weights. Adding or changing speakers means rebuilding
the profile bundle from the desired roster's clips, rather than retraining the
model. The enrollment and meeting embeddings must use the same model.

We preserve the regular diarization timeline, rather than the exclusive timeline,
so detected overlapping speaker turns remain in exported results. This preserves
model predictions; accurate recognition during crosstalk still needs evaluation.
Speaking-time totals count overlap for each speaker and can exceed elapsed time.
Similarity scores and match margins are not calibrated probabilities.

Two model configurations can be selected before each run:

| CLI model | Diarization | Identity embeddings |
| --- | --- | --- |
| `community-1` (default) | Community-1 | Native pyannote embeddings |
| `community-1-ecapa` | Community-1 | SpeechBrain ECAPA-TDNN from non-overlapping regions |

Both adapters are implemented. Community-1 has passed a real-model inference
smoke check on synthetic audio; ECAPA with actual weights and conference-room
accuracy remain unverified. ECAPA is an optional dependency. These configurations share the same
diarizer and compare different identity embedding strategies. A different diarizer
can be added behind the same backend interface.

```bash
voice-id models
voice-id enroll data/enrollment --model community-1 --profiles artifacts/community-1.npz
voice-id identify data/input/conference.mp3 --model community-1 \
  --profiles artifacts/community-1.npz --output results/community-1.json

# Install ECAPA dependencies first, then enroll a separate profile bundle.
voice-id enroll data/enrollment --model community-1-ecapa --profiles artifacts/ecapa.npz
voice-id identify data/input/conference.mp3 --model community-1-ecapa \
  --profiles artifacts/ecapa.npz --output results/ecapa.json
```

Model selection stays fixed for a run. If `identify --model` is omitted, the model
is selected from the profile bundle. Incompatible profiles are rejected before
weights are loaded. Separate bundles are required for each model configuration.
The existing 0.55 similarity and 0.08 margin defaults are uncalibrated and must be
validated separately for each configuration. Clusters with no eligible clean
speech in the ECAPA configuration remain UNKNOWN.

CLI JSON reports include run identifiers, source/profile hashes, model settings,
package versions and processing time. See [architecture and delivery plan](docs/architecture.md)
for boundaries, verification status, benchmarking and training milestones.

## Current workflow

Phase one is a local pipeline for answering **who spoke when** in a recorded conference-room session. It combines speaker diarization with supervised enrollment voiceprints:

1. Label clean reference regions for every known speaker.
2. Export those regions into named enrollment folders.
3. Build one voice profile per speaker from multiple clips.
4. Diarize the long target recording.
5. Match each detected speaker cluster to the enrolled profiles.
6. Preserve uncertain matches as `UNKNOWN`.

The CLI and local web workbench use the same backend and matching modules. Accuracy still needs measurement on real conference-room recordings.

## How much enrollment audio?

For a fixed conference room, microphone, and seating arrangement:

- **Minimum trial:** 10–15 seconds of clean speech per person.
- **Practical target:** 30–60 seconds per person.
- **Collection format:** 3–6 clips of roughly 5–15 seconds rather than one long clip.

If 3–5 minutes per speaker are available, use them as an enrollment and evaluation
pool. Split speech into clean clips, preferably including the meeting microphone
and room conditions. Hold out an entire recording/session when possible to check
generalization; adjacent clips from one recording are a weaker test. These durations
are collection guidance, not a measured accuracy guarantee for this project.

Use ordinary speech with different sentences. Exclude overlapping speakers, music, heavy noise, and clips where someone else is audible. Keep a small clean clip out of enrollment so we can tune the acceptance threshold against data the profile did not see.

Voiceprints are biometric data. Use recordings with participant consent and keep `data/` and `artifacts/` private; they are ignored by Git by default.

## 1. Label the long MP3

The separate tool lives in [`tools/clip_labeler`](tools/clip_labeler). It streams the original recording without decoding the whole file into browser memory.

```bash
python3 tools/clip_labeler/server.py /absolute/path/to/conference-recording.mp3
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765).

Workflow:

- Play/pause with `Space`.
- Press `I` to mark the start of a clean speaker region.
- Press `O` to mark its end.
- Enter the speaker name or stable seat label.
- Flag overlap, noise, or uncertainty instead of using questionable audio.
- Save labels, then export clean clips.

Labels are stored in `data/annotations/`. Clean approved WAV files are exported into:

```text
data/enrollment/
├── Alice/
│   ├── conference_0001_000012.400.wav
│   └── conference_0005_000143.100.wav
└── Seat_03/
    └── conference_0002_000028.900.wav
```

The standalone R&D labeler works with only Python; its clip export requires system
FFmpeg. The integrated workbench can also use the FFmpeg binary bundled with the
audio extra. To install system FFmpeg where supported:

```bash
brew install ffmpeg
```

## 2. Install the identification pipeline

Python 3.11 or 3.12 is recommended for the smoothest PyTorch installation.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[audio,dev]'
# For the optional ECAPA configuration:
python -m pip install -e '.[ecapa,dev]'
```

The pipeline uses the open-source `pyannote/speaker-diarization-community-1` model. For the initial download:

1. Create a Hugging Face account.
2. Accept the model conditions at <https://huggingface.co/pyannote/speaker-diarization-community-1>.
3. Create a read token and expose it without writing it into project files:

```bash
export HF_TOKEN='your-token'
```

## 3. Build supervised profiles

```bash
voice-id enroll data/enrollment --profiles artifacts/voiceprints.npz
```

The profile file contains biometric voice embeddings. Do not commit or casually share it.

## 4. Identify speakers in a recording

```bash
voice-id identify data/input/conference.mp3 \
  --profiles artifacts/voiceprints.npz \
  --output results/conference.json
```

Optional bounds improve diarization when the room roster is known:

```bash
voice-id identify data/input/conference.mp3 \
  --profiles artifacts/voiceprints.npz \
  --min-speakers 2 \
  --max-speakers 6
```

The command produces JSON and CSV timelines with start time, end time, detected cluster, assigned name, similarity, and match margin. Defaults are intentionally conservative:

- cosine similarity threshold: `0.55`
- best-vs-second-best margin: `0.08`
- uncertain result: `UNKNOWN`

These are starting values, not universal truths. We will tune them using held-out clips from your actual conference room.

## After changing Python code

Refreshing the browser only updates the UI; the Python worker must be restarted
to load backend fixes. The workbench now detects source changes, displays a
restart-required banner and blocks new jobs on an outdated worker. Restart from
the terminal where HF_TOKEN is set, then refresh. Server startup prints a source
revision for diagnostics. Static-only UI edits do not require a worker restart.

## If Analyze appears not to start

Open **Configure run** and inspect the readiness message. Missing dependencies or
Hugging Face access prevent a job from being queued. Clicking Analyze now displays
the exact error inside that dialog, with actionable setup blockers. Errors no
longer appear behind the dialog. Model download/inference failures after queueing
are retained under Runs and in the run status.

After accepting the Community-1 model conditions and creating a read token, use
this hidden prompt in zsh from the project directory, then restart the server:

```bash
read -s "HF_TOKEN?Hugging Face token: "; echo
export HF_TOKEN
.venv/bin/python tools/run_workbench.py
```

If a run fails with **Could not load libtorchcodec**, update/restart the workbench
and start a new run. The adapter now reads the converted WAV using SoundFile and
passes a channel-first waveform directly to pyannote, avoiding TorchCodec's
file-path decoder and its shared-FFmpeg requirement. Existing failed jobs remain
in history; retrying creates a new job.

Refresh the browser after restarting. Your uploaded recordings remain in the local
catalog; no re-upload is required. A configured token indicates credential presence,
not confirmed model authorization—access failures are reported by the model loader.

## Project structure and services

```text
frontend/
  speaker_frontend/static/  # Restored HTML, CSS and JavaScript
  speaker_frontend/server.py # Static server and streaming API gateway
  tests/                    # Frontend behavior tests
  pyproject.toml            # Independently packaged frontend; no ML dependencies
backend/
  src/speaker_id/            # Models, matching, reports, API and worker
  pyproject.toml            # Independently packaged backend and audio extras
tests/                     # Backend and service integration tests (root tests/)
tools/                     # One-command launcher and R&D clip labeler
data/workbench/            # Existing private local data; Git-ignored
```

The browser uses the frontend on port **8766**. Its `/api/*` requests stream to a
private localhost API port selected at startup. The API owns uploads, labels,
profiles, reports and job submission; the worker owns expensive audio/model work.
The restored interface is unchanged. Existing `data/workbench/` files need no migration.

This is a local service-oriented architecture with separate processes and a shared
SQLite catalog/filesystem. It is not a distributed microservice deployment.
[Service boundaries, independent startup and recovery](docs/services.md) explain
what is implemented and the next deployment/scaling steps. The root `pyproject.toml`
keeps `pip install -e '.[audio,dev]'` compatible for convenient local development.

## Test

```bash
python -m pytest
node --test frontend/tests/workbench_ui.test.cjs
```

Tests cover the numerical core, backend contracts, profile compatibility, real localhost HTTP uploads/ranges, label persistence, background-job workflows, corrections and restart recovery. ML calls use stubs; these tests do not establish actual model accuracy. JavaScript syntax is checked with `node --check frontend/speaker_frontend/static/app.js`.
