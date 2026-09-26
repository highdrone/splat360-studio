# Troubleshooting

Start with `splat360 doctor` (or *Environment Check*, Cmd-Shift-E, in the
app) and the job log (*Show Engine Log*, Cmd-Shift-L, or
`projects/<id>/logs/<job>.log`). Every failed stage writes the reason into
the job and the log keeps the full output of the tool that failed.

## Importing the video

**"This is a raw Insta360 file (unstitched dual fisheye)"** (`insta360_raw`)
The camera's `.insv` is two fisheye images side by side. Export it from
Insta360 Studio as an equirectangular MP4 first (8K, H.265/H.264, FlowState
on, Direction Lock off). See [CAPTURE_GUIDE.md](CAPTURE_GUIDE.md#5-export-from-insta360-studio).

**"… looks like an unstitched dual-fisheye export"** (`dual_fisheye`)
The frame is square. The export was made with the wrong projection. Re-export
as *360 video / equirectangular*, which gives a 2:1 frame such as 7680×3840.

**"… is not a 2:1 equirectangular frame"** (`not_equirect`)
Reframed exports (flat 16:9 video) cannot be reconstructed. Re-export the
untouched 360° clip. If the clip is genuinely 2:1 but ffprobe reports odd
dimensions (rotation metadata, cropped exports), run
`scripts/check-video.sh clip.mp4` and remux with
`ffmpeg -i in.mp4 -c copy -metadata:s:v rotate=0 out.mp4`.

**"Clip is N s; need at least 5 s"** (`too_short`) or **"ffprobe not found"**
(`no_ffprobe`): `brew install ffmpeg`. If ffmpeg is installed but the app
does not see it, the app was probably launched from a shell with an unusual
`PATH`; the app searches `/opt/homebrew/bin` regardless, so check that
`brew --prefix` is `/opt/homebrew` (Apple Silicon) and not `/usr/local`
(Intel Homebrew under Rosetta), and restart the app.

**"below 4K; reconstruction detail will suffer"** (`low_res`) is a warning.
The pipeline runs, but 5.7K or 8K exports give visibly better splats.

**"Unusual codec"** / decode errors during extract: convert with
`ffmpeg -i in.mp4 -c:v libx264 -crf 14 -pix_fmt yuv420p out.mp4`.

## Keyframes and views

**Few keyframes, or the sharpness metric is low everywhere.** The walk was
too fast or the light too low. Sharpness is the variance of the Laplacian on
a 960 px proxy; values under about 20 mean motion blur. Re-shoot slower or
brighter; there is no fix in software.

**The bottom of every view is black.** That is the nadir mask (default 30°
radius around straight down), hiding the stick and your hand. Reduce it in
*Settings > Views > nadir mask* only if the camera was on a tripod.

## AprilTags

**"No tags detected" / `TagSummary.unique_tags = 0`**

1. Wrong family: the sheet is `tag36h11` unless you changed it; the project
   setting must match.
2. Too far: at 1 600 px views a tag needs ~30 px, i.e. within ~22 × its size
   (130 mm → 2.9 m). Use bigger tags or walk closer.
3. Glossy paper or laminate: the highlight blanks the tag from many angles.
4. The tags were in the nadir mask when you passed them. Views from further
   away still see them; if every view is close, lower the mask radius.
5. Low `min_decision_margin` helps with dim footage; raise it if you see
   false detections (wrong ids appearing once).

The *Tags* tab lists observations per id; ids seen in fewer than three views
are flagged `weak` and are ignored for scale.

**Detections but the tag stage says coverage is low.** Fine as long as 4+
tags have solid counts; alignment needs at least one well-observed tag for
scale and three floor tags for a plane.

## Structure-from-motion

**"COLMAP registered X of N views (Y %), below the 60 % threshold"**

Registration below 60 % fails the job on purpose; a splat trained on a
partial track is misleading. In order of likelihood:

1. **Motion blur or darkness.** Check keyframe thumbnails; if edges are soft,
   re-shoot.
2. **Textureless scene**: white walls, large glass, bare floors. Add
   objects, posters, or simply more tags (they are texture too), and walk
   closer to walls.
3. **No loop closure / the walk jumps.** A cut in the clip or a very fast
   turn breaks the temporal chain. Trim to the continuous part
   (*Settings > Keyframes > start/end*).
4. **Too few pairs verified** (warning in the log): increase `sfm.window`
   (6 → 10) and lower `sfm.loop_stride` (10 → 6), or use the *quality*
   preset (ring8 views overlap more than cube6). Enable
   `sfm.guided_matching` for a second matching pass.
5. **Rig support missing**: the doctor shows COLMAP's rig capability. With
   "no rig support" (COLMAP < 3.9) faces drift independently; upgrade
   (`brew upgrade colmap`).
6. **Multiple models** (`SfmReport.models_found > 1`): the track broke into
   pieces; the largest is kept. Same fixes as 3.

**SfM is slow.** CPU SIFT matching over ~25 000 pairs is the bottleneck:
15–40 minutes for a 30 s 8K clip on an M-series Mac is expected. `fast`
preset halves it. `brew install glomap` and `sfm.engine = glomap` speeds up
the mapping step, not the matching. Reduce `sfm.max_features` (8192 → 6144)
for a modest gain.

**"COLMAP produced no reconstruction."** The first pairs failed to
initialise; usually blur or a clip whose first seconds are the operator
fumbling with the camera. Trim the start.

## Alignment and scale

**The model is the wrong size** (a room is 3 m instead of 4 m, or a tag
measures 97 %).

- The tag size in the project settings must be the printed black-square
  edge in millimetres. Measure one tag with a ruler; the "fit to page" print
  option is the usual cause.
- `AlignmentReport.scale_residual_pct` above ~2 % means the tags disagree
  with each other: one is curled, a wrong size was mixed in, or an id was
  used twice. Check `tag_edge_rmse_mm` and remove the offending id from
  `tags.ids`.
- `method = camera_up` means no tags were usable; the model is in arbitrary
  units. Fix the tag detection first, then re-run from `align`.

**The floor is tilted or the scene is upside down.** Alignment uses floor
tags whose normal is within 25° of the camera's up vector. Wall tags with
`placement = floor` confuse it; set placement to `mixed` or `wall`. A model
that comes out upside down in an external viewer usually just needs that
viewer's Y-up conversion (the export is +Y down, floor at y = 0).

## Training

**"Brush not found"** / doctor shows brush missing

- Run `scripts/setup-mac.sh` (it builds Brush and links it into
  `~/Library/Application Support/Splat360/bin`).
- Built by hand? The engine accepts `brush-cli`, `brush_cli`, `brush` or
  `brush_app` on `PATH`, in `~/.cargo/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin` or `<data-dir>/bin`. `cargo install` puts them in
  `~/.cargo/bin`, which the app adds to `PATH` itself.
- `cargo install brush` (without `--git`) installs an unrelated crate.
  Use `cargo install --git https://github.com/ArthurBrussee/brush.git brush-cli`.
- A downloaded binary that "cannot be opened": `xattr -dr
  com.apple.quarantine <binary>`.
- Restart the app after installing; the doctor runs on every call but the
  engine process inherited its `PATH` at start-up.

**Brush build fails.** Update Rust (`rustup update stable`), make sure Xcode
Command Line Tools are installed (`xcode-select --install`), and retry with
the `brush-app` crate or the prebuilt release, as in
[INSTALL.md](INSTALL.md#3-trainer). The build needs about 3 GB free.

**Training runs out of memory / the Mac becomes unresponsive.** The 30 k
iteration default at 1 600 px with up to 3 M splats needs roughly 8–12 GB
of unified memory. On 8 GB machines, or when other apps hold the GPU: lower
`train.max_resolution` (1600 → 1200), `train.max_splats` (3 M → 1.5 M) and
use the `fast` preset. Close browsers with WebGL tabs. `checkpoint_every`
writes intermediate PLYs so a killed run still leaves something to look at.

**Training is slow.** 15–40 minutes for 30 k iterations on Brush/Metal is
expected on M1/M2; M3/M4 are faster. Thermal throttling on fanless machines
roughly doubles it. `iterations = 15000` is usually enough for a preview.

**The result is blurry or has floaters.** Registration quality, not the
trainer. Check `SfmReport.mean_reprojection_error_px` (< 1 px is good) and
the registered fraction; floaters in the sky/ceiling come from the nadir
region and from windows. More iterations do not fix bad poses.

**Only a point cloud was exported.** No trainer was found and `backend` is
`auto`, or `backend = mock` is set. Install Brush and re-run from `train`.

## Desktop app

**"Splat360 Studio is damaged and can't be opened" / "cannot be opened
because the developer cannot be verified"**

The build is not notarized (all local builds and CI artifacts). Clear the
quarantine flag once:

```sh
xattr -dr com.apple.quarantine "/Applications/Splat360 Studio.app"
```

or right-click the app, *Open*, and confirm. Release builds signed with a
Developer ID and notarized do not need this.

**Setup window: "python3 was not found" / "is too old".** The app needs
Python 3.11+. `brew install python@3.12`, then relaunch. `SPLAT360_PYTHON`
can point at a specific interpreter.

**"engine did not answer /api/health within 60s".** Look at
`~/Library/Logs/Splat360 Studio/engine.log` (*Show Engine Log*). Common
causes: a broken venv (delete `~/Library/Application Support/Splat360/venv`
and relaunch, or run `scripts/setup-mac.sh --engine-only`), a missing
Python package after an update (same fix), or a firewall product that
blocks localhost listeners.

**The engine keeps restarting.** After three crashes the error window opens
with the log tail. A crash on start is almost always an import error in the
venv; on job start it is usually an external tool dying (see the job log).

**The UI is blank / "Frontend build not found".** In a source checkout run
`npm --prefix frontend run build` (or use `scripts/dev.sh --desktop`). The
packaged app bundles the build.

**Where are my files?** *File > Open Data Folder* opens
`~/Library/Application Support/Splat360`. Each project's `export/` has the
results; *Reveal in Finder* on an artifact jumps there.

## Still stuck

Open an issue with the doctor output, `report.json` if the job got that far,
and the last 200 lines of the job log. Do not attach the video unless asked;
a description of the scene and the capture settings is more useful.
