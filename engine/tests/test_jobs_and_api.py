import json
import time

from fastapi.testclient import TestClient

from splat360.api import create_app
from splat360.jobs import JobManager
from splat360.models import STAGE_ORDER, JobStatus, ProbeInfo, StageName, StageStatus
from splat360.store import ProjectStore
from splat360.util.proc import ToolError


def _fake_stages(fail_at=None, slow=None, calls=None):
    fns = {}
    for s in STAGE_ORDER:
        def fn(ctx, s=s):
            if calls is not None:
                calls.append(s)
            ctx.log(f"hello from {s.value}")
            for i in range(3):
                ctx.progress((i + 1) / 3, f"step {i}")
                if slow and s == slow:
                    time.sleep(0.2)
            if fail_at == s:
                raise ToolError("boom")
            return {"metrics": {"n": 1}, "message": "ok"}
        fns[s] = fn
    return fns


def _project_with_source(store, tmp_path):
    p = store.create("t")
    f = tmp_path / "v.mp4"
    f.write_bytes(b"x")
    p.source = ProbeInfo(path=str(f), filename="v.mp4", size_bytes=1, width=7680, height=3840, fps=30, duration_s=30,
                         is_equirectangular=True, projection="equirectangular")
    store.save(p)
    return p


def _wait(manager, job_id, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = manager.get(job_id)
        if j and not j.is_active:
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_job_runs_all_stages_and_writes_markers(data_dir, tmp_path):
    store = ProjectStore(data_dir)
    calls = []
    m = JobManager(store, _fake_stages(calls=calls))
    p = _project_with_source(store, tmp_path)
    job = m.submit(p, None, False)
    j = _wait(m, job.id)
    assert j.status == JobStatus.complete
    assert calls == list(STAGE_ORDER)
    assert all(st.status == StageStatus.complete for st in j.stages)
    for s in STAGE_ORDER:
        assert store.stage_marker(p.id, s.value)
    assert store.job_log_path(j).read_text().count("hello from") == len(STAGE_ORDER)
    assert store.get(p.id).status.value == "complete"


def test_job_failure_and_resume(data_dir, tmp_path):
    store = ProjectStore(data_dir)
    m = JobManager(store, _fake_stages(fail_at=StageName.sfm))
    p = _project_with_source(store, tmp_path)
    j = _wait(m, m.submit(p, None, False).id)
    assert j.status == JobStatus.failed
    assert "boom" in (j.error or "")
    assert j.stages[4].status == StageStatus.failed
    assert j.stages[5].status == StageStatus.pending
    # resume: first incomplete stage is sfm
    calls = []
    m2 = JobManager(store, _fake_stages(calls=calls))
    j2 = _wait(m2, m2.submit(store.get(p.id), None, False).id)
    assert j2.status == JobStatus.complete
    assert calls[0] == StageName.sfm
    assert j2.stages[0].status == StageStatus.complete  # reused


def test_cancel(data_dir, tmp_path):
    store = ProjectStore(data_dir)
    m = JobManager(store, _fake_stages(slow=StageName.extract))
    p = _project_with_source(store, tmp_path)
    job = m.submit(p, None, False)
    time.sleep(0.25)
    m.cancel(job.id)
    j = _wait(m, job.id)
    assert j.status == JobStatus.cancelled


def test_api_projects_and_tags(data_dir, tmp_path, monkeypatch):
    store = ProjectStore(data_dir)
    m = JobManager(store, _fake_stages())
    app = create_app(store, m, frontend_dir=tmp_path / "nofe")
    c = TestClient(app)
    assert c.get("/api/health").json()["ok"]
    assert c.get("/api/doctor").status_code == 200
    assert [s["name"] for s in c.get("/api/stages").json()] == [s.value for s in STAGE_ORDER]
    assert len(c.get("/api/settings/presets").json()) == 3
    r = c.post("/api/projects", json={"name": "demo", "preset": "fast"})
    assert r.status_code == 201
    pid = r.json()["id"]
    assert r.json()["settings"]["keyframes"]["target_count"] == 120
    assert c.get("/api/projects").json()[0]["id"] == pid
    # source that does not exist
    assert c.post(f"/api/projects/{pid}/source", json={"path": "/nope.mp4"}).status_code == 422
    # run without source
    assert c.post(f"/api/projects/{pid}/run", json={}).status_code == 422
    # patch
    r = c.patch(f"/api/projects/{pid}", json={"name": "renamed"})
    assert r.json()["name"] == "renamed"
    # tags
    fams = c.get("/api/tags/families").json()
    assert any(f["name"] == "tag36h11" and f["recommended"] for f in fams)
    assert c.get("/api/tags/tag36h11/9999.png").status_code == 404
    assert c.delete(f"/api/projects/{pid}").status_code == 204
    assert c.get(f"/api/projects/{pid}").status_code == 404


def test_api_run_and_websocket(data_dir, tmp_path, monkeypatch):
    import splat360.api as api_mod
    from splat360.models import DoctorReport, PlatformInfo
    monkeypatch.setattr(api_mod, "run_doctor", lambda: DoctorReport(
        ready=True, can_reconstruct=True, can_train=True, tools=[], trainer="mock", data_dir="x", engine_version="t",
        platform=PlatformInfo(os="t", os_version="", arch="", cpu_count=1, ram_gb=1, disk_free_gb=1, python="3")))
    store = ProjectStore(data_dir)
    m = JobManager(store, _fake_stages(slow=StageName.train))
    c = TestClient(create_app(store, m, frontend_dir=tmp_path / "nofe"))
    p = _project_with_source(store, tmp_path)
    r = c.post(f"/api/projects/{p.id}/run", json={})
    assert r.status_code == 202, r.text
    jid = r.json()["id"]
    assert c.post(f"/api/projects/{p.id}/run", json={}).status_code == 409
    types = []
    with c.websocket_connect(f"/api/ws/jobs/{jid}") as ws:
        first = json.loads(ws.receive_text())
        assert first["type"] == "snapshot"
        while True:
            ev = json.loads(ws.receive_text())
            types.append(ev["type"])
            if ev["type"] == "job" and ev["job"]["status"] in ("complete", "failed", "cancelled"):
                assert ev["job"]["status"] == "complete"
                break
    assert "stage" in types and "log" in types
    assert "hello from train" in c.get(f"/api/jobs/{jid}/log").text
    assert c.get(f"/api/projects/{p.id}").json()["status"] == "complete"
