#!/bin/bash
# Print the SHA-1 of the code-signing identity to sign Voicebox with on this
# Mac, creating a local one the first time there is none.
#
# macOS keeps an app's privacy grants (Microphone, Accessibility, Input
# Monitoring) only while its signature's designated requirement stays the
# same. Ad-hoc signing changes it on every build, so every update would lose
# them. Signing every build with the same identity keeps them.
#
# The identity, in order: VOICEBOX_SIGNING_IDENTITY; the one the installed
# app is signed with; the one used last time; an Apple Development
# certificate; otherwise a self-signed "Voicebox Local Signing" certificate,
# made once and kept in its own keychain.
set -euo pipefail

app="${VOICEBOX_APP:-/Applications/Voicebox.app}"
state="$HOME/Library/Application Support/Voicebox Installer"
keychain="$HOME/Library/Keychains/voicebox-signing.keychain-db"
local_name="Voicebox Local Signing"
mkdir -p "$state"

log() { echo "$@" >&2; }

if [ -n "${VOICEBOX_SIGNING_IDENTITY:-}" ]; then
  echo "$VOICEBOX_SIGNING_IDENTITY"
  exit 0
fi

# codesign only finds keys in unlocked keychains on the search list.
open_keychain() {
  security unlock-keychain -p "$(cat "$state/keychain-password")" "$keychain"
  local listed=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#\"}"
    listed+=("${line%\"}")
  done < <(security list-keychains -d user)
  for existing in "${listed[@]}"; do
    [ "$existing" = "$keychain" ] && return 0
  done
  security list-keychains -d user -s "${listed[@]}" "$keychain"
}
if [ -f "$keychain" ] && [ -f "$state/keychain-password" ]; then
  open_keychain
fi

# "HASH NAME" for each valid code-signing identity.
identities() {
  security find-identity -v -p codesigning |
    sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "\(.*\)"$/\1 \2/p'
}

# Prints the hash of the named identity and remembers the name for next time.
pick() {
  local hash
  hash=$(identities | awk -v name="$1" '{ h = $1; sub(/^[^ ]* /, ""); if ($0 == name) { print h; exit } }')
  [ -n "$hash" ] || return 1
  echo "$1" >"$state/identity"
  echo "$hash"
}

create_local_identity() {
  local tmp password
  tmp=$(mktemp -d)
  if [ ! -f "$state/local-signing.pem" ]; then
    log "Creating a code-signing certificate for this Mac, \"$local_name\"."
    cat >"$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $local_name
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$tmp/cert.cnf" \
      -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
    /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
      -name "$local_name" -out "$tmp/identity.p12" -passout pass:voicebox
    if [ ! -f "$keychain" ]; then
      password=$(/usr/bin/openssl rand -hex 24)
      (umask 077 && echo "$password" >"$state/keychain-password")
      security create-keychain -p "$password" "$keychain"
      # Never lock on its own, so builds don't stop to ask for it.
      security set-keychain-settings "$keychain"
    fi
    password=$(cat "$state/keychain-password")
    open_keychain
    security import "$tmp/identity.p12" -k "$keychain" -P voicebox -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
    cp "$tmp/cert.pem" "$state/local-signing.pem"
  fi
  rm -rf "$tmp"
  log "macOS will ask for your password to trust \"$local_name\" for code signing."
  log "This happens once; later installs reuse it."
  security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$state/local-signing.pem"
}

if [ -d "$app" ]; then
  installed=$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=//p' | head -n 1)
  if [ -n "$installed" ] && pick "$installed"; then exit 0; fi
fi
if [ -f "$state/identity" ] && pick "$(cat "$state/identity")"; then exit 0; fi
apple=$(identities | sed -n 's/^[0-9A-F]* \(Apple Development: .*\)$/\1/p' | head -n 1)
if [ -n "$apple" ] && pick "$apple"; then exit 0; fi

create_local_identity
if pick "$local_name"; then exit 0; fi
log "Could not set up \"$local_name\" for code signing."
log "Open Keychain Access, find it in the voicebox-signing keychain, and set"
log "Trust > Code Signing to Always Trust, then run the install again."
exit 1
