import { describe, expect, it } from "vitest";
import {
  matchesWorkspaceInvalidation,
  type WorkspaceInvalidationEvent,
} from "@/features/dashboard/workspace-invalidation";
import type { WorkspaceModuleCacheEntry } from "@/features/dashboard/workspace-module-cache";

describe("workspace invalidation helpers", () => {
  it("matches explicit modules and ignores unrelated workspaces", () => {
    const event: WorkspaceInvalidationEvent = {
      workspaceId: "workspace-1",
      modules: ["agents"],
    };

    expect(matchesWorkspaceInvalidation(buildEntry("agents"), event)).toBe(true);
    expect(matchesWorkspaceInvalidation(buildEntry("knowledge"), event)).toBe(false);
    expect(matchesWorkspaceInvalidation(buildEntry("agents", { workspaceId: "workspace-2" }), event)).toBe(false);
  });

  it("maps resource invalidations to related modules and optional resource keys", () => {
    expect(matchesWorkspaceInvalidation(
      buildEntry("im", { resourceKey: "channel-detail:general" }),
      {
        workspaceId: "workspace-1",
        resources: [{ type: "channel", id: "general" }],
      },
    )).toBe(true);
    expect(matchesWorkspaceInvalidation(
      buildEntry("knowledge", { resourceKey: "document-detail:doc-1" }),
      {
        workspaceId: "workspace-1",
        resources: [{ type: "document", id: "doc-1" }],
      },
    )).toBe(true);
    expect(matchesWorkspaceInvalidation(
      buildEntry("im", {
        resourceKey: "channel-detail:general",
        resourceRefs: { document: ["doc-1"] },
      }),
      {
        workspaceId: "workspace-1",
        resources: [{ type: "document", id: "doc-1" }],
      },
    )).toBe(true);
    expect(matchesWorkspaceInvalidation(
      buildEntry("im", {
        resourceKey: "channel-detail:general",
        resourceRefs: { document: ["doc-2"] },
      }),
      {
        workspaceId: "workspace-1",
        resources: [{ type: "document", id: "doc-1" }],
      },
    )).toBe(false);
    expect(matchesWorkspaceInvalidation(
      buildEntry("knowledge", { resourceKey: "document-detail:doc-2" }),
      {
        workspaceId: "workspace-1",
        resources: [{ type: "document", id: "doc-1" }],
      },
    )).toBe(false);
    expect(matchesWorkspaceInvalidation(
      buildEntry("task-board"),
      {
        workspaceId: "workspace-1",
        resources: [{ type: "task" }],
      },
    )).toBe(true);
  });

  it("can narrow matching by permission version", () => {
    expect(matchesWorkspaceInvalidation(
      buildEntry("settings", { permissionVersion: "owner" }),
      {
        workspaceId: "workspace-1",
        modules: ["settings"],
        permissionVersion: "owner",
      },
    )).toBe(true);
    expect(matchesWorkspaceInvalidation(
      buildEntry("settings", { permissionVersion: "member" }),
      {
        workspaceId: "workspace-1",
        modules: ["settings"],
        permissionVersion: "owner",
      },
    )).toBe(false);
  });
});

function buildEntry(
  moduleId: WorkspaceModuleCacheEntry["metadata"]["moduleId"],
  metadata?: Partial<WorkspaceModuleCacheEntry["metadata"]>,
): WorkspaceModuleCacheEntry {
  return {
    data: {},
    metadata: {
      moduleId,
      queryKey: "",
      stale: false,
      updatedAt: 0,
      workspaceId: "workspace-1",
      ...metadata,
    },
    status: "ready",
  };
}
