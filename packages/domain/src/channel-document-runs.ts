export type ChannelDocumentRunMode = "parallel" | "sequential";
export type ChannelDocumentRunStatus = "pending" | "running" | "completed" | "completed_with_warning" | "failed";
export type ChannelDocumentRunStepStatus =
  | "pending"
  | "ready"
  | "queued"
  | "running"
  | "completed"
  | "completed_with_warning"
  | "failed"
  | "blocked";
export type ChannelDocumentRunHandoffKind = "document" | "attachment" | "message";

export interface ChannelDocumentRun {
  id: string;
  channelName: string;
  sourceMessageId: string;
  sourceSummary: string;
  mode: ChannelDocumentRunMode;
  status: ChannelDocumentRunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDocumentRunStep {
  id: string;
  runId: string;
  agentId: string;
  agentLabel: string;
  instruction: string;
  dependsOnStepIds: string[];
  handoffKind: ChannelDocumentRunHandoffKind;
  status: ChannelDocumentRunStepStatus;
  queuedTaskId?: string;
  documentId?: string;
  documentVersionId?: string;
  lastError?: string;
  lastWarning?: string;
  createdAt: string;
  updatedAt: string;
}
