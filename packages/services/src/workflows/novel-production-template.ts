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
  /** Channel the approver belongs to (required at publish time). */
  approvalChannelName?: string;
}

/**
 * Two-round convergence DAG for novel production (docs/0815/03, first step).
 *
 * The bounded convergence loop from the target flowchart is STATICALLY UNROLLED
 * into two rounds because the current engine only supports employee_task, join,
 * and approval nodes and rejects cycles. After two rounds the flow enters an
 * approval gate (over-limit -> human decision).
 */
export function buildNovelProductionWorkflowGraph(
  input: NovelProductionTemplateInput,
): WorkflowGraphDefinition {
  const coordinator = input.coordinatorEmployeeId;
  const artist = input.artistEmployeeId ?? coordinator;
  const script = input.scriptEmployeeId ?? coordinator;
  const consistency = input.consistencyEmployeeId ?? coordinator;
  const approver = input.approverEmployeeId ?? coordinator;

  const productionOutput = ["artifactDigest", "revision"];
  const productionSkillConfig = (skillId: string) => ({ requiredSkillIds: [skillId], outputFields: productionOutput });
  // P2-12: the consistency check is the quality gate — it emits a quality-report
  // summary (blockingCount + digest) per the P1-5 contract, and the static DAG
  // unrolls the pass/block routing into two rounds (block -> next round, then
  // over-limit -> approval) because the engine has no conditional node yet.
  const consistencyCheckConfig = { outputFields: ["blockingCount", "qualityReportDigest"], qualityReportSchemaVersion: 1 };

  return {
    schemaVersion: 1,
    nodes: [
      { id: "cast-baseline", type: "employee_task", employeeId: coordinator, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.characters) },
      { id: "outline", type: "employee_task", employeeId: coordinator, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.outline) },
      { id: "art-r1", type: "employee_task", employeeId: artist, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.art) },
      { id: "script-r1", type: "employee_task", employeeId: script, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.script) },
      { id: "round1-join", type: "join", config: {} },
      { id: "consistency-r1", type: "employee_task", employeeId: consistency, config: consistencyCheckConfig },
      { id: "art-r2", type: "employee_task", employeeId: artist, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.art) },
      { id: "script-r2", type: "employee_task", employeeId: script, config: productionSkillConfig(NOVEL_PRODUCTION_SKILL_IDS.script) },
      { id: "round2-join", type: "join", config: {} },
      { id: "consistency-r2", type: "employee_task", employeeId: consistency, config: consistencyCheckConfig },
      { id: "approval", type: "approval", config: { employeeId: approver, ...(input.approvalChannelName ? { channelName: input.approvalChannelName } : {}) } },
      { id: "storyboard", type: "employee_task", employeeId: coordinator, config: { requiredSkillIds: [NOVEL_PRODUCTION_SKILL_IDS.storyboard], outputFields: ["artifactDigest", "batchManifestDigest"] } },
      { id: "shot-generation", type: "employee_task", employeeId: coordinator, config: { requiredSkillIds: [NOVEL_PRODUCTION_SKILL_IDS.shotGeneration], outputFields: ["outputPackageDigest"] } },
    ],
    edges: [
      { source: "cast-baseline", target: "outline" },
      { source: "outline", target: "art-r1" },
      { source: "outline", target: "script-r1" },
      { source: "art-r1", target: "round1-join" },
      { source: "script-r1", target: "round1-join" },
      { source: "round1-join", target: "consistency-r1" },
      { source: "consistency-r1", target: "art-r2" },
      { source: "consistency-r1", target: "script-r2" },
      { source: "art-r2", target: "round2-join" },
      { source: "script-r2", target: "round2-join" },
      { source: "round2-join", target: "consistency-r2" },
      { source: "consistency-r2", target: "approval" },
      { source: "approval", target: "storyboard" },
      { source: "storyboard", target: "shot-generation" },
    ],
  };
}
