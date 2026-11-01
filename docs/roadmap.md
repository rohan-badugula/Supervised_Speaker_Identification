# Delivery roadmap: reliable speaker analysis, measurable results

This is the ordered plan for the project. Complete and verify one milestone before
starting the next; record meaningful changes in local commits. A polished screen
alone does not establish usability, model accuracy or production readiness.

## What kind of system is this?

| Workflow | What happens | Correct description |
| --- | --- | --- |
| Anonymous mode | A pretrained pipeline finds activity and clusters voices without our person labels | Unsupervised clustering/diarization at inference, powered by pretrained models |
| Saved-profile mode | The pipeline matches voices against labeled enrollment examples | Enrollment-based/open-set speaker identification; currently no weight updates |
| Training experiments (future) | Labeled data updates selected model parameters | Supervised fine-tuning where applicable, evaluated against frozen baselines |

The pretrained segmentation and embedding networks were learned using labeled
training data. Therefore the whole system should not be advertised as trained
without supervision. Our application currently performs inference and enrollment,
not model training. New speakers do not require retraining the network.

A precise project description is: **an offline speaker-diarization and
enrollment-based identification workbench for shared-microphone meetings**.

## Milestone 1 — Make processing understandable (implemented)

Problem: users cannot tell whether a job is queued, preparing, progressing,
failed or complete, and useful text is too small. Important state disappears
inside run configuration or on narrow layouts.

Scope:

- [x] Persistent job status outside the configuration dialog, visible while playing media.
- [x] Separate queue, model preparation, extraction, inference, matching and saving stages.
- [x] Show actual model chunk/batch counts and stage percentage when provided.
- [x] Explicit indeterminate states when no meaningful total is available; no fake overall percentage or ETA.
- [x] Elapsed time, last reported progress and clear terminal outcome.
- [x] Bounded stage-event history for troubleshooting, surviving page refresh.
- [x] Larger readable text and controls, stronger contrast and visible status on narrow screens.
- [x] Tests for progress persistence, hook forwarding, failures and frontend rendering.

Exit: after starting a five-minute run, the user can see what it is doing without
opening a modal, and can distinguish a model that is processing from a failed job.
Model preparation may include downloads, so its duration remains unknown unless
we add a real download counter later. Silence in progress events is not by itself
proof that a process is hung.

## Milestone 2 — Make the primary workflow intuitive (implemented; user/device review pending)

Scope:

- [ ] Review upload → choose mode/range → run → review with a first-time user.
- [x] Name anonymous analysis and enrolled identification explicitly; explain the difference in the UI.
- [x] Surface local readiness before a run; explain that gated access is checked during model loading.
- [x] Make starting an analysis a discoverable action; keep expert settings secondary.
- [x] Show selected recording, range, model and voice collection together before submission.
- [x] Preserve choices, provide actionable retry and make partial-run results unmistakable.
- [x] Inspect desktop controls, microcopy, keyboard submission and increased-zoom behavior.
- [ ] Complete mobile/cross-browser and screen-reader checks; resolve native Safari upload-picker verification.

Exit: a new user can start an anonymous preview and find the saved results without
instructions from the developer. Record observed usability problems rather than
assuming the revised wireframe solves them.

## Visual exploration — Closed; retain the current UI

- [x] Explore three visual directions using the existing product as context.
- [x] Record the owner's decision: keep the current interface; none of the concepts will be implemented.

The additional redesign is cancelled. Preserve the implemented progress, readiness,
mode selection, preview and retry improvements. Resume the ordered functional
roadmap below. First-user, browser-upload and accessibility verification gaps from
milestone 2 remain open; closing this exploration does not mark those checks done.

## Milestone 3 — Make review and correction useful

- [ ] Keep active turns and playhead synchronized without losing editing focus.
- [ ] Provide clear overlap and UNKNOWN review filters, segment navigation and accessible shortcuts.
- [ ] Support consistent per-person renaming where intended, with a distinction from per-segment edits.
- [ ] Undo/review history and exports that preserve both original and reviewed labels.
- [ ] Manage saved profiles, source clips and local retention/deletion without accidental loss.

Exit: a user can review a short recording, correct identities and export the result
with an understandable audit trail. Edits must not silently retrain a model.

## Milestone 4 — Build a trustworthy evaluation dataset

- [ ] Consent and a documented local data lifecycle; no internal recordings in Git.
- [ ] Versioned manifests with hashes, microphone/session conditions and label schema.
- [ ] Separate enrollment, training, development and untouched test sessions.
- [ ] Labels for activity, overlap, silence and genuinely unknown speakers.
- [ ] Label-quality checks and a small manually audited reference set.
- [ ] A public or synthetic fixture for contributors and CI that contains no company material.

