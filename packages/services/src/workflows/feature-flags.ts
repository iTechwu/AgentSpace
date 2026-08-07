export type WorkflowCutoverMode = "legacy_only" | "dual_read" | "workflow_engine" | "legacy_archived";
export type WorkflowTriggerOwner = "legacy" | "workflow";

const CUTOVER_MODES = new Set<WorkflowCutoverMode>([
  "legacy_only",
  "dual_read",
  "workflow_engine",
  "legacy_archived",
]);

export function resolveTriggerOwner(input: { mode: WorkflowCutoverMode }): WorkflowTriggerOwner {
  return input.mode === "legacy_only" ? "legacy" : "workflow";
}

export function readWorkflowCutoverModeSync(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkflowCutoverMode {
  const workspaceMode = readWorkspaceModeMap(env.WORKFLOW_CUTOVER_MODES)[workspaceId];
  return parseCutoverMode(workspaceMode) ?? parseCutoverMode(env.WORKFLOW_CUTOVER_MODE) ?? "legacy_only";
}

export function assertTriggerWriteOwnerSync(
  workspaceId: string,
  source: "calendar" | "automations" | "workflow",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const mode = readWorkflowCutoverModeSync(workspaceId, env);
  const owner = resolveTriggerOwner({ mode });
  const sourceOwner: WorkflowTriggerOwner = source === "workflow" ? "workflow" : "legacy";
  if (sourceOwner !== owner) {
    throw new Error("workflow_trigger_owner_conflict");
  }
}

export function shouldReadLegacyWorkflowSources(mode: WorkflowCutoverMode): boolean {
  return mode === "legacy_only" || mode === "dual_read";
}

function parseCutoverMode(value: string | undefined): WorkflowCutoverMode | undefined {
  return value && CUTOVER_MODES.has(value as WorkflowCutoverMode) ? value as WorkflowCutoverMode : undefined;
}

function readWorkspaceModeMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}
