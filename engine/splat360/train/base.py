"""Trainer adapter interface."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable, Optional

from ..models import TrainReport, TrainSettings
from ..util.proc import CancelToken

ProgressCb = Callable[[float, str], None]


class Trainer(ABC):
    name: str = "base"
    label: str = "Base trainer"

    @abstractmethod
    def executable(self) -> Optional[str]:
        """Path to the trainer binary, or None if not installed."""

    def available(self) -> bool:
        return self.executable() is not None

    @abstractmethod
    def train(
        self,
        dataset_dir: Path,
        out_dir: Path,
        settings: TrainSettings,
        *,
        cancel: Optional[CancelToken] = None,
        on_progress: Optional[ProgressCb] = None,
        log: Optional[Callable[[str], None]] = None,
        metrics: Optional[Callable[[dict], None]] = None,
    ) -> TrainReport:
        """Train and return a report whose ``ply_path`` points at the final splat PLY."""
