# FL Studio Creative Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Creative Archive that scans FL Studio 21 projects, parses FLP structure read-only, and presents project dashboards, MIDI/arrangement/plugin analysis, dependency diagnostics, and backup diffs.

**Architecture:** Add a focused `kumikoroom.studio` backend domain with a replaceable FLP parser interface, SQLite repository, incremental scanner, deterministic analyzers, and one-worker scan service. Expose studio-specific FastAPI routes and consume them from focused web client modules and `/studio/projects/[id]` views. Keep PyFLP inside one adapter so the application model and UI remain independent of the third-party object model.

**Tech Stack:** Python 3.11+, FastAPI, SQLite, PyFLP, pytest, Next.js 14, React 18, TypeScript, Vitest, Testing Library, CSS Modules, inline SVG.

---

## Delivery milestones

1. **Foundation:** Tasks 1–7 produce a working scanner, parser, cache, API, and project library.
2. **Dashboard:** Tasks 8–9 produce the approved Rain Room dashboard and spectral musical fingerprint.
3. **Deep analysis:** Tasks 10–11 add arrangement, Pattern/MIDI, plugin, Mixer, and dependency views.
4. **History and handoff:** Tasks 12–14 add FL Studio backup diffs, report view, desktop open actions, and full verification.

## File map

### Backend files to create

- `apps/api/kumikoroom/studio/__init__.py` — public studio-domain exports.
- `apps/api/kumikoroom/studio/models.py` — stable domain dataclasses and enums.
- `apps/api/kumikoroom/studio/repository.py` — SQLite roots, projects, snapshots, jobs, and backup associations.
- `apps/api/kumikoroom/studio/scanner.py` — bounded file discovery and stable-file checks.
- `apps/api/kumikoroom/studio/parsers/base.py` — parser protocol and parser-specific exceptions.
- `apps/api/kumikoroom/studio/parsers/pyflp_adapter.py` — PyFLP-only translation layer.
- `apps/api/kumikoroom/studio/analyzer.py` — deterministic metrics, diagnostics, and musical fingerprint.
- `apps/api/kumikoroom/studio/diff.py` — semantic snapshot comparison.
- `apps/api/kumikoroom/studio/service.py` — incremental scan orchestration and one-worker queue.
- `apps/api/kumikoroom/routers/studio.py` — Studio API endpoints and response mapping.
- `apps/api/tests/test_studio_models.py`
- `apps/api/tests/test_studio_repository.py`
- `apps/api/tests/test_studio_scanner.py`
- `apps/api/tests/test_flp_parser.py`
- `apps/api/tests/test_studio_analyzer.py`
- `apps/api/tests/test_studio_service.py`
- `apps/api/tests/test_studio_api.py`
- `apps/api/tests/test_studio_diff.py`

### Backend files to modify

- `apps/api/pyproject.toml` — add the bounded PyFLP dependency.
- `apps/api/kumikoroom/config.py` — add the Studio database path.
- `apps/api/kumikoroom/main.py` — include the Studio router and app shutdown cleanup.
- `apps/api/tests/conftest.py` — isolate the Studio database in tests.

### Web files to create

- `apps/web/src/api/studioTypes.ts` — Studio request/response types.
- `apps/web/src/api/studioClient.ts` — Studio API calls and snake/camel mapping.
- `apps/web/src/components/studio/StudioLibrary.tsx`
- `apps/web/src/components/studio/ProjectCard.tsx`
- `apps/web/src/components/studio/ScanStatus.tsx`
- `apps/web/src/components/studio/ProjectWorkspace.tsx`
- `apps/web/src/components/studio/ProjectDashboard.tsx`
- `apps/web/src/components/studio/MusicalFingerprint.tsx`
- `apps/web/src/components/studio/ArrangementAnalysis.tsx`
- `apps/web/src/components/studio/PatternExplorer.tsx`
- `apps/web/src/components/studio/PluginMixerView.tsx`
- `apps/web/src/components/studio/DependencyReport.tsx`
- `apps/web/src/components/studio/VersionTimeline.tsx`
- `apps/web/src/components/studio/ProjectReport.tsx`
- `apps/web/src/components/studio/Studio.module.css`
- `apps/web/app/studio/projects/[id]/page.tsx`
- `apps/web/tests/studioClient.test.ts`
- `apps/web/tests/StudioLibrary.test.tsx`
- `apps/web/tests/ProjectDashboard.test.tsx`
- `apps/web/tests/StudioAnalysisViews.test.tsx`
- `apps/web/tests/VersionTimeline.test.tsx`

### Web files to modify

- `apps/web/src/components/StudioEntry.tsx` — render the live Studio library shell.
- `apps/web/tests/StudioEntry.test.tsx` — replace placeholder-only assertions.
- `apps/web/app/globals.css` — retain only the outer Studio page shell; feature styles live in the CSS Module.

---

### Task 1: Add stable Studio domain models and the parser dependency

**Files:**
- Create: `apps/api/kumikoroom/studio/__init__.py`
- Create: `apps/api/kumikoroom/studio/models.py`
- Create: `apps/api/tests/test_studio_models.py`
- Modify: `apps/api/pyproject.toml:6-17`

- [ ] **Step 1: Write the failing model serialization test**

```python
from kumikoroom.studio.models import (
    AnalysisDiagnostic,
    AnalysisStatus,
    FlpAnalysisSnapshot,
    ProjectInfo,
)


def test_snapshot_round_trips_through_json() -> None:
    snapshot = FlpAnalysisSnapshot(
        source_path=r"D:\Music\Blue Hour.flp",
        source_hash="abc123",
        status=AnalysisStatus.READY,
        project=ProjectInfo(title="Blue Hour", fl_version="21.2.3", tempo=128.0),
        diagnostics=[
            AnalysisDiagnostic(
                code="unused_pattern",
                severity="notice",
                message="Pattern 4 is not used in the arrangement.",
                target_type="pattern",
                target_id="4",
            )
        ],
    )

    restored = FlpAnalysisSnapshot.from_json(snapshot.to_json())

    assert restored == snapshot
    assert restored.status is AnalysisStatus.READY
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `python -m pytest apps/api/tests/test_studio_models.py -q`

Expected: FAIL with `ModuleNotFoundError: No module named 'kumikoroom.studio'`.

- [ ] **Step 3: Add the complete first-pass domain model**

Implement immutable dataclasses in `models.py` for:

```python
class AnalysisStatus(str, Enum):
    DISCOVERED = "discovered"
    QUEUED = "queued"
    PARSING = "parsing"
    READY = "ready"
    PARTIAL = "partial"
    FAILED = "failed"
    STALE = "stale"


