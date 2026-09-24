# WhisperKit vs the current MLX Whisper: engine comparison

Date: 2026-09-24. This is work item 6 in
[DICTATION_LATENCY_ARCHITECTURE.md](DICTATION_LATENCY_ARCHITECTURE.md). It is
research only, and no application code changed.

## Recommendation: don't switch

Keep Whisper large-v3-turbo on MLX. On this machine WhisperKit is **about
1.5–2.5× slower** for every clip length measured. Switching would add about
0.2 s after release on a typical short final phrase, and more on longer
phrases. That breaks the rule "nothing may add time after release".
Accuracy is identical: both engines produced the same transcripts word for
word. WhisperKit does win in two places:

- **It barely slows down when the GPU is busy.** It runs on the Neural
  Engine (ANE).
- **Its process memory is much smaller.**

Neither advantage matters for Voicebox today. The Qwen cleanup runs after
Whisper on the same MLX worker, so the two never compete for the GPU.

Revisit only if one of these becomes true (see "When to revisit"):

- The pipeline is changed so that Whisper and the LLM run at the same time.
- Real-world logs show that other apps' GPU load is slowing dictation.

## What was run, and what comes from documentation

**Measured on this machine:** Apple M2 Max, 64 GB, macOS 26.6.2 (25G83).

- **WhisperKit:** `argmax-oss-swift` at revision `3111602` (2026-09-23), built
  from source in release mode with Swift 6.4. A small benchmark
  (`scripts/benchmark-stt-engines/wkbench`) loads the model once, then
  transcribes each fixture 5 times (3 times under load).
  - Models: Argmax's Core ML conversions
    `openai_whisper-large-v3-v20240930_turbo` (1.5 GB on disk; this is
    large-v3-turbo) and `..._626MB` (598 MB, the compressed variant that
    Argmax recommends).
  - Settings: `prewarm: false`, language `en`, temperature 0.
  - Compute modes:
    - `ane`: the library default. The encoder and decoder run on the Neural
      Engine, and the mel spectrogram runs on the GPU.
    - `gpu`: everything on the GPU.
    - `mixed`: the encoder on the GPU and the decoder on the Neural Engine.
- **MLX (current Voicebox path):** `backend.services.transcribe.get_whisper_model()`
  → `MLXSTTBackend.transcribe(path, language="en", model_size="turbo")`, the
  production call.
  - Environment: `HF_HUB_OFFLINE=1`, with `config.set_data_dir` pointed at a
    scratch directory, MLX 0.32.2 and mlx-audio 0.4.1.
  - Model: the cached `openai/whisper-large-v3-turbo`.
  - Each clip was transcribed 5 times (7 times in run 3, 3 times under load).
- **Fixtures:** macOS `say` (Samantha voice, rate 165), converted with
  `afconvert` to 16 kHz mono PCM16 (`make_fixtures.py`):
  - `short` (2.06 s, with 0.35 s of low noise at the end)
  - `six` (6.28 s)
  - `fifteen` (13.87 s)
  - `paused40` (40.61 s; the long text from STREAMING_BENCHMARK.md, with 1 s
    of silence between sentences)
  - `tech` (12.51 s; numbers, negation and a port, with pauses)
- **WER:** lower-cased word tokens with punctuation ignored. This is the same
  normalization as STREAMING_BENCHMARK.md.
- **Contention test:** a separate process runs 4096×4096 MLX matrix
  multiplications in a loop (`gpuload.py`). This is the worst case of another
  GPU workload running at the same time.

**Not measured:**

- Power and energy. `powermetrics` needs root, which was not used.
- WhisperKit's live microphone streaming (`AudioStreamTranscriber`). It
  records from the microphone itself, so it can't be fed fixtures without
  changing its code. It was reviewed from its source instead (see below).
- Real human recordings.

**Taken from documentation or source code:** Pro SDK features and pricing, the
cache behavior after OS updates, and licensing. Sources are listed at the end.

**Contention during the runs:** other agents were working on this machine at
the same time. At times one of them had a Python benchmark process holding
models (about 4.5 GB RSS, mostly idle but sometimes 44% CPU). A Dart build
also ran early on. The MLX numbers vary more from run to run for this reason.
The table shows all three MLX runs, and run 3 was the quietest. The WhisperKit
ANE numbers were stable to within ±2% across runs.

## Results

### Warm latency: file in, text out (median of the warm runs, in seconds)

