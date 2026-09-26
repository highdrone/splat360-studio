#!/usr/bin/env bash
#
# Splat360 Studio — one-shot macOS setup.
#
# Installs everything the engine needs on an Apple Silicon Mac:
#
#   1. Homebrew (prompted if missing)
#   2. ffmpeg, COLMAP, Python 3.12 via Homebrew   (+ GLOMAP with --with-glomap)
#   3. the engine virtualenv the desktop app expects:
#        ~/Library/Application Support/Splat360/venv
#      with `pip install -e "<repo>/engine[dev]"`
#   4. Rust (rustup) and the Brush Gaussian-splat trainer, built from source,
#      symlinked into ~/Library/Application Support/Splat360/bin
#   5. `splat360 doctor`
#
# Idempotent: re-running skips everything that is already installed.
#
# Usage: scripts/setup-mac.sh [--no-trainer] [--with-glomap] [--engine-only] [--yes]
#
#   --no-trainer   skip Rust + Brush (pipeline falls back to a point-cloud preview)
#   --with-glomap  also install GLOMAP (optional faster global SfM)
#   --engine-only  only create/update the Python venv (no Homebrew, no trainer)
#   --yes          do not prompt (assume yes for the Homebrew installer)
#
# Environment overrides:
#   SPLAT360_DATA_DIR   data directory (default ~/Library/Application Support/Splat360)
#   SPLAT360_PYTHON     interpreter used to create the venv
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
WITH_TRAINER=1
WITH_GLOMAP=0
ENGINE_ONLY=0
ASSUME_YES=0

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --no-trainer) WITH_TRAINER=0 ;;
    --with-glomap) WITH_GLOMAP=1 ;;
    --engine-only) ENGINE_ONLY=1; WITH_TRAINER=0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  C_RESET=$(tput sgr0); C_BOLD=$(tput bold)
  C_GREEN=$(tput setaf 2); C_YELLOW=$(tput setaf 3); C_RED=$(tput setaf 1); C_BLUE=$(tput setaf 4); C_DIM=$(tput dim)
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_DIM=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
skip()  { printf '  %s•%s %s %s(already installed)%s\n' "$C_DIM" "$C_RESET" "$*" "$C_DIM" "$C_RESET"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf '  %s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; }
note()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
die()   { fail "$@"; exit 1; }

confirm() {
  # confirm "question" -> 0 when yes
  if [[ $ASSUME_YES -eq 1 ]]; then return 0; fi
  if [[ ! -t 0 ]]; then
    warn "no terminal to ask '$1'; pass --yes to proceed non-interactively"
    return 1
  fi
  local reply
  read -r -p "  $1 [Y/n] " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE_DIR="$REPO_ROOT/engine"
DATA_DIR="${SPLAT360_DATA_DIR:-$HOME/Library/Application Support/Splat360}"
VENV_DIR="$DATA_DIR/venv"          # must match desktop/src/helpers.ts venvDirFor()
BIN_DIR="$DATA_DIR/bin"            # searched by the engine (config.extra_bin_dirs) and the desktop shell
CARGO_BIN="$HOME/.cargo/bin"
BRUSH_REPO="https://github.com/ArthurBrussee/brush.git"
BRUSH_RELEASE_URL="https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz"
MIN_PY_MINOR=11

START_TS=$(date +%s)

printf '%sSplat360 Studio — macOS setup%s\n' "$C_BOLD" "$C_RESET"
note "repo:      $REPO_ROOT"
note "data dir:  $DATA_DIR"
note "venv:      $VENV_DIR"
note "tool bin:  $BIN_DIR"
[[ $ENGINE_ONLY -eq 1 ]] && note "mode:      engine only (no Homebrew packages, no trainer)"
[[ $WITH_TRAINER -eq 0 && $ENGINE_ONLY -eq 0 ]] && note "mode:      no trainer (point-cloud preview only)"
cat <<EOF

  Estimated time on a fresh machine (mostly downloads and one compile):
    Homebrew packages (ffmpeg, COLMAP, Python)   3–10 min, ~2 GB
    Python engine venv                           1–2 min,  ~0.5 GB
    Rust toolchain + Brush build from source     5–10 min, ~1.5 GB (~3 GB during the build)
EOF

# ---------------------------------------------------------------------------
# 1. Platform checks
# ---------------------------------------------------------------------------
step "Checking the platform"
OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "$OS" != "Darwin" ]]; then
  if [[ $ENGINE_ONLY -eq 1 ]]; then
    warn "not macOS ($OS): continuing with the Python venv only"
  else
    die "this script is for macOS (detected $OS). On Linux run it with --engine-only and install ffmpeg/COLMAP yourself."
  fi
