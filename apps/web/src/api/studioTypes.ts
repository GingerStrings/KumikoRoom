export type StudioAnalysisStatus =
  | "discovered"
  | "queued"
  | "parsing"
  | "ready"
  | "partial"
  | "failed"
  | "stale";

export type StudioScanStatus = "queued" | "running" | "completed" | "failed";

export interface StudioRoot {
  id: string;
  path: string;
  createdAt: string;
}
export interface StudioProjectSummary {
  id: string;
  canonicalPath: string;
  displayName: string;
  status: StudioAnalysisStatus;
  modifiedAt: string | null;
  latestSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
  tempo: number | null;
  patternCount: number;
  warningCount: number;
  errorCount: number;
  diagnosticCount: number;
  inferredKey: string | null;
}

export interface StudioProjectDetail extends StudioProjectSummary {
  latestSnapshotSourceHash: string | null;
  latestSnapshotAnalyzedAt: string | null;
}

export interface StudioScanJob {
  id: string;
  status: StudioScanStatus;
  discoveredCount: number;
  parsedCount: number;
  cachedCount: number;
  failedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudioProjectInfo {
  title: string | null;
  author: string | null;
  flVersion: string | null;
  tempo: number | null;
  ppq: number | null;
  timeSignatureNumerator: number | null;
  timeSignatureDenominator: number | null;
  createdAt: string | null;
  timeSpentSeconds: number | null;
}

export interface StudioNoteSummary {
  key: number;
  position: number;
  length: number;
  velocity: number;
  channelId: string | null;
}

export interface StudioPatternSummary {
  id: string;
  name: string;
  notes: StudioNoteSummary[];
  usedInPlaylist: boolean;
}

export interface StudioChannelSummary {
  id: string;
  name: string;
  pluginName: string | null;
  channelType: string;
}

export interface StudioPlaylistClipSummary {
  id: string;
  trackIndex: number;
  start: number;
  length: number;
  clipType: string;
  sourceId: string | null;
}

export interface StudioPluginInstance {
  id: string;
  name: string;
  kind: string;
  location: string;
  stateSupported: boolean;
}

export interface StudioMixerInsertSummary {
  id: string;
  name: string;
  slotPluginIds: string[];
  routeTargetIds: string[];
}

export interface StudioAutomationSummary {
  id: string;
  name: string;
  targetName: string | null;
  pointCount: number;
}

export interface StudioProjectAsset {
  path: string;
  kind: "render" | "audio" | "backup";
  modifiedAt: string | null;
  size: number | null;
}

export interface StudioDependencyReference {
  entityId?: string;
  path: string;
  kind: string;
  exists: boolean;
}

export type StudioOpenAction =
  | { kind: "project" | "folder" }
  | { kind: "dependency" | "backup"; entityId: string };

export interface StudioMusicalFingerprint {
  noteMin: number | null;
  noteMax: number | null;
  noteDensity: number;
  velocityMean: number | null;
  patternReuse: number;
  inferredKey: string | null;
  inferredKeyConfidence: number;
  inferredKeyEvidence: string[];
}

export interface StudioAnalysisDiagnostic {
  code: string;
  severity: "error" | "warning" | "notice";
  message: string;
  targetType: string | null;
  targetId: string | null;
}

export interface StudioAnalysis {
  sourcePath: string;
  sourceHash: string;
  status: StudioAnalysisStatus;
  project: StudioProjectInfo;
  patterns: StudioPatternSummary[];
  channels: StudioChannelSummary[];
  playlistClips: StudioPlaylistClipSummary[];
  plugins: StudioPluginInstance[];
  mixerInserts: StudioMixerInsertSummary[];
  automations: StudioAutomationSummary[];
  relatedAssets: StudioProjectAsset[];
  dependencies: StudioDependencyReference[];
  fingerprint: StudioMusicalFingerprint;
  diagnostics: StudioAnalysisDiagnostic[];
  unknownEventCount: number;
}

export type StudioVersionKind = "current" | "history" | "backup" | "candidate";

export interface StudioVersion {
  snapshotId: string;
  sourcePath: string;
  sourceHash: string;
  analyzedAt: string;
  kind: StudioVersionKind;
  associationId: string | null;
  score: number | null;
  confirmed: boolean;
  title: string | null;
  tempo: number | null;
  patternCount: number | null;
}

export interface StudioVersionPage {
  items: StudioVersion[];
  nextCursor: string | null;
}

export interface StudioBackupAssociation {
  id: string;
  projectId: string;
  candidateProjectId: string;
  snapshotId: string;
  score: number;
  confirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StudioDiffSection {
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  changed: Array<Record<string, unknown>>;
}

export interface StudioSnapshotDiff {
  fromSnapshotId: string;
  toSnapshotId: string;
  summary: { changeCount: number };
  projectMetrics: StudioDiffSection;
  patterns: StudioDiffSection;
  notes: StudioDiffSection;
  channels: StudioDiffSection;
  plugins: StudioDiffSection;
  playlistClips: StudioDiffSection;
  mixerInserts: StudioDiffSection;
  dependencies: StudioDiffSection;
}
