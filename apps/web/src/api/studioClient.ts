import { request } from "./client";
import type {
  StudioAnalysis,
  StudioAnalysisDiagnostic,
  StudioAutomationSummary,
  StudioChannelSummary,
  StudioDependencyReference,
  StudioMixerInsertSummary,
  StudioMusicalFingerprint,
  StudioOpenAction,
  StudioPatternSummary,
  StudioPlaylistClipSummary,
  StudioPluginInstance,
  StudioProjectAsset,
  StudioProjectDetail,
  StudioProjectInfo,
  StudioProjectSummary,
  StudioRoot,
  StudioScanJob,
  StudioBackupAssociation,
  StudioSnapshotDiff,
  StudioVersion,
  StudioVersionPage
} from "./studioTypes";

type RootApi = { id: string; path: string; created_at: string };
type ProjectApi = {
  id: string;
  canonical_path: string;
  display_name: string;
  status: StudioProjectSummary["status"];
  modified_at: string | null;
  latest_snapshot_id: string | null;
  created_at: string;
  updated_at: string;
  tempo: number | null;
  pattern_count: number;
  warning_count: number;
  error_count: number;
  diagnostic_count: number;
  inferred_key: string | null;
};
type ProjectDetailApi = ProjectApi & {
  latest_snapshot_source_hash: string | null;
  latest_snapshot_analyzed_at: string | null;
};
type ScanJobApi = {
  id: string;
  status: StudioScanJob["status"];
  discovered_count: number;
  parsed_count: number;
  cached_count: number;
  failed_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type AnalysisApi = {
  source_path: string;
  source_hash: string;
  status: StudioAnalysis["status"];
  project: {
    title: string | null; author: string | null; fl_version: string | null; tempo: number | null;
    ppq: number | null; time_signature_numerator: number | null; time_signature_denominator: number | null;
    created_at: string | null; time_spent_seconds: number | null;
  };
  patterns: Array<{ id: string; name: string; notes: Array<{ key: number; position: number; length: number; velocity: number; channel_id: string | null }>; used_in_playlist: boolean }>;
  channels: Array<{ id: string; name: string; plugin_name: string | null; channel_type: string }>;
  playlist_clips: Array<{ id: string; track_index: number; start: number; length: number; clip_type: string; source_id: string | null }>;
  plugins: Array<{ id: string; name: string; kind: string; location: string; state_supported: boolean }>;
  mixer_inserts: Array<{ id: string; name: string; slot_plugin_ids: string[]; route_target_ids: string[] }>;
  automations: Array<{ id: string; name: string; target_name: string | null; point_count: number }>;
  related_assets: Array<{ path: string; kind: StudioProjectAsset["kind"]; modified_at: string | null; size: number | null }>;
  dependencies: Array<{ entity_id?: string | null; path: string; kind: string; exists: boolean }>;
  fingerprint: {
    note_min: number | null; note_max: number | null; note_density: number; velocity_mean: number | null;
    pattern_reuse: number; inferred_key: string | null; inferred_key_confidence: number; inferred_key_evidence: string[];
  };
  diagnostics: Array<{ code: string; severity: StudioAnalysisDiagnostic["severity"]; message: string; target_type: string | null; target_id: string | null }>;
  unknown_event_count: number;
};

type VersionApi = {
  snapshot_id: string; source_path: string; source_hash: string; analyzed_at: string;
  kind: StudioVersion["kind"]; association_id: string | null; score: number | null;
  confirmed: boolean; title: string | null; tempo: number | null; pattern_count: number | null;
};
type VersionPageApi = { items: VersionApi[]; next_cursor: string | null };
type AssociationApi = {
  id: string; project_id: string; candidate_project_id: string; snapshot_id: string;
  score: number; confirmed: boolean; created_at: string; updated_at: string;
};
type DiffSectionApi = { added: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>>; changed: Array<Record<string, unknown>> };
type DiffApi = {
  from_snapshot_id: string; to_snapshot_id: string; summary: { change_count: number };
  project_metrics: DiffSectionApi; patterns: DiffSectionApi; notes: DiffSectionApi;
  channels: DiffSectionApi; plugins: DiffSectionApi; playlist_clips: DiffSectionApi;
  mixer_inserts: DiffSectionApi; dependencies: DiffSectionApi;
};

export function getStudioRoots(): Promise<StudioRoot[]> {
  return request<RootApi[]>("/api/studio/roots").then((values) => values.map(mapRoot));
}

export function addStudioRoot(path: string): Promise<StudioRoot> {
  return request<RootApi>("/api/studio/roots", { method: "POST", body: JSON.stringify({ path }) }).then(mapRoot);
}

export function removeStudioRoot(rootId: string): Promise<void> {
  return request<void>(`/api/studio/roots/${encodeURIComponent(rootId)}`, { method: "DELETE" });
}

export function startStudioScan(): Promise<StudioScanJob> {
  return request<ScanJobApi>("/api/studio/scans", { method: "POST" }).then(mapScanJob);
}

export function getStudioScan(scanId: string): Promise<StudioScanJob> {
  return request<ScanJobApi>(`/api/studio/scans/${encodeURIComponent(scanId)}`).then(mapScanJob);
}

export function getStudioProjects(): Promise<StudioProjectSummary[]> {
  return request<ProjectApi[]>("/api/studio/projects").then((values) => values.map(mapProject));
}

export function getStudioProject(projectId: string, options: { signal?: AbortSignal } = {}): Promise<StudioProjectDetail> {
  return request<ProjectDetailApi>(`/api/studio/projects/${encodeURIComponent(projectId)}`, {
    signal: options.signal
  }).then((value) => ({
    ...mapProject(value),
    latestSnapshotSourceHash: value.latest_snapshot_source_hash,
    latestSnapshotAnalyzedAt: value.latest_snapshot_analyzed_at
  }));
}

export function getStudioAnalysis(projectId: string, options: { signal?: AbortSignal } = {}): Promise<StudioAnalysis> {
  return request<AnalysisApi>(`/api/studio/projects/${encodeURIComponent(projectId)}/analysis`, {
    signal: options.signal
  }).then(mapAnalysis);
}

export function openStudioAsset(
  projectId: string,
  action: StudioOpenAction,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  return request<void>(`/api/studio/projects/${encodeURIComponent(projectId)}/open`, {
    method: "POST",
    body: JSON.stringify({
      kind: action.kind,
      ...(action.kind === "dependency" || action.kind === "backup"
        ? { entity_id: action.entityId }
        : {})
    }),
    signal: options.signal
  });
}

export function getStudioVersions(
  projectId: string,
  options: { signal?: AbortSignal; cursor?: string; limit?: number } = {}
): Promise<StudioVersionPage> {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return request<VersionPageApi>(`/api/studio/projects/${encodeURIComponent(projectId)}/versions${query}`, {
    signal: options.signal
  }).then((page) => ({
    items: page.items.map(mapVersion),
    nextCursor: page.next_cursor
  }));
}

export function confirmStudioVersion(
  projectId: string,
  candidateId: string,
  options: { signal?: AbortSignal } = {}
): Promise<StudioBackupAssociation> {
  return request<AssociationApi>(`/api/studio/projects/${encodeURIComponent(projectId)}/versions/confirm`, {
    method: "POST",
    body: JSON.stringify({ candidate_id: candidateId }),
    signal: options.signal
  }).then((value) => ({
    id: value.id,
    projectId: value.project_id,
    candidateProjectId: value.candidate_project_id,
    snapshotId: value.snapshot_id,
    score: value.score,
    confirmed: value.confirmed,
    createdAt: value.created_at,
    updatedAt: value.updated_at
  }));
}

export function getStudioDiff(
  projectId: string,
  fromSnapshotId: string,
  toSnapshotId: string,
  options: { signal?: AbortSignal } = {}
): Promise<StudioSnapshotDiff> {
  const query = `from=${encodeURIComponent(fromSnapshotId)}&to=${encodeURIComponent(toSnapshotId)}`;
  return request<DiffApi>(`/api/studio/projects/${encodeURIComponent(projectId)}/diff?${query}`, {
    signal: options.signal
  }).then(mapDiff);
}

function mapRoot(value: RootApi): StudioRoot {
  return { id: value.id, path: value.path, createdAt: value.created_at };
}

function mapProject(value: ProjectApi): StudioProjectSummary {
  return {
    id: value.id, canonicalPath: value.canonical_path, displayName: value.display_name, status: value.status,
    modifiedAt: value.modified_at, latestSnapshotId: value.latest_snapshot_id, createdAt: value.created_at,
    updatedAt: value.updated_at, tempo: value.tempo, patternCount: value.pattern_count,
    warningCount: value.warning_count, errorCount: value.error_count, diagnosticCount: value.diagnostic_count,
    inferredKey: value.inferred_key
  };
}

function mapVersion(value: VersionApi): StudioVersion {
  return {
    snapshotId: value.snapshot_id,
    sourcePath: value.source_path,
    sourceHash: value.source_hash,
    analyzedAt: value.analyzed_at,
    kind: value.kind,
    associationId: value.association_id,
    score: value.score,
    confirmed: value.confirmed,
    title: value.title,
    tempo: value.tempo,
    patternCount: value.pattern_count
  };
}

function mapDiff(value: DiffApi): StudioSnapshotDiff {
  return {
    fromSnapshotId: value.from_snapshot_id,
    toSnapshotId: value.to_snapshot_id,
    summary: { changeCount: value.summary.change_count },
    projectMetrics: value.project_metrics,
    patterns: value.patterns,
    notes: value.notes,
    channels: value.channels,
    plugins: value.plugins,
    playlistClips: value.playlist_clips,
    mixerInserts: value.mixer_inserts,
    dependencies: value.dependencies
  };
}

function mapScanJob(value: ScanJobApi): StudioScanJob {
  return {
    id: value.id, status: value.status, discoveredCount: value.discovered_count, parsedCount: value.parsed_count,
    cachedCount: value.cached_count, failedCount: value.failed_count, error: value.error,
    createdAt: value.created_at, updatedAt: value.updated_at
  };
}

function mapAnalysis(value: AnalysisApi): StudioAnalysis {
  const project: StudioProjectInfo = {
    title: value.project.title, author: value.project.author, flVersion: value.project.fl_version,
    tempo: value.project.tempo, ppq: value.project.ppq, timeSignatureNumerator: value.project.time_signature_numerator,
    timeSignatureDenominator: value.project.time_signature_denominator, createdAt: value.project.created_at,
    timeSpentSeconds: value.project.time_spent_seconds
  };
  const patterns: StudioPatternSummary[] = value.patterns.map((pattern) => ({
    id: pattern.id, name: pattern.name, usedInPlaylist: pattern.used_in_playlist,
    notes: pattern.notes.map((note) => ({
      key: note.key,
      position: note.position,
      length: note.length,
      velocity: note.velocity,
      channelId: note.channel_id
    }))
  }));
  const channels: StudioChannelSummary[] = value.channels.map((channel) => ({ id: channel.id, name: channel.name, pluginName: channel.plugin_name, channelType: channel.channel_type }));
  const playlistClips: StudioPlaylistClipSummary[] = value.playlist_clips.map((clip) => ({ id: clip.id, trackIndex: clip.track_index, start: clip.start, length: clip.length, clipType: clip.clip_type, sourceId: clip.source_id }));
  const plugins: StudioPluginInstance[] = value.plugins.map((plugin) => ({ id: plugin.id, name: plugin.name, kind: plugin.kind, location: plugin.location, stateSupported: plugin.state_supported }));
  const mixerInserts: StudioMixerInsertSummary[] = value.mixer_inserts.map((insert) => ({ id: insert.id, name: insert.name, slotPluginIds: insert.slot_plugin_ids, routeTargetIds: insert.route_target_ids }));
  const automations: StudioAutomationSummary[] = value.automations.map((automation) => ({ id: automation.id, name: automation.name, targetName: automation.target_name, pointCount: automation.point_count }));
  const relatedAssets: StudioProjectAsset[] = value.related_assets.map((asset) => ({ path: asset.path, kind: asset.kind, modifiedAt: asset.modified_at, size: asset.size }));
  const dependencies: StudioDependencyReference[] = value.dependencies.map((dependency) => ({ entityId: dependency.entity_id ?? undefined, path: dependency.path, kind: dependency.kind, exists: dependency.exists }));
  const fingerprint: StudioMusicalFingerprint = {
    noteMin: value.fingerprint.note_min, noteMax: value.fingerprint.note_max, noteDensity: value.fingerprint.note_density,
    velocityMean: value.fingerprint.velocity_mean, patternReuse: value.fingerprint.pattern_reuse,
    inferredKey: value.fingerprint.inferred_key, inferredKeyConfidence: value.fingerprint.inferred_key_confidence,
    inferredKeyEvidence: value.fingerprint.inferred_key_evidence
  };
  const diagnostics: StudioAnalysisDiagnostic[] = value.diagnostics.map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity, message: diagnostic.message, targetType: diagnostic.target_type, targetId: diagnostic.target_id }));
  return {
    sourcePath: value.source_path, sourceHash: value.source_hash, status: value.status, project, patterns,
    channels, playlistClips, plugins, mixerInserts, automations, relatedAssets, dependencies, fingerprint,
    diagnostics, unknownEventCount: value.unknown_event_count
  };
}
