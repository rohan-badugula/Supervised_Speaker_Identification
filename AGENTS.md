# Project working conventions

- Keep the workbench local unless the owner explicitly requests deployment.
- Make meaningful local commits as work progresses. Use short imperative titles,
  following the existing history (for example, "Redesign workbench around...").
  Stage explicit paths, keep unrelated user changes out, and do not push without
  an explicit request.
- Record significant architecture, model and interface decisions in
  `docs/LEARNING_GUIDE.local.md` when that personal file exists. Explain the
  alternatives, tradeoffs and verification. Keep that file Git-ignored.
- Never commit recordings, annotations, voiceprints, reports, runtime databases
  or tokens. Keep runtime data in the ignored directories.
- Keep model inference, enrollment and identity matching behind the existing
  backend contract. UI work should not fork the pipeline.
- Validate relevant behavior and report verification limits. Synthetic model
  stubs and UI fixtures do not establish real-model accuracy.