| Fixture | Audio | MLX run 1 / 2 / 3 | WhisperKit ANE (turbo) | WhisperKit GPU (turbo) | WhisperKit ANE (626MB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| short | 2.06 s | 0.430 / 0.370 / **0.384** | **0.550** | 0.753 / 0.921 | 0.823 |
| six | 6.28 s | 0.470 / 0.547 / **0.353** | **0.721** | 0.954 / 1.016 | 1.021 |
| fifteen | 13.87 s | 0.479 / 0.655 / **0.403** | **1.051** | 1.239 / 1.231 | 1.356 |
| paused40 | 40.61 s | 1.190 / 1.262 / **0.867** | **2.50** | 2.81 / 3.24 | 3.07 |
| tech | 12.51 s | 0.553 / 0.465 / **0.366** | **0.91** | 1.25 / 1.10 | 1.21 |

`mixed` mode (the encoder on the GPU) was about the same as `gpu` or slightly
worse, for example `short` at 0.82 s and `fifteen` at 1.45 s.

**Why WhisperKit is slower here.** The Core ML encoder always processes a
full 30 s Whisper window. On the M2 Max's Neural Engine that takes
**0.387 s per window**, however short the clip is. The ANE decoder then adds
about 13 ms per token. So even a 2 s phrase costs WhisperKit about 0.55 s.
MLX on the M2 Max's 38-core GPU runs both the encoder and the decoder faster.
MLX's whole pipeline, including reading the file, takes 0.34–0.40 s for one
window. `paused40` needs two 30 s windows in both engines. Argmax's own
benchmarks are mostly for iPhones and base M-series chips, where the ANE is
relatively stronger. A Max-class GPU changes that balance.

### Latency when the GPU is busy (the gpuload.py test, median in seconds)

| Fixture | MLX, idle → with GPU load | WhisperKit ANE, idle → with GPU load |
| --- | ---: | ---: |
| short | 0.38 → **1.41** (3.7×) | 0.550 → **0.571** |
| six | 0.35 → 2.41 | 0.721 → 0.751 |
| fifteen | 0.40 → 2.98 | 1.051 → 1.065 |
| paused40 | 0.87 → 7.12 | 2.50 → 2.52 |
| tech | 0.37 → 2.59 | 0.91 → 0.94 |

This is WhisperKit's real strength: the Neural Engine is effectively
private. This test is a worst case, with the GPU saturated by another
process. Within Voicebox, Whisper and the Qwen cleanup run one after the
other on one MLX worker, so they don't compete. Contention only happens when
another app is using the GPU heavily (games, video export, local LLMs) during
dictation.

### Load time

| Engine / mode | First load ever (Core ML compile/specialize) | Later loads (cache warm) |
| --- | ---: | ---: |
| WhisperKit ANE, turbo | **158.0 s** (the encoder alone took 153.7 s) | **1.26–1.28 s** (includes 0.39 s for the tokenizer) |
| WhisperKit ANE, 626MB | 73.6 s | 1.21 s |
| WhisperKit GPU, turbo | 21.8 s | 3.19 s |
| MLX turbo (current path, in the venv) | n/a | **2.12–2.28 s** load, plus 1.4–1.7 s of Python/MLX imports |

- **The WhisperKit first-load cost comes back.** Core ML keeps the
  device-specialized model in a system cache that Argmax doesn't control.
  WhisperKit's own `prewarm` documentation says this cache "is evicted after
  every OS update and if the models are not used for extended periods of
  time". So after each macOS update, the first dictation would face a load
  of about 2.5 minutes, unless the app prewarms in the background and uses
  something else in the meantime. There is no API to check whether the cache
  is still valid.
- **The MLX load measured here was about 2.2 s, not the 24 s logged by the
  app.** That points to something specific to the packaged app (its frozen
  build or a cold file cache) rather than the MLX engine itself. Item 2 owns
  that investigation, so it is not repeated here. The point for this
  comparison is that load time is not a reason to switch: a fixed MLX path
  should load in about 2–4 s.

### Memory

| Engine | Measured |
| --- | --- |
| MLX turbo | MLX active memory is 1,539 MB after load, and MLX peak is 2,390 MB. Process peak footprint is 3.16 GB; max RSS is 2.1 GB. |
| WhisperKit ANE | Process peak footprint is about 106–140 MB; max RSS is 240 MB. The first run, which specialized the model, reached 1.62 GB RSS. |
| WhisperKit GPU | Process peak footprint is 2.2 GB. |

Caveat: weights on the Neural Engine are held by system services, and
`phys_footprint` doesn't fully count them. So the ANE figure understates the
total cost to the system. Even so, it is clearly much lower than holding
about 1.5 GB of weights in unified GPU memory. With 64 GB, memory doesn't
decide anything here. It would matter more on 8–16 GB machines.

### Accuracy

- **The prose fixtures matched exactly.** On all four (`short`, `six`,
  `fifteen`, `paused40`), MLX, WhisperKit ANE and WhisperKit GPU produced
  **the same text, including punctuation**. WER was 0 in every case. Every
  engine returned the same text on every repeat.
- **The technical fixture differed only in punctuation.** Both engines turned
  the numbers into digits: "7", "minus $5", "8000". That gives a WER of 0.179
  with this word-form reference, the same for both. The only difference:
  WhisperKit kept the periods between the paused phrases, and MLX left them
  out ("…count to 7 Do not disable…"). The cleanup step normally restores
  punctuation, so this is a minor difference in raw output, not a real
  quality gap.
- **The compressed model had no accuracy loss on these fixtures.** The
  626 MB variant had WER 0 on the prose, but it was slower than the full
  turbo model on this Mac.

## WhisperKit capabilities, and how they fit Voicebox

- **Streaming.** The open-source `AudioStreamTranscriber` records from the
  microphone itself (AVAudioEngine). It re-transcribes the growing buffer
  from the last confirmed segment whenever at least 1 s of new audio with
  voice has arrived. It confirms all but the last 2 segments and clips
  decoding at the last confirmed timestamp. This is the same
  rolling-window approach Voicebox's `capture_stream.py` already uses, with
  no streaming encoder. Each step still pays the full 30 s encoder
  (0.387 s here). So it would bring no new latency trick. It would also mean
  giving up Voicebox's phrase-seam guards, which were tuned for correctness
  (see STREAMING_BENCHMARK.md).
- **True low-latency streaming is paid.** Argmax's documentation lists
  real-time transcription as a Pro SDK feature. Pro is closed source and
  priced per device per month (about $0.42/device/month on Argmax's pricing
  page, plus a trial fee). It advertises Parakeet v2 streaming at about
  160 ms latency. That is a separate product decision and not covered by
  this report.
- **Models.** Large-v3-turbo is available as a Core ML build in two variants:
  `v20240930_turbo` (1.5 GB) and `_626MB` (compressed). Other options
  include distil-large-v3, the older `large-v3_turbo` builds, and
  quantized variants. The model builds are MIT on Hugging Face
  (`argmaxinc/whisperkit-coreml`). They are a separate download: the MLX
  weights can't be reused.
- **Compute.** The default puts the encoder and decoder on the Neural Engine
  (macOS 14 and later) and the mel spectrogram on CPU and GPU. This can be
  configured per stage with `ModelComputeOptions`.
- **License.** The SDK code is MIT. It includes a vendored copy of
  swift-transformers (Apache-2.0) and lists its third-party attributions in
  `NOTICES`.
- **Packaging.** The benchmark binary is about 3 MB. It links only system
  frameworks (Foundation, CoreML, AVFoundation, Accelerate and similar) and
  needs no dynamic libraries from outside the system. A Swift sidecar
  would be easy to ship as a Tauri `externalBin`. It would need its own
  code-signing and notarization entry, like the existing Python sidecar
  (see MACOS_NOTARIZATION.md). The other route is to link it into the Rust
  shell through a `swift-rs`/C-ABI bridge. The library needs macOS 14 or
  later.

## Integration cost and risk if Voicebox switched anyway

1. **Two inference stacks instead of one.** The Qwen cleanup LLM stays on
   MLX in Python. So switching Whisper adds a Swift engine without removing
   the Python/MLX sidecar or its load time.
2. **A new process boundary on the critical path.** Either Python calls a
   Swift sidecar, which adds IPC to every window, or the Rust shell runs
   recognition and ships text to Python for cleanup. The second option moves
   the streaming and seam logic in `capture_stream.py` into Rust or Swift,
   and needs its tests and correctness guards rebuilt. This is weeks of
   work, not days.
3. **Handling the first load and cache eviction.** The app would need a
   background prewarm, a way to fall back while the model specializes
   (2.6 min for turbo on the Neural Engine, 22 s on the GPU), and handling
   for the cache being evicted after macOS updates or long idle periods.
4. **An extra 1.5 GB model download** and a second model-management path
   (download progress, cache, deletion).
5. **Slower results on the Macs that matter most.** On Max-class GPUs
   WhisperKit adds about 0.15–0.25 s after release for a short final phrase,
   and more for longer ones. It may be competitive on base M1/M2 chips or
   8 GB machines, but that was not tested.

## Hybrid option

A hybrid would run WhisperKit on the Neural Engine for **previews only** and
keep MLX for the final result. That would stop previews from ever occupying
the MLX worker. It would fix the "preview delays the final" problem without
touching the GPU queue. However:

- Item 3 already removes that delay more cheaply, by not running a queued
  preview on `finish` and by reusing text that previews already covered.
- The hybrid would carry all of costs 1–4 above.

Not recommended now.

## When to revisit

- **The pipeline starts overlapping Whisper and the LLM.** For example, the
  last phrase's recognition runs while cleanup of the earlier phrases is
  still running. Then GPU contention inside Voicebox becomes real, and
  WhisperKit's flat latency under load (0.55–0.57 s whether the GPU is idle
  or busy) could beat MLX's contended latency (1.4 s or more).
