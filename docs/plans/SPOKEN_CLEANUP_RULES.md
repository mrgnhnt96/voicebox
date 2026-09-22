# Spoken cleanup rules

A rule-based pass that resolves the mechanical patterns of speech before the
refinement model sees the transcript: repeats, restarts, changed answers and
refined answers. Each rule rewrites one recognizable shape the same way every
time and leaves anything ambiguous to the model.

## Why

Dictation should come out ready to send, in the speaker's own words. Speech is
faster than typing and leaves less time to think, so transcripts arrive with
false starts, repeated words and answers the speaker corrected mid-sentence.

Measured on the local models this app ships (4-bit MLX Qwen3), the refinement
model does not fix these reliably, and naming the patterns in the prompt did
not change that:

| Said | 1.7B | 4B |
| --- | --- | --- |
| "I can, I can probably get there" | "I can I can probably get there" | fixed |
| "somebody said Wednesday, or was it Tuesday, no Wednesday" | "Was it Tuesday or Wednesday?" (turned into a question) | "or was it Tuesday? No, Wednesday." (kept as spoken) |
| "we should ship Thursday, well Thursday morning probably" | "ship Thursday, probably Thursday morning" | "ship Thursday, well Thursday morning probably" |

Adding explicit instructions for these patterns to the prompt (commit 80b5e0d)
left 4B's output byte-identical and moved 1.7B's only slightly. A deterministic
pass fixes them outright, costs no measurable time, works at any model size,
and applies even with refinement turned off.

## Where it fits

`prepare_refinement()` in `backend/services/refinement.py` already runs
deterministic passes before the model: `collapse_repetitive_artifacts()`,
`apply_spoken_corrections()` (explicit retraction cues such as "no wait" and
"I mean") and `apply_dictation_edits()` (spoken formatting commands). The new
pass is another module in that chain, running before `apply_spoken_corrections`
so that cue-based retractions still see a de-duplicated transcript.

Two behaviours of the chain matter and must not change:

- When `apply_spoken_corrections` or `apply_dictation_edits` resolves something,
  `prepare_refinement` returns an explicit edit and the generative pass is
  skipped. The new rules do **not** resolve a transcript on their own: they
  clean it and hand it on to the model.
- The content check (`backend/services/content_check.py`) compares the model's
  output against the text `prepare_refinement` returns, so anything these rules
  drop is not counted as content the model lost.

Both the streaming path (`capture_stream.py`, phrase by phrase) and the batch
path (`captures.refine_capture`) go through `prepare_refinement`, so they
inherit the pass with no change of their own.

## The rules

Each rule is conservative: it fires on a tight shape or not at all.

| Rule | Said | Result |
| --- | --- | --- |
| Immediate repeat | "look at the, the budget" | "look at the budget" |
| Repeated restart | "I can, I can probably get there" | "I can probably get there" |
| Stuttered clause | "it loads, it's loading everything" | "it's loading everything" |
| Changed answer | "said Wednesday, or was it Tuesday, no Wednesday" | "said Wednesday" |
| Refined answer | "ship Thursday, well Thursday morning" | "ship Thursday morning" |

Details worth pinning down in the implementation:

- **Immediate repeat**: the same word twice in a row, optionally separated by a
  comma. Keep genuine repetition: "very, very good", "no, no, no", "had had".
- **Repeated restart**: a run of 2 or more words repeated straight after itself,
  where the second run continues ("I can, I can probably"). Keep the second run.
- **Stuttered clause**: two clauses separated by a comma that start with the
  same subject and a different form of the same verb ("it loads, it's
  loading"). Keep the second. Requires the shared subject; do not guess.
- **Changed answer**: a comma-separated alternative introduced by "or was it",
  "no", "actually", "sorry" or "I mean", where the replacement is the same kind
  of thing as what it replaces — a weekday for a weekday, a time for a time, a
  number for a number. Keep the last one. When the run circles back to the
  original ("Wednesday, or was it Tuesday, no Wednesday") the result is the
  original, said once.
- **Refined answer**: "X, well X + more" where the second mentions the first and
  adds to it ("Thursday, well Thursday morning"). Keep the longer one, and drop
  a trailing hedge ("probably") only when it directly follows the cue.

### Not in scope

- **Things said late** ("oh wait, before that, make sure you're on main"): where
  the clause belongs is a judgement, so it stays with the model and the user's
  examples.
- **"No" as an answer** ("did it work? no, it crashed") and **"well" as a
  sentence opener** ("well, I think so"): these are not corrections.
- **Filler and disfluency removal**: `_SMART_CLEANUP` already covers it.
- Anything that needs to know what the speaker meant.

## Safety

- A rule only ever deletes words the speaker said twice or replaced. It never
  adds, reorders or substitutes a word.
- Same-kind matching for changed answers is what keeps "call Bob, no Bill"
  (both names → replace) apart from "call Bob, no problem" (not the same kind →
  leave alone). Build the kind test from small closed sets (weekdays, months,
  numbers, times) plus a fallback: same part-of-speech shape and a shared prefix
  are not enough on their own, so when in doubt, leave the text alone.
- The rules run on the transcript, never on the model's output, so a rule bug
  can drop a word the speaker said. That is the risk to test hardest.

## Tests

`backend/tests/test_spoken_cleanup.py`, in the style of
`test_spoken_corrections.py`:

- One case per rule, from the table above.
- Every "not in scope" case above, asserting the text is unchanged.
- Genuine repetition kept: "very, very good", "no, no, no", "I had had enough".
- Technical terms and numbers survive: "set it to 3.5, no 4.5" replaces the
  number; "run npm install, install the deps" does not lose a word.
- `prepare_refinement` applies the pass, and a transcript the rules clean still
  goes to the model (no explicit-edit short circuit).
- Existing suites must stay green, especially `test_spoken_corrections.py`,
  `test_dictation_edits.py`, `test_capture_stream.py` and
  `test_content_check.py`.

## Verification

Re-run the two live probes and compare against these numbers, measured on
2026-09-22 with the current build:

1. **Calibration run** (`POST /writing-style/calibration`, 5 rewrites): the
   share of each paragraph a user still had to edit was 43 · 27 · 28 · 36 · 13 %
   on 1.7B and 35 · 31 · 25 · 36 · 11 % on 4B. The rules should lower the early
   numbers, where repeats and changed answers dominate.
2. **Cleanup with the user's examples**: "okay so the bug is, it only happens
   when you, when the user logs out" still came back with "when you, when the
   user" on 1.7B. That should be fixed by the repeated-restart rule alone.

Report both before and after, on both models. Do not claim an improvement that
the probes do not show.

## Done when

- The rules module and its tests exist, and the full backend suite passes
  (`backend/venv/bin/python -m pytest tests/ -q`, ignoring the pre-existing
  `test_progress.py::test_hf_progress_tracker` failure).
- `uvx ruff check` and `uvx ruff format --check` pass on the new and changed
  files.
- The live probes above are re-run and reported.
- Ship it in one commit; do not rebuild or reinstall the app.
