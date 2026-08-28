import type { WorkspaceModuleLoaderData } from "@/features/dashboard/workspace-module-loaders";
import type { WorkspaceModuleLoaderId } from "@/features/dashboard/workspace-module-loader-types";

export interface WorkspaceModuleProfileSample {
  moduleId: WorkspaceModuleLoaderId;
  serverDurationMs: number;
  seedBytes: number;
}

export interface WorkspaceModuleProfileSummary {
  samples: WorkspaceModuleProfileSample[];
  topByServerDuration: WorkspaceModuleProfileSample[];
  topBySeedBytes: WorkspaceModuleProfileSample[];
}

export function summarizeWorkspaceModuleProfiles(
  samples: readonly WorkspaceModuleProfileSample[],
  limit = 3,
): WorkspaceModuleProfileSummary {
  const normalized = samples.map((sample) => ({ ...sample }));
  return {
    samples: normalized,
    topByServerDuration: sortProfileSamples(normalized, "serverDurationMs").slice(0, limit),
    topBySeedBytes: sortProfileSamples(normalized, "seedBytes").slice(0, limit),
  };
}

export function createWorkspaceModuleProfileSample(input: {
  moduleData: WorkspaceModuleLoaderData;
  serverDurationMs: number;
}): WorkspaceModuleProfileSample {
  return {
    moduleId: input.moduleData.moduleId,
    serverDurationMs: input.serverDurationMs,
    seedBytes: measureWorkspaceModuleSeedBytes(input.moduleData),
  };
}

export function formatWorkspaceModuleProfileSummary(summary: WorkspaceModuleProfileSummary): string {
  return [
    "server: " + summary.topByServerDuration.map(formatProfileSample).join(", "),
    "seed: " + summary.topBySeedBytes.map(formatProfileSample).join(", "),
  ].join("; ");
}

function sortProfileSamples(
  samples: readonly WorkspaceModuleProfileSample[],
  key: "serverDurationMs" | "seedBytes",
): WorkspaceModuleProfileSample[] {
  return [...samples].sort((left, right) => {
    const diff = right[key] - left[key];
    if (diff !== 0) {
      return diff;
    }
    return left.moduleId.localeCompare(right.moduleId);
  });
}

function formatProfileSample(sample: WorkspaceModuleProfileSample): string {
  return `${sample.moduleId} ${sample.serverDurationMs}ms ${sample.seedBytes} bytes`;
}

function measureWorkspaceModuleSeedBytes(moduleData: WorkspaceModuleLoaderData): number {
  const json = JSON.stringify(moduleData);
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(json).length;
  }
  return json.length;
}
