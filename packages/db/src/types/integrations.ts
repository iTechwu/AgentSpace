// 外部集成与各类绑定（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import type { DaemonProvider } from "@dofe-agent/domain";
import type { KnowledgeAssignmentMode } from "@dofe-agent/domain/workspace";

export type ExternalIntegrationProvider = string;
export type ExternalIntegrationStatus = "active" | "disabled" | "error";
export type ExternalIntegrationTransportMode = "http_webhook" | "websocket_worker";
export type ExternalIntegrationHealthStatus = "unknown" | "healthy" | "degraded" | "error";

export interface ExternalIntegrationRecord {
  id: string;
  workspaceId: string;
  provider: ExternalIntegrationProvider;
  displayName: string;
  status: ExternalIntegrationStatus;
  transportMode: ExternalIntegrationTransportMode;
  agentId?: string;
  appId?: string;
  tenantKey?: string;
  encryptedCredentialsJson: string;
  configJson: string;
  capabilitiesJson: string;
  scopesJson: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
  lastHealthStatus?: ExternalIntegrationHealthStatus;
  lastHealthCheckedAt?: string;
  lastError?: string;
}

export type ExternalBindingStatus = "active" | "disabled" | "archived";

export interface ExternalUserBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  userId: string;
  externalUserId: string;
  externalUnionId?: string;
  externalOpenId?: string;
  externalEmail?: string;
  displayName?: string;
  status: ExternalBindingStatus;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export type ExternalChannelBindingSyncMode = "mirror" | "ingest_only" | "send_only";

export interface ExternalChannelBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelName: string;
  externalChatId: string;
  externalChatType?: string;
  externalChatName?: string;
  status: ExternalBindingStatus;
  syncMode: ExternalChannelBindingSyncMode;
  metadataJson: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
}

export type ExternalResourceBindingProviderType = string;
export type ExternalResourceBindingDofeAgentType = string;

export interface ExternalResourceBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  providerResourceType: ExternalResourceBindingProviderType;
  providerResourceToken: string;
  providerResourceUrl?: string;
  dofeAgentResourceType: ExternalResourceBindingDofeAgentType;
  dofeAgentResourceId: string;
  channelName?: string;
  displayName?: string;
  status: ExternalBindingStatus;
  permissionsJson: string;
  metadataJson: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type ExternalMessageDirection = "inbound" | "outbound";

export interface ExternalMessageMappingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelBindingId?: string;
  direction: ExternalMessageDirection;
  externalMessageId: string;
  externalThreadId?: string;
  externalSenderId?: string;
  externalEventId?: string;
  dofeAgentMessageId?: string;
  taskQueueId?: string;
  routerSessionId?: string;
  metadataJson: string;
  createdAt: string;
}

export type ExternalMessageOutboxStatus = "pending" | "locked" | "sent" | "failed" | "cancelled";

export interface ExternalMessageOutboxRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelBindingId?: string;
  targetExternalChatId: string;
  targetExternalThreadId?: string;
  dofeAgentMessageId?: string;
  payloadJson: string;
  metadataJson: string;
  status: ExternalMessageOutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export type ExternalThreadBindingStatus = "active" | "closed" | "archived";

export interface ExternalThreadBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelBindingId?: string;
  provider: ExternalIntegrationProvider;
  tenantKey?: string;
  externalChatId: string;
  externalThreadId: string;
  channelName: string;
  agentId: string;
  taskQueueId?: string;
  dofeAgentMessageId?: string;
  status: ExternalThreadBindingStatus;
  metadataJson: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ExternalDataOperationRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type ExternalDataOperationActorType = "user" | "agent" | "system";

export interface ExternalDataOperationRunRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  resourceBindingId?: string;
  operationType: string;
  providerResourceType: ExternalResourceBindingProviderType;
  providerResourceToken: string;
  actorType: ExternalDataOperationActorType;
  actorId?: string;
  status: ExternalDataOperationRunStatus;
  requestJson: string;
  resultJson: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ExternalIntegrationEventStatus = "received" | "processed" | "ignored" | "failed";

export interface ExternalIntegrationEventRecord {
  id: string;
  workspaceId: string;
  integrationId?: string;
  provider: ExternalIntegrationProvider;
  externalEventId: string;
  eventType: string;
  status: ExternalIntegrationEventStatus;
  payloadJson: string;
  errorMessage?: string;
  receivedAt: string;
  processedAt?: string;
}


export interface DaemonConnectionRecord {
  id: string;
  workspaceId: string;
  daemonKey: string;
  deviceName: string;
  status: "online" | "offline";
  metadataJson: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
}
