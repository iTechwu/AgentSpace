// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/collaboration` 子路径与根 re-export 使用。

export {
  resolveCollaborativeObjectSync,
  type CollaborativeObjectInput,
} from "./registry.ts";

export {
  listCollaborationActivitiesSync,
  recordCollaborationActivitySync,
  type CollaborationObjectFilter,
} from "./activity.ts";

export {
  createCollaborationCommentThreadSync,
  addCollaborationCommentSync,
  listCollaborationCommentThreadsSync,
} from "./comments.ts";

export {
  acceptCollaborationChangeProposalSync,
  createCollaborationChangeProposalSync,
  listCollaborationChangeProposalsSync,
  rejectCollaborationChangeProposalSync,
} from "./proposals.ts";
