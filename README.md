<p align="center">
  <img src=".github/assets/icon-dark.webp" alt="Voicebox" width="120" height="120" />
</p>

<h1 align="center">Voicebox</h1>

<p align="center">
  <strong>Local dictation for macOS.</strong><br/>
  Hold a hotkey, speak, and get ready-to-send text in your own words, pasted into any app.<br/>
  Everything runs on your Mac.
</p>

<br/>

## What is Voicebox?

Voicebox is a local-first dictation app for Apple Silicon Macs. Hold a global hotkey anywhere on your system and speak. When you let go, Whisper transcribes what you said, a local LLM cleans it up, and the result is pasted into the text field you were typing in.

The goal is text you could send as-is while keeping what you meant, in your own words. Refinement removes filler, stutters, false starts and self-corrections. It does not summarize or add anything. Voicebox also learns from the corrections you make.

- **Private.** Audio, transcripts, models and everything learned from your corrections stay on your machine. Nothing is hosted.
- **Native.** Built with Tauri (Rust), not Electron. Audio capture, the hotkey, focus tracking and paste run in native code, so they are fast.
- **Apple Silicon.** Whisper and the refinement LLM run on MLX (Metal).

---

## Features

### Global dictation

- **Configurable chords.** Hold-to-speak and tap-to-toggle chords can each be rebound in the in-app chord picker. If you tap `Space` while holding push-to-talk, the session switches to toggle mode without dropping any audio.
- **Native audio capture.** The microphone is captured in Rust and streamed to the local server while you speak. You can choose which input device to use.
- **Target-aware paste.** Text is pasted into the field that had focus when you started. Voicebox checks that field through Accessibility and saves and restores your clipboard, so the paste does not overwrite what you had copied.
- **On-screen pill.** A floating overlay shows whether Voicebox is recording, transcribing or refining.
- **Permission setup.** On first run, in-app screens guide you through granting Accessibility and Input Monitoring, with links straight to the right pages in System Settings.

### Speech-to-text

Transcription uses OpenAI Whisper on MLX. The same model handles dictation, the Captures tab and the `/transcribe` endpoint. It is loaded at startup, so the first dictation is as fast as the rest.

| Size                          | Notes                                                |
| ----------------------------- | ---------------------------------------------------- |
| Base / Small / Medium / Large | Standard Whisper quality ladder                      |
| Turbo                         | About 8x faster than Whisper Large with little quality loss |

### Local LLM refinement

A bundled Qwen3 model (0.6B, 1.7B or 4B) cleans up each transcript before it is pasted. It removes filler words, stutters and false starts, applies spoken self-corrections ("no, actually…", "I mean…"), and keeps technical terms exactly as you said them. Each of these behaviors can be turned on or off.

### Captures

Every dictation and uploaded audio file is saved in the Captures tab, with the original audio next to its transcript.

- **Replay, re-transcribe, refine.** You can run speech-to-text again with a different Whisper size, or run the raw transcript through the LLM again with different options.
- **Edit and report.** You can fix a transcript in place, or report a wrong transcription or refinement.
- **Local storage.** Audio and transcripts stay in your Voicebox data directory. Settings has a shortcut that opens that folder.

### Correction learning

The corrections you report become examples and rules. A periodic job builds those rules locally and tests each candidate against your past corrections, and it only keeps rules that improve the results. You can look at what was learned, run the job on demand, or roll back to an earlier set of rules.

### Writing style

"Match my writing" learns how you punctuate. A short calibration step asks you to rewrite a few refined paragraphs the way you would type them. Voicebox counts what you do at sentence breaks, with capitalization and with commas, and adds evidence from your later corrections. The refinement prompt and a final pass follow those habits. The final pass only changes punctuation and capitalization, never your words.

### Model management

- You can download, unload and delete models from the Models tab.
- Set `VOICEBOX_MODELS_DIR` to use a custom models directory. You can also move your models to another folder in the app, with progress shown.

---

## API

The local server listens on `http://127.0.0.1:17493`. Some useful endpoints:

```bash
# Transcribe an audio file
curl -X POST http://127.0.0.1:17493/transcribe \
  -F "file=@recording.wav" \
  -F "model=turbo"

# List captures
curl http://127.0.0.1:17493/captures

# Is the server up?
curl http://127.0.0.1:17493/health
```

Full API documentation is at `http://127.0.0.1:17493/docs` while the server is running.

---

## Tech Stack

| Layer       | Technology                                                                  |
| ----------- | --------------------------------------------------------------------------- |
| Desktop app | Tauri (Rust)                                                                |
| Native shim | Rust: audio capture, global hotkey, focus introspection, paste injection    |
| Frontend    | React, TypeScript, Tailwind CSS, Zustand, React Query                       |
| Backend     | FastAPI (Python), bundled as a sidecar binary                               |
| STT         | Whisper / Whisper Turbo on MLX                                              |
| Local LLM   | Qwen3 (0.6B / 1.7B / 4B) on MLX                                             |
| Database    | SQLite                                                                      |

---

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup.

### Quick Start

```bash
just setup   # creates the Python venv and installs all dependencies
just dev     # starts the backend and the desktop app
```

To install [just](https://github.com/casey/just), run `brew install just`. Run `just --list` to see every command.

**Prerequisites:** an Apple Silicon Mac, [Bun](https://bun.sh), [Rust](https://rustup.rs), [Python 3.11+](https://python.org), [Xcode](https://developer.apple.com/xcode/), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Building Locally

Voicebox is built and installed from this checkout. There are no hosted releases.

```bash
just build   # builds the server sidecar binary and the Tauri app
```

The app bundle is written to `tauri/src-tauri/target/release/bundle/`.

### Project Structure

```
voicebox/
├── app/              # React frontend
├── tauri/            # Desktop shell (Tauri + Rust native dictation code)
├── backend/          # Python FastAPI server (STT, refinement, captures, learning)
├── docs/             # Plans and project status
└── scripts/          # Build scripts
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
