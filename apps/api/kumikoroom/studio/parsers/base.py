from pathlib import Path
from typing import Protocol

from ..models import FlpAnalysisSnapshot


class FlpParseError(RuntimeError):
    def __init__(
        self,
        path: Path,
        stage: str,
        message: str,
        cause: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.path = path
        self.stage = stage
        self.message = message
        self.cause = cause
        if cause is not None:
            self.__cause__ = cause


class FlpParser(Protocol):
    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot: ...
