# Splat360 Studio

Turns Insta360 X6 360° video into 3D Gaussian splats; prints AprilTags for metric scale and levelling.

## Layout
- `engine/` Python 3.11+ FastAPI engine + CLI (`splat360`). Pipeline stages in `engine/splat360/pipeline/`, COLMAP glue in `engine/splat360/colmap/`, trainers in `engine/splat360/train/`, AprilTags in `engine/splat360/tags/`.
- `frontend/` Vite + React + TypeScript UI, built to `frontend/dist` and served by the engine at `/`.
- `desktop/` Electron shell for macOS; spawns the engine as a sidecar.
- `docs/API.md` and `engine/splat360/models.py` are the API contract; `frontend/src/api/types.ts` mirrors it.

## Commands
- Engine: `cd engine && pip install -e ".[dev]" && python -m pytest tests -q` (fast). Full pipeline test: `SPLAT360_E2E=1 python -m pytest tests/test_e2e_synthetic.py -q` (needs ffmpeg + colmap, minutes).
- Frontend: `cd frontend && npm install && npm run typecheck && npm run lint && npm test && npm run build`.
- Desktop: `cd desktop && npm install && npm run typecheck && npm test`.
- Run locally: `splat360 serve --open` (after building the frontend) or `scripts/dev.sh`.

## Conventions
- Coordinate conventions are documented in `engine/splat360/pipeline/geometry.py` (+X right, +Y down, +Z forward; floor at y=0 after alignment). Do not change them without updating align, synth and the viewer.
- COLMAP option names differ between 3.9 and 3.11+; use `Colmap.pick()` / `Colmap.run()` which drop unsupported options.
- Tag sizes refer to the black square edge (`width_at_border` cells). 130 mm is the largest tag36h11 that fits Letter/A4.
- Add fields to models rather than renaming; keep `docs/API.md` in sync.
