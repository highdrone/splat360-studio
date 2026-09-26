# Splat360 Studio

Splat360 Studio turns a short 360° video from an Insta360 X6 into a 3D Gaussian
splat, on an Apple Silicon Mac, without CUDA. You print a sheet of AprilTags,
lay them on the floor, walk a slow loop with the camera, and the app produces a
metric, levelled `.ply` / `.splat` you can drop into any splat viewer.

It ships as a macOS app (Electron shell around a local Python engine), a web UI
you can run in a browser, and a command line (`splat360`).

| | |
| --- | --- |
| Input | equirectangular 8K30 MP4 exported from Insta360 Studio (about 30 s) |
| Output | `splat.ply`, `splat.splat`, sparse point cloud, tag observations, HTML/JSON report |
| Scale and orientation | metric, +Y down, floor at y = 0, taken from printed AprilTags |
| Trainer | [Brush](https://github.com/ArthurBrussee/brush) on Metal (OpenSplat optional); point-cloud preview without a trainer |
| SfM | COLMAP (CPU) with the six cube faces of every frame locked as a rigid rig |

## Requirements

- Apple Silicon Mac, macOS 14 or newer, 16 GB RAM recommended, 10–30 GB free
  disk per 8K project. Intel Macs run the reconstruction but training is slow
  and untested.
- [Homebrew](https://brew.sh): `ffmpeg`, `colmap` (3.9 or newer; 3.11+ preferred
  for native rig support), `python@3.12` (Python 3.11+ works).
- Rust toolchain to build Brush from source (about 5–10 minutes, done by the
  setup script). No trainer is needed to *reconstruct*; without one the export
  is a point-cloud preview.
- Node 20+ only if you build the app or the web UI yourself.
- An Insta360 X6 (any camera that exports 2:1 equirectangular video works).

## Quick start (about 5 minutes plus build time)

```sh
git clone https://github.com/splat360/splat360-studio.git
cd splat360-studio
scripts/setup-mac.sh                 # Homebrew tools, engine venv, Brush; ends with `splat360 doctor`
export PATH="$HOME/Library/Application Support/Splat360/venv/bin:$PATH"
```

1. **Print tags.** `splat360 tags sheet -o tags.pdf --count 12 --size-mm 130 --page letter`
   prints twelve `tag36h11` tags at 130 mm, the largest that fits Letter (126 mm
   for A4). Print at 100 % scale on matte paper and check the 100 mm bar on the
   sheet with a ruler. For bigger rooms send `--size-mm 200 --page a2` to a
   print shop. Whatever size you print, pass the same number later.
2. **Shoot.** Put 6–12 tags flat on the floor, spread through the space. Camera
   on the invisible selfie stick at eye height, 8K30, walk a slow loop that
   returns to the start, about 30 s. Details in [docs/CAPTURE_GUIDE.md](docs/CAPTURE_GUIDE.md).
3. **Export.** In Insta360 Studio export the clip as equirectangular MP4, 8K,
   H.265 or H.264, FlowState stabilization **on**, Direction Lock **off**. The
   raw `.insv` is rejected by the app. `scripts/check-video.sh clip.mp4` tells
   you whether the export is usable.
4. **Run.** Either open the app (`scripts/build-mac.sh` produces the DMG, or
   `scripts/dev.sh` serves the web UI at http://localhost:5173) and create a
   project, or from the terminal:

   ```sh
   splat360 run clip.mp4 --preset balanced --tag-size-mm 130
   ```

   Results land in `~/Library/Application Support/Splat360/projects/<id>/export/`.
   The app shows the trained splat in a built-in viewer with the camera path
   and tags overlaid.

Without a camera: `splat360 demo -o synthetic.mp4` renders a synthetic tagged
room you can run through the whole pipeline; the app can create the same demo
project for you (`POST /api/demo/synthetic`).

## How the pipeline works

The engine runs eight stages. Each writes a completion marker, so a project can
be resumed or re-run from any stage without repeating the earlier ones.

**probe.** `ffprobe` reads the container. Raw `.insv`/`.insp` files and square
dual-fisheye exports are rejected with an explanation; the frame must be 2:1
equirectangular, at least 5 s long; below 4K wide is a warning.

**extract.** The clip is decoded once at full resolution. Candidate frames are
scored for sharpness (variance of the Laplacian on a downscaled copy), the
blurriest quarter of each window is discarded and 200 keyframes (default) are
picked evenly over the clip so that slow and fast parts of the walk are both
covered. Thumbnails are kept for the UI.

**reproject.** An equirectangular image is not a pinhole image, and COLMAP's
models of it are poor. Every keyframe is resampled into six 100° pinhole faces
of 1600 px (front, right, back, left, up, down), or a ring of eight views plus
up and down for the *quality* preset. Because all faces of one frame share the
optical centre and have known rotations, they form a rigid rig with exact,
fixed intrinsics. A nadir mask blanks the cone around straight down (the
tripod, stick and your hand) so it never enters SfM or training.

**tags.** AprilTags (`tag36h11`) are detected in every view; weak detections
are dropped. Tags are optional but they are what make the result metric.

**sfm.** COLMAP extracts SIFT features with intrinsics fixed per face and the
nadir masks applied. Instead of exhaustive matching, an explicit pair list is
built: each frame against its ±6 neighbours in time, adjacent faces of the
same frame, and every 10th frame against every other 10th frame for loop
closure. The mapper runs with intrinsics locked and the rig constraint applied
(`rig_configurator` on COLMAP 3.11+, `rig_bundle_adjuster` on 3.9/3.10), which
keeps the six faces welded together and removes most of the drift a 360°
walk would otherwise accumulate. GLOMAP can replace the incremental mapper.

**align.** Tag corners are triangulated from the registered views. The
distance between corners is known from the printed size, which fixes the
metric scale; floor tags define the ground plane and gravity; the model is
rotated so +Y is down, the floor is placed at y = 0 and the trajectory is
centred at x = z = 0. Without tags the scene is levelled from the camera
poses and stays in arbitrary units.

**train.** The aligned COLMAP model and views are handed to Brush (30 000
iterations by default, Metal) or OpenSplat. If neither is installed the SfM
points are written as a splat so you still get a preview.

**export.** `splat.ply`, `splat.splat`, `sparse_points.ply`, `tags.json`,
`report.json`/`report.html` with per-stage timings, registration rate,
reprojection error, scale residual and a quality score, plus `job.log`.

### Why a rigid six-face rig

Feeding COLMAP the equirectangular frames directly fails in practice: SIFT
descriptors are not invariant to the strong, position-dependent distortion,
and COLMAP's spherical camera support is thin. Cube faces give clean pinhole
geometry with intrinsics that are known exactly (they are chosen, not
estimated), so nothing has to be self-calibrated. Treating the six faces as a
rig adds the knowledge that they were captured from one point at one instant:
a face that sees only a blank wall is still positioned correctly by its
siblings, and the bundle adjustment cannot bend the rig apart. The explicit
pair list turns matching from O(n²) into roughly 25 000 pairs for 1 200
views, which is what makes CPU-only SfM finish in tens of minutes.

### What the AprilTags do

Structure-from-motion recovers shape up to an unknown scale and orientation.
A printed tag is a calibration object of known size lying on a known surface:
its four corners, triangulated from many views, give the scale (the residual
across all tags is reported, so a print that came out at 97 % shows up as a
3 % residual instead of silently shrinking the room), the tag plane gives
gravity and the floor height, and the ids make the measurement unambiguous
even when several tags look alike from a distance. They also give you a check
you can trust: if a 130 mm tag measures 130 mm ± 1 % in the model, the
reconstruction is sound. Tags are not used for feature matching; SfM works
the same with or without them.

## Performance

Measured on a 4-core Linux box with a small synthetic clip (30 keyframes,
180 views at 800 px): SfM about 5 minutes. The figures below for a real 30 s
8K30 clip on an M-series Mac with the *balanced* preset (200 keyframes,
1 200 views at 1 600 px) are **estimates**, not measurements:

| Stage | Estimate | Bound by |
| --- | --- | --- |
| Keyframes (decode 8K, sharpness scoring) | 2–4 min | CPU / video decoder |
| Pinhole views (1 200 images) | 1–2 min | CPU |
| AprilTag detection | ~1 min | CPU |
| SfM (SIFT, ~25 k pairs, mapper, rig BA) | 15–40 min | CPU (SIFT matching) |
| Alignment | seconds | |
| Training, 30 k iterations (Brush, Metal) | 15–40 min | GPU |
| Export | < 1 min | disk |

*fast* roughly halves everything; *quality* (320 keyframes, ring of 10 views at
2 000 px, 45 k iterations) is several times slower. Disk: 5–20 GB per project
while intermediates are kept.

## Outputs

`~/Library/Application Support/Splat360/projects/<id>/export/`

| File | Content |
| --- | --- |
| `splat.ply` | Gaussian splat, standard 3DGS PLY (positions, SH coefficients, opacity, scales, rotations) |
| `splat.splat` | antimatter15 `.splat` for lightweight web viewers |
| `sparse_points.ply` | COLMAP point cloud after alignment, metric and levelled |
| `tags.json` | every tag observation (id, view, corners, decision margin) |
| `report.json`, `report.html` | settings, per-stage metrics and timings, quality score and notes |
| `job.log` | combined log of the last job |
| `checkpoint_<iter>.ply` | intermediate splats when checkpoints are enabled |

Coordinates: +X right, +Y down, +Z forward (OpenCV / COLMAP convention),
floor at y = 0 when floor tags were found, units metres. Viewers that expect
Y up need a 180° rotation about X, which most splat viewers offer.

## FAQ

**Do I need the tags?** No. Without them you get a splat in arbitrary units,
levelled from the camera path. With them you get metres, a floor plane and
noticeably better loop closure.

**Do I need a GPU trainer?** Reconstruction (probe through align) is CPU only.
Training needs Brush or OpenSplat; without one the export is a point-cloud
preview you can still inspect in the viewer.

**Can I use another 360° camera?** Anything that exports 2:1 equirectangular
video at 4K or more. Stabilised, horizon-locked output helps but is not required.

**How long a clip?** 20–60 s. Longer clips are accepted up to 5 minutes; use
the trim settings, or the keyframe count grows without adding coverage.

**Can I re-run just the training?** Yes, from the app (run the project from
the *train* stage) or the API (`POST /api/projects/{id}/run` with
`from_stage`). Earlier stages are reused from disk. The `splat360 run` command
always creates a new project, so it cannot resume an existing one.

**Where is everything stored?** `~/Library/Application Support/Splat360`
(`--data-dir` or `SPLAT360_DATA_DIR` to override). Delete a project from the
app to remove its working directory.

**Windows or Linux?** The engine and web UI are portable Python/TypeScript and
run on Linux (CI does). The packaged app, Metal training and the setup script
target macOS.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md): manual install, what the setup script does, updating.
- [docs/CAPTURE_GUIDE.md](docs/CAPTURE_GUIDE.md): tags, camera settings, walking pattern, Insta360 Studio export.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, process model, on-disk layout, resume, security.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): probe errors, low registration, missing tags, wrong scale, trainer problems, Gatekeeper.
- [docs/API.md](docs/API.md): the engine's HTTP/WebSocket API and the desktop bridge.
- [desktop/README.md](desktop/README.md): building, signing and notarizing the macOS app.
- [engine/README.md](engine/README.md): engine package layout and tests.

## Development

```sh
make setup        # scripts/setup-mac.sh
make dev          # engine with reload + Vite dev server (make dev-desktop adds Electron)
make test         # engine pytest, frontend and desktop vitest
make lint         # ruff, eslint, tsc
make build-mac    # DMG in desktop/release/
```

CI runs the engine tests on Ubuntu and the frontend/desktop checks on Node 22;
`release-mac.yml` builds the DMG on a macOS runner on demand.

## Roadmap

- Multi-clip projects (merge several walks of the same space).
- GPU feature matching on Metal to cut the SfM time.
- Wall-mounted tag support with per-tag normals in the report.
- Mesh export (Poisson from the splat centres) for CAD hand-off.
- Automatic trimming of the start and end of the walk (operator fumbling).
- Intel builds and a Linux AppImage.

## License

MIT, see [LICENSE](LICENSE). Brush, COLMAP, ffmpeg and the other tools this
project drives are licensed separately by their authors.
