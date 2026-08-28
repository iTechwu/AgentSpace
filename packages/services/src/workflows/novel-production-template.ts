import type { WorkflowGraphDefinition } from "@dofe-agent/domain";

/**
 * The five independent production skills plus the new shot-generation module.
 * Each is a separately upgradeable/validatable/re-runnable Module; the workflow
 * orchestrates them. Upstream skills stay independent JSON producers.
 */
export const NOVEL_PRODUCTION_SKILL_IDS = {
  characters: "novel-characters",
  outline: "novel-outline",
  art: "novel-art",
  script: "novel-script",
  storyboard: "novel-storyboard",
  shotGeneration: "shot-generation",
} as const;

export interface NovelProductionTemplateInput {
  coordinatorEmployeeId: string;
  artistEmployeeId?: string;
  scriptEmployeeId?: string;
  consistencyEmployeeId?: string;
  /** Approver employee for the over-limit approval gate (defaults to coordinator). */
  approverEmployeeId?: string;
  /** Channel the approver belongs to; required because publish validation resolves it. */
  approvalChannelName: string;
  /** Bounded convergence rounds (defaults to 2). */
  maxRounds?: number;
}

/**
 * Two-round (bounded) convergence for novel production, expressed as a single
 * `iteration_group` node. The convergence group (candidate art/script +
 * consistency quality gate) is a bounded, quality-gated loop; the current DAG
 * executor compiles it to a static unroll via `compileWorkflowIterationGroups`.
 */
export function buildNovelProductionWorkflowGraph(
  input: NovelProductionTemplateInput,
): WorkflowGraphDefinition {
  const coordinator = input.coordinatorEmployeeId;
  const artist = input.artistEmployeeId ?? coordinator;
  const script = input.scriptEmployeeId ?? coordinator;
  const consistency = input.consistencyEmployeeId ?? coordinator;
  const approver = input.approverEmployeeId ?? coordinator;
  const approvalChannelName = input.approvalChannelName.trim();
  if (!approvalChannelName) {
    throw new Error("novel_production_approval_channel_required");
  }
  const maxRounds = input.maxRounds ?? 2;

  const productionOutput = ["artifactDigest", "revision"];
  const productionSkillConfig = (skillId: string) => ({ requiredSkillIds: [skillId], outputFields: productionOutput });
  const consistencyCheckConfig = { outputFields: ["blockingCount", "qualityReportDigest"], qualityReportSchemaVersion: 1 };

  // The convergence loop body: candidate art/script (parallel) -> join ->
  // consistency quality gate. Single entry (prepare-round), single terminal
  // (consistency).
  const convergenceBody: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [
      { id: "prepare-round", type: "employee_task", employeeId: consistency, config: {} },
      { id: "art", type: "employee_task", employeeId: artist, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.art) },
      { id: "script", type: "employee_task", employeeId: script, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.script) },
      { id: "merge", type: "join", config: {} },
      { id: "consistency", type: "employee_task", employeeId: consistency, config: consistencyCheckConfig },
    ],
    edges: [
      { source: "prepare-round", target: "art" },
      { source: "prepare-round", target: "script" },
      { source: "art", target: "merge" },
      { source: "script", target: "merge" },
      { source: "merge", target: "consistency" },
    ],
  };

  return {
    schemaVersion: 1,
    nodes: [
      { id: "cast-baseline", type: "employee_task", employeeId: coordinator, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.characters) },
      { id: "outline", type: "employee_task", employeeId: coordinator, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.outline) },
      {
        id: "convergence",
        type: "iteration_group",
        config: {
          maxRounds,
          body: convergenceBody,
          qualityGate: {
            nodeId: "consistency",
            blockingField: "blockingCount",
            qualityReportField: "qualityReportDigest",
          },
          overLimit: "approval",
          overLimitApproval: { employeeId: approver, channelName: approvalChannelName },
        },
      },
      { id: "storyboard", type: "employee_task", employeeId: coordinator, config: { requiredSkillIds: [NOVEL_PRODUCTION_SKILL_IDS.storyboard], outputFields: ["artifactDigest", "batchManifestDigest"] } },
      { id: "shot-generation", type: "employee_task", employeeId: coordinator, config: { requiredSkillIds: [NOVEL_PRODUCTION_SKILL_IDS.shotGeneration], outputFields: ["outputPackageDigest"] } },
    ],
    edges: [
      { source: "cast-baseline", target: "outline" },
      { source: "outline", target: "convergence" },
      { source: "convergence", target: "storyboard" },
      { source: "storyboard", target: "shot-generation" },
    ],
  };
}
