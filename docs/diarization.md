# Diarization stages, progress and future streaming

The goal remains a file describing **who spoke when**, including overlapping turns.
The current system does not transcribe words. Profiles can supply identities, but
anonymous diarization does not require enrollment or training for each speaker.

## Current batch pipeline

| Stage | What happens | What progress can show |
| --- | --- | --- |
| Model | Load the selected pretrained diarization/embedding recipe | Indeterminate while weights load/download |
| Audio | Extract the selected section into mono 16 kHz WAV | Stage and elapsed time; no fabricated percentage |
| Speech | Detect speech, speaker changes and simultaneous activity | Native segmentation chunk counts where emitted |
| Voice features | Compute embeddings representing voices | Native embedding batch counts where emitted |
| Group voices | Cluster related voices and assemble speaker turns, retaining overlap | Stage transitions; clustering does not necessarily report a useful total |
| Assign labels | Assign Person 1/2 labels or compare compatible saved profiles; reject uncertain identities as UNKNOWN | Phase and clean-identity voice counts where emitted |
| Save | Add provenance and write JSON/CSV with original recording timestamps | Saving and clear completion/failure |

These are user-facing groups of actual backend phases, not seven equally expensive
steps. Some work is integrated inside the pretrained pipeline rather than a separate
service per stage. The ECAPA configuration extracts clean identity features after
diarization; those operations appear under Assign labels. Enrollment instead shows
model preparation, included reference-clip processing and collection saving.

The current Community-1 adapter calls the pretrained pipeline on a prepared audio
input and consumes its completed output. See the [official model card](https://huggingface.co/pyannote/speaker-diarization-community-1)
for its usage and pretrained-model context. Saving reusable profiles computes
labeled voice representations; it does not update model weights.

## Understanding the tracker

The tracker above playback shows current status, phase, elapsed time and a stage
bar. A value such as **18 / 40 batches · 45% of this stage** is measured progress
inside that operation; it is not 45% of the whole job. Other stages use an
indeterminate meter. No overall completion time is estimated.

Expand **What is happening internally?** for explanations and persisted event
history. Worker heartbeat and model/stage progress timestamps are separate: a live
worker can still be spending time in an operation with no count callback. An
unavailable worker is called out rather than animating progress indefinitely.
Completed, failed and interrupted runs retain their terminal meaning.

When another job is running, any displayed earlier timeline is explicitly labeled
as an earlier saved result. Stage callbacks do not provide provisional speaker
turns. Final files are still produced after successful completion.

## Sidebar filtering

Detected turns shorter than one second are hidden in the right-hand review log by
default, with an explicit hidden count. A checkbox reveals them. Exactly one-second
turns remain visible. This does not remove short contributions from the underlying
timeline, exports, overlap, identity matching or saved report, and does not change
manual reference labeling. A display filter is not a diarization accuracy fix.

## Progressive analysis is a future feature

Three separate capabilities should not be confused:

1. **Media playback:** seek and play the original file while analysis runs. This
   already works through byte-range streaming.
2. **Progressive file analysis:** process overlapping chunks of an uploaded video
   and expose provisional speaker results before the entire file is complete.
3. **Live diarization:** accept new microphone audio continuously with a bounded
   delay and an online stateful inference strategy.

The proposed first addition is progressive file analysis. It requires overlapping
chunks, original timestamps, stable identities across chunks, unknown/new-speaker
handling, partial-result checkpoints and resumable UI events. Speaker assignments
near boundaries may be revised; the UI must identify provisional versus reconciled
results. A final reconciliation pass writes the authoritative timestamp files.

Simply running the existing batch pipeline independently on each chunk is not
sufficient: Person 1 can mean a different voice in the next chunk, and overlap can
be lost at boundaries. True live processing may justify a different streaming-capable
backend, evaluated against the offline baseline.

Measure first-result latency, memory, real-time factor and final diarization/named
identity/overlap errors. A real-time factor below one means average processing is
faster than the audio duration on the measured hardware; it does not guarantee
bounded per-chunk latency. Playback remains independent of inference speed.

## Fullscreen behavior

The player requests fullscreen for its shell so transport and speaker overlays
remain available, with standard and WebKit compatibility paths. Native-video
fullscreen is a fallback and may use browser controls without HTML overlays.
Fullscreen requires an actual browser/user gesture and can be refused; the UI
reports refusal rather than claiming success. See the [Fullscreen API reference](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API).
