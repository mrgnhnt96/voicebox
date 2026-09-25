#!/bin/bash
# Install or update Voicebox on this Mac.
#
#   ./scripts/install.sh                  from a checkout
#   bash <(curl -fsSL https://raw.githubusercontent.com/mrgnhnt96/voicebox/main/scripts/install.sh)
#
# Checks what the build needs and says how to install anything missing,
# pulls the latest code, builds the server (only when it changed) and the
# app, and replaces /Applications/Voicebox.app. Every build is signed with
# the same identity, so updates keep the app's privacy permissions.
#
# Options:
#   --no-pull          build the checkout as it is
#   --rebuild-server   rebuild the Python server even if it hasn't changed
#   --no-launch        don't open Voicebox afterwards
#
# Run from outside a checkout, it clones into $VOICEBOX_DIR (default
# ~/voicebox), on $VOICEBOX_BRANCH (default the repo's default branch).
set -euo pipefail

repo_url="${VOICEBOX_REPO:-https://github.com/mrgnhnt96/voicebox.git}"
app="${VOICEBOX_APP:-/Applications/Voicebox.app}"
bundle_id="sh.voicebox.app"

pull=1
rebuild_server=0
launch=1
for arg in "$@"; do
  case "$arg" in
  --no-pull) pull=0 ;;
  --rebuild-server) rebuild_server=1 ;;
  --no-launch) launch=0 ;;
  -h | --help)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown option: $arg (see --help)" >&2
    exit 1
    ;;
  esac
done

if [ -t 1 ]; then
  bold=$'\033[1m' dim=$'\033[2m' red=$'\033[31m' green=$'\033[32m' yellow=$'\033[33m' reset=$'\033[0m'
else
  bold='' dim='' red='' green='' yellow='' reset=''
fi
step() { echo; echo "${bold}==> $*${reset}"; }
ok() { echo "  ${green}✓${reset} $*"; }
warn() { echo "  ${yellow}!${reset} $*"; }
die() {
  echo "${red}✗ $*${reset}" >&2
  exit 1
}

# Tools installed by rustup and bun's installers live here, and a fresh
# shell may not have them on PATH yet.
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

# ─── Find the checkout ────────────────────────────────────────────────

script_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$script_dir" ] && [ -f "$script_dir/../tauri/src-tauri/tauri.conf.json" ]; then
  root="$(cd "$script_dir/.." && pwd)"
else
  # Run from curl: get a checkout, then run its own copy of this script.
  dir="${VOICEBOX_DIR:-$HOME/voicebox}"
  command -v git >/dev/null 2>&1 ||
    die "git is missing. Install the Xcode Command Line Tools: xcode-select --install"
  if [ ! -d "$dir/.git" ]; then
    step "Cloning Voicebox into $dir"
    if [ -n "${VOICEBOX_BRANCH:-}" ]; then
      git clone --branch "$VOICEBOX_BRANCH" "$repo_url" "$dir"
    else
      git clone "$repo_url" "$dir"
    fi
  fi
  exec "$dir/scripts/install.sh" "$@"
fi
cd "$root"

# ─── Check what the build needs ───────────────────────────────────────

step "Checking requirements"

