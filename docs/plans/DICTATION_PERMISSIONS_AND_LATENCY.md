# Dictation permissions, paste errors, and short-recording latency

Observed on the installed macOS build: Captures settings showed Accessibility permission missing while auto-paste was enabled. Local ad-hoc rebuilds can invalidate that approval. The code cannot grant Accessibility permission; the user must enable the installed Voicebox app in System Settings. This is separate from microphone permission.

A local read-only replay of a 1.16-second saved capture measured approximately 4.10s for cold librosa audio loading, 4.65s for first transcription, and 0.58s for warm transcription. The capture endpoint had been decoding/resampling WAV audio solely to calculate duration, then asking Whisper to decode it again. It now reads WAV header metadata with soundfile and lets Whisper decode the recording. The updated production capture service measured 2.88s on first use and 0.58s warm in a subsequent local run. These are indicative process-cold measurements, not controlled performance guarantees; model initialization, queueing and low-confidence Whisper retries can still cause delays. No indefinite warm transcription stall was reproduced.

The recording pill now says Opening microphone while acquiring permission/device access, and switches to Recording only after MediaRecorder actually starts. Known permission denials stop before getUserMedia; browsers that cannot query microphone permission still rely on getUserMedia to grant or reject access. Rejections never start MediaRecorder or upload audio.

Final text delivery is now awaited before showing Done. Missing focus, native paste errors and false native paste results surface an error instead of being silently ignored. Text remains in Captures. Permission grants are not changed automatically.

Validation: three frontend regressions and one WAV fast-path regression failed before the changes and passed afterward. Full focused checks: 11 frontend tests, 39 backend tests, and app/web TypeScript checks passed. The frontend uses media-device/native-delivery fakes; this does not verify system permission prompts or real target-app insertion.
