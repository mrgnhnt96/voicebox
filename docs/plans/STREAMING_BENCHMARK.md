# Streaming dictation inference benchmark

This benchmark exercises the actual installed Whisper and Qwen models through the production streaming service, delivering synthetic audio frames at real-time speed. It does not measure microphone hardware, WebKit capture, WebSocket transport, database persistence, or native paste. It is an inference/service check, not end-to-end desktop acceptance.

## Reproduce

Use a backend Python environment with the project's inference dependencies installed and Whisper turbo / Qwen3 0.6B already cached. The script forces Hugging Face and Transformers offline mode; it does not download models. The current machine's environment is `backend/venv/bin/python`.

Create a nonsensitive fixture with macOS's installed Samantha voice:

```sh
mkdir -p /tmp/voicebox-stream-benchmark
cat > /tmp/voicebox-stream-benchmark/reference.txt <<'TEXT'
Please move the planning meeting to Thursday afternoon. We need to review the project timeline and confirm the next release date. Add a reminder to check the documentation before sending the update to the team.
TEXT
say -v Samantha -r 165 -f /tmp/voicebox-stream-benchmark/reference.txt -o /tmp/voicebox-stream-benchmark/fixture.aiff
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/voicebox-stream-benchmark/fixture.aiff /tmp/voicebox-stream-benchmark/fixture.wav
backend/venv/bin/python scripts/benchmark-streaming-dictation.py \
  /tmp/voicebox-stream-benchmark/fixture.wav \
  /tmp/voicebox-stream-benchmark/reference.txt \
  --runs 3 --output /tmp/voicebox-stream-benchmark/results.json
```

For a pause-rich fixture, synthesize each sentence separately, concatenate the PCM with one second of digital silence between sentences, and pass that WAV with the same complete reference. For forced-window coverage, use continuous speech lasting more than 20 seconds.

Each replay uses 100ms mono signed 16-bit PCM frames, contiguous sequence numbers and sample offsets, the production `StreamingCapture` worker, and a temporary data directory. No user captures are read or persisted. Output contains measurements, fixture hash and word error rates; no audio or transcript text. Reference normalization lowercases and extracts word tokens, ignoring punctuation; this is not an identifier/casing/code correctness metric.

The first batch run in each process includes model loading; subsequent batch runs are warm. Every streaming replay follows batch inference with warm models. Process-cold means a new Python process, not a cold filesystem cache. The first-import overhead happens before measured model loading. RSS uses `resource.getrusage`: bytes on macOS, KiB on Linux; it does not fully describe GPU allocation.

## Local evidence — 2026-09-17

Hardware: Apple M2 Max, 64 GiB RAM, macOS 26.6.2 arm64. Models: Whisper large-v3-turbo (`turbo`) and MLX Qwen3 0.6B 4-bit; English, default prose refinement flags. No adapters or learned corrections in the isolated data directory.

The three prose fixtures used guarded service source SHA256: `f9711a27f405cede51e74eb6dd60fb43127888f0c291374c3990b4a9c649ae27`. The subsequent technical fixture used `8d0c450967e2802b0887f540122afe2f809a5654e59cd0ba8e6959cefaa31751`, which adds a tested fallback for learned-correction suffix conflicts; the prose fixtures do not exercise that branch and were not repeated. Dependencies: MLX 0.32.2, mlx-audio 0.4.1, mlx-lm 0.31.1. A PyInstaller application build was running in the background during part of this work; no other inference benchmark was run concurrently. Timings are local smoke evidence, not controlled performance claims.

| Fixture | Duration | Warm batch stop-to-output | Streaming stop-to-output | Final quality |
| --- | ---: | ---: | ---: | --- |
| Short continuous prose | 11.17 s | 0.773 s | 0.794–0.806 s | Raw exactly matches batch; raw/refined WER 0 |
| Long continuous prose | 35.84 s | 1.604 s | 1.599–1.741 s | Raw exactly matches batch, raw WER 0.00917; refined WER 0 |
| Prose with one-second pauses | 40.61 s | 1.54 s | 0.706–0.710 s | Raw exactly matches batch; raw/refined WER 0 in both runs |
| Technical terms, numbers and negation with pauses | 12.83 s | 0.772 s | 0.851–0.888 s | Final refined output exactly matches batch; raw differs only in casing/punctuation |

