import {
  createWorkflowDefinitionSync,
  listWorkflowDefinitionsSync,
  upsertWorkflowTriggerSync,
} from "@dofe-agent/db";
import type { ActiveEmployee, AutomationRule, ScheduledTask } from "@dofe-agent/domain/workspace";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import { publishWorkflowSync } from "./publishing.ts";

export interface LegacyMigrationInput {
  workspaceId: string;
  scheduledTasks: Array<Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "title" | "scheduledAt">>;
  automationRules: Array<Partial<AutomationRule> & Pick<AutomationRule, "id">>;
  employees?: Array<Pick<ActiveEmployee, "id" | "name" | "remarkName">>;
  strictEmployeeResolution?: boolean;
}

interface LegacyMigrationActionBase {
  sourceId: string;
  sourceType: "scheduled_task" | "automation_rule";
  name: string;
  description: string;
  ownerUserId: string;
}

export type LegacyMigrationAction =
  | (LegacyMigrationActionBase & {
      kind: "create_workflow";
      employeeId: string;
      triggerType: "schedule";
      triggerConfig: Record<string, unknown>;
      nextFireAt: string;
      channelName?: string;
      enabled: boolean;
    })
  | (LegacyMigrationActionBase & { kind: "disabled_draft"; reasonCode: string })
  | (LegacyMigrationActionBase & { kind: "legacy_adapter"; reasonCode: string });

export interface LegacyMigrationPlan {
  actions: LegacyMigrationAction[];
  counts: Record<LegacyMigrationAction["kind"], number>;
}

export interface MigrationReport {
  dryRun: boolean;
  workspaceId: string;
  counts: LegacyMigrationPlan["counts"] & { skipped_existing: number; failed: number };
  createdWorkflowIds: string[];
  failures: Array<{ sourceId: string; reasonCode: string }>;
}

export function planLegacyMigration(input: LegacyMigrationInput): LegacyMigrationPlan {
  const employees = buildEmployeeIndex(input.employees ?? []);
  const actions: LegacyMigrationAction[] = [];

  for (const task of input.scheduledTasks) {
    const base = {
      sourceId: task.id,
      sourceType: "scheduled_task" as const,
      name: task.title.trim() || `Legacy schedule ${task.id}`,
      description: task.description?.trim() ?? "",
      ownerUserId: task.createdBy?.trim() || "system:workflow-migration",
    };
    const employeeId = resolveEmployeeId(task.assignee, employees, Boolean(input.strictEmployeeResolution));
    if (!employeeId) {
      actions.push({ ...base, kind: "disabled_draft", reasonCode: "workflow_migration_employee_unresolved" });
      continue;
    }
    actions.push({
      ...base,
      kind: "create_workflow",
      employeeId,
      triggerType: "schedule",
      triggerConfig: scheduleConfig(task),
      nextFireAt: task.nextRunAt ?? task.scheduledAt,
      ...(task.channelName ? { channelName: task.channelName } : {}),
      enabled: task.status === undefined || task.status === "active",
    });
  }

  for (const rule of input.automationRules) {
    actions.push({
      sourceId: rule.id,
      sourceType: "automation_rule",
      name: rule.name?.trim() || `Legacy automation ${rule.id}`,
      description: rule.description?.trim() ?? "",
      ownerUserId: rule.createdBy?.trim() || "system:workflow-migration",
      kind: "legacy_adapter",
      reasonCode: "workflow_migration_dynamic_rule_requires_review",
    });
  }

  return { actions, counts: countActions(actions) };
}

