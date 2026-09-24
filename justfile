# Voicebox development commands (macOS, Apple Silicon)
# Install: brew install just (or cargo install just)
# Usage: just --list

# Directories
backend_dir := "backend"
tauri_dir := "tauri"
app_dir := "app"
venv := backend_dir / "venv"

venv_bin := venv / "bin"
python := venv_bin / "python"
pip := venv_bin / "pip"

# Detect best python for venv creation
system_python := `command -v python3.12 2>/dev/null || command -v python3.13 2>/dev/null || echo python3`

# ─── Setup ────────────────────────────────────────────────────────────

# Full project setup (python venv + JS deps + dev sidecar)
setup: setup-python setup-js
    @echo ""
    @echo "Setup complete! Run: just dev"

# Create venv and install Python dependencies
setup-python:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d "{{ venv }}" ]; then
        echo "Creating Python virtual environment..."
        PY_MINOR=$({{ system_python }} -c "import sys; print(sys.version_info[1])")
        if [ "$PY_MINOR" -gt 13 ]; then
            echo "Warning: Python 3.$PY_MINOR detected. ML packages may not be compatible."
            echo "Recommended: brew install python@3.12"
        fi
        {{ system_python }} -m venv {{ venv }}
    fi
    echo "Installing Python dependencies..."
    {{ pip }} install --upgrade pip -q
    {{ pip }} install -r {{ backend_dir }}/requirements.txt
    # Apple Silicon: install MLX backend
    if [ "$(uname -m)" = "arm64" ] && [ "$(uname)" = "Darwin" ]; then
        echo "Detected Apple Silicon — installing MLX dependencies..."
        {{ pip }} install -r {{ backend_dir }}/requirements-mlx.txt
        # mlx-lm and mlx-audio declare transformers>=5.x, which conflicts with
        # our transformers<=4.57.x cap, so install them --no-deps (their other
        # runtime deps are covered by requirements.txt / requirements-mlx.txt —
        # see the note in requirements-mlx.txt and .github/workflows/release.yml)
        {{ pip }} install --no-deps mlx-lm==0.31.1
        {{ pip }} install --no-deps mlx-audio==0.4.1
    fi
    {{ pip }} install pyinstaller ruff pytest pytest-asyncio -q
    echo "Python environment ready."

# Install JavaScript dependencies
setup-js:
    bun install

# ─── Development ──────────────────────────────────────────────────────

# Start backend (if not already running) + frontend for development
dev: _ensure-venv _ensure-sidecar
    #!/usr/bin/env bash
    set -euo pipefail

    backend_pid=""
    if curl -sf http://127.0.0.1:17493/health > /dev/null 2>&1; then
        echo "Backend already running on http://localhost:17493"
    else
        echo "Starting backend on http://localhost:17493 ..."
        {{ venv_bin }}/uvicorn backend.main:app --reload --port 17493 &
        backend_pid=$!
        sleep 2
    fi

    trap '[ -n "$backend_pid" ] && kill "$backend_pid" 2>/dev/null; wait' EXIT

    echo "Starting Tauri desktop app..."
    cd {{ tauri_dir }} && bun run tauri dev

# Start backend only
dev-backend: _ensure-venv
    {{ venv_bin }}/uvicorn backend.main:app --reload --port 17493

# Start Tauri desktop app only (backend must be running separately)
dev-frontend: _ensure-sidecar
    cd {{ tauri_dir }} && bun run tauri dev

# Kill all dev processes
kill:
    -pkill -f "uvicorn backend.main:app" 2>/dev/null || true
    -pkill -f "vite" 2>/dev/null || true
    @echo "Dev processes killed."

# ─── Build ────────────────────────────────────────────────────────────

# Build everything (server binary + desktop app)
build: build-server build-tauri

# Build Python server binary
build-server: _ensure-venv
    PATH="{{ venv_bin }}:$PATH" ./scripts/build-server.sh

# Build Tauri desktop app
build-tauri:
    cd {{ tauri_dir }} && bun run tauri build

# ─── Code Quality ────────────────────────────────────────────────────

# Run all checks (JS + Python lint + format)
check: check-js check-python

# JS/TS: lint + format + typecheck (Biome)
check-js:
    bun run check

# Python: lint + format check (ruff)
check-python: _ensure-venv
    {{ venv_bin }}/ruff check {{ backend_dir }}
    {{ venv_bin }}/ruff format --check {{ backend_dir }}

# Lint with Biome (JS) + ruff (Python)
lint: _ensure-venv
    bun run lint
    {{ venv_bin }}/ruff check {{ backend_dir }}

# Format with Biome (JS) + ruff (Python)
format: _ensure-venv
    bun run format
    {{ venv_bin }}/ruff format {{ backend_dir }}

# Fix lint + format issues (JS + Python)
fix: _ensure-venv
    bun run check:fix
    {{ venv_bin }}/ruff check {{ backend_dir }} --fix
    {{ venv_bin }}/ruff format {{ backend_dir }}

# Python lint only
lint-python: _ensure-venv
    {{ venv_bin }}/ruff check {{ backend_dir }}

# Python format only
format-python: _ensure-venv
    {{ venv_bin }}/ruff format {{ backend_dir }}

# Python auto-fix lint issues
fix-python: _ensure-venv
    {{ venv_bin }}/ruff check {{ backend_dir }} --fix
    {{ venv_bin }}/ruff format {{ backend_dir }}

# Run Python tests
test: _ensure-venv
    {{ venv_bin }}/python -m pytest {{ backend_dir }}/tests -v

# ─── Database ─────────────────────────────────────────────────────────

# Initialize SQLite database
db-init: _ensure-venv
    {{ python }} -c "from backend.database import init_db; init_db()"

# Reset database (delete + reinit)
db-reset:
    rm -f {{ backend_dir }}/data/voicebox.db
    just db-init

# ─── Utilities ────────────────────────────────────────────────────────

# Generate TypeScript API client (backend must be running)
generate-api:
    ./scripts/generate-api.sh

# Open API docs in browser
docs:
    open http://localhost:17493/docs

# Tail backend logs
logs:
    tail -f {{ backend_dir }}/logs/*.log 2>/dev/null || echo "No log files found"

# ─── Clean ────────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf {{ tauri_dir }}/src-tauri/target/release
    rm -rf {{ app_dir }}/dist

# Clean Python venv and cache
clean-python:
    rm -rf {{ venv }}
    find {{ backend_dir }} -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# Nuclear clean (everything including node_modules)
clean-all: clean clean-python
    rm -rf node_modules
    rm -rf {{ app_dir }}/node_modules
    rm -rf {{ tauri_dir }}/node_modules
    cd {{ tauri_dir }}/src-tauri && cargo clean

# ─── Internal ─────────────────────────────────────────────────────────

# Ensure venv exists (prompt to run setup if not)
[private]
_ensure-venv:
    #!/usr/bin/env bash
    if [ ! -d "{{ venv }}" ]; then
        echo "Python venv not found. Run: just setup"
        exit 1
    fi

# Ensure Tauri dev sidecar placeholder exists
[private]
_ensure-sidecar:
    bun run setup:dev
