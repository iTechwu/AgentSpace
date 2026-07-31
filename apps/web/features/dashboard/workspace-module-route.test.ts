import { describe, expect, it } from "vitest";
import {
  buildWorkspaceModuleDataQuery,
  buildWorkspaceModuleHref,
  isWorkspaceModuleId,
  WORKSPACE_MODULE_IDS,
  normalizeWorkspaceModuleQuery,
  parseWorkspaceModuleHref,
  parseWorkspaceModulePath,
  type WorkspaceModuleId,
} from "@/features/dashboard/workspace-module-route";

describe("workspace module route", () => {
  it("parses workspace module paths and derived views", () => {
    expect(parseWorkspaceModulePath("/w/acme/im", "view=direct").isDigitalContactsView).toBe(false);
    expect(parseWorkspaceModulePath("/w/acme/im", "view=direct").conversationView).toBe("direct");
    expect(parseWorkspaceModulePath("/w/acme/im", "view=direct&context=contacts").isDigitalContactsView).toBe(true);
    expect(parseWorkspaceModulePath("/w/acme/im", "focus=channel%3Atour+visit&tab=documents&doc=doc-1").moduleId).toBe("im");
    expect(parseWorkspaceModulePath("/w/acme/contacts").isHumanContactsView).toBe(true);
    expect(parseWorkspaceModulePath("/w/acme/agents", "mode=container").agentsMode).toBe("container");
    expect(parseWorkspaceModulePath("/w/acme/agents", "mode=showcase").agentsMode).toBe("showcase");
    expect(parseWorkspaceModulePath("/w/acme/knowledge", "view=documents").knowledgeView).toBe("documents");
    expect(parseWorkspaceModulePath("/w/acme/task/board").moduleId).toBe("task-board");

    const settings = parseWorkspaceModulePath("/w/acme/settings/security");
    expect(settings.moduleId).toBe("settings");
    expect(settings.isSettingsPath).toBe(true);
    expect(settings.settingsPath).toEqual(["security"]);
  });

  it("normalizes module query state without keeping inactive default values", () => {
    expect(normalizeWorkspaceModuleQuery("im", "view=all&focus=channel%3Ageneral").toString()).toBe("focus=channel%3Ageneral");
    expect(normalizeWorkspaceModuleQuery("im", "tab=documents&doc=doc-1&focus=channel%3Atour+visit").toString()).toBe(
      "focus=channel%3Atour+visit&tab=documents&doc=doc-1",
    );
    expect(normalizeWorkspaceModuleQuery("im", "view=direct&tab=files&focus=contact%3Aa").toString()).toBe(
      "view=direct&focus=contact%3Aa&tab=files",
    );
    expect(normalizeWorkspaceModuleQuery("im", "context=contacts&view=direct&focus=contact%3Aa").toString()).toBe(
      "view=direct&context=contacts&focus=contact%3Aa",
    );
    expect(normalizeWorkspaceModuleQuery("im", "context=unknown&view=direct").toString()).toBe("view=direct");
    expect(normalizeWorkspaceModuleQuery("agents", "mode=showcase&create=server&focus=agent%3Aops&tab=settings").toString()).toBe(
      "mode=showcase&create=server&focus=agent%3Aops&tab=settings",
    );
    expect(normalizeWorkspaceModuleQuery("agents", "mode=bogus&create=server&focus=agent%3Aops").toString()).toBe(
      "create=server&focus=agent%3Aops",
    );
    expect(normalizeWorkspaceModuleQuery("agents", "mode=agent&tab=bogus").toString()).toBe("mode=agent");
    expect(normalizeWorkspaceModuleQuery("knowledge", "view=knowledge&page=page-1").toString()).toBe("page=page-1");
    expect(normalizeWorkspaceModuleQuery("inbox", "filter=task&focus=item-1&debug=1").toString()).toBe("filter=task&focus=item-1&debug=1");
    expect(normalizeWorkspaceModuleQuery("inbox", "filter=bogus&focus=item-1").toString()).toBe("focus=item-1");
    expect(normalizeWorkspaceModuleQuery("skills", "create=skill&source=nav").toString()).toBe("create=skill&source=nav");
    expect(normalizeWorkspaceModuleQuery("skills", "create=bogus&source=nav").toString()).toBe("source=nav");
    expect(normalizeWorkspaceModuleQuery("settings", "section=preferences&z=2&a=1").toString()).toBe("section=preferences&a=1&z=2");
  });

  it.each([
    ["inbox", "/inbox", "filter=task&focus=item-1"],
    ["im", "/im", "view=direct&focus=contact%3Aatlas&tab=files"],
    ["contacts", "/contacts", "view=digital&focus=human%3Auser-1"],
    ["approvals", "/approvals", ""],
    ["task-board", "/task/board", ""],
    ["agents", "/agents", "mode=container&create=server"],
    ["skills", "/skills", "create=skill"],
    ["knowledge", "/knowledge", "view=documents&document=doc-1"],
    ["market", "/market", ""],
    ["performance", "/performance", ""],
    ["org-chart", "/org-chart", ""],
    ["costs", "/costs", ""],
    ["tables", "/tables", ""],
    ["automations", "/automations", ""],
    ["calendar", "/calendar", ""],
    ["templates", "/templates", ""],
    ["settings", "/settings/preferences", ""],
  ] satisfies Array<[WorkspaceModuleId, string, string]>)("keeps only loader-sensitive query state for %s", (moduleId, path, query) => {
    const routeState = parseWorkspaceModulePath(`/w/acme${path}`, query);

    expect(routeState.moduleId).toBe(moduleId);
    expect(buildWorkspaceModuleDataQuery(routeState).toString()).toBe(expectedDataQuery(moduleId, query));
  });

  it("builds workspace module hrefs that round-trip through the parser", () => {
    const href = buildWorkspaceModuleHref("acme team", {
      moduleId: "settings",
      settingsPath: ["preferences"],
      query: { source: "nav" },
    });

    expect(href).toBe("/w/acme%20team/settings/preferences?source=nav");

    const parsed = parseWorkspaceModuleHref(href);
    expect(parsed.workspaceSlug).toBe("acme team");
    expect(parsed.moduleId).toBe("settings");
    expect(parsed.settingsPath).toEqual(["preferences"]);
    expect(parsed.searchParams.toString()).toBe("source=nav");
  });

  it("builds the canonical task board URL", () => {
    expect(buildWorkspaceModuleHref("acme", "task-board")).toBe("/w/acme/task/board");
  });

  it("guards known workspace module ids", () => {
    expect(isWorkspaceModuleId("task-board")).toBe(true);
    expect(isWorkspaceModuleId("unknown")).toBe(false);
    expect(isWorkspaceModuleId(undefined)).toBe(false);
  });

  it("has deep-link coverage for every known workspace module", () => {
    const covered = new Set<WorkspaceModuleId>([
      "inbox",
      "im",
      "contacts",
      "approvals",
      "task-board",
      "agents",
      "skills",
      "knowledge",
      "market",
      "performance",
      "org-chart",
      "costs",
      "tables",
      "automations",
      "calendar",
      "templates",
      "settings",
    ]);

    expect(covered).toEqual(new Set(WORKSPACE_MODULE_IDS));
  });
});

function expectedDataQuery(moduleId: WorkspaceModuleId, query: string): string {
  if (moduleId === "settings") {
    return "section=preferences";
  }
  if (moduleId === "im") {
    const focus = normalizeWorkspaceModuleQuery(moduleId, query).get("focus");
    return focus ? new URLSearchParams({ focus }).toString() : "";
  }
  return "";
}
