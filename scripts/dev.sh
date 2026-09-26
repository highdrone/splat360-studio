#!/usr/bin/env bash
#
# Splat360 Studio — development runner.
#
# Starts the Python engine with auto-reload and the Vite dev server for the
# web UI, and optionally the Electron shell. Everything is stopped when this
# script exits (Ctrl-C).
#
# Usage: scripts/dev.sh [--desktop] [--port N] [--no-frontend]
#
#   --desktop       also start the Electron shell (`npm --prefix desktop run dev`).
#                   The shell spawns its own engine on a free port and loads the
#                   Vite dev server at http://localhost:5173.
#   --port N        engine port for the browser workflow (default 8765; the Vite
#                   proxy in frontend/vite.config.ts targets 8765).
#   --no-frontend   engine only.
#
# Browser workflow: open http://localhost:5173 (UI with /api proxied to the
# engine) or http://127.0.0.1:8765 (engine, serves frontend/dist if built).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${SPLAT360_DATA_DIR:-$HOME/Library/Application Support/Splat360}"
VENV_DIR="$DATA_DIR/venv"
PORT=8765
WITH_DESKTOP=0
WITH_FRONTEND=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --desktop) WITH_DESKTOP=1 ;;
    --no-frontend) WITH_FRONTEND=0 ;;
    --port) shift; PORT="${1:?--port needs a value}" ;;
    --port=*) PORT="${1#--port=}" ;;
    -h | --help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -t 1 ]]; then C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'; else C_BOLD=""; C_DIM=""; C_RESET=""; fi
log() { printf '%s[dev]%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }

# --- engine command ---------------------------------------------------------
if [[ -x "$VENV_DIR/bin/splat360" ]]; then
  SPLAT360=("$VENV_DIR/bin/splat360")
elif [[ -x "$REPO_ROOT/engine/.venv/bin/splat360" ]]; then
  SPLAT360=("$REPO_ROOT/engine/.venv/bin/splat360")
elif command -v splat360 >/dev/null 2>&1; then
  SPLAT360=("$(command -v splat360)")
elif python3 -c "import splat360" >/dev/null 2>&1; then
  SPLAT360=(python3 -m splat360)
else
  echo "splat360 engine not installed. Run scripts/setup-mac.sh (or pip install -e 'engine[dev]')." >&2
  exit 1
fi

# Tools installed by setup-mac.sh must be reachable even from a bare shell.
export PATH="$DATA_DIR/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
export SPLAT360_DATA_DIR="$DATA_DIR"

# --- process management -----------------------------------------------------
PIDS=()

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  log "stopping…"
  local pid
  for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill_tree "$pid"; done
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

start() {
  # start <label> <command...>
  local label="$1"; shift
  log "starting $label: ${C_DIM}$*${C_RESET}"
  "$@" 2>&1 | sed -u "s/^/[$label] /" &
  # $! is the sed; find the actual command pid as its sibling in the pipeline
  local sed_pid=$!
  local cmd_pid
  cmd_pid="$(pgrep -P $$ -n 2>/dev/null | head -n 1 || true)"
  PIDS+=("$sed_pid")
  [[ -n "$cmd_pid" && "$cmd_pid" != "$sed_pid" ]] && PIDS+=("$cmd_pid")
}

# --- go -----------------------------------------------------------------------
if [[ $WITH_FRONTEND -eq 1 && ! -d "$REPO_ROOT/frontend/node_modules" ]]; then
  log "installing frontend dependencies"
  npm --prefix "$REPO_ROOT/frontend" install
fi
if [[ $WITH_DESKTOP -eq 1 && ! -d "$REPO_ROOT/desktop/node_modules" ]]; then
  log "installing desktop dependencies"
  npm --prefix "$REPO_ROOT/desktop" install
fi

(cd "$REPO_ROOT/engine" && start engine "${SPLAT360[@]}" --data-dir "$DATA_DIR" serve --host 127.0.0.1 --port "$PORT" --reload)

if [[ $WITH_FRONTEND -eq 1 ]]; then
  start frontend npm --prefix "$REPO_ROOT/frontend" run dev -- --port 5173
fi

if [[ $WITH_DESKTOP -eq 1 ]]; then
  # The shell waits for the Vite server itself; give it a head start anyway.
  sleep 2
  start desktop npm --prefix "$REPO_ROOT/desktop" run dev
fi

log "engine  → http://127.0.0.1:$PORT   (API docs: /api/docs)"
[[ $WITH_FRONTEND -eq 1 ]] && log "web UI  → http://localhost:5173"
log "press Ctrl-C to stop everything"
wait
