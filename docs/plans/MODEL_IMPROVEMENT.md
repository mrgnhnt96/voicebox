# Local model improvement loop

This extends the vocabulary rule job with real MLX LoRA gradient training of the
Qwen3 refinement model and recorded-audio comparison of installed Whisper models.
Speech recognition weights are not fine-tuned: recognition reports evaluate model
selection. Refinement weights are trained as small adapters over the selected
cached Qwen model. No reports, audio, adapters or metrics are uploaded.

## Scheduling and foreground priority

The server checks every six hours after at least two minutes without foreground
work. Check now starts a job explicitly. A separate worker process owns training
and evaluation, with a 30-minute limit and a 16 GiB MLX allocation limit. Training
waits if the system has under 8 GiB available memory. There are no background model
downloads. Currently this trainer runs on Apple Silicon Macs.

Recording starts and 30-second recording heartbeats cancel the worker. Mutating
API requests (including inference and MCP calls) also preempt it before dispatch.
The worker runs in its own process group; cancellation stops that whole group.
It watches its parent and exits if the server dies. Partial adapters never become
active. Interrupted work retries from the last approved model after another idle
period; it does not resume partial optimizer state. Manual cancellation defers the
next automatic attempt by six hours.

## Dataset contract

Read the newest report for each capture/target from at most 1,000 recent reports.
Near-identical transcripts and identical audio belong to one persistent group.
Reports from the same group cannot count as distinct examples or cross splits.
Group assignments persist across runs; ambiguous merges across splits are excluded.
Empty expected output is valid supervision for unwanted output/hallucinations.

Refined-output reports supply `(raw transcript, expected final output)` supervision.
Raw-output reports supply `(recording, expected raw transcript)` speech evaluation.
Notes are retained as report context, not treated as executable instructions or
training labels. The latest correction wins within a group/target.

A model-training attempt needs at least 12 independent training examples, 3
validation examples and 5 held-out examples with available audio. These minimums
are eligibility gates, not promises that such a small dataset will improve the
model. Speech selection needs 5 held-out raw audio reports and 5 held-out refined
audio reports before a new speech model can be promoted. Inputs over 2,000
characters are excluded; audio evaluation is limited to recordings at most 60
seconds and 8 MiB. Missing audio prevents that example from counting as an audio
acceptance test. Byte hashes detect recordings that change during the job.

## Actual weight training

Use the installed MLX-LM trainer: quantized base model, rank-8 LoRA on the last four
layers, batch size 1, learning rate 1e-5, and 40–200 iterations. Start from the last
approved compatible adapter when available. Production preprocessing and chat
formatting are reused exactly, with thinking disabled and prompt tokens masked
out of training loss. Existing refinement examples provide rehearsal. Independent
acceptance fixtures are never used for training or validation.

Examples resolved entirely by deterministic cleanup are not trained as model
examples. Tokenization excludes examples beyond 4,096 tokens rather than silently
truncating their answers. Training verifies that adapter parameters actually
changed and writes a checksum and training evidence alongside the weights.

Reference: https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md

## Evaluation and promotion

The worker loads the current model and candidate separately and generates actual
outputs under two fixed seeds. Order alternates between seeds. Tests include the
held-out raw transcripts, the same held-out recordings retranscribed with Whisper,
and separate fixed regression fixtures under the tested refinement flags. The
same frozen vocabulary rules apply to both sides. Checks require:

- A strict aggregate edit-error reduction on held-out cases and improvements on
  at least two independent recordings, with no individual example regression.
- At least five independent audio-to-final-text checks.
- Preservation of numerical facts and explicit negations in the expected text.
- Median and P95 inference latency within 10% plus small measurement tolerances;
  cold load plus first-generation latency is checked separately.
- Inference peak memory within 20% + 512 MiB of baseline and under 16 GiB.

Speech candidates must improve word errors without recording-level regressions,
pass timing/memory checks, and pass a separate audio-to-final-output comparison
using the current refinement model. Only one component is promoted per revision;
individually passing speech and refinement changes are not silently combined.
These finite checks reduce risk; they do not prove quality on all future speech.

The parent independently recomputes acceptance gates, checks pipeline/revision
identity, verifies the adapter artifacts, and atomically publishes the registry.
A candidate that fails remains inactive with evaluation details saved locally.
The same dataset/configuration is not repeatedly retrained without new evidence.

## Runtime and rollback

Only refinement uses the personal adapter. General-purpose LLM calls use the base
model. Loading and adapter swaps stay on the existing serial MLX thread. Adapters
are tied to their exact cached base-model snapshot, tested model size, tested
refinement flags, pipeline signature and vocabulary-rule revision. There is no
per-dictation report retrieval or additional inference call on the normal path.
An adapter error quarantines it and retries the base model.

The data directory's `model-improvement/state.json` stores active and previous
revisions, permanent dataset groups, attempted datasets and blocked promotions.
Each `runs/<id>/` contains the plan, training evidence, adapter, worker log, full
A/B outputs and decision metrics. Ten previous deployment entries are retained.
Undo restores the previous valid registry and blocks automatic reactivation of
that attempt. Restart validates hashes before using saved adapters.

## Verification

Unit tests: `backend/tests/test_model_improvement.py` plus existing capture,
refinement and MLX thread-affinity tests. Real hardware integration:

```sh
VOICEBOX_RUN_MLX_TRAINING_TESTS=1 backend/venv/bin/python -m pytest \
  backend/tests/test_model_training_integration.py -q
```

The opt-in test uses synthetic supervision, a temporary adapter directory and an
already-cached 0.6B model. It executes a real gradient update, verifies changed
weights, loads the adapter through production inference, then returns to the base
model. It never promotes the test adapter or changes the user's report database.
