# Architecture

Splat360 Studio is three programs that talk over localhost:

```
┌──────────────────────────────┐   spawn, PATH, --port   ┌──────────────────────────────┐
│ desktop/  Electron shell     │ ──────────────────────▶ │ engine/  Python (FastAPI)    │
│  main.ts   process manager   │   GET /api/health       │  api.py    HTTP + WebSocket  │
│  preload   window.splat360   │ ◀────────────────────── │  jobs.py   one worker thread │
│  menu      native menus      │                         │  pipeline/ 8 stages          │
└──────────────┬───────────────┘                         │  colmap/ tags/ train/        │
               │ loads frontend/dist/index.html          └──────────────┬───────────────┘
               ▼                                                        │ subprocesses
┌──────────────────────────────┐   fetch + WebSocket      ffmpeg  ffprobe  colmap  glomap
│ frontend/  React + Vite      │ ◀──────────────────────▶ brush-cli / opensplat
│  api/      typed client      │   http://127.0.0.1:PORT
│  store/    zustand           │
│  viewer    three.js splats   │
└──────────────────────────────┘
```

| Component | Language | Role |
| --- | --- | --- |
| `engine/` | Python 3.11+, FastAPI, OpenCV, NumPy, pupil-apriltags, reportlab | Everything that touches pixels: probing, keyframes, reprojection, tag detection, COLMAP orchestration, alignment, trainer adapters, export, reports, tag PDFs, the synthetic demo. Also the `splat360` CLI. |
| `frontend/` | TypeScript, React 18, Vite, zustand, three.js + `@mkkellogg/gaussian-splats-3d` | The UI: projects, wizard, live job progress, tag printer, doctor page, capture guide, splat viewer. Runs in the Electron window or a browser. |
| `desktop/` | TypeScript, Electron 33, electron-builder | macOS shell: finds Python, bootstraps the venv on first run, spawns the engine, opens the window, native dialogs, menus, log access. |

The contract between them is `engine/splat360/models.py` (Pydantic) mirrored
by `frontend/src/api/types.ts`, and the routes in [API.md](API.md).

## Process model

### Desktop launch

1. `main.ts` takes the single-instance lock and installs menus and IPC.
2. `ensurePython()` looks for an interpreter in this order: `SPLAT360_PYTHON`,
   `~/Library/Application Support/Splat360/venv/bin/python` (if `import
   splat360, fastapi, uvicorn` succeeds), a bundled `resources/engine/.venv`,
   `engine/.venv` in a source checkout. If nothing usable exists it opens
   `setup.html`, picks the newest Python ≥ 3.11 on `PATH` or in the usual
   Homebrew/system locations, runs `python -m venv` and `pip install
   <engine>` (editable in a source checkout, regular install from the bundled
   `resources/engine` when packaged), streaming output to the window.
3. `EngineManager.start()` asks the OS for a free port and spawns
   `python -m splat360 serve --host 127.0.0.1 --port N --data-dir <data>` in
   its own process group, with `PATH` extended by `<data>/bin`, `~/.cargo/bin`,
   `/opt/homebrew/bin` and the system directories, `PYTHONUNBUFFERED=1` and
   `SPLAT360_DATA_DIR`. stdout/stderr go to `~/Library/Logs/Splat360
   Studio/engine.log`.
4. It polls `GET /api/health` every 500 ms for up to 60 s. If the child exits
   it is restarted up to three times with increasing delay; after that the
   error window (`error.html`) shows the message and the log tail, with
   *Retry* and *Quit*.
5. The main window loads `frontend/dist/index.html` from disk (or the Vite
   dev server when `SPLAT360_DEV=1`). The preload script exposes
   `window.splat360` with `apiBase` set to `http://127.0.0.1:N`; a strict
   Content-Security-Policy allows connections only to `self`, that origin
   and its `ws://` twin.
6. Quit (Cmd-Q or closing the last window) sends SIGTERM to the engine's
   process group, which takes COLMAP, ffmpeg and the trainer with it, then
   SIGKILL after 5 s.

### Engine

`splat360 serve` runs uvicorn with one FastAPI app. Requests are cheap and
synchronous; long work happens in `JobManager`, a single worker thread that
executes one job at a time (`max_parallel_jobs = 1`; COLMAP and the trainer
already use every core and the GPU). Each stage function receives a
`StageContext` with the project paths, settings, a cancel token, and
callbacks for progress, metrics and log lines. External tools run through
`util/proc.run_streaming`, which starts them in a new process group, streams
their output line by line to the job log, and kills the group on
cancellation.

Events (`JobEvent`: `snapshot`, `stage`, `log`, `job`) go through an in-memory
bus; `/api/ws/jobs/{id}` replays a snapshot on connect and then streams, and
`/api/ws/events` carries `job` and `stage` events for every job. Clients that
reconnect get a fresh snapshot, so the UI never depends on having seen every
message.

### Browser mode

Without Electron the engine serves `frontend/dist` at `/` (SPA fallback) and
the UI uses the same origin for `/api`. `window.splat360` is undefined, so
the UI switches to an upload control (`POST /api/projects/{id}/upload`, the
file is copied into `source/`) and plain downloads instead of native dialogs.

