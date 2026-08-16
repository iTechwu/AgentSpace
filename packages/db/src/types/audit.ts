// 审计日志 / Daemon 注册 / API Token（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import {
  type DaemonConnectionRecord,
} from "./integrations.ts";
import {
  type AgentRuntimeRecord,
} from "./runtime.ts";

export type AuditLogSource =
  | "workspace_snapshot_ledger"
  | "runtime_credential"
  | "runtime_lifecycle"
  | "runtime_model"
  | "platform_admin"
  | "skill_lifecycle";

export interface AuditLogRecord {
  id: string;
  workspaceId: string;
  title: string;
  note: string;
  code?: string;
  dataJson: string;
  source: AuditLogSource;
  sourceIndex: number;
  createdAt: string;
}

export interface RegisteredDaemonSnapshot {
  daemon: DaemonConnectionRecord;
  runtimes: AgentRuntimeRecord[];
}

export interface DaemonApiTokenRecord {
  id: string;
  workspaceId: string;
  daemonConnectionId?: string;
  label: string;
  tokenHash: string;
  purpose: DaemonApiTokenPurpose;
  status: "active" | "revoked";
  createdBy: string;
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export type DaemonApiTokenPurpose = "general" | "managed_node_bootstrap";