@dataclass(frozen=True)
class ProjectInfo:
    title: str | None = None
    author: str | None = None
    fl_version: str | None = None
    tempo: float | None = None
    ppq: int | None = None
    time_signature_numerator: int | None = None
    time_signature_denominator: int | None = None
    created_at: str | None = None
    time_spent_seconds: int | None = None


@dataclass(frozen=True)
class NoteSummary:
    key: int
    position: int
    length: int
    velocity: int
    channel_id: str | None


@dataclass(frozen=True)
class PatternSummary:
    id: str
    name: str
    notes: list[NoteSummary] = field(default_factory=list)
    used_in_playlist: bool = False


@dataclass(frozen=True)
class ChannelSummary:
    id: str
    name: str
    plugin_name: str | None = None
    channel_type: str = "unknown"


@dataclass(frozen=True)
class PlaylistClipSummary:
    id: str
    track_index: int
    start: int
    length: int
    clip_type: str
    source_id: str | None = None


@dataclass(frozen=True)
class PluginInstance:
    id: str
    name: str
    kind: str
    location: str
    state_supported: bool


@dataclass(frozen=True)
class MixerInsertSummary:
    id: str
    name: str
    slot_plugin_ids: list[str] = field(default_factory=list)
    route_target_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AutomationSummary:
    id: str
    name: str
    target_name: str | None = None
    point_count: int = 0


@dataclass(frozen=True)
class ProjectAsset:
    path: str
    kind: Literal["render", "audio", "backup"]
    modified_at: str | None = None
    size: int | None = None


@dataclass(frozen=True)
class DependencyReference:
    path: str
    kind: str
    exists: bool


@dataclass(frozen=True)
class AnalysisDiagnostic:
    code: str
    severity: Literal["error", "warning", "notice"]
    message: str
    target_type: str | None = None
    target_id: str | None = None


@dataclass(frozen=True)
class MusicalFingerprint:
    note_min: int | None = None
    note_max: int | None = None
    note_density: float = 0.0
    velocity_mean: float | None = None
    pattern_reuse: float = 0.0
    inferred_key: str | None = None
    inferred_key_confidence: float = 0.0
    inferred_key_evidence: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class FlpAnalysisSnapshot:
    source_path: str
    source_hash: str
    status: AnalysisStatus
    project: ProjectInfo
    patterns: list[PatternSummary] = field(default_factory=list)
    channels: list[ChannelSummary] = field(default_factory=list)
    playlist_clips: list[PlaylistClipSummary] = field(default_factory=list)
    plugins: list[PluginInstance] = field(default_factory=list)
    mixer_inserts: list[MixerInsertSummary] = field(default_factory=list)
    automations: list[AutomationSummary] = field(default_factory=list)
    related_assets: list[ProjectAsset] = field(default_factory=list)
    dependencies: list[DependencyReference] = field(default_factory=list)
    fingerprint: MusicalFingerprint = field(default_factory=MusicalFingerprint)
    diagnostics: list[AnalysisDiagnostic] = field(default_factory=list)
    unknown_event_count: int = 0

    def to_json(self) -> str:
        return TypeAdapter(FlpAnalysisSnapshot).dump_json(self).decode("utf-8")

    @classmethod
    def from_json(cls, payload: str) -> "FlpAnalysisSnapshot":
        return TypeAdapter(cls).validate_json(payload)
```

Add recursive `to_json()` and `from_json()` methods that preserve enums and nested dataclasses. Export public model types from `studio/__init__.py`.

- [ ] **Step 4: Add PyFLP to the API dependency list and run the test**

Add `"pyflp>=2.2.1,<3.0"` to `[project].dependencies` in `apps/api/pyproject.toml`.

Run: `python -m pip install -e "apps/api[dev]"`

Expected: the editable API package and bounded PyFLP dependency install successfully.

Run: `python -m pytest apps/api/tests/test_studio_models.py -q`

Expected: PASS.

- [ ] **Step 5: Commit the domain foundation**

```powershell
git add apps/api/pyproject.toml apps/api/kumikoroom/studio apps/api/tests/test_studio_models.py
git commit -m "feat: add studio analysis domain models"
```

---

### Task 2: Add Studio configuration and SQLite repository

**Files:**
- Create: `apps/api/kumikoroom/studio/repository.py`
- Create: `apps/api/tests/test_studio_repository.py`
- Modify: `apps/api/kumikoroom/config.py:10-61`
- Modify: `apps/api/tests/conftest.py:9-38`
- Modify: `apps/api/tests/test_config.py:95-104`

- [ ] **Step 1: Write failing configuration and repository tests**

```python
def test_studio_db_path_can_be_overridden(monkeypatch, tmp_path: Path) -> None:
    expected = tmp_path / "studio.sqlite3"
    monkeypatch.setenv("KUMIKOROOM_STUDIO_DB_PATH", str(expected))
    assert load_settings().studio_db_path == expected