## On-disk layout

```
<data-dir>/                      ~/Library/Application Support/Splat360
├── venv/                        engine virtualenv (created by setup-mac.sh or the app)
├── bin/                         symlinks to trainer binaries
├── cache/
├── logs/
└── projects/<id>/
    ├── project.json             Project (settings, source probe, stage states, artifacts)
    ├── source/                  uploaded clip (browser mode only; native picks are referenced by path)
    ├── keyframes/               <index:05d>.jpg full-resolution keyframes, index.json, thumbs/
    ├── views/
    │   ├── index.json           per-view intrinsics, face rotations (cam_from_rig), frame index
    │   ├── <face>/              front/ right/ back/ left/ up/ down/ (cube6) or yaw000..yaw315/ up/ down/ (ring8)
    │   └── masks/<face>/        COLMAP nadir masks (<keyframe>.jpg.png), only for faces that need one
    ├── tags/                    observations.json (TagObservation[]), summary.json (TagSummary)
    ├── sfm/                     database.db, pairs.txt, sparse/, sparse_final/0, report.json, COLMAP logs
    ├── align/                   sparse/0 (metric, levelled model), sparse_points.ply, report.json
    ├── train/                   dataset/ (trainer input), output/ (checkpoints), report.json
    ├── export/                  splat.ply splat.splat sparse_points.ply tags.json report.json report.html job.log
    ├── logs/<job-id>.log        combined log per job
    ├── jobs/<job-id>.json       Job records
    └── stages/<stage>.json      completion markers (see below)
```

Everything under `projects/<id>` is derived from `source` plus
`project.json`; deleting a project removes the directory. Nothing is written
outside the data directory except the files the user explicitly saves
(tag PDFs, exported artifacts).

## Stage caching and resume

Every stage that completes writes `stages/<name>.json` with its metrics and
a timestamp. When a job is submitted:

- with no `from_stage`, the job starts at the first stage without a marker;
- with `from_stage`, the job starts there and reuses the outputs of earlier
  stages as they are on disk;
- with `force`, markers from `from_stage` onwards are deleted first so the
  work is redone.

Stages after the starting one keep their previous state in the job until they
run. Changing settings does not invalidate markers automatically: after
changing, say, the keyframe count, re-run from `extract` with *force*. The
export stage leaves keyframes and the trainer dataset in place when
`export.keep_intermediates` is on (default), which is what makes re-running a
single stage possible.

At start-up `JobManager._recover()` marks any job that was `queued` or
`running` when the engine last died as `failed` ("Engine restarted while
the job was running") and clears the project's `current_job_id`, so a crash
never leaves a project stuck in `running`.

## Error handling

- **Input validation** happens in `probe` and again in `POST /source` /
  `/upload`; `RunRequest` is refused with 422 while the source has errors or
  the doctor reports missing tools for the requested stages, and with 409
  while a job is already active.
- **Stage failures** raise inside the worker; the stage and the job become
  `failed` with the exception message (for external tools, `ToolError`
  carries the exit code and the last lines of output). Later stages are
  left `pending`. The job log keeps the full tool output.
- **Quality gates**: SfM fails the job when fewer than
  `sfm.min_registered_fraction` (60 %) of views register, and warns when
  few pairs verify. Alignment falls back from tags to camera-up levelling and
  says so in `AlignmentReport.notes`. Training falls back to the point-cloud
  "mock" trainer when no trainer is found and `backend` is `auto`.
- **Cancellation** sets the cancel token; stage code checks it between steps
  and every running subprocess is killed as a process group. The job ends
  `cancelled` and can be resumed later from the same stage.
- **Engine crash**: the desktop shell restarts it (bounded) and the UI
  re-subscribes; the recovered job state is `failed`, never a phantom
  `running`.
- **Desktop startup failures** (no Python, venv install failed, engine never
  healthy) open the error window with the log tail and a *Retry* that runs
  the whole start sequence again.

## Security

- The engine binds **127.0.0.1 only**, on a random free port chosen by the
  shell (8765 by default from the CLI). It is never exposed on the network
  and has no authentication; any process on the same machine, as the same
  user, can use it. That is the trust boundary.
- File paths accepted by the API (`POST /source`) are read, never written to;
  artifact downloads are limited to names produced by the pipeline inside the
  project directory.
- The Electron renderer runs with `contextIsolation`, `sandbox: true`,
  `nodeIntegration: false`; the preload exposes six functions and three
  values. IPC handlers check the sender window, validate URLs (`http(s)`
  only), paths (absolute and existing for *Reveal in Finder*) and file names
  (*Save PDF*, size-capped). External links open in the default browser;
  the window refuses to navigate anywhere but its own document, the engine
  and (in dev) the Vite server.
- CSP: `default-src 'self'`; scripts `'self'` + `'wasm-unsafe-eval'` (the
  splat viewer); `connect-src` restricted to the engine origin.
- The packaged app uses hardened runtime with the entitlements needed for
  V8's JIT, loading unsigned Homebrew/venv dylibs, localhost networking and
  user-selected files. No camera, microphone or location entitlements.
- Nothing phones home. Doctor, planner and reports are computed locally.
