import type { StudioAnalysis, StudioDependencyReference } from "../../api/studioTypes";

export interface DependencyClassification {
  available: StudioDependencyReference[];
  missing: StudioDependencyReference[];
  unknown: StudioDependencyReference[];
}

export function classifyDependencies(
  analysis: Pick<StudioAnalysis, "dependencies" | "diagnostics">
): DependencyClassification {
  const unresolvedTargets = new Set(
    analysis.diagnostics
      .filter((diagnostic) => (
        diagnostic.code === "unresolved_dependency"
        && normalizeTargetType(diagnostic.targetType) === "dependency"
        && typeof diagnostic.targetId === "string"
        && diagnostic.targetId.length > 0
      ))
      .map((diagnostic) => diagnostic.targetId as string)
  );
  return {
    available: analysis.dependencies.filter((dependency) => dependency.exists === true),
    missing: analysis.dependencies.filter((dependency) => dependency.exists === false && !unresolvedTargets.has(dependency.path)),
    unknown: analysis.dependencies.filter((dependency) => dependency.exists === false && unresolvedTargets.has(dependency.path))
  };
}

function normalizeTargetType(targetType: string | null): string {
  return targetType?.trim().toLowerCase().replace(/-/g, "_") ?? "";
}
