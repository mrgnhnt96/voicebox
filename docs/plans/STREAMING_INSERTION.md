# Streaming cleaned text into the target app (round 2, work item 4)

Date: 2026-09-24. Part of [DICTATION_LATENCY_ROUND_2.md](DICTATION_LATENCY_ROUND_2.md).
Builds on [TEXT_INSERTION.md](TEXT_INSERTION.md) (direct AX insertion) and
[STREAMING_DICTATION_PHASE_1.md](STREAMING_DICTATION_PHASE_1.md) (protocol v1).

## Verdict

It is implemented, tested, and **off by default**. To try it, start the app
with `VOICEBOX_LIVE_TEXT=1`. Without that variable, the client doesn't ask for
provisional text, so the server sends none and nothing changes.

- **Correct in every replayed take.** Across 87 takes that had provisional
  text, none needed a revision: every provisional text was a prefix of the
  final text. Revisions are still handled for the cases that can happen
  (see "Revision").
- **Small gain for most dictations.** Most dictations are one phrase. For
  those, the first provisional text is **one word**, shown about 0.12–0.18 s
  before the final text would be on an uncontended machine (estimate below).
- **Large gain for dictations with pauses** (10 of 100 takes). The phrases
  already cleaned before release (40–83 % of the final text) can appear right
  after release instead of ~0.65 s later.
- **No gain in the user's main target.** Every logged insertion this week went
  to `com.mcclowes.saggar`, which falls back to the clipboard
  (`UseClipboard(NotATextRole)`). Live text never runs there.
- **Main risks are UX, not correctness.** There may be more than one undo step,
  and web editors may not register AX writes. Both need checking by hand
  before the feature is turned on by default.

## Where the time goes after release

Real-app numbers from `server.log` for the 4B cleanup. Generating 8 tokens
took 0.31 s, 11 took 0.36 s, 19 took 0.45 s and 29 took 0.58 s. That is about
0.19 s of fixed cost (prefill plus the first token), then ~15 ms per token.
Typical output is 8–20 tokens.

```
release ── recognize last phrase (0.33 s) ── cleanup: prefill+1st token (~0.19 s) ── tokens (~15 ms each) ── final ── insert
                                                                       ↑ first provisional word needs ~2 words out
```

Most of the cleanup time is the fixed cost, and each provisional text holds
back its last word (see below). So streaming can only show the first word
about 0.1–0.2 s before the final text. Phrases cleaned before release are the
exception: they are ready at release.

## Protocol addition (backward compatible)

- **Start message:** optional `"provisional": true`. Older servers ignore
  unknown keys. The Rust client sends the key only when live text is on
  (`protocol::start_message(rate, provisional)`).
- **New event:** `{"type": "provisional", "text": "...", "session_id",
  "revision", "covered_samples", "degraded_reason"}`.
  - It is sent only after `finish`, and only to clients that asked.
  - `text` is the start of the whole dictation's expected final text. Each
    one is longer than the previous one.
  - It is a prediction, not a promise. `final` stays the only authoritative
    text.
  - Old clients never ask for it. If one got it anyway, the Rust client would
    treat any unknown type as `Update` and ignore it.

## Server (`backend/services/capture_stream.py`)

**When provisional text is offered.** Only when the client asked, the key is
released, `auto_refine` and `allow_auto_paste` are on, and the session will
finish on the normal path. It is not offered for overlap (forced) seams,
degraded or backlogged sessions, a pending whole-dictation reconcile, or a
refinement error.

It is offered at two points:

1. **At release.** The text cleaned before release is offered with its
   trailing punctuation removed (`close_dictation(self.refined)`). This runs
   as a task while the last phrase is recognized, not before recognition
   starts, so it never delays recognition.
2. **During the last phrase's cleanup.** `qwen_llm_backend.generation_listener`
   is a `ContextVar`. The backend calls it on the MLX thread with the text
   generated so far after each token. It is a few lines, wrapped in
   try/except. `streaming_cleanup` forwards each call to the event loop with
   `call_soon_threadsafe`. A single relay task then:
   - projects only the latest text;
   - builds the projection on the first token, so reading the habits (~1.6 ms)
     overlaps generation;
   - costs about 0.04 ms per token.

   Revisions (`actually`, `scratch that`...) and deterministic corrections
   stream nothing.

**What the projection is.** It runs the same steps the final text goes
through, assuming the partial cleanup is complete and passes the check:

1. `strip`, then `apply_learned`: refine_transcript's own post-processing.
2. `open_phrase`, then `join` with the earlier text.
3. `apply_learned_corrections`.
4. `close_dictation`.

