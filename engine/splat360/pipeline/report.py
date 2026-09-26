"""Standalone HTML report."""
from __future__ import annotations

import html

from ..models import ProjectReport


def _row(k: str, v) -> str:
    return f"<tr><th>{html.escape(str(k))}</th><td>{html.escape('' if v is None else str(v))}</td></tr>"


def _fmt(v, nd=2):
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def render_html(r: ProjectReport) -> str:
    score = r.quality_score
    colour = "#22c55e" if (score or 0) >= 80 else "#eab308" if (score or 0) >= 55 else "#ef4444"
    parts = [f"""<!doctype html><html><head><meta charset="utf-8"><title>Splat360 report</title>
<style>
body{{font:14px/1.5 -apple-system,BlinkMacSystemFont,Inter,Segoe UI,sans-serif;margin:0;padding:32px;color:#111;background:#fafafa}}
h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}}
table{{border-collapse:collapse;min-width:420px}} th{{text-align:left;padding:4px 16px 4px 0;color:#555;font-weight:500}} td{{padding:4px 0}}
.score{{display:inline-block;font-size:28px;font-weight:700;color:{colour}}} .muted{{color:#666}}
ul{{padding-left:18px}} code{{background:#eee;padding:1px 4px;border-radius:3px}}
</style></head><body>
<h1>Splat360 Studio report</h1>
<div class="muted">Project {html.escape(r.project_id)} · generated {r.generated_at.strftime('%Y-%m-%d %H:%M UTC')}</div>
<h2>Quality</h2>
<div class="score">{_fmt(score, 0)}<span style="font-size:14px;color:#555"> / 100</span></div>
<ul>{''.join(f'<li>{html.escape(n)}</li>' for n in r.quality_notes) or '<li>No issues detected.</li>'}</ul>
"""]
    if r.source:
        s = r.source
        parts.append("<h2>Source</h2><table>" + _row("File", s.filename) + _row("Resolution", f"{s.width}x{s.height}")
                     + _row("Frame rate", _fmt(s.fps)) + _row("Duration", f"{_fmt(s.duration_s, 1)} s")
                     + _row("Codec", s.codec) + _row("Projection", s.projection) + "</table>")
    parts.append("<h2>Keyframes and views</h2><table>" + _row("Keyframes", r.keyframes.get("count"))
                 + _row("Frames scored", r.keyframes.get("frames_scored"))
                 + _row("View layout", r.views.get("layout")) + _row("Views", r.views.get("count"))
                 + _row("View size", f"{r.views.get('size')} px, {_fmt(r.views.get('fov_deg'), 0)}° FOV") + "</table>")
    if r.tags:
        t = r.tags
        parts.append("<h2>AprilTags</h2><table>" + _row("Family", t.family) + _row("Printed size", f"{t.size_mm} mm")
                     + _row("Unique tags", t.unique_tags) + _row("Observations", t.total_observations)
                     + _row("Views with tags", f"{t.views_with_tags} / {t.views_total} ({t.coverage_fraction * 100:.0f}%)")
                     + (_row("Weak tags (<3 views)", ", ".join(map(str, t.weak_tags))) if t.weak_tags else "") + "</table>")
    if r.sfm:
        s = r.sfm
        parts.append("<h2>Structure from motion</h2><table>" + _row("Engine", f"{s.engine} (COLMAP {s.colmap_version})")
                     + _row("Registered views", f"{s.images_registered} / {s.images_total} ({s.registered_fraction * 100:.0f}%)")
                     + _row("Registered keyframes", f"{s.frames_registered} / {s.frames_total}")
                     + _row("3D points", s.points3d) + _row("Mean reprojection error", f"{_fmt(s.mean_reprojection_error_px, 3)} px")
                     + _row("Mean track length", _fmt(s.mean_track_length)) + _row("Rig constrained", "yes" if s.rig_constrained else "no")
                     + _row("Models found", s.models_found) + "</table>"
                     + ("<ul>" + "".join(f"<li>{html.escape(w)}</li>" for w in s.warnings) + "</ul>" if s.warnings else ""))
    if r.alignment:
        a = r.alignment
        parts.append("<h2>Scale and levelling</h2><table>" + _row("Method", a.method)
                     + _row("Scale factor", _fmt(a.scale_factor, 5)) + _row("Scale spread", f"{_fmt(a.scale_residual_pct)} %")
                     + _row("Tags used", a.tags_used) + _row("Tag edge RMSE", f"{_fmt(a.tag_edge_rmse_mm, 1)} mm")
                     + _row("Ground plane from tags", "yes" if a.ground_plane_from_tags else "no") + "</table>"
                     + ("<ul>" + "".join(f"<li>{html.escape(n)}</li>" for n in a.notes) + "</ul>" if a.notes else ""))
    if r.train:
        t = r.train
        parts.append("<h2>Training</h2><table>" + _row("Backend", t.backend) + _row("Iterations", t.iterations)
                     + _row("Duration", f"{t.duration_s / 60:.1f} min") + _row("Splats", t.final_splats)
                     + _row("PSNR", _fmt(t.psnr)) + _row("SSIM", _fmt(t.ssim, 3)) + "</table>")
    if r.timings_s:
        parts.append("<h2>Timings</h2><table>" + "".join(_row(k, f"{v:.0f} s") for k, v in r.timings_s.items())
                     + _row("Total", f"{sum(r.timings_s.values()) / 60:.1f} min") + "</table>")
    if r.artifacts:
        parts.append("<h2>Outputs</h2><ul>" + "".join(
            f"<li><code>{html.escape(a.name)}</code> <span class='muted'>{a.size_bytes / 1e6:.1f} MB</span></li>"
            for a in r.artifacts) + "</ul>")
    parts.append("</body></html>")
    return "".join(parts)
