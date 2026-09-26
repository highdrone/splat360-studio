# Splat360 Studio — macOS desktop shell

Electron wrapper that turns the engine + web UI into a double-clickable app.
It contains no pipeline code: it finds (or creates) the Python virtualenv,
spawns `python -m splat360 serve` on a free localhost port, and loads the
built web UI with `window.splat360.apiBase` pointing at it.

```
src/main.ts           startup sequence, windows, menus, IPC handlers
src/engine.ts         EngineManager: spawn, health poll, bounded restarts, kill tree
src/bootstrap.ts      first-run venv creation (python -m venv + pip install)
src/helpers.ts        pure helpers (paths, python discovery, CSP, validation) — unit-tested
src/menu.ts           application and dock menus
src/preload.ts        window.splat360 bridge (docs/API.md "Desktop bridge")
src/shell-preload.ts  window.shell for setup.html / error.html
src/setup.html        first-run installer window (live pip output)
src/error.html        startup / crash window with log tail, Retry, Quit
build/entitlements.mac.plist   hardened-runtime entitlements
electron-builder.yml  packaging configuration (DMG + zip, arm64)
resources/icon.png    app icon source (make-icon.js regenerates it)
```

Requirements: Node 20+ (CI uses 22), and for running the app a Python 3.11+
with the engine's dependencies reachable (see [docs/INSTALL.md](../docs/INSTALL.md)).

## Development

```sh
npm install
npm run typecheck          # tsc --noEmit
npm test                   # vitest, src/__tests__
npm run dev                # build + electron with SPLAT360_DEV=1
```

`npm run dev` loads the UI from the Vite dev server (`SPLAT360_DEV_SERVER`,
default `http://localhost:5173`) and opens DevTools, so start
`npm --prefix ../frontend run dev` first, or use `scripts/dev.sh --desktop`
from the repository root, which starts engine, Vite and Electron together and
stops all three on Ctrl-C. The shell always spawns its own engine on a free
port; the standalone engine from `dev.sh` serves the browser workflow.

`npm start` runs the app against `frontend/dist` (build it with
`npm --prefix ../frontend run build` first).

Environment variables honoured by the shell:

| Variable | Effect |
| --- | --- |
| `SPLAT360_DEV=1` | load the Vite dev server instead of `frontend/dist`, open DevTools |
| `SPLAT360_DEV_SERVER` | dev server URL (default `http://localhost:5173`) |
| `SPLAT360_PYTHON` | use this interpreter, skip venv discovery and bootstrap |
| `SPLAT360_DATA_DIR` | data directory passed to the engine as `--data-dir` |

Paths at runtime:

| | Source checkout | Packaged app |
| --- | --- | --- |
| Engine sources | `../engine` | `Contents/Resources/engine` |
| Web UI | `../frontend/dist` | `Contents/Resources/frontend/dist` |
| Venv | `~/Library/Application Support/Splat360/venv` (editable install) | same (regular install from bundled sources) |
| Logs | `~/Library/Logs/Splat360 Studio/engine.log` | same |

## Packaging

```sh
npm run dist        # frontend build + tsc + electron-builder --mac → release/*.dmg, *.zip
npm run dist:dir    # unpacked release/mac-arm64/Splat360 Studio.app only (fast)
```

or `scripts/build-mac.sh` from the repository root, which also installs
dependencies, runs the checks and prints the DMG path. The bundle contains
the Electron shell, the compiled `dist/`, the engine sources (minus tests
and caches) and the built web UI. It does **not** contain Python, ffmpeg,
COLMAP or Brush; those are found on the user's machine (the first launch
creates the venv, `scripts/setup-mac.sh` installs the rest).

Only arm64 is built. For an Intel build append `x64` to `mac.target[].arch`
in `electron-builder.yml` or run `npx electron-builder --mac --x64`; it is
untested.

## Signing and notarization

Local and CI builds are unsigned by default (`mac.notarize: false`,
`dmg.sign: false`). Gatekeeper then reports the app as damaged; users must
clear the quarantine attribute once:

```sh
xattr -dr com.apple.quarantine "/Applications/Splat360 Studio.app"
```

To produce a signed, notarized build you need an Apple Developer account, a
*Developer ID Application* certificate in the login keychain (or exported as
`CSC_LINK` / `CSC_KEY_PASSWORD`), and an app-specific password:

```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com > App-Specific Passwords
export APPLE_TEAM_ID="ABCDE12345"
npm run dist -- --config.mac.notarize=true
```

`scripts/build-mac.sh` turns notarization on automatically when all three
variables are set. electron-builder signs the app with the hardened runtime
and `build/entitlements.mac.plist`, submits it to Apple's notary service and
staples the ticket. Notarization takes 2–15 minutes. The entitlements
disable library validation so the venv's and Homebrew's unsigned dylibs can
be loaded by processes the app starts, and allow JIT for V8.

In GitHub Actions, `release-mac.yml` reads the same three names from
repository secrets (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`) plus `CSC_LINK` / `CSC_KEY_PASSWORD` for the certificate;
without them it uploads an unsigned DMG.

## Tests

`src/__tests__/helpers.test.ts` covers the pure helpers (python candidate
ordering, version parsing, free port, CSP, IPC input validation, log tail,
tool `PATH` composition). `main.ts`, `menu.ts` and the preloads import
`electron` and are exercised by running the app; keep logic out of them and
in `helpers.ts` / `engine.ts` / `bootstrap.ts` so it stays testable.
