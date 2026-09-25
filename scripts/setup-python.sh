#!/bin/bash
# Create backend/venv with Python 3.12 and install the server's dependencies.
# Python 3.12 is required: numba (pinned below 0.61 for librosa) has no
# wheels for 3.13.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Voicebox requires an Apple Silicon Mac (arm64 macOS)." >&2
  exit 1
fi

venv=backend/venv
is_312() { [ -x "$1" ] && [ "$("$1" -c 'import sys; print(sys.version_info[:2] == (3, 12))' 2>/dev/null)" = True ]; }

# A Python 3.12 to build the venv with: on PATH, Homebrew's, or uv's.
find_python() {
  local candidate
  for candidate in "$(command -v python3.12 2>/dev/null)" /opt/homebrew/opt/python@3.12/bin/python3.12 \
    "$(command -v uv >/dev/null 2>&1 && uv python find 3.12 2>/dev/null)"; do
    if [ -n "$candidate" ] && is_312 "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# --check: succeed when the venv can be set up, without changing anything.
if [ "${1:-}" = --check ]; then
  is_312 "$venv/bin/python" || find_python >/dev/null
  exit
fi

if ! is_312 "$venv/bin/python"; then
  python=$(find_python) || {
    echo "Python 3.12 not found. Install it with: brew install python@3.12" >&2
    exit 1
  }
  if [ -d "$venv" ]; then
    echo "Recreating $venv with Python 3.12..."
    rm -rf "$venv"
  fi
  echo "Creating Python virtual environment..."
  "$python" -m venv "$venv"
fi

pip="$venv/bin/pip"
echo "Installing Python dependencies..."
"$pip" install --upgrade pip -q
"$pip" install -r backend/requirements.txt
# mlx-lm and mlx-audio declare transformers>=5.x, which conflicts with our
# transformers<=4.57.x cap, so install them --no-deps (their runtime deps
# are covered by requirements.txt — see the note there)
"$pip" install --no-deps mlx-lm==0.31.1 mlx-audio==0.4.1
"$pip" install pyinstaller ruff pytest pytest-asyncio -q
echo "Python environment ready."
