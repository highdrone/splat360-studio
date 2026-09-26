"""Thin wrapper around the COLMAP (and GLOMAP) command line tools.

Handles version differences between COLMAP 3.9 (rig_bundle_adjuster) and
COLMAP 3.11+ (native rigs via rig_configurator) by probing each command's
``--help`` output for option names.
"""
from __future__ import annotations

import re
import subprocess
from collections.abc import Callable, Sequence
from functools import lru_cache
from pathlib import Path

from ..util.proc import CancelToken, ToolError, find_tool, run_streaming


class Colmap:
    def __init__(self, exe: str | None = None):
        self.exe = exe or find_tool("colmap")
        if not self.exe:
            raise ToolError("COLMAP not found. Install with: brew install colmap")
        self._version: tuple[int, ...] | None = None

    # -- introspection ------------------------------------------------
    @property
    def version(self) -> tuple[int, ...]:
        if self._version is None:
            self._version = self._probe_version()
        return self._version

    @property
    def version_str(self) -> str:
        return ".".join(str(v) for v in self.version) if self.version else "unknown"

    def _probe_version(self) -> tuple[int, ...]:
        try:
            out = subprocess.run([self.exe, "help"], capture_output=True, text=True, timeout=30)
            text = out.stdout + out.stderr
        except Exception:
            return ()
        m = re.search(r"COLMAP\s+(\d+)\.(\d+)(?:\.(\d+))?", text)
        if not m:
            return ()
        return tuple(int(g) for g in m.groups() if g is not None)

    @lru_cache(maxsize=64)  # noqa: B019 - one Colmap instance per stage run
    def options(self, command: str) -> frozenset[str]:
        """Option names accepted by a COLMAP subcommand (from ``--help``)."""
        try:
            out = subprocess.run([self.exe, command, "-h"], capture_output=True, text=True, timeout=30)
            text = out.stdout + out.stderr
        except Exception:
            return frozenset()
        return frozenset(re.findall(r"--([A-Za-z0-9_.]+)", text))

    @lru_cache(maxsize=1)  # noqa: B019
    def commands(self) -> frozenset[str]:
        try:
            out = subprocess.run([self.exe, "help"], capture_output=True, text=True, timeout=30)
            text = out.stdout + out.stderr
        except Exception:
            return frozenset()
        cmds = re.search(r"Available commands:(.*)", text, re.DOTALL)
        if not cmds:
            return frozenset()
        return frozenset(ln.strip() for ln in cmds.group(1).splitlines() if ln.strip() and " " not in ln.strip())

    @property
    def has_native_rigs(self) -> bool:
        return "rig_configurator" in self.commands()

    @property
    def has_rig_bundle_adjuster(self) -> bool:
        return "rig_bundle_adjuster" in self.commands()

    def has_cuda(self) -> bool:
        try:
            out = subprocess.run([self.exe, "help"], capture_output=True, text=True, timeout=30)
            return "with CUDA" in (out.stdout + out.stderr)
        except Exception:
            return False

    def pick(self, command: str, candidates: Sequence[str]) -> str | None:
        """First option name among ``candidates`` supported by ``command``."""
        opts = self.options(command)
        for c in candidates:
            if c in opts:
                return c
        return None

    # -- execution ----------------------------------------------------
    def run(
        self,
        command: str,
        args: dict[str, object],
        *,
        cancel: CancelToken | None = None,
        on_line: Callable[[str], None] | None = None,
        cwd: Path | None = None,
    ) -> None:
        """Run ``colmap <command>`` with ``--key value`` args. Unknown options are dropped with a log note."""
        opts = self.options(command)
        cmd = [self.exe, command]
        for k, v in args.items():
            if v is None:
                continue
            if opts and k not in opts:
                if on_line:
                    on_line(f"[colmap] note: option --{k} not supported by this version; skipped")
                continue
            if isinstance(v, bool):
                v = int(v)
            cmd += [f"--{k}", str(v)]
        if on_line:
            on_line("$ " + " ".join(_q(c) for c in cmd))
        try:
            run_streaming(cmd, on_line=on_line, cancel=cancel, cwd=cwd)
        except ToolError as e:
            raise ToolError(f"COLMAP {command} failed: {e}\n{e.tail}", e.returncode, e.tail) from e


class Glomap:
    def __init__(self, exe: str | None = None):
        self.exe = exe or find_tool("glomap")
        if not self.exe:
            raise ToolError("GLOMAP not found. Install with: brew install glomap (or choose the COLMAP engine)")

    def mapper(self, database: Path, image_path: Path, output: Path, *, threads: int = -1,
               cancel: CancelToken | None = None, on_line: Callable[[str], None] | None = None) -> None:
        cmd = [self.exe, "mapper", "--database_path", str(database), "--image_path", str(image_path),
               "--output_path", str(output)]
        if threads and threads > 0:
            cmd += ["--BundleAdjustment.thread_count", str(threads)]
        if on_line:
            on_line("$ " + " ".join(_q(c) for c in cmd))
        try:
            run_streaming(cmd, on_line=on_line, cancel=cancel)
        except ToolError as e:
            raise ToolError(f"GLOMAP mapper failed: {e}\n{e.tail}", e.returncode, e.tail) from e


def _q(s: str) -> str:
    return f'"{s}"' if " " in s else s
