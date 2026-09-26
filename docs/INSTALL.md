# Installing Splat360 Studio

Target platform: Apple Silicon Mac, macOS 14 (Sonoma) or newer. Everything
below also works on an Intel Mac, but Metal training there is untested and
slow.

There are two ways to install: the setup script (recommended) or by hand.
Both end with the same layout on disk, which the desktop app, the CLI and
the scripts all expect.

## Where things go

| Path | Content |
| --- | --- |
| `~/Library/Application Support/Splat360/` | data directory (`--data-dir`, `SPLAT360_DATA_DIR`) |
| `…/Splat360/venv/` | Python virtualenv with the `splat360` engine installed |
| `…/Splat360/bin/` | symlinks to trainer binaries (`brush-cli`, `brush`, `brush_app`) |
| `…/Splat360/projects/<id>/` | one directory per project (see [ARCHITECTURE.md](ARCHITECTURE.md)) |
| `~/.cargo/bin/` | Rust toolchain and Brush binaries built with `cargo install` |
| `/opt/homebrew/bin/` | ffmpeg, ffprobe, colmap, glomap, python3.12 |
| `~/Library/Logs/Splat360 Studio/engine.log` | engine output when started by the desktop app |

The engine looks for tools on `PATH` and additionally in `…/Splat360/bin`,
`~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and
`/Applications/COLMAP.app/Contents/MacOS` (`SPLAT360_BIN_DIRS` prepends more).
The desktop app adds the same directories to the engine's `PATH`, so tools
are found even when the app is launched from Finder with a minimal
environment.

## Option A: the setup script

```sh
git clone https://github.com/splat360/splat360-studio.git
cd splat360-studio
scripts/setup-mac.sh
```

What it does, in order (each step is skipped when already done):

1. Checks macOS version and architecture, Xcode Command Line Tools and free
   disk space.
2. Installs Homebrew if missing (asks first; `--yes` skips the prompt).
3. `brew install ffmpeg colmap python@3.12`, plus `glomap` with `--with-glomap`.
4. Creates `~/Library/Application Support/Splat360/venv` with Python 3.12
   (3.11+ accepted, `SPLAT360_PYTHON` overrides) and runs
   `pip install -e "<repo>/engine[dev]"`.
5. Installs `rustup` via Homebrew, the stable toolchain, then builds Brush:
   `cargo install --git https://github.com/ArthurBrussee/brush.git brush-cli`;
   if that fails, `brush-app` (binary `brush`); if that fails too, downloads
   the prebuilt `brush-app-aarch64-apple-darwin.tar.xz` release. The result is
   symlinked into `…/Splat360/bin`. Skipped when a Brush binary is already
   found, or with `--no-trainer`.
6. Runs `splat360 doctor`.

Flags: `--no-trainer`, `--with-glomap`, `--engine-only` (venv only, nothing
else), `--yes`. Expect 10–25 minutes on a fresh machine, most of it the COLMAP
download and the Brush compile (5–10 minutes). Disk: about 5 GB.

Add the CLI to your shell if you want to call it directly:

```sh
export PATH="$HOME/Library/Application Support/Splat360/venv/bin:$PATH"
splat360 doctor
```

## Option B: manual install

### 1. Homebrew tools

```sh
brew install ffmpeg colmap python@3.12
brew install glomap        # optional global SfM
```

COLMAP from Homebrew is CPU-only, which is expected. Version 3.11 or newer
gives native rig support (`rig_configurator`); 3.9/3.10 still work through
`rig_bundle_adjuster`; older versions have no rig support and the pipeline
falls back to plain bundle adjustment.

### 2. Engine

```sh
python3.12 -m venv "$HOME/Library/Application Support/Splat360/venv"
"$HOME/Library/Application Support/Splat360/venv/bin/pip" install -e "engine[dev]"
```

Any venv location works for the CLI, but the desktop app only looks in the
path above (and `engine/.venv` when run from a source checkout, or
`SPLAT360_PYTHON`). If it finds nothing it creates the venv itself on first
launch.

### 3. Trainer

**Brush** (recommended, Rust + wgpu on Metal). It is not on Homebrew and not
on crates.io (`cargo install brush` installs an unrelated crate). Build from
the repository:

```sh
brew install rustup
rustup-init -y                      # or $(brew --prefix rustup)/bin/rustup-init
source "$HOME/.cargo/env"
cargo install --git https://github.com/ArthurBrussee/brush.git brush-cli   # binary: brush-cli
# fallback if brush-cli fails to build:
cargo install --git https://github.com/ArthurBrussee/brush.git brush-app   # binary: brush
```

Prebuilt fallback: download
`https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz`,
extract `brush_app`, copy it to `~/Library/Application Support/Splat360/bin/`,
`chmod +x` it and run `xattr -dr com.apple.quarantine` on it.

The engine accepts any of `brush-cli`, `brush_cli`, `brush`, `brush_app` on
its search path, in that order of preference.

**OpenSplat** (optional, advanced): a libtorch-based trainer with an MPS
backend. Build it from source following
https://github.com/pierotofy/OpenSplat (CMake, libtorch for macOS arm64,
`-DGPU_RUNTIME=MPS`) and put the `opensplat` binary on the search path. The
engine prefers Brush when both exist; choose per project with
*Settings > Train > backend*.

Without a trainer the pipeline completes with a point-cloud preview instead of
a trained splat.

### 4. Verify

```sh
splat360 doctor
```

prints every tool with its path and version, the platform (CPU, RAM, disk,
GPU) and a verdict: *Ready* (reconstruct + train), *Can reconstruct, no
trainer*, or *Not ready*. The app shows the same report under
*Environment Check* (Cmd-Shift-E).

End-to-end test without a camera:

```sh
splat360 demo -o synthetic.mp4         # 90 frames, 2048 px, a room with 300 mm tags
splat360 run synthetic.mp4 --preset fast --tag-size-mm 300
```

The synthetic room prints its ground truth next to the clip
(`synthetic.mp4.ground_truth.json`) so the alignment report can be checked.

## The desktop app

Build it yourself with `scripts/build-mac.sh` (needs Node 20+; see
[desktop/README.md](../desktop/README.md)) or download a DMG from a release.
Unsigned builds are blocked by Gatekeeper ("is damaged and can't be opened");
clear the flag once:

```sh
xattr -dr com.apple.quarantine "/Applications/Splat360 Studio.app"
```

On first launch the app checks for the venv above and creates it if missing,
using the bundled engine sources and the newest Python 3.11+ it can find in
Homebrew or system locations. It does not install ffmpeg, COLMAP or Brush;
run `scripts/setup-mac.sh` or step 1 and 3 above for those.

## Web UI without the app

```sh
npm --prefix frontend install && npm --prefix frontend run build
splat360 serve --open              # http://127.0.0.1:8765
```

The engine serves `frontend/dist` at `/`. In the browser the file picker
becomes an upload control (the file is copied into the project directory).

## Updating

```sh
git pull
scripts/setup-mac.sh               # re-installs the engine into the venv, skips the rest
```

The engine is installed in editable mode, so Python changes in `engine/` take
effect on the next engine start without reinstalling. To rebuild Brush from a
newer commit: `cargo install --force --git https://github.com/ArthurBrussee/brush.git brush-cli`.

## Uninstalling

```sh
rm -rf "$HOME/Library/Application Support/Splat360"     # venv, projects, tool links
rm -rf "$HOME/Library/Logs/Splat360 Studio"
rm -rf "/Applications/Splat360 Studio.app"
cargo uninstall brush-cli brush-app                     # optional
brew uninstall colmap glomap                            # optional
```
