# Vocabulary correction layer

The broader training/evaluation/deployment loop is implemented in
[MODEL_IMPROVEMENT.md](MODEL_IMPROVEMENT.md). This document describes only its
lightweight vocabulary-rule component.

The server runs a local CPU-only job one minute after startup, then every six
hours while running. Captures → Learning from corrections exposes status,
Check now, and Undo last update. No cloud uploads or model fine-tuning occur.

## Activation contract

- Read at most 500 recent reports; use the newest report per capture/target.
  Evaluation is bounded to reports of at most 1,000 characters.
- Deduplicate identical source utterances. The chronological first two thirds
  propose candidates; the last third is held out from candidate generation.
- Learn only one short, spelling-similar vocabulary replacement per report,
  anchored by an unchanged word on each side. Numeric edits, insertions,
  deletions, broad rewrites and edits across punctuation do not qualify.
- Require two distinct training recordings supporting the same contextual rule
  and an improvement on a distinct held-out recording. Match case and language.
- Reject any candidate that increases token edit distance on any saved example,
  changes any user-corrected expected text, or changes the independent unchanged
  examples in `correction_rules.KNOWN_GOOD`.
- Cap the active set at 32 rules. Benchmark the rule layer on 4,000 characters
  for 25 runs; median processing time must be at most 5 ms. This measures rule
  overhead, not full STT/LLM latency or model accuracy.
- Publish the rules and evaluation metrics atomically, retaining ten previous
  versions. A new contradictory report withdraws the affected rule on the next
  run. Manual rollback blocks withdrawn additions from automatic reactivation.

## Live dictation

Approved rules run after refinement, from an immutable in-memory snapshot.
There is no per-dictation report lookup, file read, additional model prompt, or
model invocation. Raw STT remains intact. Refinement must be enabled for these
corrections to take effect. Inputs over 4,000 characters and inputs with more
than 128 matching spans skip the rule layer. Overlapping matches are skipped.

This is conservative personal vocabulary adaptation, not autonomous model
training. The checks validate the deterministic correction layer on recorded
text; they do not establish general model quality or rerun recorded audio.
The model-improvement worker additionally trains refinement adapters and compares
actual outputs on independent recordings, as documented in MODEL_IMPROVEMENT.md.

## Persistence and controls

`correction-learning.json` in the server's data directory contains the active
revision, previous versions, blocked rule IDs, data fingerprint and last metrics.
Deleting a capture removes its reports, but does not erase already learned rules.
Identical report data is not reevaluated each interval. Restart loads the last
published rules. Failure to load starts with no rules; job failures retain the
previous active state and log the failure.

- `GET /capture/learning`: status and last evaluation metrics
- `POST /capture/learning/run`: run the job in a worker thread
- `POST /capture/learning/rollback`: restore the prior safe version

Validation: `backend/venv/bin/python -m pytest backend/tests/test_correction_learning.py
backend/tests/test_capture_feedback.py` (run as one command).