**`stable_prefix(text, holdback)`** then drops the last `holdback` words and
any punctuation before them. Those can still change: the model may be
mid-word, and seam punctuation, `apply_style` boundaries (which look at the
next word's capital letter) and learned corrections (which need the word
after them as context) all depend on what comes next. The holdback is 1 word,
or 4 words while learned correction rules are active.

**Timing.** Nothing new sits on the path from release to final:

- The release-time offer runs concurrently with recognition.
- The per-token relay runs on the event loop while the MLX thread generates.
- The final `await relay_task` waits only for a send already in progress. It
  never cancels one.

Paired runs (same recording, with and without provisional text, alternated)
showed a median difference in release→final of +0.002 s over 100 pairs.
Other agents' benchmarks were loading the GPU, so that difference is noise:
the interquartile range was ±0.3 s.

## Client (Rust)

**`text_insert.rs`**: verified live writes, testable against a fake field.

- **`begin_live`** runs only where `choose_strategy` already allows direct
  insertion, so terminals, secure fields, non-text roles and unsettable fields
  are excluded.
  - The field must be readable back before anything is written
    (`AXStringForRange`, or else `AXValue`).
  - It then reuses `insert_into`.
  - It returns `Started(Owned{start, text})` only if the field reads back
    exactly.
  - `Declined` means nothing was inserted; the final text then takes today's
    path.
  - `Broken` means something may have landed that can't be tracked. Nothing
    more is written, and nothing is pasted again.
- **`intact`**: the owned range still reads as the owned text, and the caret
  sits right after it.
- **`extend_live`** and **`finish_live`** write only when the field is
  intact. Otherwise they return `Edited` and write nothing.
- **`rewrite`** keeps the common prefix and selects only the tail that
  differs (`AXSelectedTextRange`). It sets the new tail (possibly empty), then
  checks three things: the caret, the character count, and that the text
  reads back. It re-reads for late-applying apps the same way `insert_into`
  does. If the app didn't apply the write, it puts the caret back.

**`dictation/live.rs`**: the `Live` state machine for one take.

- **States:** Idle → Active / Declined / Broken, Active → Stalled, and
  Closed once finished.
- **`offer`** never blocks. A worker writes the latest text, skipping any that
  arrived while a write was in flight. After the first write, writes are at
  least 100 ms apart (`WRITE_INTERVAL`), which is 3–4 writes per take instead
  of ~8 events. The worker never holds the state lock while it waits.
- **Eligible targets:** the snapshotted target is not Voicebox, Accessibility
  is trusted, and the target is still frontmost. Live text never activates
  another app.
- **`finish(Some(final))`** is called from `AppEnv::paste`. It waits for any
  write in flight, then makes the owned text exactly the final text. If no
  live text was written, it returns `NotStarted` and `paste_final_text_with`
  runs unchanged.
- **`finish(None)`** runs after every `take::settle`. It withdraws live text
  when the take ended without a paste: empty output, a refinement error,
  auto-paste off, or a failed recovery. That matches today, where nothing is
  inserted in those cases.

`client.rs` and `protocol.rs` parse the event. Provisional text counts only
after `finish` has been sent and when the session id matches.

## Revision

The final text is written over the owned range when:

- the provisional text is not a prefix of it (the content check rejected
  the cleanup, a habit or correction changed a held-back word, or an adapter
  retry regenerated the text);
- it is shorter (empty output);
- or it is longer (the usual case, a plain append).

Only the tail after the common prefix is rewritten. If the user edited the
text or moved the caret (`intact` fails), nothing is written. The pill then
shows "Text saved in Captures. The field changed while Voicebox was typing…".
The final text is never written over something the user touched.

## Correctness argument

1. **Final text equals today's.** The server's final text doesn't depend on
   provisional text. Projection works on copies and only reads session state.
   `test_rejected_cleanup_delivers_exactly_what_it_would_without_provisional`
   checks this, including the reject path.
2. **Visible text equals the final text.** At finish, the field is either:
   - verified intact and rewritten, then verified by caret, count and
     read-back;
   - left alone with an error, if the user touched it or the app misbehaved;
   - or, if nothing was ever written, delivered by today's path.
3. **No duplication.** Once anything may have landed (`Started`, `Broken`,
   `Stalled`), the clipboard path can never run for that take.
   `Declined` is returned only when the field is observably unchanged, the
   same rule `insert_into` uses.
4. **Clipboard-path apps are untouched.** `begin_live` uses the same
   `choose_strategy` gate. Where live text is declined, the final text takes
   the unchanged path.

