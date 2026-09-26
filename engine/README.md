# splat360 engine

Python engine behind Splat360 Studio: a FastAPI server plus a job runner that
turns an equirectangular 360° video into a 3D Gaussian splat.

```
pip install -e ".[dev]"
splat360 doctor                 # check ffmpeg / COLMAP / Brush
splat360 serve --open           # API + web UI on http://127.0.0.1:8765
splat360 run clip.mp4 --preset balanced --tag-size-mm 200
splat360 tags sheet -o tags.pdf --count 12 --size-mm 200 --page letter
splat360 demo -o synthetic.mp4  # render a synthetic tagged room for testing
```

## Layout

| Package | Role |
| --- | --- |
| `splat360.models` | Pydantic models shared with the UI (see `docs/API.md`). |
| `splat360.pipeline.probe` | ffprobe validation, equirect / dual-fisheye / `.insv` detection. |
| `splat360.pipeline.extract` | sharpness-scored keyframe selection, full-res extraction with ffmpeg. |
| `splat360.pipeline.geometry` | rig / equirect / pinhole conventions (documented in the module). |
| `splat360.pipeline.reproject` | equirect → cube6 / ring8 pinhole views + nadir masks. |
| `splat360.tags` | AprilTag families (vendored code tables), detection, PDF/SVG printing, planning. |
| `splat360.colmap` | COLMAP runner (3.9 → 3.12+ aware), sparse model IO, match-pair builder. |
| `splat360.pipeline.sfm` | feature extraction, custom pair matching, mapping, rig bundle adjustment. |
| `splat360.pipeline.align` | tag triangulation → metric scale, floor plane, levelling, centring. |
| `splat360.train` | trainer adapters: Brush (Metal), OpenSplat (MPS), point-cloud preview. |
| `splat360.pipeline.stages` | stage functions, report, artifacts. |
| `splat360.jobs` / `splat360.store` | job execution, cancellation, resume, persistence, events. |
| `splat360.api` / `splat360.cli` | HTTP + websocket API, command line. |
| `splat360.synth` | synthetic equirect renderer with ground truth (tests and demo). |

## Tests

```
python -m pytest tests -q                    # fast unit tests
SPLAT360_E2E=1 python -m pytest tests/test_e2e_synthetic.py -q   # full pipeline (needs COLMAP, minutes)
```

## Data directory

macOS: `~/Library/Application Support/Splat360` (override with `--data-dir` or
`SPLAT360_DATA_DIR`). Each project lives in `projects/<id>/` with
`keyframes/`, `views/`, `tags/`, `sfm/`, `align/`, `train/`, `export/`,
`logs/`, `jobs/` and `stages/` (completion markers used for resume).