- **Real-world logs show release-to-final spikes that line up with other
  apps' GPU load.** Item 1's per-take logging could show this.
- **Voicebox targets smaller Macs (8–16 GB, base chips).** Measure again
  there first.
- **Argmax Pro (Parakeet streaming) or Apple's own on-device speech APIs are
  evaluated as a different class of engine.** These are true streaming
  models, not rolling Whisper windows. They were not part of this test.

## Reproduce

Scripts are in `scripts/benchmark-stt-engines/`. Results are JSON lines on
stdout. Use a scratch directory outside the repo; the fixtures and models are
not committed.

```sh
PY=backend/venv/bin/python
SCRATCH=/path/to/scratch
$PY scripts/benchmark-stt-engines/make_fixtures.py $SCRATCH/fx

# MLX (current path; needs the cached openai/whisper-large-v3-turbo, runs offline)
$PY scripts/benchmark-stt-engines/mlxbench.py "$PWD" $SCRATCH/data 5 $SCRATCH/fx/*.wav > $SCRATCH/mlx.jsonl

# WhisperKit: build the benchmark, download a Core ML model (about 1.5 GB, about 36 s here)
(cd scripts/benchmark-stt-engines/wkbench && swift build -c release)
$PY -c "from huggingface_hub import snapshot_download as s; s('argmaxinc/whisperkit-coreml', allow_patterns=['openai_whisper-large-v3-v20240930_turbo/*'], local_dir='$SCRATCH/models')"
scripts/benchmark-stt-engines/wkbench/.build/release/wkbench \
  $SCRATCH/models/openai_whisper-large-v3-v20240930_turbo ane 5 $SCRATCH/tok $SCRATCH/fx/*.wav > $SCRATCH/wk.jsonl
# (the tokenizer, a few MB, is fetched once into $SCRATCH/tok; modes: ane | gpu | mixed)

FX_DIR=$SCRATCH/fx $PY scripts/benchmark-stt-engines/summarize.py $SCRATCH/mlx.jsonl $SCRATCH/wk.jsonl

# Contention: saturate the GPU in another process while a bench runs
$PY scripts/benchmark-stt-engines/gpuload.py 150 &
```

The first WhisperKit run on a machine includes the Core ML specialization
(2.6 minutes for turbo on the Neural Engine). Run it twice and report both
runs. `summarize.py` leaves run 0 out of the warm median.

## Sources

- WhisperKit / argmax-oss-swift README and source code (revision `3111602`):
  `Sources/WhisperKit/Core/Configurations.swift` (the `prewarm` and cache
  eviction notes), `Core/Models.swift` (the default compute units),
  `Core/Audio/AudioStreamTranscriber.swift` (the streaming loop), and
  `LICENSE`. <https://github.com/argmaxinc/argmax-oss-swift>
- Core ML model builds and their sizes: <https://huggingface.co/argmaxinc/whisperkit-coreml>
  (the model card says MIT).
- Open-source vs Pro: <https://app.argmaxinc.com/docs/wiki/open-source-vs-pro-sdk>
- Pro SDK (Parakeet streaming, about 160 ms): <https://www.argmaxinc.com/blog/pro-sdk-ga>.
  Pricing: <https://www.argmaxinc.com/pricing>
- Homebrew `whisperkit-cli` 1.1.0 (MIT) exists but was not used. The CLI was
  built from source instead, so nothing was installed on the system.