## Measurements

**Setup.** The user's 100 most recent dictations (<60 s), replayed at
real-time pace through `StreamingCapture` with real models:

- Whisper turbo, Qwen3 4B, English, "learned" punctuation;
- the user's writing style, correction rules (none active) and examples,
  copied read-only into a scratch data directory;
- each recording run with and without provisional text, in alternating order.

**GPU contention.** Other agents were running speculative-decoding and
bundle benchmarks on the same GPU. Median release→final was 1.56 s, against
0.65–0.8 s in the real app. Every absolute number below is inflated. The
ratios and the revision counts are not.

| Metric (100 takes) | Value |
|---|---|
| Takes with any provisional text | 87 (others: 8 had no LLM after release, e.g. deterministic "new line" or empty output; 1 degraded) |
| Provisional texts that were not a prefix of the final text (would need a revision) | **0 of 87** takes |
| Release→first provisional, median (contended) | 1.01 s, vs 1.63 s release→final in the same runs |
| Earlier by, median (contended) | 0.46 s overall; 0.36 s when it came from the last phrase's cleanup (77 takes); 1.28 s when earlier phrases were shown at release (10 takes) |
| Gain as a share of the last phrase's cleanup time | median 0.39 (IQR 0.29–0.63) |
| First provisional text, words (streamed case) | median **1** |
| Share of final text in the first provisional text | median 12 %; 40–83 % in the at-release takes |
| Share of final text in the last provisional text | median 88 % |
| Provisional events per take | median 8; client writes ≤ 1 + (cleanup time / 100 ms) |
| Release→final, with minus without (paired) | median +0.002 s (IQR −0.31 to +0.39 s, contention noise) |

**Uncontended estimate.** The real app's cleanup takes 0.30–0.45 s. With the
measured ratio of 0.39, the first streamed word appears ~0.12–0.18 s before
the final text: release+~0.55 s instead of ~0.7 s.

The 16 least contended takes (cleanup ≤ 0.55 s) agree:

- median gain 0.14 s;
- first provisional at 0.65 s;
- final at 0.83 s.

Takes with a pause (10 %) show roughly half their text at release+~0.01 s
plus the AX write, instead of ~0.7 s.

The AX write time itself was not measured here. That needs the app running;
the log line `[dictation] take N: live start … release→X ms` reports it.

The replay harness is a scratch script, not committed: it copies the data
directory and uses `config.set_data_dir`, like
`scripts/benchmark-streaming-dictation.py`.

## Risks (to check by hand)

- **Undo granularity.** 2–5 AX writes per take may become 2–5 undo steps.
  Today's single insertion is one.
- **"Succeeds but doesn't register"** (web editors, Electron). This risk is
  already listed in TEXT_INSERTION.md, and live text makes it worse: a
  revision selects and replaces a range, which custom editor models may
  ignore.
- **Flicker.** One word appears, then the rest. In the rare revision case,
  the tail is replaced in place.
- **Late-applying apps.** A write that lands more than 45 ms later reads as
  `NotApplied` or `Uncertain`. That gives an error, never a duplicate.
- **User typing during the ~0.5 s window.** Detected; the rest is not
  inserted, and the pill tells the user the text is in Captures.

## Manual checklist (with `VOICEBOX_LIVE_TEXT=1`, dev build from a terminal)

For each target, dictate two takes:

- one short sentence;
- two sentences with a pause between them, so earlier text appears at
  release.

Then press ⌘Z once and note how much disappears.

| Target | Expect |
|---|---|
| TextEdit (rich and plain) | First word(s) appear before the rest, the final text is exact, no duplicate. Note the undo steps. |
| Notes, Mail compose | Same as TextEdit |
| Safari `<textarea>` / `<input>`, then Send or submit | The page sees the whole final text, not only the first word |
| Chrome textarea, Gmail, Notion (contenteditable) | Exact final text, or a clean decline (log `live start Declined`). Never doubled. |
| Slack composer | The whole text is posted when sent |
| VS Code (Monaco) | Exact text in the editor, not just the hidden textarea |
| Terminal, iTerm2, Ghostty, saggar | No live text (`Declined(ClipboardOnlyApp / NotATextRole)`); today's paste |
| Type a key while the text is appearing | Nothing you typed is overwritten; the error pill says the text is in Captures |

Report any target where text is doubled or missing, or where ⌘Z behaves
badly. Only then consider turning it on by default. If only the at-release
part proves worth it, stream only that (skip `streaming_cleanup`), which
gives the big gain for dictations with pauses with a single early write.