if [ "$(uname)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  die "Voicebox only runs on Apple Silicon Macs."
fi

missing=()
need() { missing+=("$1|$2"); }
has_brew=0
command -v brew >/dev/null 2>&1 && has_brew=1
brew_first=""
[ "$has_brew" = 1 ] || brew_first='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'$'\n      '

if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode Command Line Tools"
else
  need "Xcode Command Line Tools (compilers, git, codesign)" "xcode-select --install"
fi

if command -v git >/dev/null 2>&1; then ok "git"; fi

if ./scripts/setup-python.sh --check; then
  ok "Python 3.12"
else
  need "Python 3.12 (the server's ML packages don't support 3.13 yet)" "${brew_first}brew install python@3.12"
fi

if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
  ok "Rust $(rustc --version | cut -d' ' -f2)"
else
  need "Rust (builds the app shell)" "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

if command -v bun >/dev/null 2>&1; then
  ok "Bun $(bun --version)"
  bun=(bun)
elif command -v npx >/dev/null 2>&1; then
  ok "Bun (through npx)"
  bun=(npx --yes bun@1.3.8)
else
  need "Bun (builds the interface)" "curl -fsSL https://bun.sh/install | bash"
fi

free_gb=$(df -g "$root" | awk 'NR == 2 { print $4 }')
if [ "${free_gb:-0}" -lt 15 ]; then
  warn "Only ${free_gb} GB free. A first build needs about 15 GB (Python packages, Rust build)."
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "${red}${bold}Some things Voicebox needs to build are missing.${reset} Install them, then run this again:"
  for item in "${missing[@]}"; do
    echo
    echo "  ${bold}${item%%|*}${reset}"
    echo "      ${item#*|}"
  done
  echo
  echo "${dim}Open a new terminal after installing, so the new commands are on your PATH.${reset}"
  exit 1
fi

if [ ! -w "$(dirname "$app")" ]; then
  die "$(dirname "$app") isn't writable by $(whoami). Use an administrator account, or set VOICEBOX_APP=\$HOME/Applications/Voicebox.app."
fi

# ─── Get the latest code ──────────────────────────────────────────────

if [ "$pull" = 1 ] && [ -d .git ] && git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  step "Updating the code"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    warn "This checkout has local changes, so it's built as it is."
  elif git pull --ff-only --quiet; then
    ok "$(git rev-parse --abbrev-ref HEAD) at $(git log -1 --format='%h %s')"
  else
    warn "Couldn't fast-forward to the latest code; building what's here."
  fi
fi

# A stamp of the inputs, to skip steps whose inputs haven't changed.
stamp_of() { { "$@" || true; } 2>/dev/null | shasum | cut -d' ' -f1; }

# ─── Dependencies ─────────────────────────────────────────────────────

step "Installing interface dependencies"
"${bun[@]}" install
ok "JavaScript packages"

step "Setting up the Python environment"
python_stamp=$(stamp_of cat backend/requirements.txt scripts/setup-python.sh)
python_stamp_file=backend/venv/.voicebox-install-stamp
if [ -f "$python_stamp_file" ] && [ "$(cat "$python_stamp_file")" = "$python_stamp" ]; then
  ok "Up to date"
else
  ./scripts/setup-python.sh
  echo "$python_stamp" >"$python_stamp_file"
  ok "Python packages"
fi

# ─── Build ────────────────────────────────────────────────────────────

step "Building the server"
server_inputs() {
  git rev-parse HEAD:backend
  git diff HEAD -- backend
  git ls-files --others --exclude-standard backend
  cat scripts/build-server.sh "$python_stamp_file"
}
server_stamp=$(stamp_of server_inputs)
server_stamp_file=tauri/src-tauri/binaries/.voicebox-server-stamp
if [ "$rebuild_server" = 0 ] && [ -x tauri/src-tauri/binaries/voicebox-server/voicebox-server ] &&
  [ -f "$server_stamp_file" ] && [ "$(cat "$server_stamp_file")" = "$server_stamp" ]; then
  ok "Unchanged since the last build"
else
  echo "  ${dim}This takes a few minutes.${reset}"
  ./scripts/build-server.sh
  echo "$server_stamp" >"$server_stamp_file"
  ok "Server built"
fi

step "Building the app"
echo "  ${dim}The first build compiles the Rust app shell and takes a while.${reset}"
VOICEBOX_APP="$app" ./scripts/build-local-app.sh
built=tauri/src-tauri/target/release/bundle/macos/Voicebox.app
ok "Built and signed with \"$(codesign -dvv "$built" 2>&1 | sed -n 's/^Authority=//p' | head -n 1)\""

# ─── Install ──────────────────────────────────────────────────────────

step "Installing to $app"
requirement() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'; }
old_requirement=""
[ -d "$app" ] && old_requirement=$(requirement "$app")
new_requirement=$(requirement "$built")

if pgrep -f "$app/Contents/MacOS/" >/dev/null 2>&1; then
  osascript -e 'quit app id "'"$bundle_id"'"' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -f "$app/Contents/MacOS/" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -f "$app/Contents/MacOS/" 2>/dev/null || true
  ok "Quit the running app"
fi
rm -rf "$app"
ditto "$built" "$app"
codesign --verify --deep --strict "$app"
ok "Installed"

if [ -n "$old_requirement" ] && [ "$old_requirement" != "$new_requirement" ]; then
  # The old grants belong to the old signature and no longer apply. Clear
  # them so System Settings asks again cleanly instead of showing switches
  # that are on but don't work.
  for service in Microphone Accessibility ListenEvent PostEvent; do
    tccutil reset "$service" "$bundle_id" >/dev/null 2>&1 || true
  done
  warn "This build is signed differently from the one it replaced, so macOS"
  warn "will ask for Microphone, Accessibility and Input Monitoring again."
  warn "It's signed the same way from now on, so updates keep them."
fi

if [ "$launch" = 1 ]; then
  open "$app"
  ok "Opened Voicebox"
fi

echo
echo "${green}${bold}Voicebox is installed.${reset} Run this script again to update."