export function applyLegacyMigrationSync(input: {
  workspaceId: string;
  plan: LegacyMigrationPlan;
  dryRun: boolean;
}): MigrationReport {
  const report: MigrationReport = {
    dryRun: input.dryRun,
    workspaceId: input.workspaceId,
    counts: { ...input.plan.counts, skipped_existing: 0, failed: 0 },
    createdWorkflowIds: [],
    failures: [],
  };
  if (input.dryRun) return report;

  const existingKeys = new Set(
    listWorkflowDefinitionsSync(input.workspaceId)
      .filter((item) => item.legacySourceType && item.legacySourceId)
      .map((item) => `${item.legacySourceType}:${item.legacySourceId}`),
  );
  for (const action of input.plan.actions) {
    const sourceKey = `${action.sourceType}:${action.sourceId}`;
    if (existingKeys.has(sourceKey)) {
      report.counts.skipped_existing += 1;
      continue;
    }
    try {
      const graph = graphForAction(action);
      const definition = createWorkflowDefinitionSync({
        workspaceId: input.workspaceId,
        name: action.name,
        description: action.description,
        ownerUserId: action.ownerUserId,
        channelName: action.kind === "create_workflow" ? action.channelName : undefined,
        createdBy: "system:workflow-migration",
        legacySourceType: action.sourceType,
        legacySourceId: action.sourceId,
        draftGraphJson: JSON.stringify(graph),
      });
      report.createdWorkflowIds.push(definition.id);
      existingKeys.add(sourceKey);

      if (action.kind === "create_workflow") {
        publishWorkflowSync({
          workspaceId: input.workspaceId,
          workflowId: definition.id,
          graph,
          actor: { userId: "system:workflow-migration", role: "admin" },
          governance: { migratedFrom: action.sourceType },
        });
        upsertWorkflowTriggerSync({
          id: `workflow-trigger-migrated-${safeId(action.sourceId)}`,
          workspaceId: input.workspaceId,
          workflowId: definition.id,
          type: action.triggerType,
          configJson: JSON.stringify(action.triggerConfig),
          status: action.enabled ? "active" : "paused",
          nextFireAt: action.nextFireAt,
          misfirePolicy: "skip",
          dedupeWindowSeconds: 60,
        });
      }
    } catch (error) {
      report.counts.failed += 1;
      report.failures.push({ sourceId: action.sourceId, reasonCode: stableMigrationFailure(error) });
    }
  }
  return report;
}

function graphForAction(action: LegacyMigrationAction): WorkflowGraphDefinition {
  if (action.kind !== "create_workflow") return { schemaVersion: 1, nodes: [], edges: [] };
  return {
    schemaVersion: 1,
    nodes: [{
      id: `legacy-${safeId(action.sourceId)}`,
      type: "employee_task",
      employeeId: action.employeeId,
      config: { instruction: action.description || action.name },
    }],
    edges: [],
  };
}

function buildEmployeeIndex(employees: LegacyMigrationInput["employees"]): Map<string, string> {
  const index = new Map<string, string>();
  for (const employee of employees ?? []) {
    for (const value of [employee.id, employee.name, employee.remarkName]) {
      if (value?.trim()) index.set(value.trim().toLocaleLowerCase(), employee.id);
    }
  }
  return index;
}

function resolveEmployeeId(assignee: string | undefined, index: Map<string, string>, strict: boolean): string | undefined {
  const value = assignee?.trim();
  if (!value) return undefined;
  const resolved = index.get(value.toLocaleLowerCase());
  if (resolved || strict) return resolved;
  if (value.startsWith("emp-")) return value;
  return `emp-${safeId(value)}`;
}

function scheduleConfig(task: Partial<ScheduledTask>): Record<string, unknown> {
  if (task.repeat === "daily") {
    const date = new Date(task.scheduledAt ?? "");
    if (!Number.isNaN(date.getTime())) {
      return { dailyAt: `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}` };
    }
  }
  if (task.repeat === "weekly") return { repeatSeconds: 7 * 24 * 60 * 60 };
  if (task.repeat === "monthly") return { legacyRepeat: "monthly" };
  if (task.repeat === "cron") return { cronExpression: task.cronExpression ?? "" };
  return { once: true };
}

function countActions(actions: LegacyMigrationAction[]): LegacyMigrationPlan["counts"] {
  return {
    create_workflow: actions.filter((item) => item.kind === "create_workflow").length,
    disabled_draft: actions.filter((item) => item.kind === "disabled_draft").length,
    legacy_adapter: actions.filter((item) => item.kind === "legacy_adapter").length,
  };
}

function safeId(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "legacy";
}

function stableMigrationFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return code.startsWith("workflow_") ? code : "workflow_migration_apply_failed";
}