def test_repository_stores_root_project_and_snapshot(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    root = repository.add_root(tmp_path / "projects")
    project = repository.upsert_project(
        canonical_path=tmp_path / "projects" / "Blue Hour.flp",
        display_name="Blue Hour",
    )
    repository.save_snapshot(project.id, make_snapshot("hash-1"))

    assert repository.list_roots() == [root]
    assert repository.get_latest_snapshot(project.id).source_hash == "hash-1"
```

- [ ] **Step 2: Run tests and confirm missing settings/repository failures**

Run: `python -m pytest apps/api/tests/test_config.py apps/api/tests/test_studio_repository.py -q`

Expected: FAIL because `studio_db_path` and `StudioRepository` do not exist.

- [ ] **Step 3: Add the Studio database setting**

Add:

```python
DEFAULT_STUDIO_DB_PATH = Path("user-data/studio/kumikoroom-studio.sqlite3")

@dataclass(frozen=True)
class ApiSettings:
    # existing fields remain unchanged
    studio_db_path: Path = DEFAULT_STUDIO_DB_PATH
```

Populate it in `load_settings()` from `KUMIKOROOM_STUDIO_DB_PATH`. Add the variable to the autouse cleanup fixture and point it at `tmp_path / "studio.sqlite3"`.

- [ ] **Step 4: Implement repository schema and methods**

Create tables with explicit foreign keys:

```sql
CREATE TABLE IF NOT EXISTS studio_roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_projects (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  modified_at TEXT,
  latest_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(project_id, source_hash),
  FOREIGN KEY(project_id) REFERENCES studio_projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS studio_scan_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  parsed_count INTEGER NOT NULL DEFAULT 0,
  cached_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Implement `add_root`, `remove_root`, `list_roots`, `upsert_project`, `list_projects`, `get_project`, `save_snapshot`, `get_latest_snapshot`, `find_snapshot_by_hash`, `create_scan_job`, and `update_scan_job` with transaction boundaries and typed return dataclasses.

- [ ] **Step 5: Run focused tests and commit**

Run: `python -m pytest apps/api/tests/test_config.py apps/api/tests/test_studio_repository.py -q`

Expected: PASS.

```powershell
git add apps/api/kumikoroom/config.py apps/api/kumikoroom/studio/repository.py apps/api/tests/conftest.py apps/api/tests/test_config.py apps/api/tests/test_studio_repository.py
git commit -m "feat: persist studio projects and analysis snapshots"
```

---

### Task 3: Discover FLP projects without escaping configured roots

**Files:**
- Create: `apps/api/kumikoroom/studio/scanner.py`
- Create: `apps/api/tests/test_studio_scanner.py`

- [ ] **Step 1: Write failing discovery boundary tests**

```python
def test_scanner_discovers_flp_files_and_skips_external_links(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    (root / "Blue Hour.flp").write_bytes(b"FLhd")
    (root / "notes.txt").write_text("ignore", encoding="utf-8")

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "Private.flp").write_bytes(b"FLhd")
    make_directory_link(root / "linked", outside)

    found = discover_flp_files([root])

    assert [item.path.name for item in found] == ["Blue Hour.flp"]


def test_stable_file_requires_two_identical_observations(tmp_path: Path) -> None:
    path = tmp_path / "Song.flp"
    path.write_bytes(b"one")
    first = observe_file(path)
    path.write_bytes(b"two-two")
    second = observe_file(path)
    assert is_stable(first, second) is False
    assert is_stable(second, observe_file(path)) is True
```

- [ ] **Step 2: Run tests and confirm missing scanner functions**

Run: `python -m pytest apps/api/tests/test_studio_scanner.py -q`

Expected: FAIL with missing imports from `kumikoroom.studio.scanner`.

- [ ] **Step 3: Implement bounded discovery**

```python
@dataclass(frozen=True)
class DiscoveredFlp:
    path: Path
    root: Path
    modified_ns: int
    size: int


def discover_flp_files(roots: Iterable[Path]) -> list[DiscoveredFlp]:
    discovered: list[DiscoveredFlp] = []
    for root in roots:
        resolved_root = root.resolve(strict=True)
        for current, directories, files in os.walk(resolved_root, followlinks=False):
            directories[:] = [
                name for name in directories
                if not (Path(current) / name).is_symlink()
            ]
            for name in files:
                if Path(name).suffix.lower() != ".flp":
                    continue
                path = (Path(current) / name).resolve(strict=True)
                if not path.is_relative_to(resolved_root):
                    continue
                stat = path.stat()
                discovered.append(DiscoveredFlp(path, resolved_root, stat.st_mtime_ns, stat.st_size))
    return sorted(discovered, key=lambda item: str(item.path).casefold())
```

Implement `FileObservation`, `observe_file`, `is_stable`, and `sha256_file` using 1 MiB chunks. Add `discover_project_assets(main_flp)` that reads sibling `Renders`, `Audio`, `Backup`, and `Backups` directories without recursing outside the resolved project directory, returning `ProjectAsset` metadata for supported audio/render/FLP extensions.

- [ ] **Step 4: Add default FL Studio Backup location detection**

Implement `default_fl_studio_backup_root()` using the Windows `Personal` known-folder registry value when available, falling back to `Path.home() / "Documents"`. Return the Backup path only when it exists. Add tests that monkeypatch the known-folder helper.

- [ ] **Step 5: Run tests and commit**

Run: `python -m pytest apps/api/tests/test_studio_scanner.py -q`

Expected: PASS, with link-specific tests skipped only when the test process lacks Windows link privileges.

```powershell
git add apps/api/kumikoroom/studio/scanner.py apps/api/tests/test_studio_scanner.py
git commit -m "feat: discover bounded FL Studio projects"
```

---

### Task 4: Translate PyFLP projects into the internal model

**Files:**
- Create: `apps/api/kumikoroom/studio/parsers/__init__.py`
- Create: `apps/api/kumikoroom/studio/parsers/base.py`
- Create: `apps/api/kumikoroom/studio/parsers/pyflp_adapter.py`
- Create: `apps/api/tests/test_flp_parser.py`

- [ ] **Step 1: Write failing adapter tests with a fake PyFLP object graph**

```python
def test_adapter_maps_project_patterns_notes_channels_and_playlist(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "Blue Hour.flp"
    source.write_bytes(b"fake-flp")
    monkeypatch.setattr(pyflp, "parse", lambda _: fake_project())

    snapshot = PyFlpParser().parse(source, source_hash="hash-1")

    assert snapshot.project.title == "Blue Hour"
    assert snapshot.project.fl_version == "21.2.3"
    assert snapshot.project.tempo == 128.0
    assert snapshot.patterns[0].notes[0].velocity == 96
    assert snapshot.channels[0].plugin_name == "FLEX"
    assert snapshot.playlist_clips[0].source_id == snapshot.patterns[0].id
```

The fake project must expose only the public attributes used by the adapter so tests fail when the adapter reaches into undocumented private state.

- [ ] **Step 2: Run the parser test and confirm missing parser classes**

Run: `python -m pytest apps/api/tests/test_flp_parser.py -q`

Expected: FAIL because `PyFlpParser` is undefined.

- [ ] **Step 3: Define the parser protocol and errors**

```python
class FlpParseError(RuntimeError):
    def __init__(self, path: Path, stage: str, message: str) -> None:
        super().__init__(message)
        self.path = path
        self.stage = stage


class FlpParser(Protocol):
    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot: ...
```

- [ ] **Step 4: Implement the PyFLP adapter in bounded mapping functions**

Keep `pyflp` imports inside `pyflp_adapter.py`. Split translation into `_project_info`, `_patterns`, `_channels`, `_playlist_clips`, `_plugins`, `_mixer`, `_automations`, and `_dependencies`. Catch a failed whole-file parse as `FlpParseError(stage="open")`; catch unsupported child structures and append `AnalysisDiagnostic(code="unsupported_structure", severity="warning", ...)`, returning `AnalysisStatus.PARTIAL`.

Use public iteration APIs documented by PyFLP. Do not call `pyflp.save` anywhere in production or tests.

- [ ] **Step 5: Run tests and commit**

Run: `python -m pytest apps/api/tests/test_flp_parser.py -q`

Expected: PASS.

```powershell
git add apps/api/kumikoroom/studio/parsers apps/api/tests/test_flp_parser.py
git commit -m "feat: parse FLP projects through an isolated adapter"
```

---

### Task 5: Compute musical fingerprint and objective diagnostics

**Files:**
- Create: `apps/api/kumikoroom/studio/analyzer.py`
- Create: `apps/api/tests/test_studio_analyzer.py`

- [ ] **Step 1: Write failing deterministic analysis tests**

```python
def test_analyzer_builds_fingerprint_and_unused_pattern_diagnostic() -> None:
    snapshot = snapshot_with_notes(
        keys=[62, 65, 69, 62, 65, 69, 60, 62, 65, 69, 62, 65, 69, 60],
        velocities=[80, 90, 100, 85, 95, 105, 70, 80, 90, 100, 85, 95, 105, 70],
        used_pattern_ids={"1"},
        extra_empty_pattern_id="2",
    )

    analyzed = analyze_snapshot(snapshot)

    assert analyzed.fingerprint.note_min == 60
    assert analyzed.fingerprint.note_max == 69
    assert analyzed.fingerprint.velocity_mean == pytest.approx(89.2857, rel=1e-4)
    assert analyzed.fingerprint.inferred_key == "D minor"
    assert 0.0 <= analyzed.fingerprint.inferred_key_confidence <= 1.0
    assert any(item.code == "unused_pattern" and item.target_id == "2" for item in analyzed.diagnostics)
```

- [ ] **Step 2: Run the test and confirm the missing analyzer failure**

Run: `python -m pytest apps/api/tests/test_studio_analyzer.py -q`

Expected: FAIL because `analyze_snapshot` is undefined.

- [ ] **Step 3: Implement objective metrics**

Implement pure functions for note range, mean velocity, note density per PPQ beat, Pattern reuse ratio, unused/empty Pattern diagnostics, unused Channel diagnostics, missing dependency diagnostics, arrangement end position, and long-empty-region diagnostics.

- [ ] **Step 4: Implement bounded key inference with evidence**

Use pitch-class histograms and fixed major/minor Krumhansl-style profiles normalized into `0..1`. Store the winning key, confidence, and a diagnostic evidence string. Return no inferred key when fewer than 12 pitched notes exist or confidence is below `0.55`.

- [ ] **Step 5: Run tests and commit**

Run: `python -m pytest apps/api/tests/test_studio_analyzer.py -q`

Expected: PASS.

```powershell
git add apps/api/kumikoroom/studio/analyzer.py apps/api/tests/test_studio_analyzer.py
git commit -m "feat: analyze FLP musical structure and diagnostics"
```

---

### Task 6: Orchestrate incremental scans with one background worker

**Files:**
- Create: `apps/api/kumikoroom/studio/service.py`
- Create: `apps/api/tests/test_studio_service.py`

- [ ] **Step 1: Write failing cache and failure-isolation tests**

```python
def test_scan_reuses_cached_hash_and_isolates_parse_failure(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    parser = RecordingParser(failing_names={"Broken.flp"})
    service = StudioService(repository, parser, executor=InlineExecutor())
    root = make_flp_root(tmp_path, ["Good.flp", "Broken.flp"])
    repository.add_root(root)

    first = service.run_scan_now()
    second = service.run_scan_now()

    assert first.parsed_count == 1
    assert first.failed_count == 1
    assert second.cached_count == 1
    assert repository.list_projects()[0].display_name in {"Good", "Broken"}
```

- [ ] **Step 2: Run the test and confirm the missing service failure**

Run: `python -m pytest apps/api/tests/test_studio_service.py -q`

Expected: FAIL because `StudioService` is undefined.

- [ ] **Step 3: Implement synchronous scan orchestration**

`run_scan_now()` must discover roots, create/update project rows, observe file stability, hash changed files, reuse matching snapshots, parse changed files, analyze successful snapshots, save results, and update job counters after each file. A failed file creates a failed project status and leaves the latest successful snapshot unchanged.

- [ ] **Step 4: Add the one-worker async wrapper and shutdown**

```python
class StudioService:
    def __init__(self, repository, parser, executor=None) -> None:
        self._executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix="studio-scan")

    def start_scan(self) -> StudioScanJob:
        job = self._repository.create_scan_job()
        self._executor.submit(self._run_job, job.id)
        return job

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
```

Prevent concurrent duplicate jobs by returning the current queued/running job.

- [ ] **Step 5: Run tests and commit**

Run: `python -m pytest apps/api/tests/test_studio_service.py -q`

Expected: PASS.

```powershell
git add apps/api/kumikoroom/studio/service.py apps/api/tests/test_studio_service.py
git commit -m "feat: orchestrate incremental studio scans"
```

---

### Task 7: Expose Studio roots, scans, projects, and snapshots through FastAPI

**Files:**
- Create: `apps/api/kumikoroom/routers/studio.py`
- Create: `apps/api/tests/test_studio_api.py`
- Modify: `apps/api/kumikoroom/main.py:1-21`

- [ ] **Step 1: Write failing API lifecycle tests**

```python
def test_studio_api_adds_root_scans_and_returns_project(client, tmp_path, monkeypatch) -> None:
    root = make_flp_root(tmp_path, ["Blue Hour.flp"])
    install_fake_studio_service(monkeypatch, root)

    root_response = client.post("/api/studio/roots", json={"path": str(root)})
    scan_response = client.post("/api/studio/scans")
    projects_response = client.get("/api/studio/projects")

    assert root_response.status_code == 201
    assert scan_response.status_code == 202
    assert projects_response.status_code == 200
    assert projects_response.json()[0]["display_name"] == "Blue Hour"
```

Also cover invalid paths, duplicate roots, missing projects, partial snapshots, and deletion of a root without deleting files.

- [ ] **Step 2: Run tests and confirm 404 responses**

Run: `python -m pytest apps/api/tests/test_studio_api.py -q`

Expected: FAIL because `/api/studio/*` routes are absent.

- [ ] **Step 3: Implement Pydantic request/response schemas and routes**

Provide:

```text
GET    /api/studio/roots
POST   /api/studio/roots
DELETE /api/studio/roots/{root_id}
POST   /api/studio/scans
GET    /api/studio/scans/{scan_id}
GET    /api/studio/projects
GET    /api/studio/projects/{project_id}
GET    /api/studio/projects/{project_id}/analysis
```

Normalize resolved paths in the API. Reject missing/non-directory roots with `400`, missing entities with `404`, and duplicate roots with the existing row and `200`.

- [ ] **Step 4: Register router and service cleanup**

Import `studio` next to `room`, include the router, and add an app lifespan context that closes the cached `StudioService` during shutdown. Keep the service dependency replaceable in tests through `studio_service()`.

- [ ] **Step 5: Run API and full backend tests, then commit**

Run: `python -m pytest apps/api/tests/test_studio_api.py apps/api/tests/test_room_api.py -q`

Expected: PASS.

Run: `python -m pytest apps/api/tests -q`

Expected: all API tests PASS.

```powershell
git add apps/api/kumikoroom/main.py apps/api/kumikoroom/routers/studio.py apps/api/tests/test_studio_api.py
git commit -m "feat: expose creative archive API"
```

---

### Task 8: Add the web Studio client and live project library

**Files:**
- Create: `apps/web/src/api/studioTypes.ts`
- Create: `apps/web/src/api/studioClient.ts`
- Create: `apps/web/src/components/studio/StudioLibrary.tsx`
- Create: `apps/web/src/components/studio/ProjectCard.tsx`
- Create: `apps/web/src/components/studio/ScanStatus.tsx`
- Create: `apps/web/src/components/studio/Studio.module.css`
- Create: `apps/web/tests/studioClient.test.ts`
- Create: `apps/web/tests/StudioLibrary.test.tsx`
- Modify: `apps/web/src/components/StudioEntry.tsx:1-56`
- Modify: `apps/web/tests/StudioEntry.test.tsx:1-37`

- [ ] **Step 1: Write failing client mapping tests**

```typescript
it("maps studio project summaries to camel case", async () => {
  mockFetchJson([{ id: "p1", display_name: "Blue Hour", status: "ready", modified_at: "2026-07-13T10:00:00Z", tempo: 128, pattern_count: 42, warning_count: 2 }]);

  await expect(getStudioProjects()).resolves.toEqual([
    { id: "p1", displayName: "Blue Hour", status: "ready", modifiedAt: "2026-07-13T10:00:00Z", tempo: 128, patternCount: 42, warningCount: 2 }
  ]);
});
```

- [ ] **Step 2: Write failing library states test**

```tsx
it("shows discovered projects and starts a rescan", async () => {
  render(<StudioLibrary initialProjects={[projectSummary]} roots={[rootSummary]} />);
  expect(screen.getByRole("link", { name: /Blue Hour/ })).toHaveAttribute("href", "/studio/projects/p1");
  await userEvent.click(screen.getByRole("button", { name: "重新扫描" }));
  expect(startStudioScan).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Implement Studio types and client**

Define `StudioRoot`, `StudioProjectSummary`, `StudioScanJob`, `StudioAnalysis`, and the nested analysis types. Implement `getStudioRoots`, `addStudioRoot`, `removeStudioRoot`, `startStudioScan`, `getStudioScan`, `getStudioProjects`, and `getStudioAnalysis` using the exported `request` helper.

- [ ] **Step 4: Replace the placeholder with the live library**

Make `StudioEntry` a client component that loads roots/projects, renders accessible loading/empty/error states, adds a folder path form, filters by text/status/BPM/inferred key/plugin, sorts by recent edit or name, starts a scan, polls only while a job is queued/running, and renders project cards. Preserve links back to `/room` and `/`.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test --workspace apps/web -- tests/studioClient.test.ts tests/StudioLibrary.test.tsx tests/StudioEntry.test.tsx`

Expected: PASS.

```powershell
git add apps/web/src/api/studioTypes.ts apps/web/src/api/studioClient.ts apps/web/src/components/StudioEntry.tsx apps/web/src/components/studio apps/web/tests/studioClient.test.ts apps/web/tests/StudioLibrary.test.tsx apps/web/tests/StudioEntry.test.tsx
git commit -m "feat: browse parsed FL Studio projects"
```

---

### Task 9: Build the project dashboard and spectral musical fingerprint

**Files:**
- Create: `apps/web/app/studio/projects/[id]/page.tsx`
- Create: `apps/web/src/components/studio/ProjectWorkspace.tsx`
- Create: `apps/web/src/components/studio/ProjectDashboard.tsx`
- Create: `apps/web/src/components/studio/MusicalFingerprint.tsx`
- Create: `apps/web/tests/ProjectDashboard.test.tsx`
- Modify: `apps/web/src/components/studio/Studio.module.css`

- [ ] **Step 1: Write failing dashboard semantics tests**

```tsx
it("renders project metrics, diagnostics, and fingerprint evidence", () => {
  render(<ProjectDashboard analysis={analysisFixture} />);

  expect(screen.getByRole("heading", { name: "Blue Hour" })).toBeTruthy();
  expect(screen.getByText("128 BPM")).toBeTruthy();
  expect(screen.getByText("42 Patterns")).toBeTruthy();
  expect(screen.getByLabelText("音乐指纹")).toBeTruthy();
  expect(screen.getByText("D minor · 82% 可信度")).toBeTruthy();
  expect(screen.getByText("2 条依赖提醒")).toBeTruthy();
});
```

- [ ] **Step 2: Run the test and confirm missing components**

Run: `npm run test --workspace apps/web -- tests/ProjectDashboard.test.tsx`

Expected: FAIL because dashboard components do not exist.

- [ ] **Step 3: Implement the route and workspace tabs**

`page.tsx` passes the route id to `ProjectWorkspace`. The workspace fetches the analysis and exposes tabs for `总览`, `编曲`, `Pattern`, `插件与 Mixer`, `依赖`, and `版本`. Unknown ids show an in-product 404 state with a link to `/studio`.

- [ ] **Step 4: Implement approved dashboard visuals**

Use the Rain Room surface for page structure and an inline SVG fingerprint for note range, density, velocity, reuse, and inferred key. Give every visual a text summary and `<title>`/ARIA label. Keep iridescent styling inside the fingerprint panel; metrics and diagnostics use high-contrast paper surfaces.

- [ ] **Step 5: Run tests, build, and commit**

Run: `npm run test --workspace apps/web -- tests/ProjectDashboard.test.tsx`

Expected: PASS.

Run: `npm run build --workspace apps/web`

Expected: optimized Next.js build succeeds and includes `/studio/projects/[id]`.

```powershell
git add apps/web/app/studio/projects apps/web/src/components/studio/ProjectWorkspace.tsx apps/web/src/components/studio/ProjectDashboard.tsx apps/web/src/components/studio/MusicalFingerprint.tsx apps/web/src/components/studio/Studio.module.css apps/web/tests/ProjectDashboard.test.tsx
git commit -m "feat: add FLP project dashboard"
```

---

### Task 10: Add arrangement and Pattern/MIDI explorers

**Files:**
- Create: `apps/web/src/components/studio/ArrangementAnalysis.tsx`
- Create: `apps/web/src/components/studio/PatternExplorer.tsx`
- Create: `apps/web/tests/StudioAnalysisViews.test.tsx`
- Modify: `apps/web/src/components/studio/ProjectWorkspace.tsx`
- Modify: `apps/web/src/components/studio/Studio.module.css`

- [ ] **Step 1: Write failing interaction tests**

```tsx
it("links arrangement clips to the selected Pattern", async () => {
  render(<StudioAnalysisHarness analysis={analysisFixture} />);
  await userEvent.click(screen.getByRole("button", { name: "Pattern 12 clip at bar 17" }));
  expect(screen.getByRole("heading", { name: "Pattern 12" })).toBeTruthy();
  expect(screen.getByLabelText("Pattern 12 Piano Roll")).toBeTruthy();
});
```

- [ ] **Step 2: Run the test and confirm missing analysis views**

Run: `npm run test --workspace apps/web -- tests/StudioAnalysisViews.test.tsx`

Expected: FAIL because arrangement and Pattern components are missing.

- [ ] **Step 3: Implement the scalable arrangement timeline**

Render Playlist tracks as SVG/HTML lanes using normalized PPQ coordinates. Provide zoom controls for `整曲`, `2×`, and `4×`; horizontal keyboard scrolling; clip labels; density overlay; long-gap markers; and Pattern selection callbacks. Do not render one DOM node per empty grid cell.

- [ ] **Step 4: Implement Pattern and Piano Roll exploration**

Render a searchable Pattern list, usage badges, metrics, pitch grid, velocity strip, Channel legend, similarity links, and inference confidence. Virtualize the Pattern list once it exceeds 100 rows. Preserve a textual note-count/range summary for accessibility.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test --workspace apps/web -- tests/StudioAnalysisViews.test.tsx`

Expected: PASS.

```powershell
git add apps/web/src/components/studio/ArrangementAnalysis.tsx apps/web/src/components/studio/PatternExplorer.tsx apps/web/src/components/studio/ProjectWorkspace.tsx apps/web/src/components/studio/Studio.module.css apps/web/tests/StudioAnalysisViews.test.tsx
git commit -m "feat: visualize FLP arrangement and MIDI patterns"
```

---

### Task 11: Add plugin, Mixer, automation, and dependency analysis

**Files:**
- Create: `apps/web/src/components/studio/PluginMixerView.tsx`
- Create: `apps/web/src/components/studio/DependencyReport.tsx`
- Modify: `apps/web/src/components/studio/ProjectWorkspace.tsx`
- Modify: `apps/web/tests/StudioAnalysisViews.test.tsx`
- Modify: `apps/web/src/components/studio/Studio.module.css`

- [ ] **Step 1: Add failing plugin-route and dependency tests**

```tsx
it("shows Mixer routes and links missing dependencies to their source", () => {
  render(<StudioAnalysisHarness analysis={analysisFixture} initialTab="plugins" />);
  expect(screen.getByLabelText("Mixer 路由图")).toBeTruthy();
  expect(screen.getByText("FLEX → Insert 4")).toBeTruthy();
  expect(screen.getByText("vocal_take_03.wav")).toBeTruthy();
  expect(screen.getByRole("button", { name: "查看 vocal_take_03.wav 所在位置" })).toBeTruthy();
});
```

- [ ] **Step 2: Run the test and confirm missing views**

Run: `npm run test --workspace apps/web -- tests/StudioAnalysisViews.test.tsx`

Expected: FAIL with missing plugin/Mixer and dependency content.

- [ ] **Step 3: Implement plugin and Mixer views**

Render Channel Rack and plugin tables with source filters, unsupported-state badges, location links, effect chains, and a bounded SVG route graph. Collapse inserts with no plugins/routes. Show automation targets in a separate subsection and label unresolved targets.

- [ ] **Step 4: Implement dependency and diagnostic views**

Group dependencies into `缺失`, `可用`, and `未知`. Group diagnostics by severity and target. Clicking a target switches to the relevant workspace tab and selects the referenced Pattern, Channel, plugin, or Mixer Insert. File-location buttons call a local API action introduced in Task 13; keep them disabled with explanatory text until that endpoint exists.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test --workspace apps/web -- tests/StudioAnalysisViews.test.tsx`

Expected: PASS.

```powershell
git add apps/web/src/components/studio/PluginMixerView.tsx apps/web/src/components/studio/DependencyReport.tsx apps/web/src/components/studio/ProjectWorkspace.tsx apps/web/src/components/studio/Studio.module.css apps/web/tests/StudioAnalysisViews.test.tsx
git commit -m "feat: inspect FLP plugins mixer and dependencies"
```

---

### Task 12: Associate FL Studio backups and compare semantic snapshots

**Files:**
- Create: `apps/api/kumikoroom/studio/diff.py`
- Create: `apps/api/tests/test_studio_diff.py`
- Create: `apps/web/src/components/studio/VersionTimeline.tsx`
- Create: `apps/web/tests/VersionTimeline.test.tsx`
- Modify: `apps/api/kumikoroom/studio/repository.py`
- Modify: `apps/api/kumikoroom/studio/scanner.py`
- Modify: `apps/api/kumikoroom/studio/service.py`
- Modify: `apps/api/kumikoroom/routers/studio.py`
- Modify: `apps/web/src/api/studioClient.ts`
- Modify: `apps/web/src/api/studioTypes.ts`
- Modify: `apps/web/src/components/studio/ProjectWorkspace.tsx`

- [ ] **Step 1: Write failing association and diff tests**

```python
def test_backup_association_requires_high_confidence() -> None:
    main = project_candidate("Blue Hour.flp", title="Blue Hour", pattern_ids={"1", "2", "3"})
    strong = project_candidate("Blue Hour - backup.flp", title="Blue Hour", pattern_ids={"1", "2", "3"})
    weak = project_candidate("Untitled.flp", title=None, pattern_ids={"9"})

    assert score_backup_association(main, strong) >= 0.8
    assert score_backup_association(main, weak) < 0.8


def test_snapshot_diff_reports_added_pattern_and_plugin() -> None:
    result = diff_snapshots(snapshot_v1(), snapshot_v2())
    assert result.patterns.added == ["Pattern 8"]
    assert result.plugins.added == ["Serum"]
```

- [ ] **Step 2: Run backend tests and confirm missing diff functions**

Run: `python -m pytest apps/api/tests/test_studio_diff.py -q`

Expected: FAIL because association and diff functions are missing.

- [ ] **Step 3: Implement backup association and semantic diff**

Score normalized stem similarity, internal title equality, modified-time proximity, and Pattern/Channel/plugin structural overlap. Auto-associate only at `>=0.8`; persist lower scores as unconfirmed candidates. Implement deterministic added/removed/changed sets for project metrics, Patterns, notes, Channels, plugins, Playlist clips, Mixer inserts, and dependencies.

- [ ] **Step 4: Expose versions/diff endpoints and build the timeline**

Add:

```text
GET  /api/studio/projects/{project_id}/versions
POST /api/studio/projects/{project_id}/versions/confirm
GET  /api/studio/projects/{project_id}/diff?from={snapshot_id}&to={snapshot_id}
```

`VersionTimeline` displays main/current analysis, confirmed backups, unconfirmed candidates, two-version selection, and a structured diff. It never offers automatic overwrite or restore.

- [ ] **Step 5: Run backend/web tests and commit**

Run: `python -m pytest apps/api/tests/test_studio_diff.py apps/api/tests/test_studio_api.py -q`

Expected: PASS.

Run: `npm run test --workspace apps/web -- tests/VersionTimeline.test.tsx tests/studioClient.test.ts`

Expected: PASS.

```powershell
git add apps/api/kumikoroom/studio apps/api/kumikoroom/routers/studio.py apps/api/tests/test_studio_diff.py apps/web/src/api/studioClient.ts apps/web/src/api/studioTypes.ts apps/web/src/components/studio/VersionTimeline.tsx apps/web/src/components/studio/ProjectWorkspace.tsx apps/web/tests/VersionTimeline.test.tsx apps/web/tests/studioClient.test.ts
git commit -m "feat: compare FL Studio backup snapshots"
```

---

### Task 13: Add safe local open actions and the editorial report view

**Files:**
- Create: `apps/web/src/components/studio/ProjectReport.tsx`
- Modify: `apps/api/kumikoroom/routers/studio.py`
- Modify: `apps/api/tests/test_studio_api.py`
- Modify: `apps/web/src/api/studioClient.ts`
- Modify: `apps/web/src/components/studio/DependencyReport.tsx`
- Modify: `apps/web/src/components/studio/ProjectWorkspace.tsx`
- Modify: `apps/web/src/components/studio/Studio.module.css`
- Modify: `apps/web/tests/StudioAnalysisViews.test.tsx`

- [ ] **Step 1: Write failing safe-open API tests**

```python
def test_open_action_rejects_path_outside_project(client, monkeypatch, tmp_path) -> None:
    project = install_project_fixture(monkeypatch, tmp_path)
    response = client.post(
        f"/api/studio/projects/{project.id}/open",
        json={"target": r"C:\Windows\System32\cmd.exe"},
    )
    assert response.status_code == 400


def test_open_action_uses_registered_project_path(client, monkeypatch, tmp_path) -> None:
    project, open_spy = install_project_fixture_with_open_spy(monkeypatch, tmp_path)
    response = client.post(f"/api/studio/projects/{project.id}/open", json={"kind": "project"})
    assert response.status_code == 204
    open_spy.assert_called_once_with(project.canonical_path)
```

- [ ] **Step 2: Run tests and confirm missing endpoint**

Run: `python -m pytest apps/api/tests/test_studio_api.py -q`

Expected: FAIL because the open endpoint does not exist.

- [ ] **Step 3: Implement allowlisted local actions**

Add `POST /api/studio/projects/{project_id}/open` accepting `kind: project | folder | dependency | backup` plus an existing entity id. Resolve targets from repository records only; never accept arbitrary absolute target paths. Use `os.startfile` on Windows behind an injectable `LocalOpener`. Return `409` when the target no longer exists.

- [ ] **Step 4: Implement the editorial report tab**

Create a print-friendly Project Dossier view containing project metadata, fingerprint summary, arrangement miniature, plugin/dependency counts, diagnostics, and parser coverage. Add `@media print` rules that hide navigation and actions. Add a `打印报告` button calling `window.print()`.

- [ ] **Step 5: Run tests and commit**

Run: `python -m pytest apps/api/tests/test_studio_api.py -q`

Expected: PASS.

Run: `npm run test --workspace apps/web -- tests/StudioAnalysisViews.test.tsx`

Expected: PASS.

```powershell
git add apps/api/kumikoroom/routers/studio.py apps/api/tests/test_studio_api.py apps/web/src/api/studioClient.ts apps/web/src/components/studio/DependencyReport.tsx apps/web/src/components/studio/ProjectReport.tsx apps/web/src/components/studio/ProjectWorkspace.tsx apps/web/src/components/studio/Studio.module.css apps/web/tests/StudioAnalysisViews.test.tsx
git commit -m "feat: open local FLP assets and print project reports"
```

---

### Task 14: Verify real FL Studio 21 projects and finish documentation

**Files:**
- Create: `apps/api/tests/test_studio_local_flp.py`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/superpowers/specs/2026-07-13-fl-studio-creative-archive-design.md`

- [x] **Step 1: Add an opt-in local real-FLP contract test**

```python
@pytest.mark.skipif(
    not os.environ.get("KUMIKOROOM_TEST_FLP_PATH"),
    reason="KUMIKOROOM_TEST_FLP_PATH is not configured",
)
def test_real_flp_is_read_only_and_has_core_structure() -> None:
    path = Path(os.environ["KUMIKOROOM_TEST_FLP_PATH"])
    before = sha256_file(path)
    snapshot = PyFlpParser().parse(path, source_hash=before)
    after = sha256_file(path)

    assert after == before
    assert snapshot.project.fl_version is not None
    assert snapshot.project.tempo is not None
    assert snapshot.patterns
    assert snapshot.channels
```

- [x] **Step 2: Run the local contract against 3–5 user-selected projects**

For each selected FLP, set `KUMIKOROOM_TEST_FLP_PATH` and run:

```powershell
$env:KUMIKOROOM_TEST_FLP_PATH="D:\path\to\project.flp"
python -m pytest apps/api/tests/test_studio_local_flp.py -q
```

Expected: PASS with identical before/after hashes. Record unsupported structures as adapter fixtures or diagnostics before moving to the next project.

- [x] **Step 3: Document local configuration and privacy boundaries**

Add `KUMIKOROOM_STUDIO_DB_PATH` to `.env.example`. Document how to add scan roots in the UI, where analysis data lives, that source FLPs are read-only, how automatic backups are discovered, and that real private project fixtures stay outside Git.

- [x] **Step 4: Run the complete verification matrix**

Run:

```powershell
npm test
npm run build --workspace apps/web
npm run build --workspace apps/desktop
git diff --check
```

Expected:

- Web, desktop, and API tests all pass.
- Next.js production build succeeds.
- Desktop TypeScript build succeeds.
- `git diff --check` prints no errors.

- [x] **Step 5: Perform visual and accessibility QA**

Run the API and Web locally, inspect `/studio` plus one project at 1280×720, 1024×768, and 390×844. Verify keyboard navigation, visible focus, readable diagnostics, reduced-motion behavior, empty/loading/partial/failed states, print layout, and no horizontal page overflow. Record screenshots locally under ignored `tmp/studio-qa/`.

- [x] **Step 6: Commit final verification and docs**

```powershell
git add .env.example README.md README.zh-CN.md apps/api/tests/test_studio_local_flp.py docs/superpowers/specs/2026-07-13-fl-studio-creative-archive-design.md
git commit -m "docs: finish creative archive setup and verification"
```

---

## Final acceptance checklist

- [x] User can add one or more local project directories. Evidence: Studio root API and library root controls.
- [x] Studio discovers independent FLPs and project-folder FLPs without escaping configured roots. Evidence: scanner boundary, junction, and symlink tests.
- [x] Cached projects appear immediately while changed files parse in the background. Evidence: repository/service cache and stale-state tests.
- [x] Project dashboard shows truthful metadata, diagnostics, arrangement miniature, and musical fingerprint. Evidence: dashboard component tests and responsive QA.
- [x] Arrangement and Pattern explorers correspond to FL Studio 21 project content. Evidence: adapter/analyzer contracts and five real-FLP runs.
- [x] Plugin, Mixer, automation, and dependency pages show supported/unsupported boundaries. Evidence: analysis-view and dependency-report tests.
- [x] FL Studio automatic backups appear in a secondary timeline with confidence-aware association. Evidence: association, pagination, and timeline tests.
- [x] Snapshot diff reports structural changes without modifying or restoring files. Evidence: deterministic semantic diff and ownership tests.
- [x] Safe open actions resolve targets only from registered project data. Evidence: registered-identity and open-target API tests.
- [x] Report view prints cleanly in the approved editorial style. Evidence: report tests and print QA.
- [x] Real FLP hashes remain unchanged before and after parsing. Evidence: `local-flp-01` through `local-flp-05`, 5/5 identical SHA-256.
- [x] Full automated tests and both production builds pass. Evidence: Web 336/336, desktop 3/3, API 443 passed with the opt-in local test skipped by default; Next.js and desktop TypeScript production builds both exited 0.
