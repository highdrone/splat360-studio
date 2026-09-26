"""Command line interface: ``splat360 serve|doctor|run|tags|demo``."""
from __future__ import annotations

import webbrowser
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from .config import ENGINE_VERSION
from .config import settings as cfg

app = typer.Typer(help="Splat360 Studio engine", add_completion=False, no_args_is_help=True)
tags_app = typer.Typer(help="AprilTag printing")
app.add_typer(tags_app, name="tags")
console = Console()


def _apply_data_dir(data_dir: Path | None) -> None:
    if data_dir:
        cfg.data_dir = data_dir.expanduser().resolve()
    cfg.ensure_dirs()


@app.callback()
def _root(data_dir: Path | None = typer.Option(None, "--data-dir", help="Where projects are stored")):
    _apply_data_dir(data_dir)


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = typer.Option(False, "--open"),
          reload: bool = False, log_level: str = "info"):
    """Start the local engine (HTTP + websocket API, serves the web UI if built)."""
    import uvicorn

    cfg.host, cfg.port = host, port
    if open_browser:
        import threading
        threading.Timer(1.5, lambda: webbrowser.open(f"http://{host}:{port}/")).start()
    console.print(f"[bold]Splat360 engine {ENGINE_VERSION}[/bold] on http://{host}:{port}  data: {cfg.data_dir}")
    if reload:
        uvicorn.run("splat360.server:app", host=host, port=port, reload=True, log_level=log_level)
    else:
        from .server import app as asgi
        uvicorn.run(asgi, host=host, port=port, log_level=log_level, ws_ping_interval=20)


@app.command()
def doctor():
    """Check that ffmpeg, COLMAP and a trainer are installed."""
    from .doctor import run_doctor

    r = run_doctor()
    t = Table(title=f"Splat360 environment ({r.platform.os} {r.platform.os_version}, {r.platform.arch})")
    for col in ("Tool", "Status", "Version", "Path / install"):
        t.add_column(col)
    for tool in r.tools:
        status = "[green]found[/green]" if tool.found else ("[red]missing[/red]" if tool.required else "[yellow]missing[/yellow]")
        t.add_row(tool.name, status, tool.version or "", tool.path or tool.install_hint)
    console.print(t)
    console.print(f"CPU {r.platform.cpu_count} cores, RAM {r.platform.ram_gb} GB, disk free {r.platform.disk_free_gb} GB, "
                  f"GPU {r.platform.gpu or 'unknown'}")
    for m in r.messages:
        console.print(f"[yellow]•[/yellow] {m}")
    console.print("[green]Ready[/green]" if r.ready else ("[yellow]Can reconstruct, no trainer[/yellow]" if r.can_reconstruct
                                                          else "[red]Not ready[/red]"))
    raise typer.Exit(0 if r.can_reconstruct else 1)


@app.command()
def run(video: Path | None = typer.Argument(None, help="Equirectangular video (omit with --project)"),
        name: str | None = None, preset: str = "balanced",
        project_id: str | None = typer.Option(None, "--project", help="Resume an existing project id"),
        from_stage: str | None = None, force: bool = False,
        tag_size_mm: float | None = None, tag_family: str | None = None,
        backend: str | None = None, iterations: int | None = None):
    """Run the whole pipeline on a video, or resume an existing project (--project ID [--from-stage])."""
    import time

    from .api import presets
    from .jobs import JobManager
    from .models import StageName
    from .pipeline.probe import probe_video
    from .pipeline.stages import STAGE_FUNCTIONS
    from .store import ProjectStore

    store = ProjectStore(cfg.data_dir)
    if project_id:
        project = store.get(project_id)
        if not project:
            console.print(f"[red]No project {project_id} in {cfg.data_dir}[/red]")
            raise typer.Exit(2)
        if video:
            project.source = probe_video(video)
        settings = project.settings
    else:
        if not video:
            console.print("[red]Give a video path or --project ID[/red]")
            raise typer.Exit(2)
        settings = next((p.settings for p in presets() if p.id == preset), None)
        if settings is None:
            console.print(f"[red]Unknown preset {preset}[/red]")
            raise typer.Exit(2)
        project = store.create(name or video.stem, settings)
        project.source = probe_video(video)
    if tag_size_mm:
        settings.tags.size_mm = tag_size_mm
    if tag_family:
        settings.tags.family = tag_family
    if backend:
        settings.train.backend = backend  # type: ignore[assignment]
    if iterations:
        settings.train.iterations = iterations
    project.settings = settings
    store.save(project)
    if not project.source:
        console.print("[red]Project has no source video[/red]")
        raise typer.Exit(1)
    for i in project.source.issues:
        console.print(f"[{'red' if i.level == 'error' else 'yellow'}]{i.level}[/]: {i.message} {i.hint or ''}")
    if not project.source.ok:
        raise typer.Exit(1)
    manager = JobManager(store, STAGE_FUNCTIONS)
    sid, q = manager.bus.subscribe(None)
    job = manager.submit(project, StageName(from_stage) if from_stage else None, force)
    console.print(f"project {project.id}  job {job.id}  workdir {project.workdir}")
    last = {}
    import queue as _q
    while True:
        try:
            ev = q.get(timeout=1)
        except _q.Empty:
            continue
        if ev.type == "stage" and ev.stage:
            key = (ev.stage.name, int(ev.stage.progress * 20))
            if last.get(ev.stage.name) != key or ev.stage.status.value in ("complete", "failed"):
                last[ev.stage.name] = key
                console.print(f"[{ev.stage.name.value:9}] {ev.stage.status.value:9} {ev.stage.progress * 100:5.1f}%  {ev.stage.message}")
        elif ev.type == "job" and ev.job and not ev.job.is_active:
            console.print(f"[bold]{ev.job.status.value}[/bold] {ev.job.error or ''}")
            for a in store.get(project.id).artifacts:
                console.print(f"  {a.name}  {a.size_bytes / 1e6:.1f} MB  {a.path}")
            raise typer.Exit(0 if ev.job.status.value == "complete" else 1)
        time.sleep(0)


@tags_app.command("sheet")
def tags_sheet(out: Path = typer.Option(Path("apriltags.pdf"), "--out", "-o"), family: str = "tag36h11",
               first_id: int = 0, count: int = 12, size_mm: float = 200.0, page: str = "letter",
               landscape: bool = False, project_name: str | None = None):
    """Write a printable AprilTag PDF."""
    from .models import TagSheetRequest
    from .tags.sheet import render_tag_sheet

    req = TagSheetRequest(family=family, first_id=first_id, count=count, tag_size_mm=size_mm, page=page,  # type: ignore[arg-type]
                          orientation="landscape" if landscape else "portrait", project_name=project_name)
    out.write_bytes(render_tag_sheet(req))
    console.print(f"wrote {out} ({count} × {family} at {size_mm} mm)")


@app.command()
def demo(out: Path = typer.Option(Path("synthetic.mp4"), "--out", "-o"), frames: int = 150, width: int = 2048):
    """Render a synthetic tagged room as an equirectangular clip (for testing)."""
    from .synth import render_synthetic_clip

    gt = render_synthetic_clip(out, frames=frames, width=width, on_progress=lambda f, m: None)
    console.print(f"wrote {out}: {gt['frames']} frames {gt['width']}x{gt['height']}, {len(gt['tags'])} tags; "
                  f"ground truth in {out}.ground_truth.json")


@app.command()
def version():
    console.print(ENGINE_VERSION)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
