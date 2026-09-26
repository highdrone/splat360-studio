#!/usr/bin/env bash
#
# Splat360 Studio — build the macOS app (DMG + zip, arm64).
#
#   1. install frontend/desktop npm dependencies if missing
#   2. build the web UI (frontend/dist)
#   3. compile the Electron shell and run electron-builder
#      (`npm --prefix desktop run dist`)
#   4. print the DMG path
#
# Usage: scripts/build-mac.sh [--dir] [--skip-tests] [--notarize]
#
#   --dir          unpacked .app only (fast; no DMG)
#   --skip-tests   do not run the desktop/frontend test suites first
#   --notarize     force notarization (default: on when APPLE_ID,
#                  APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are all set)
#
# Signing: electron-builder picks up a "Developer ID Application" certificate
# from the keychain (or CSC_LINK / CSC_KEY_PASSWORD). Without one the build is
# unsigned and users must run:
#   xattr -dr com.apple.quarantine "/Applications/Splat360 Studio.app"
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$REPO_ROOT/frontend"
DESKTOP="$REPO_ROOT/desktop"

DIR_ONLY=0
RUN_TESTS=1
NOTARIZE=0
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then NOTARIZE=1; fi

for arg in "$@"; do
  case "$arg" in
    --dir) DIR_ONLY=1 ;;
    --skip-tests) RUN_TESTS=0 ;;
    --notarize) NOTARIZE=1 ;;
    -h | --help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RESET=$'\033[0m'; else C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RESET=""; fi
step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

[[ "$(uname -s)" == "Darwin" ]] || { echo "electron-builder can only produce a signed macOS app on macOS" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required (brew install node)" >&2; exit 1; }
node -e 'const [maj]=process.versions.node.split("."); if (+maj < 20) { console.error("node >= 20 required, found " + process.version); process.exit(1) }'

START_TS=$(date +%s)

step "Dependencies"
[[ -d "$FRONTEND/node_modules" ]] || npm --prefix "$FRONTEND" ci
[[ -d "$DESKTOP/node_modules" ]] || npm --prefix "$DESKTOP" ci
echo "ok"

if [[ $RUN_TESTS -eq 1 ]]; then
  step "Tests"
  npm --prefix "$DESKTOP" run typecheck
  npm --prefix "$DESKTOP" test
  npm --prefix "$FRONTEND" run typecheck
fi

step "Web UI (frontend/dist)"
npm --prefix "$FRONTEND" run build

step "Electron shell + electron-builder"
if [[ $NOTARIZE -eq 1 ]]; then
  echo "notarization: ${C_GREEN}on${C_RESET} (APPLE_ID=$APPLE_ID, team $APPLE_TEAM_ID)"
  EXTRA=(--config.mac.notarize=true)
else
  echo "notarization: ${C_YELLOW}off${C_RESET} (set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID to enable)"
  EXTRA=()
fi
# `dist` builds the frontend again (cheap, already cached by Vite) then runs electron-builder --mac.
if [[ $DIR_ONLY -eq 1 ]]; then
  npm --prefix "$DESKTOP" run dist:dir -- ${EXTRA[@]+"${EXTRA[@]}"}
else
  npm --prefix "$DESKTOP" run dist -- ${EXTRA[@]+"${EXTRA[@]}"}
fi

ELAPSED=$(( $(date +%s) - START_TS ))
step "Done in $((ELAPSED / 60)) min $((ELAPSED % 60)) s"
RELEASE="$DESKTOP/release"
if [[ $DIR_ONLY -eq 1 ]]; then
  APP="$(find "$RELEASE" -maxdepth 2 -name '*.app' -type d | head -n 1 || true)"
  echo "app: ${APP:-not found under $RELEASE}"
else
  DMG="$(find "$RELEASE" -maxdepth 1 -name '*.dmg' -type f | head -n 1 || true)"
  ZIP="$(find "$RELEASE" -maxdepth 1 -name '*.zip' -type f | head -n 1 || true)"
  if [[ -n "$DMG" ]]; then
    echo "DMG: ${C_GREEN}$DMG${C_RESET} ($(du -h "$DMG" | cut -f1))"
  else
    echo "DMG: not found under $RELEASE" >&2
    exit 1
  fi
  [[ -n "$ZIP" ]] && echo "zip: $ZIP"
  if [[ $NOTARIZE -eq 0 ]]; then
    echo
    echo "This build is not notarized. After installing, clear the quarantine flag:"
    echo "  xattr -dr com.apple.quarantine \"/Applications/Splat360 Studio.app\""
  fi
fi
