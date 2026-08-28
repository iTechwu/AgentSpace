import type { WorkspaceModuleId } from "@/features/dashboard/workspace-module-route";

export interface WorkspaceModuleViewer {
  email?: string;
  id: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  sessionId?: string;
}

export type WorkspaceModuleLoaderId = Extract<
  WorkspaceModuleId,
  | "agents"
  | "approvals"
  | "automations"
  | "calendar"
  | "contacts"
  | "costs"
  | "im"
  | "inbox"
  | "knowledge"
  | "market"
  | "org-chart"
  | "performance"
  | "settings"
  | "skills"
  | "tables"
  | "task-board"
  | "templates"
>;

export type WorkspaceModuleLoaderData =
  | {
      moduleId: "agents";
      data: unknown;
    }
  | {
      moduleId: "approvals";
      data: unknown;
    }
  | {
      moduleId: "automations";
      data: unknown;
    }
  | {
      moduleId: "calendar";
      data: unknown;
    }
  | {
      moduleId: "contacts";
      view: "human" | "digital";
      currentUserDisplayName: string;
      data: unknown;
    }
  | {
      moduleId: "costs";
      costs: unknown;
      budgets: unknown;
    }
  | {
      moduleId: "im";
      currentUserDisplayName: string;
      data: unknown;
    }
  | {
      moduleId: "org-chart";
      data: unknown;
    }
  | {
      moduleId: "performance";
      data: unknown;
    }
  | {
      moduleId: "settings";
      data: unknown;
    }
  | {
      moduleId: "skills";
      data: unknown;
    }
  | {
      moduleId: "tables";
      data: unknown;
    }
  | {
      moduleId: "inbox";
      data: unknown;
    }
  | {
      moduleId: "knowledge";
      data: unknown;
    }
  | {
      moduleId: "market";
      data: unknown;
    }
  | {
      moduleId: "task-board";
      data: unknown;
    }
  | {
      moduleId: "templates";
      data: unknown;
    };

export function isWorkspaceModuleLoaderId(moduleId: WorkspaceModuleId | null): moduleId is WorkspaceModuleLoaderId {
  return (
    moduleId === "agents" ||
    moduleId === "approvals" ||
    moduleId === "automations" ||
    moduleId === "calendar" ||
    moduleId === "contacts" ||
    moduleId === "costs" ||
    moduleId === "im" ||
    moduleId === "inbox" ||
    moduleId === "knowledge" ||
    moduleId === "market" ||
    moduleId === "org-chart" ||
    moduleId === "performance" ||
    moduleId === "settings" ||
    moduleId === "skills" ||
    moduleId === "tables" ||
    moduleId === "task-board" ||
    moduleId === "templates"
  );
}
