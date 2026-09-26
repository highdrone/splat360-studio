# Splat360 Engine API

The engine is a local FastAPI server (`splat360 serve`) that the web UI and the
macOS desktop shell talk to. All routes are prefixed with `/api`. JSON bodies
use the Pydantic models in `engine/splat360/models.py`; that file is the source
of truth for every shape below. TypeScript types in
`frontend/src/api/types.ts` mirror it field-for-field.

Base URL: `http://127.0.0.1:<port>` (default port 8765). The desktop shell picks
a free port and passes it to the UI as `window.splat360.apiBase`; in the browser
the UI uses the same origin.

Errors: non-2xx responses carry `{"detail": "<message>"}` (FastAPI default).
Validation errors carry FastAPI's `{"detail": [...]}` list.

## Health and environment

| Method | Path | Response | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | `Health` | Cheap liveness check. |
| GET | `/api/doctor` | `DoctorReport` | Detects ffmpeg, ffprobe, colmap, glomap, brush, opensplat; platform info; `ready`, `can_reconstruct`, `can_train`. Runs every call (about 1 s). |
| GET | `/api/settings/defaults` | `PipelineSettings` | Default settings. |
| GET | `/api/settings/presets` | `QualityPreset[]` | `fast`, `balanced`, `quality`. |
| GET | `/api/stages` | `{name, label}[]` | Stage order and human labels. |

## Projects

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/projects` | | `Project[]` (newest first) |
| POST | `/api/projects` | `ProjectCreate` | `Project` |
| GET | `/api/projects/{id}` | | `Project` |
| PATCH | `/api/projects/{id}` | `ProjectUpdate` | `Project` (rejected with 409 while a job is active) |
| DELETE | `/api/projects/{id}` | | `204` (deletes the work directory) |
| POST | `/api/projects/{id}/source` | `SetSourceRequest` | `Project` with `source` populated. Probes the file; `source.issues` lists errors/warnings. 422 if the path does not exist. Never copies the file. |
| POST | `/api/projects/{id}/upload` | multipart `file` | `Project`. Browser fallback: stores the file in the project workdir, then probes it. |
| POST | `/api/projects/{id}/run` | `RunRequest` | `Job` (202). 409 if a job is already active, 422 if the source has errors or the doctor says tools are missing for the requested stages. |
| GET | `/api/projects/{id}/jobs` | | `Job[]` |
| GET | `/api/projects/{id}/artifacts` | | `Artifact[]` |
| GET | `/api/projects/{id}/artifacts/{name}` | | File download (`Content-Disposition: attachment`). `?inline=1` to stream inline (used by the viewer and image previews). Supports HTTP Range. |
| GET | `/api/projects/{id}/keyframes` | | `{count, items: [{index, time_s, sharpness, url}]}` — thumbnail URLs (`/api/projects/{id}/keyframes/{index}.jpg`). |
| GET | `/api/projects/{id}/keyframes/{index}.jpg` | | JPEG thumbnail (about 1024 px wide). |
| GET | `/api/projects/{id}/views` | | `{count, faces: string[], items: [{name, frame_index, face, url}]}` (first 200 by default, `?offset=&limit=`). |
| GET | `/api/projects/{id}/views/{name}` | | JPEG/PNG pinhole view. `name` may contain one `/`. |
| GET | `/api/projects/{id}/tags` | | `TagSummary` (404 until the tags stage has run). |
| GET | `/api/projects/{id}/tags/observations` | | `TagObservation[]` (`?tag_id=` filter). |
| GET | `/api/projects/{id}/report` | | `ProjectReport` (404 until export has run at least once; partial reports are available after each stage via `?partial=1`). |
| GET | `/api/projects/{id}/cameras` | | `{frames: [{index, position:[x,y,z], quaternion:[w,x,y,z]}], points_sample: [[x,y,z,r,g,b], ...]}` after `align`. Used for the trajectory overlay in the viewer. |

Artifact `name`s produced by the pipeline (stable):

- `splat.ply` — the trained Gaussian splat (3DGS PLY, kind `ply`).
- `splat.splat` — antimatter15 `.splat` format for lightweight web viewers.
- `report.json` — `ProjectReport`.
- `report.html` — human-readable report.
- `sparse_points.ply` — SfM point cloud (metric, levelled).
- `tags.json` — all tag observations.
- `job.log` — combined log of the last job.
- `checkpoint_<iter>.ply` — intermediate splats when `checkpoint_every > 0`.

## Jobs

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/jobs` | `Job[]` (active first) |
| GET | `/api/jobs/{id}` | `Job` |
| POST | `/api/jobs/{id}/cancel` | `Job` (status `cancelled` once the running stage stops; child processes are killed) |
| GET | `/api/jobs/{id}/log?tail=500` | `text/plain`, last N lines |
| WS | `/api/ws/jobs/{id}` | stream of `JobEvent` |

Websocket protocol: on connect the server sends one `{"type":"snapshot", "job": Job}`
then streams `stage` events (progress, message, metrics, eta_s), `log` lines
and finally a `job` event with the terminal status. The socket closes after the
terminal event. Clients should reconnect with backoff; a snapshot is always
sent first so reconnects are lossless for state (logs may have gaps; use
`/log` to backfill).

There is also `/api/ws/events`, a global stream that emits `job` and `stage`
events for every job (used by the dashboard).

## AprilTags

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/tags/families` | | `TagFamilyInfo[]` |
| GET | `/api/tags/{family}/{id}.png?px=600` | | PNG of a single tag with quiet zone. |
| GET | `/api/tags/{family}/{id}.svg?size_mm=200` | | Vector SVG at physical size (for large-format printing). |
| POST | `/api/tags/sheet` | `TagSheetRequest` | `application/pdf`. One tag per page when the tag is larger than half the page; otherwise a grid. Every tag carries an id label, family, size, project name, and crop marks. Page 1 is a placement guide (optional). A 100 mm scale bar lets the user verify print scale. |
| POST | `/api/tags/plan` | `TagPlanRequest` | `TagPlan` — recommended count, size and spacing. |

## Demo

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/demo/synthetic` | `SyntheticDemoRequest` | `Project` with a rendered synthetic equirectangular clip of a tagged room as its source. Lets a user verify the install end-to-end without a camera. |

## Desktop bridge (Electron only)

Exposed on `window.splat360` by the preload script:

```ts
interface Splat360Bridge {
  apiBase: string;                                   // e.g. "http://127.0.0.1:53211"
  platform: "darwin" | "win32" | "linux";
  version: string;
  pickVideo(): Promise<string | null>;               // native open dialog, returns absolute path
  pickDirectory(): Promise<string | null>;
  revealPath(path: string): Promise<void>;           // show in Finder
  openExternal(url: string): Promise<void>;
  savePdf(bytes: ArrayBuffer, suggestedName: string): Promise<string | null>;
  onEngineStatus(cb: (s: {state: "starting"|"ready"|"error"; message?: string}) => void): () => void;
}
```

In the browser `window.splat360` is undefined; the UI must fall back to an
upload control and to plain downloads.
