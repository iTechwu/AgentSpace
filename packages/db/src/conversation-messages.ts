// 会话消息独立持久化（docs/0820/session-split §2.5、§5.3）：把带 conversationId 的消息镜像到
// conversation_message 表，供按会话查询。与工作区状态 JSON 双写，不替代现有消息流。

import { DEFAULT_WORKSPACE_ID, getDatabase } from "./database.ts";

export interface ConversationMessageRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  channel?: string;
  speaker: string;
  speakerUserId?: string;
  role: string;
  summary: string;
  status: string;
  kind?: string;
  processType?: string;
  tool?: string;
  code?: string;
  dataJson: string;
  time?: string;
  createdAt: string;
}

export interface WriteConversationMessageInput {
  id: string;
  workspaceId?: string;
  conversationId: string;
  channel?: string;
  speaker: string;
  speakerUserId?: string;
  role: string;
  summary: string;
  status?: string;
  kind?: string;
  processType?: string;
  tool?: string;
  code?: string;
  data?: Record<string, string>;
  time?: string;
  now?: string;
}

export function writeConversationMessageSync(input: WriteConversationMessageInput): ConversationMessageRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  db.prepare(
    "INSERT INTO conversation_message (id, workspace_id, conversation_id, channel, speaker, speaker_user_id, role, summary, status, kind, process_type, tool, code, data_json, time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET summary = excluded.summary, status = excluded.status, kind = excluded.kind, process_type = excluded.process_type, tool = excluded.tool, code = excluded.code, data_json = excluded.data_json, time = excluded.time",
  ).run(
    input.id,
    workspaceId,
    input.conversationId,
    input.channel ?? null,
    input.speaker,
    input.speakerUserId ?? null,
    input.role,
    input.summary,
    input.status ?? "completed",
    input.kind ?? null,
    input.processType ?? null,
    input.tool ?? null,
    input.code ?? null,
    JSON.stringify(input.data ?? {}),
    input.time ?? null,
    now,
  );
  const record = readConversationMessageSync(input.id);
  if (!record) {
    throw new Error("Conversation message could not be read after write.");
  }
  return record;
}

export function readConversationMessageSync(id: string): ConversationMessageRecord | null {
  const row = getDatabase().prepare(
    "SELECT id, workspace_id AS \"workspaceId\", conversation_id AS \"conversationId\", channel, speaker, speaker_user_id AS \"speakerUserId\", role, summary, status, kind, process_type AS \"processType\", tool, code, data_json AS \"dataJson\", time, created_at AS \"createdAt\" FROM conversation_message WHERE id = ?",
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapConversationMessageRecord(row) : null;
}

export function listConversationMessagesSync(conversationId: string): ConversationMessageRecord[] {
  const rows = getDatabase().prepare(
    "SELECT id, workspace_id AS \"workspaceId\", conversation_id AS \"conversationId\", channel, speaker, speaker_user_id AS \"speakerUserId\", role, summary, status, kind, process_type AS \"processType\", tool, code, data_json AS \"dataJson\", time, created_at AS \"createdAt\" FROM conversation_message WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
  ).all(conversationId) as Array<Record<string, unknown>>;
  return rows.map(mapConversationMessageRecord).filter((row): row is ConversationMessageRecord => row !== null);
}

export function deleteConversationMessagesSync(conversationId: string): void {
  getDatabase().prepare("DELETE FROM conversation_message WHERE conversation_id = ?").run(conversationId);
}

function mapConversationMessageRecord(value: Record<string, unknown>): ConversationMessageRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.speaker !== "string" ||
    typeof value.role !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.status !== "string" ||
    typeof value.dataJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    conversationId: value.conversationId,
    channel: optionalString(value.channel),
    speaker: value.speaker,
    speakerUserId: optionalString(value.speakerUserId),
    role: value.role,
    summary: value.summary,
    status: value.status,
    kind: optionalString(value.kind),
    processType: optionalString(value.processType),
    tool: optionalString(value.tool),
    code: optionalString(value.code),
    dataJson: value.dataJson,
    time: optionalString(value.time),
    createdAt: value.createdAt,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
