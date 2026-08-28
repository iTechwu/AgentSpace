// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/knowledge` 子路径与根 re-export 使用。

export {
  listKnowledgePagesSync,
  readKnowledgePageSync,
  createKnowledgePageSync,
  createKnowledgePageFromSharedDocumentSync,
  updateKnowledgePageSync,
  moveKnowledgePageSync,
  deleteKnowledgePageSync,
  materialToKnowledgePageSync,
} from "./knowledge.ts";

export {
  reapStuckParseTasksSync,
  submitFileParseTaskSync,
  type FileParseIntent,
  type SubmitFileParseTaskInput,
  type SubmitFileParseTaskResult,
} from "./parse-task.ts";

export {
  approveKnowledgeProposalForActorSync,
  createKnowledgeProposalFromAgentSync,
  listKnowledgeProposalsForWorkspace,
  listKnowledgeProposalsForWorkspaceSync,
  listPendingKnowledgeProposalsForApprover,
  listPendingKnowledgeProposalsForApproverSync,
  readKnowledgeProposalSync,
  rejectKnowledgeProposalForActorSync,
  type ApproveKnowledgeProposalInput,
  type CreateKnowledgeProposalFromAgentInput,
  type KnowledgeProposalApprovalResult,
  type KnowledgeProposalOperation,
  type RejectKnowledgeProposalInput,
} from "../knowledge-proposals/knowledge-proposals.ts";

export {
  listKnowledgeAssignmentPoliciesSync,
  listKnowledgeAssignmentsSync,
  listKnowledgeAssignmentsByPageIdSync,
  listKnowledgeAssignmentsByEmployeeSync,
  listEmployeeKnowledgePageIdsSync,
  listEmployeeKnowledgePagesSync,
  setKnowledgePageAssignmentModeSync,
  setKnowledgePageAssignedEmployeesSync,
  setEmployeeKnowledgePageIdsSync,
  deleteKnowledgeAssignmentsForPageSync,
  deleteKnowledgeAssignmentsForEmployeeSync,
  type AgentKnowledgePageAssignment,
  type KnowledgeAssignmentPolicy,
} from "./assignments.ts";
