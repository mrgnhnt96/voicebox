# Transcription correction dataset

In Captures, select Raw or Refined, then **Report incorrect output**. Edit the
expected output and optionally describe the error. An empty expected output is
valid for hallucinated speech or other output that should have been omitted.
Reports are stored on the connected Voicebox server. This does not train a model
or transmit examples to an external service.

Each report stores the capture ID, target stage, expected output, notes, timestamp,
and an immutable snapshot of the raw/refined output, model sizes, language,
refinement flags, duration, and audio path. Reporting leaves the capture's output
unchanged. Reprocessing a capture does not overwrite existing reports. A stale
snapshot is rejected so the user cannot accidentally report a different result.
Deleting a capture deletes its audio and reports.

**Export all corrections (JSON)** exports a versioned JSON document with every
report. Audio is referenced by the snapshot's storage path; it is not embedded in
the export. Retain the corresponding audio files when preparing a speech dataset.
Audio is also available at `GET /captures/{capture_id}/audio` while the capture
exists.

API:

- `POST /captures/{capture_id}/feedback`: submit `target` (`raw` or `refined`),
  `expected_text`, optional `notes`, and the observed capture as `snapshot`.
- `GET /captures/{capture_id}/feedback`: saved corrections for one capture.
- `GET /capture/feedback/export`: all saved corrections as a JSON array.

## Using the dataset

Review corrections before using them. Raw corrections pair audio with the expected
transcription. Refined corrections pair the original raw transcript and refinement
settings with the expected final text. Keep these two tasks separate when measuring
quality. Reports are append-only; resolve conflicting reports for the same capture
when curating the dataset.

Build a fixed evaluation set of reviewed examples before changing models or
prompts. Keep captures used for evaluation out of training data, compare candidate
outputs against those same examples, and inspect regressions alongside aggregate
scores. Automatic training, dataset curation, and evaluation execution are future
work; this feature supplies the correction records they need.