Complete measurements, fixture hashes and source hashes are retained in [STREAMING_BENCHMARK_RESULTS.json](STREAMING_BENCHMARK_RESULTS.json). Each final fixture uses two replays: one process-cold batch, one warm batch, and two warm streaming runs. The paused fixture reduced the measured final wait by about 54%. First recognition arrived at 2.324 seconds, first accepted phrase at 3.61 seconds, and first refinement at 3.93 seconds. There were 33 updates before stop. Peak pending audio was 7.4 seconds and peak process RSS approximately 2.53 GiB. The short and long continuous fixtures produced their first speculative refinements at about 6.7 seconds, but did not reduce the final wait; the long fixture explicitly used full-audio reconciliation. Process-cold batch totals were 3.10 seconds (short), 4.03 seconds (long), and 3.97 seconds (paused). All final stream runs had no refinement exceptions.

Earlier versions failed quality checks despite appearing faster. An isolated phrase changed “Add a reminder to check the documentation…” into “Check the documentation…”, deleting the requested reminder action. Forced overlapping windows also lost content. The final service guards phrase content and uses full-audio final recognition after an unsafe forced seam. These are deliberate correctness/latency tradeoffs.

Small replay counts do not establish production median/P95 latency, real-microphone accuracy, or battery/thermal impact. Human recordings, richer identifiers/numbers, background inference contention, and installed-app delivery remain separate acceptance work. Whole-session full-audio fallback is expected to retain batch-like finalization cost for continuous long speech.

## Longer fixture

The continuous and paused long recordings use this exact text:

> Please move the planning meeting to Thursday afternoon. We need to review the project timeline and confirm the next release date. Add a reminder to check the documentation before sending the update to the team. The new version should include a clear explanation of the recording settings and microphone selection. During the review, compare the original transcript with the final output and make sure that every sentence is preserved. We should also test a longer recording with several pauses and verify that the final words arrive promptly. After the meeting, send a short summary of the decisions and assign each remaining task to the person responsible for completing it.

Save it as `/tmp/voicebox-stream-benchmark/long-reference.txt`. Use the same `say` and `afconvert` commands above for continuous speech. To reproduce the paused fixture exactly:

```python
from pathlib import Path
import subprocess
import wave

root = Path('/tmp/voicebox-stream-benchmark')
parts = root.joinpath('long-reference.txt').read_text().strip().split('. ')
frames = []
for index, phrase in enumerate(parts):
    source, target = root / f'part-{index}.aiff', root / f'part-{index}.wav'
    subprocess.run(['say', '-v', 'Samantha', '-r', '165', '-o', str(source), phrase], check=True)
    subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', str(source), str(target)], check=True)
    with wave.open(str(target)) as audio:
        frames.append(audio.readframes(audio.getnframes()))
    if index < len(parts) - 1:
        frames.append(bytes(32000))
with wave.open(str(root / 'pauses.wav'), 'wb') as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(16000)
    audio.writeframes(b''.join(frames))
```

## Technical fixture

Use the paused-generation recipe above with this reference:

> Set the retry count to seven. Do not disable authentication. The account balance is minus five dollars. Open package dot json before changing the port to eight thousand.

Both final refined outputs were exactly:

> Set the retry count to 7. Do not disable authentication. The account balance is minus $5. Open package.json before changing the port to 8000.

The amount, negation, filename and port survived in both paths. Raw streaming text differed from batch only in capitalization and one period. The word-form reference yields 21.4% WER in **both** paths because this simple scorer does not equate “seven” with “7”, “five dollars” with “$5”, or spoken “dot” with a literal dot; this is not evidence of a semantic regression. First streaming refinement arrived at 3.03 seconds. This synthetic example does not establish arbitrary identifier spelling, acronym recognition, or voice-to-code support. Its local diagnostic replay additionally logged these known synthetic strings to inspect the discrepancy; the reusable benchmark defaults to metrics only.
