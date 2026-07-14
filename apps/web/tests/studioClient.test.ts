import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addStudioRoot,
  getStudioAnalysis,
  getStudioProject,
  getStudioProjects,
  getStudioRoots,
  removeStudioRoot,
  startStudioScan
} from "../src/api/studioClient";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 204 ? "No Content" : "OK",
    text: async () => (status === 204 ? "" : JSON.stringify(body))
  };
}

describe("Studio API client", () => {
  it("maps roots and project summaries to camel case", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([{ id: "r1", path: "D:/Music", created_at: "2026-07-13T08:00:00Z" }])
      )
      .mockResolvedValueOnce(
        response([
          {
            id: "p1",
            canonical_path: "D:/Music/Blue Hour.flp",
            display_name: "Blue Hour",
            status: "ready",
            modified_at: "2026-07-13T10:00:00Z",
            latest_snapshot_id: "s1",
            created_at: "2026-07-13T10:00:01Z",
            updated_at: "2026-07-13T10:00:02Z",
            tempo: 128,
            pattern_count: 42,
            warning_count: 2,
            error_count: 0,
            diagnostic_count: 3,
            inferred_key: "A minor"
          }
        ])
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getStudioRoots()).resolves.toEqual([
      { id: "r1", path: "D:/Music", createdAt: "2026-07-13T08:00:00Z" }
    ]);
    await expect(getStudioProjects()).resolves.toEqual([
      {
        id: "p1",
        canonicalPath: "D:/Music/Blue Hour.flp",
        displayName: "Blue Hour",
        status: "ready",
        modifiedAt: "2026-07-13T10:00:00Z",
        latestSnapshotId: "s1",
        createdAt: "2026-07-13T10:00:01Z",
        updatedAt: "2026-07-13T10:00:02Z",
        tempo: 128,
        patternCount: 42,
        warningCount: 2,
        errorCount: 0,
        diagnosticCount: 3,
        inferredKey: "A minor"
      }
    ]);
  });

  it("maps project detail and nested analysis values", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: "p/1",
          canonical_path: "D:/Music/Blue Hour.flp",
          display_name: "Blue Hour",
          status: "partial",
          modified_at: "2026-07-13T10:00:00Z",
          latest_snapshot_id: "s1",
          created_at: "2026-07-13T10:00:01Z",
          updated_at: "2026-07-13T10:00:02Z",
          tempo: 128,
          pattern_count: 1,
          warning_count: 1,
          error_count: 0,
          diagnostic_count: 1,
          inferred_key: "A minor",
          latest_snapshot_source_hash: "hash-1",
          latest_snapshot_analyzed_at: "2026-07-13T10:00:03Z"
        })
      )
      .mockResolvedValueOnce(
        response({
          source_path: "D:/Music/Blue Hour.flp",
          source_hash: "hash-1",
          status: "partial",
          project: {
            title: "Blue Hour",
            author: "Kumiko",
            fl_version: "21.2",
            tempo: 128,
            ppq: 96,
            time_signature_numerator: 4,
            time_signature_denominator: 4,
            created_at: null,
            time_spent_seconds: 3600
          },
          patterns: [
            {
              id: "pat-1",
              name: "Verse",
              used_in_playlist: true,
              notes: [{ key: 60, position: 0, length: 96, velocity: 100, channel_id: "ch-1" }]
            }
          ],
          channels: [{ id: "ch-1", name: "Keys", plugin_name: "FLEX", channel_type: "instrument" }],
          playlist_clips: [{ id: "clip-1", track_index: 1, start: 0, length: 384, clip_type: "pattern", source_id: "pat-1" }],
          plugins: [{ id: "plug-1", name: "FLEX", kind: "generator", location: "channel:ch-1", state_supported: true }],
          mixer_inserts: [{ id: "mix-1", name: "Master", slot_plugin_ids: ["plug-2"], route_target_ids: [] }],
          automations: [{ id: "auto-1", name: "Cutoff", target_name: "FLEX cutoff", point_count: 4 }],
          related_assets: [{ path: "D:/Music/Blue Hour.wav", kind: "render", modified_at: null, size: 1024 }],
          dependencies: [{ path: "D:/Samples/kick.wav", kind: "sample", exists: false }],
          fingerprint: {
            note_min: 48,
            note_max: 84,
            note_density: 0.25,
            velocity_mean: 98.5,
            pattern_reuse: 0.5,
            inferred_key: "A minor",
            inferred_key_confidence: 0.72,
            inferred_key_evidence: ["pitch-class profile"]
          },
          diagnostics: [{ code: "missing_dependency", severity: "warning", message: "Missing kick", target_type: "dependency", target_id: "D:/Samples/kick.wav" }],
          unknown_event_count: 2
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getStudioProject("p/1")).resolves.toMatchObject({
      latestSnapshotSourceHash: "hash-1",
      latestSnapshotAnalyzedAt: "2026-07-13T10:00:03Z"
    });
    await expect(getStudioAnalysis("p/1")).resolves.toMatchObject({
      sourcePath: "D:/Music/Blue Hour.flp",
      project: { flVersion: "21.2", timeSpentSeconds: 3600 },
      patterns: [{ usedInPlaylist: true, notes: [{ channelId: "ch-1" }] }],
      plugins: [{ stateSupported: true }],
      mixerInserts: [{ slotPluginIds: ["plug-2"], routeTargetIds: [] }],
      dependencies: [{ exists: false }],
      fingerprint: { inferredKeyConfidence: 0.72 },
      diagnostics: [{ targetType: "dependency" }],
      unknownEventCount: 2
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/studio/projects/p%2F1", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/studio/projects/p%2F1/analysis", expect.any(Object));
  });

  it("sends root mutations and starts scans", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({ id: "r1", path: "D:/Music", created_at: "2026-07-13T08:00:00Z" }, 201)
      )
      .mockResolvedValueOnce(response(undefined, 204))
      .mockResolvedValueOnce(
        response(
          {
            id: "scan-1",
            status: "queued",
            discovered_count: 0,
            parsed_count: 0,
            cached_count: 0,
            failed_count: 0,
            error: null,
            created_at: "2026-07-13T08:00:00Z",
            updated_at: "2026-07-13T08:00:00Z"
          },
          202
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await addStudioRoot("D:/Music");
    await removeStudioRoot("r/1");
    await expect(startStudioScan()).resolves.toMatchObject({
      id: "scan-1",
      status: "queued",
      discoveredCount: 0
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/studio/roots",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "D:/Music" }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/studio/roots/r%2F1",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/studio/scans",
      expect.objectContaining({ method: "POST" })
    );
  });
});
