# Bundled model files

- `silero_vad.onnx`: Silero VAD v5 voice activity detector
  (https://github.com/snakers4/silero-vad, MIT license), from
  `src/silero_vad/data/silero_vad.onnx`. SHA-256
  `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`.
  Used by `backend/services/speech_detect.py`, so Whisper never runs on audio
  without a voice in it.
