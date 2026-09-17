#!/bin/bash
# Build a local macOS app with a stable signing identity so privacy grants can persist.
# Backend binaries must already exist (run build-server.sh when backend code changes).
set -euo pipefail
cd "$(dirname "$0")/.."
identity="${VOICEBOX_SIGNING_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development:.*\)"/\1/p' | head -n 1)
fi
if [ -z "$identity" ]; then
  echo 'No Apple Development signing identity found. Set VOICEBOX_SIGNING_IDENTITY to your signing certificate.' >&2
  exit 1
fi
config=$(mktemp /tmp/voicebox-local-signing.XXXXXX)
trap 'rm -f "$config"' EXIT
python3 - "$config" "$identity" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as config:
    json.dump({'bundle': {'createUpdaterArtifacts': False, 'macOS': {'signingIdentity': sys.argv[2]}}}, config)
PY
npx --yes bun@1.3.8 run --cwd tauri tauri build --bundles app --config "$config"
codesign --verify --deep --strict tauri/src-tauri/target/release/bundle/macos/Voicebox.app