Exit: the same held-out dataset can be rerun by manifest, and leakage/label-quality
limitations are documented. Internal test audio can stay private; reproducibility
can expose manifests, tooling and aggregate evidence without publishing voices.

## Milestone 5 — Benchmark before choosing or training models

- [ ] Implement anonymous diarization metrics with explicit collar/overlap rules.
- [ ] Score named identity attribution separately from optimally remapped anonymous clusters.
- [ ] Measure unknown false acceptance/rejection and overlap detection/identity quality.
- [ ] Measure warm/cold runtime, real-time factor and peak memory on stated hardware.
- [ ] Compare current embedding recipes; add a genuinely different diarization backend.
- [ ] Tune thresholds only on development data, then freeze the configuration for test evaluation.
- [ ] Publish an error taxonomy, model comparison and reproducible experiment commands.

Exit: a source-backed benchmark report shows strengths, failures and uncertainty.
Set numerical acceptance targets after establishing a baseline; do not invent an
accuracy number for the résumé. Generic DER alone does not verify named identity.

## Milestone 6 — Targeted learning experiments

- [ ] Choose the component to improve based on measured error: segmentation,
      clustering, embedding, score calibration or overlap handling.
- [ ] Compare reference duration (for example, 15s/30s/1min/3min/5min) and recording-condition mismatch.
- [ ] Add training/configuration entry points, seeds and training-data/checkpoint versions.
- [ ] Compare pretrained enrollment, calibrated matching and targeted fine-tuning.
- [ ] Re-enroll after changing the embedding space; preserve old artifacts for reproducible comparisons.
- [ ] Run ablations and an untouched test evaluation; report regressions as well as gains.

Exit: evidence shows whether training improved the intended problem. Training
every component is not a requirement for a strong engineering project.

## Milestone 7 — Harden the application and development workflow

- [ ] Lock tested dependencies and exact model/checkpoint revisions.
- [ ] Version and validate API/report schemas; separate client errors from system failures.
- [ ] Worker process isolation, safe cancellation, queue recovery and resource limits.
- [ ] Secure credential persistence (Keychain for this Mac), redacted diagnostics and retention controls.
- [ ] Tests using real small audio fixtures and optional cached-model integration checks.
- [ ] Browser interaction/accessibility tests, CI regression gates and package-install tests.
- [ ] Structured stage timings, error categories and operational health checks.

Exit: installation, restart, failure and recovery behavior are documented and tested.
For an actual shared service, add authentication, authorization and stronger storage
boundaries before deployment. Do not expose the local HTTP server unchanged.

## Milestone 8 — Deliver and demonstrate the complete system

- [ ] Package a supported local distribution and/or a reviewed deployment target.
- [ ] Add Gemini/transcription as an explicit downstream integration with provenance and ambiguity handling.
- [ ] Run load/resource/recovery checks and document operating procedures.
- [ ] Create a clean public demo using publishable audio, architecture diagrams and a concise walkthrough.
- [ ] Publish measured results, limitations, model cards/attribution and a reproducible development guide.
- [ ] Write résumé bullets from demonstrated behavior and measured improvements.

A résumé-grade story should connect a real problem, architecture decisions,
measured baseline, tested improvements, usable application and operating evidence.
Production readiness is tied to a stated deployment and reliability target, not
just a feature count or number of models.

## Progress log

- Plan established: anonymous/enrolled terminology clarified; UX observability
  and readability prioritized before more model features.

- 2026-11-01: Milestone 1 implemented and checked with persisted progress tests,
  UI rendering tests, a real cached Community-1 hook smoke run and a synthetic
  browser preview. Model counters, elapsed time, heartbeat and terminal outcomes
  are visible outside configuration; text sizes increased. Real-meeting usability
  review and the broader workflow audit remain in milestone 2.

- 2026-11-01: Milestone 2 implementation added explicit modes, first-five-minute
  defaults, visible setup blockers, run summary, sticky submission, tab-local drafts
  and faithful retry. Latest run state is separated from the displayed report;
  corrections use that report ID. Verified 75 Python and 19 frontend tests plus
  synthetic browser submission, completion, failure and retry. First-time user
  and full device/accessibility validation remain open.

- 2026-11-01: Added the requested final visual-design pass before returning focus
  to evaluation and the core speaker-analysis pipeline. Explore three directions
  first; keep progress, readiness and usability fixes intact.

- 2026-11-01: Owner preferred the current UI over all three concepts. Closed
  visual exploration and cancelled the proposed redesign; resume functional work.
