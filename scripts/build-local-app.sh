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

# The server folder is copied into the app as-is, so sign its code first:
# every library, then the executable with the app's hardened-runtime
# entitlements. Tauri then seals the folder into the app signature.
server=tauri/src-tauri/binaries/voicebox-server
if [ ! -x "$server/voicebox-server" ]; then
  echo "Server not built at $server. Run scripts/build-server.sh first." >&2
  exit 1
fi
find "$server/_internal" -type f -print0 | xargs -0 file | grep 'Mach-O' | cut -d: -f1 | tr '\n' '\0' |
  xargs -0 -n 32 -P 8 codesign --force --timestamp=none --options runtime --sign "$identity"
codesign --force --timestamp=none --options runtime --entitlements tauri/src-tauri/Entitlements.plist \
  --sign "$identity" "$server/voicebox-server"

config=$(mktemp /tmp/voicebox-local-signing.XXXXXX)
trap 'rm -f "$config"' EXIT
python3 - "$config" "$identity" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as config:
    json.dump({'bundle': {'createUpdaterArtifacts': False, 'macOS': {'signingIdentity': sys.argv[2]}}}, config)
PY
npx --yes bun@1.3.8 run --cwd tauri tauri build --bundles app --config "$config"
codesign --verify --deep --strict tauri/src-tauri/target/release/bundle/macos/Voicebox.app
