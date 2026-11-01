# Architecture and delivery plan

## Product contract

An offline recording and a roster of enrolled voices produce a named timeline.
Multiple speakers can occupy the same time interval. Unsupported or uncertain
identities remain UNKNOWN. Transcription and Gemini integration are downstream.
A run selects one model configuration before processing and keeps it for the run.

## Boundaries

1. CLI selects a registry entry and checks voiceprint compatibility before loading models.
2. FFmpeg converts media to mono 16 kHz WAV.
3. A Backend implements enrollment embedding extraction and diarization, returning
   model-independent Turn and DiarizationResult values.
4. Shared matching applies acceptance thresholds and margins to cluster embeddings.
5. Reporting exports JSON and CSV with overlapping turns and run metadata.

Backend adapters own framework-specific output formats. Application code does not
read pyannote annotations or SpeechBrain tensors. The clip labeler remains a
separate local data-preparation tool.

## Model configurations

- community-1: native pyannote diarization and cluster embeddings.
- community-1-ecapa: identical diarization model, with SpeechBrain ECAPA identity
  embeddings. Non-overlapping intervals of at least one second are embedded in
  chunks of at most ten seconds, using up to sixty seconds per cluster. Clusters
  without eligible clean speech remain UNKNOWN. Overlap remains in the output.

These configurations compare identity embedding strategies; they are not two
independent diarization models. The ECAPA recipe is versioned in its model identity.
Future adapters can introduce other diarizers or fine-tuned checkpoints through
the same contract. No training implementation is present yet.

Every configuration has a distinct compatibility identity stored in its profile
bundle. Matching dimensions alone is insufficient: profiles from different
embedding spaces must never be compared. Existing native Community-1 profiles
remain compatible. A roster change currently requires rebuilding its bundle.

## Experiment traceability

CLI JSON reports contain a run UUID, UTC start, processing time (conversion plus
inference and matching, excluding model loading), configuration, device, package
versions, source/profile SHA-256 digests, speaker bounds, thresholds and margins.
Cosine similarity is not a calibrated confidence probability.

This is preliminary traceability, not exact reproducibility: upstream weight
revisions and dependency versions are not yet locked. Checkpoint digests, pinned
environments, enrollment manifests and training-data versions are required before
publishing benchmark claims. Avoid selecting thresholds on the test set.

## Delivery milestones

The ordered next-step plan and acceptance criteria are in [roadmap.md](roadmap.md).
UX progress visibility and readability are implemented in milestone 1; primary-workflow usability is next.


- [x] Backend contract, registry and two selectable adapter configurations.
- [x] Profile compatibility enforcement, atomic profile writes and input validation.
- [x] Overlap-preserving reports and initial run provenance.
- [x] Offline unit tests and CI definition for Python 3.11–3.13.
- [x] Install Community-1 dependencies; smoke-test cached weights and waveform decoding locally.
- [ ] Verify ECAPA with actual weights and evaluate real meeting audio.
- [ ] Establish a dataset manifest with enrollment, development and untouched test
      sessions; include unknown speakers and genuine overlaps. Check audio and label quality.
- [ ] Build benchmark runner: named attribution error, diarization error, unknown
      false acceptance/rejection, overlap precision/recall, processing speed and memory.
- [ ] Add a third backend with a different diarization model; compare on fixed splits.
- [ ] Tune matching on development data; publish held-out results and error analysis.
- [ ] Train/fine-tune selected components only after identifying the dominant errors.
      Track checkpoints, data, configurations and ablations. Re-enroll after embedding changes.
- [ ] Add authenticated application API, job queue, cancellation, resource limits,
      structured logs, deletion/retention controls and integration tests.
- [x] Local UI model selection, enrollment labeling, saved collections and timeline review.
- [x] Local HTTP API, serialized background jobs and restart-state recovery.
- [ ] Integrate Gemini and spoken-word transcription.
- [ ] Package deployment, run load/recovery checks and document operating procedures.

## Current verification boundary

See [workbench architecture](workbench.md) for the implemented local application.
Core and job tests use synthetic embeddings and framework stubs. They verify contracts,
matching, overlap preservation and isolation, not real-model accuracy or framework
compatibility. A local cached Community-1 smoke check executes inference on a
synthetic tone and verifies progress hooks; it does not measure speaker accuracy.
CI currently tests the lightweight core only. ECAPA integration, model revision
pinning and real-audio evaluation remain open.
This foundation is not a production deployment.