else
  MACOS_VER="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  MACOS_MAJOR="${MACOS_VER%%.*}"
  if [[ "${MACOS_MAJOR:-0}" -lt 14 ]]; then
    warn "macOS $MACOS_VER detected; macOS 14 (Sonoma) or newer is the supported target"
  else
    ok "macOS $MACOS_VER"
  fi
  if [[ "$ARCH" == "arm64" ]]; then
    ok "Apple Silicon ($ARCH)"
  else
    warn "Intel Mac ($ARCH): reconstruction works but Brush/Metal training is untested and slow. Apple Silicon is recommended."
  fi
fi

if [[ "$OS" == "Darwin" && $ENGINE_ONLY -eq 0 ]]; then
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode Command Line Tools"
  else
    warn "Xcode Command Line Tools are missing; Homebrew and the Brush build need them."
    if confirm "Run 'xcode-select --install' now? (a dialog opens; re-run this script when it finishes)"; then
      xcode-select --install || true
      die "re-run scripts/setup-mac.sh after the Command Line Tools have been installed"
    fi
  fi
fi

if [[ "$OS" == "Darwin" ]]; then
  FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
  if [[ "${FREE_GB:-0}" -lt 20 ]]; then
    warn "only ${FREE_GB} GB free in $HOME; setup needs ~5 GB and an 8K project needs 10–30 GB of working space"
  else
    ok "${FREE_GB} GB free disk"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Homebrew + packages
# ---------------------------------------------------------------------------
brew_bin() {
  if command -v brew >/dev/null 2>&1; then command -v brew; return; fi
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [[ -x "$b" ]] && { echo "$b"; return; }
  done
  return 1
}

