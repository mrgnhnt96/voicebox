#!/bin/bash
# Interleave MLX and whisper.cpp variants round by round so GPU contention from
# other processes hits every engine alike.
# usage: run_whisper_rounds.sh <scratch> <rounds> <runs_per_fixture>
#   <scratch>/fx/*.wav         16 kHz mono fixtures
#   <scratch>/models/ggml-*.bin
#   <scratch>/data             copy of the Voicebox data dir
#   $WRBENCH                   path to the built wrbench binary
# Output: <scratch>/whisper.jsonl (appended), one JSON object per line.
set -u
S=$1; ROUNDS=$2; RUNS=$3
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PY=${PY:-$REPO/backend/venv/bin/python}   # a worktree has no venv: set PY to the main checkout's
[ -x "$PY" ] || { echo "PY not executable: $PY" >&2; exit 1; }
[ -x "${WRBENCH:-}" ] || { echo "set WRBENCH to the wrbench binary" >&2; exit 1; }
OUT=$S/whisper.jsonl
FX=$(ls "$S"/fx/*.wav)
M=$S/models
for r in $(seq 1 "$ROUNDS"); do
  echo "round $r $(date +%T) load: $(sysctl -n vm.loadavg)" >&2
  "$PY" "$HERE/mlx_whisper.py" "$REPO" "$S/data" "$RUNS" $FX 2>/dev/null | sed "s/^{/{\"round\": $r, /" >> "$OUT"
  "$WRBENCH" "$M/ggml-large-v3-turbo.bin" "$RUNS" $FX 2>/dev/null | sed "s/^{/{\"round\":$r,/" >> "$OUT"
  WR_FLASH=1 "$WRBENCH" "$M/ggml-large-v3-turbo.bin" "$RUNS" $FX 2>/dev/null | sed "s/^{/{\"round\":$r,/" >> "$OUT"
  WR_FLASH=1 "$WRBENCH" "$M/ggml-large-v3-turbo-q8_0.bin" "$RUNS" $FX 2>/dev/null | sed "s/^{/{\"round\":$r,/" >> "$OUT"
  WR_FLASH=1 "$WRBENCH" "$M/ggml-large-v3-turbo-q5_0.bin" "$RUNS" $FX 2>/dev/null | sed "s/^{/{\"round\":$r,/" >> "$OUT"
  WR_FLASH=1 WR_NO_TS=1 "$WRBENCH" "$M/ggml-large-v3-turbo.bin" "$RUNS" $FX 2>/dev/null | sed "s/^{/{\"round\":$r,/" >> "$OUT"
  WR_FLASH=1 WR_AUDIO_CTX=-1 "$WRBENCH" "$M/ggml-large-v3-turbo.bin" "$RUNS" $FX 2>/dev/null | sed "s/^{/{\"round\":$r,/" >> "$OUT"
done
echo "done $(date +%T)" >&2
