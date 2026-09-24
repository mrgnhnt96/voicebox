# Dictation latency, round 2

Date: 2026-09-24. Follows [DICTATION_LATENCY_ARCHITECTURE.md](DICTATION_LATENCY_ARCHITECTURE.md),
which is implemented: native Rust mic capture and streaming, direct text
insertion, no previews, in-memory Whisper, fast Whisper loading, a cached
cleanup prompt with stable examples, startup warm-ups, and a clipboard
snapshot taken at key-down.

## Where the time goes now

Machine: Apple M2 Max, 64 GB, macOS 26.6. User settings: Whisper turbo in
English, Qwen3 4B cleanup, "learned" punctuation, built-in mic at 48 kHz.
These are the installed app's logged numbers (`logs/server.log` and
`logs/app-console.log` in the data directory).

| Stage after release | Typical |
|---|---|
| Whisper on the final phrase | 0.31–0.35 s (0.57 s on the first dictation after launch, even with the warm-up) |
| Cleanup (4B; the prompt is cached, so this is mostly writing output at ~15 ms per token) | 0.30–0.45 s |
| Paste or insert until text is visible | ~0.08 s |
| **Release to text** | **~0.65–0.8 s** |
| App launch to ready | ~22 s |

## Work items

Every item is judged by measurement: before and after, same machine,
repeated runs. Report the numbers even when they show no gain. A change
that doesn't beat the baseline is not merged.

1. **Server startup (bundle format).** The PyInstaller single-file bundle
   unpacks itself on every launch. Measure a one-folder bundle, including
   Tauri packaging, signing and how the sidecar is launched.
2. **Speculative decoding for cleanup.** Use Qwen3 0.6B as a draft for 4B,
   via mlx-lm's draft support. The output must be identical to 4B alone at
   the same sampling settings, and it must keep working with the cached
   prompt.
3. **Skip cleanup when nothing needs fixing.** Detect dictations the model
   would return unchanged or only trivially changed, and skip the model.
   Measure against real dictations how often it triggers and how often it
   would change the output.
4. **Stream cleaned text into the target app as it's generated.** This only
   applies where direct accessibility insertion works. The final text must
   exactly match what's delivered today: no duplication, and revisions
   handled. Design and prototype it, and measure time to first visible word.
5. **Whisper's first-dictation cost.** Find and remove the remaining
   ~0.24 s on the first dictation after launch.
6. **Rust inference benchmark (research only).** Compare whisper.cpp and
   llama.cpp (or candle) on Metal against the current MLX models for
   latency, accuracy, memory and load time. Recommend switching or staying.

## Rules

- Nothing may add time after release. Speed is the product.
- Write the failing test first, and keep the suites green. The known
  failure is `backend/tests/test_progress.py::test_hf_progress_tracker`.
- Base your work on `feature/wisprflow-replacement`. Commit only the files
  you intend to commit (check `git diff --cached`), and never use
  `git stash`.
- For realistic benchmarks, copy the user's data directory
  (`~/Library/Application Support/sh.voicebox.app`) into a scratch folder
  and work on the copy. Never write to the original, never install into
  `/Applications`, and never quit or restart the running Voicebox app.
- Other agents share the GPU. Interleave A/B runs, repeat them, and note
  any contention.
