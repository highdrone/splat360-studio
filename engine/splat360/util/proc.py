"""Subprocess helpers with cancellation, log streaming and tool discovery."""
from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ..config import extra_bin_dirs


class Cancelled(Exception):
    """Raised inside a stage when the job was cancelled."""


class ToolError(RuntimeError):
    """An external tool failed."""

    def __init__(self, message: str, returncode: int | None = None, tail: str = ""):
        super().__init__(message)
        self.returncode = returncode
        self.tail = tail


class CancelToken:
    def __init__(self) -> None:
        self._ev = threading.Event()
        self._procs: set[subprocess.Popen] = set()
        self._lock = threading.Lock()

    def cancel(self) -> None:
        self._ev.set()
        with self._lock:
            procs = list(self._procs)
        for p in procs:
            kill_tree(p)

    @property
    def cancelled(self) -> bool:
        return self._ev.is_set()

    def check(self) -> None:
        if self._ev.is_set():
            raise Cancelled()

    def _register(self, p: subprocess.Popen) -> None:
        with self._lock:
            self._procs.add(p)
        if self._ev.is_set():
            kill_tree(p)

    def _unregister(self, p: subprocess.Popen) -> None:
        with self._lock:
            self._procs.discard(p)


def kill_tree(p: subprocess.Popen, grace_s: float = 3.0) -> None:
    """Terminate a process and its children (process group on POSIX)."""
    if p.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        else:  # pragma: no cover
            p.terminate()
    except Exception:
        pass
    deadline = time.time() + grace_s
    while time.time() < deadline:
        if p.poll() is not None:
            return
        time.sleep(0.05)
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        else:  # pragma: no cover
            p.kill()
    except Exception:
        pass


def find_tool(names: Sequence[str] | str) -> str | None:
    """Find the first executable among ``names`` on PATH or in extra bin dirs."""
    if isinstance(names, str):
        names = [names]
    env_override = os.environ.get(f"SPLAT360_{names[0].upper().replace('-', '_')}")
    if env_override and Path(env_override).exists():
        return env_override
    for n in names:
        p = shutil.which(n)
        if p:
            return p
        for d in extra_bin_dirs():
            cand = d / n
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand)
    return None


def tool_version(cmd: Sequence[str], pattern: str = r"(\d+\.\d+(?:\.\d+)?)", timeout: float = 20) -> str | None:
    try:
        out = subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None
    text = (out.stdout or "") + (out.stderr or "")
    m = re.search(pattern, text)
    return m.group(1) if m else (text.strip().splitlines()[0][:60] if text.strip() else None)


@dataclass
class RunResult:
    returncode: int
    duration_s: float
    tail: list[str] = field(default_factory=list)


def run_streaming(
    cmd: Sequence[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    on_line: Callable[[str], None] | None = None,
    cancel: CancelToken | None = None,
    check: bool = True,
    tail_lines: int = 60,
    stdin_data: bytes | None = None,
    merge_stderr: bool = True,
) -> RunResult:
    """Run a command, streaming combined output line by line.

    Raises ``Cancelled`` if the token is cancelled and ``ToolError`` on a
    non-zero exit when ``check`` is true.
    """
    if cancel:
        cancel.check()
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    start = time.time()
    popen_kwargs: dict = {
        "cwd": str(cwd) if cwd else None,
        "env": full_env,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT if merge_stderr else subprocess.DEVNULL,
        "stdin": subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
        "bufsize": 0,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    p = subprocess.Popen(list(cmd), **popen_kwargs)
    if cancel:
        cancel._register(p)
    tail: list[str] = []
    try:
        if stdin_data is not None and p.stdin:
            try:
                p.stdin.write(stdin_data)
                p.stdin.close()
            except BrokenPipeError:
                pass
        assert p.stdout is not None
        buf = b""
        while True:
            chunk = p.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            # Split on \n and \r so progress bars that use carriage returns stream too.
            while True:
                m = re.search(rb"[\r\n]", buf)
                if not m:
                    break
                line, buf = buf[: m.start()], buf[m.end():]
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    tail.append(text)
                    if len(tail) > tail_lines:
                        del tail[0]
                    if on_line:
                        on_line(text)
        if buf.strip():
            text = buf.decode("utf-8", errors="replace").rstrip()
            tail.append(text)
            if on_line:
                on_line(text)
        rc = p.wait()
    finally:
        if cancel:
            cancel._unregister(p)
        if p.poll() is None:
            kill_tree(p)
    if cancel and cancel.cancelled:
        raise Cancelled()
    dur = time.time() - start
    if check and rc != 0:
        raise ToolError(
            f"{Path(cmd[0]).name} exited with code {rc}",
            returncode=rc,
            tail="\n".join(tail[-tail_lines:]),
        )
    return RunResult(returncode=rc, duration_s=dur, tail=tail)


def run_capture(cmd: Sequence[str], timeout: float = 120, cwd: Path | None = None) -> str:
    out = subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)
    if out.returncode != 0:
        raise ToolError(f"{Path(cmd[0]).name} failed: {(out.stderr or out.stdout).strip()[-800:]}", out.returncode)
    return out.stdout


def cpu_count() -> int:
    try:
        return max(1, len(os.sched_getaffinity(0)))  # type: ignore[attr-defined]
    except Exception:
        return max(1, os.cpu_count() or 1)


def chunked(seq: Sequence, n: int) -> Iterable[Sequence]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]
