import { describe, expect, it } from "vitest";
import {
  createWorkspaceModuleProfileSample,
  formatWorkspaceModuleProfileSummary,
  summarizeWorkspaceModuleProfiles,
  type WorkspaceModuleProfileSample,
} from "@/features/dashboard/workspace-module-loader-profile";
import type { WorkspaceModuleLoaderData } from "@/features/dashboard/workspace-module-loaders";

describe("workspace module loader profile helpers", () => {
  it("measures seed bytes and ranks slowest/largest modules", () => {
    const samples: WorkspaceModuleProfileSample[] = [
      createProfileSample({
        moduleData: { moduleId: "im", currentUserDisplayName: "techwu", data: { channels: Array.from({ length: 8 }, (_, index) => ({ id: index })) } },
        serverDurationMs: 24,
      }),
      createProfileSample({
        moduleData: { moduleId: "knowledge", data: { pages: Array.from({ length: 3 }, (_, index) => ({ id: index })) } },
        serverDurationMs: 18,
      }),
      createProfileSample({
        moduleData: { moduleId: "agents", data: { agents: [{ id: "agent-1" }] } },
        serverDurationMs: 31,
      }),
      createProfileSample({
        moduleData: { moduleId: "settings", data: { members: [{ id: "member-1" }], sessions: [] } },
        serverDurationMs: 12,
      }),
    ];

    const summary = summarizeWorkspaceModuleProfiles(samples, 3);

    expect(summary.topByServerDuration.map((sample) => sample.moduleId)).toEqual(["agents", "im", "knowledge"]);
    expect(summary.topBySeedBytes.map((sample) => sample.moduleId)).toEqual(["im", "settings", "knowledge"]);
    expect(formatWorkspaceModuleProfileSummary(summary)).toMatch(
      /^server: agents \d+ms \d+ bytes, im \d+ms \d+ bytes, knowledge \d+ms \d+ bytes; seed: im \d+ms \d+ bytes, settings \d+ms \d+ bytes, knowledge \d+ms \d+ bytes$/,
    );
  });
});

function createProfileSample(input: {
  moduleData: unknown;
  serverDurationMs: number;
}): WorkspaceModuleProfileSample {
  return createWorkspaceModuleProfileSample({
    moduleData: input.moduleData as WorkspaceModuleLoaderData,
    serverDurationMs: input.serverDurationMs,
  });
}