if [[ "$OS" == "Darwin" && $ENGINE_ONLY -eq 0 ]]; then
  step "Homebrew"
  if BREW="$(brew_bin)"; then
    skip "Homebrew ($BREW)"
  else
    warn "Homebrew is not installed. It provides ffmpeg, COLMAP, Python and rustup."
    if confirm "Install Homebrew now? (official installer, asks for your password)"; then
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      BREW="$(brew_bin)" || die "Homebrew installation did not produce a brew binary"
      ok "Homebrew installed"
    else
      die "Homebrew is required (or install ffmpeg, colmap and python@3.12 yourself and re-run with --engine-only)"
    fi
  fi
  eval "$("$BREW" shellenv)"

  step "Homebrew packages"
  PKGS=(ffmpeg colmap python@3.12)
  [[ $WITH_GLOMAP -eq 1 ]] && PKGS+=(glomap)
  TO_INSTALL=()
  for p in "${PKGS[@]}"; do
    if "$BREW" list --versions "$p" >/dev/null 2>&1; then
      skip "$p $("$BREW" list --versions "$p" | awk '{print $2}')"
    else
      TO_INSTALL+=("$p")
    fi
  done
  if [[ ${#TO_INSTALL[@]} -gt 0 ]]; then
    note "installing: ${TO_INSTALL[*]} (a few minutes; COLMAP pulls Ceres, Qt and friends)"
    "$BREW" install "${TO_INSTALL[@]}"
    for p in "${TO_INSTALL[@]}"; do ok "$p"; done
  fi
  if ! "$BREW" list --versions glomap >/dev/null 2>&1 && [[ $WITH_GLOMAP -eq 0 ]]; then
    note "GLOMAP not installed (optional; re-run with --with-glomap)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Python venv + engine
# ---------------------------------------------------------------------------
step "Python engine"
[[ -f "$ENGINE_DIR/pyproject.toml" ]] || die "engine sources not found at $ENGINE_DIR"

py_minor() { "$1" -c 'import sys; print(sys.version_info[1])' 2>/dev/null || echo 0; }
py_major() { "$1" -c 'import sys; print(sys.version_info[0])' 2>/dev/null || echo 0; }

pick_python() {
  local cands=()
  [[ -n "${SPLAT360_PYTHON:-}" ]] && cands+=("$SPLAT360_PYTHON")
  if command -v brew >/dev/null 2>&1; then
    cands+=("$(brew --prefix python@3.12 2>/dev/null || true)/bin/python3.12")
  fi
  cands+=(/opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3
          python3.12 python3.13 python3.11 python3)
  local c
  for c in "${cands[@]}"; do
    [[ -z "$c" ]] && continue
    if command -v "$c" >/dev/null 2>&1 || [[ -x "$c" ]]; then
      local exe; exe="$(command -v "$c" 2>/dev/null || echo "$c")"
      if [[ "$(py_major "$exe")" -eq 3 && "$(py_minor "$exe")" -ge $MIN_PY_MINOR ]]; then
        echo "$exe"; return 0
      fi
    fi
  done
  return 1
}

mkdir -p "$DATA_DIR" "$BIN_DIR"
VENV_PY="$VENV_DIR/bin/python"
if [[ -x "$VENV_PY" ]] && [[ "$(py_minor "$VENV_PY")" -ge $MIN_PY_MINOR ]]; then
  skip "venv at $VENV_DIR (Python $("$VENV_PY" -c 'import platform; print(platform.python_version())'))"
else
  if [[ -d "$VENV_DIR" ]]; then
    warn "existing venv at $VENV_DIR is broken or too old; recreating it"
    rm -rf "$VENV_DIR"
  fi
  SYS_PY="$(pick_python)" || die "no Python >= 3.$MIN_PY_MINOR found; run 'brew install python@3.12'"
  note "creating venv with $SYS_PY ($("$SYS_PY" --version))"
  "$SYS_PY" -m venv "$VENV_DIR"
  ok "venv created"
fi

note "installing the engine (editable) into the venv"
"$VENV_PY" -m pip install --quiet --upgrade pip
"$VENV_PY" -m pip install --quiet --upgrade -e "$ENGINE_DIR[dev]"
"$VENV_PY" -c "import splat360, fastapi, uvicorn" || die "engine installed but cannot be imported"
ok "splat360 $("$VENV_DIR/bin/splat360" version 2>/dev/null || echo '?') installed in $VENV_DIR"

# ---------------------------------------------------------------------------
# 4. Trainer: Rust + Brush
# ---------------------------------------------------------------------------
find_brush() {
  # Same candidates as engine/splat360/train/brush.py, same search dirs as config.extra_bin_dirs().
  local name d
  for name in brush-cli brush_cli brush brush_app; do
    for d in "$BIN_DIR" "$CARGO_BIN" /opt/homebrew/bin /usr/local/bin; do
      [[ -x "$d/$name" ]] && { echo "$d/$name"; return 0; }
    done
    if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  done
  return 1
}

link_into_bin() {
  # link_into_bin <absolute path> : symlink into $BIN_DIR under the same basename
  local src="$1" dst
  dst="$BIN_DIR/$(basename "$src")"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]] || [[ "$dst" == "$src" ]]; then
    return 0
  fi
  ln -sfn "$src" "$dst"
  ok "linked $dst -> $src"
}

ensure_rust() {
  if [[ -x "$CARGO_BIN/cargo" ]]; then
    skip "Rust toolchain ($("$CARGO_BIN/cargo" --version))"
    return 0
  fi
  if command -v cargo >/dev/null 2>&1; then
    skip "Rust toolchain ($(cargo --version))"
    return 0
  fi
  note "installing rustup via Homebrew, then the stable toolchain (~1 GB)"
  local rustup_init=""
  if "$BREW" list --versions rustup >/dev/null 2>&1; then
    skip "rustup (Homebrew)"
  else
    "$BREW" install rustup
  fi
  for c in "$(brew --prefix rustup 2>/dev/null || true)/bin/rustup-init" /opt/homebrew/opt/rustup/bin/rustup-init \
           /opt/homebrew/bin/rustup-init; do
    [[ -x "$c" ]] && { rustup_init="$c"; break; }
  done
  [[ -z "$rustup_init" ]] && command -v rustup-init >/dev/null 2>&1 && rustup_init="$(command -v rustup-init)"
  [[ -n "$rustup_init" ]] || die "rustup-init not found after 'brew install rustup'"
  "$rustup_init" -y --no-modify-path --profile minimal --default-toolchain stable
  [[ -x "$CARGO_BIN/cargo" ]] || die "cargo not found at $CARGO_BIN after rustup-init"
  ok "Rust $("$CARGO_BIN/cargo" --version)"
}

install_brush_release() {
  # Last resort: prebuilt binary from the Brush GitHub release.
  [[ "$ARCH" == "arm64" ]] || { warn "no prebuilt Brush binary for $ARCH"; return 1; }
  local tmp; tmp="$(mktemp -d)"
  note "downloading $BRUSH_RELEASE_URL"
  if ! curl -fL --progress-bar -o "$tmp/brush.tar.xz" "$BRUSH_RELEASE_URL"; then
    rm -rf "$tmp"; return 1
  fi
  tar -xJf "$tmp/brush.tar.xz" -C "$tmp"
  local bin
  bin="$(find "$tmp" -type f \( -name brush_app -o -name brush -o -name brush-cli \) | head -n 1)"
  [[ -n "$bin" ]] || { rm -rf "$tmp"; warn "archive did not contain a brush binary"; return 1; }
  cp "$bin" "$BIN_DIR/brush_app"
  chmod +x "$BIN_DIR/brush_app"
  xattr -dr com.apple.quarantine "$BIN_DIR/brush_app" 2>/dev/null || true
  rm -rf "$tmp"
  ok "installed prebuilt $BIN_DIR/brush_app"
}

if [[ $WITH_TRAINER -eq 1 ]]; then
  step "Gaussian splat trainer (Brush)"
  if BRUSH="$(find_brush)"; then
    skip "Brush ($BRUSH)"
    link_into_bin "$BRUSH"
  else
    ensure_rust
    export PATH="$CARGO_BIN:$PATH"
    note "building Brush from source (5–10 min on an M-series Mac; compiles wgpu/burn, needs ~3 GB temporarily)"
    note "Brush is not on crates.io; 'cargo install brush' is an unrelated crate."
    BUILT=""
    if cargo install --locked --git "$BRUSH_REPO" brush-cli; then
      [[ -x "$CARGO_BIN/brush-cli" ]] && BUILT="$CARGO_BIN/brush-cli"
    fi
    if [[ -z "$BUILT" ]]; then
      warn "brush-cli did not build; trying the brush-app crate (binary: brush)"
      if cargo install --locked --git "$BRUSH_REPO" brush-app; then
        [[ -x "$CARGO_BIN/brush" ]] && BUILT="$CARGO_BIN/brush"
      fi
    fi
    if [[ -z "$BUILT" ]]; then
      warn "source build failed; falling back to the prebuilt release binary"
      if install_brush_release; then BUILT="$BIN_DIR/brush_app"; fi
    fi
    if [[ -n "$BUILT" ]]; then
      ok "Brush: $BUILT"
      link_into_bin "$BUILT"
    else
      fail "Brush could not be installed. The pipeline still works and produces a point-cloud preview."
      note "See docs/INSTALL.md 'Trainer' for manual steps, or install OpenSplat instead."
    fi
  fi
  note "OpenSplat (libtorch/MPS) is an optional alternative; see docs/INSTALL.md."
fi

# ---------------------------------------------------------------------------
# 5. Doctor
# ---------------------------------------------------------------------------
step "Environment check (splat360 doctor)"
export PATH="$BIN_DIR:$CARGO_BIN:/opt/homebrew/bin:$PATH"
DOCTOR_RC=0
"$VENV_DIR/bin/splat360" --data-dir "$DATA_DIR" doctor || DOCTOR_RC=$?

ELAPSED=$(( $(date +%s) - START_TS ))
printf '\n'
if [[ $DOCTOR_RC -eq 0 ]]; then
  printf '%sSetup finished in %d min %d s.%s\n' "$C_GREEN" $((ELAPSED / 60)) $((ELAPSED % 60)) "$C_RESET"
else
  printf '%sSetup finished in %d min %d s, but the doctor reports missing required tools (see above).%s\n' \
    "$C_YELLOW" $((ELAPSED / 60)) $((ELAPSED % 60)) "$C_RESET"
fi
cat <<EOF

Next steps:
  "$VENV_DIR/bin/splat360" tags sheet -o tags.pdf --count 12 --size-mm 200 --page letter
  "$VENV_DIR/bin/splat360" run clip.mp4 --preset balanced --tag-size-mm 200
  scripts/dev.sh                      # engine + web UI for development
  open "Splat360 Studio.app"          # or build it with scripts/build-mac.sh

Add the engine CLI to your shell if you like:
  export PATH="$VENV_DIR/bin:\$PATH"
EOF
exit "$DOCTOR_RC"
