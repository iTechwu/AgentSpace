import type { ChannelRecord } from "@dofe-agent/domain/workspace";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";

export function listStoredChannelsSync(workspaceId = DEFAULT_WORKSPACE_ID): ChannelRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      id,
      name,
      kind,
      human_member_names_json AS humanMemberNamesJson,
      human_member_count AS humanMemberCount,
      employee_names_json AS employeeNamesJson
     FROM workspace_channel
     WHERE workspace_id = ?
     ORDER BY LOWER(name) ASC, name ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map(mapStoredChannelRecord)
    .filter((channel): channel is ChannelRecord => channel !== null);
}

export function readStoredChannelSync(channelName: string, workspaceId = DEFAULT_WORKSPACE_ID): ChannelRecord | null {
  return listStoredChannelsSync(workspaceId).find((channel) => channel.name === channelName) ?? null;
}

export function createStoredChannelSync(channel: ChannelRecord, workspaceId = DEFAULT_WORKSPACE_ID): ChannelRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_channel (
      id,
      workspace_id,
      name,
      kind,
      human_member_names_json,
      human_member_count,
      employee_names_json,
      version,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    `channel-${randomLikeId()}`,
    workspaceId,
    channel.name,
    channel.kind ?? "group",
    JSON.stringify(channel.humanMemberNames ?? []),
    channel.humanMembers,
    JSON.stringify(channel.employeeNames),
    now,
    now,
  );

  return readStoredChannelSync(channel.name, workspaceId) ?? channel;
}

export function updateStoredChannelSync(channelName: string, next: ChannelRecord, workspaceId = DEFAULT_WORKSPACE_ID): ChannelRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE workspace_channel
     SET name = ?,
         kind = ?,
         human_member_names_json = ?,
         human_member_count = ?,
         employee_names_json = ?,
         version = version + 1,
         updated_at = ?
     WHERE workspace_id = ? AND name = ?`,
  ).run(
    next.name,
    next.kind ?? "group",
    JSON.stringify(next.humanMemberNames ?? []),
    next.humanMembers,
    JSON.stringify(next.employeeNames),
    now,
    workspaceId,
    channelName,
  );
  if (result.changes === 0) {
    return null;
  }
  return readStoredChannelSync(next.name, workspaceId);
}

export function deleteStoredChannelSync(channelName: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM workspace_channel
     WHERE workspace_id = ? AND name = ?`,
  ).run(workspaceId, channelName);
  return result.changes > 0;
}

export function replaceStoredChannelsSync(channels: ChannelRecord[], workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  withTransaction(db, () => {
    const nextNames = channels.map((channel) => channel.name);
    if (nextNames.length === 0) {
      db.prepare("DELETE FROM workspace_channel WHERE workspace_id = ?").run(workspaceId);
      return;
    }

    db.prepare(
      `DELETE FROM workspace_channel
       WHERE workspace_id = ?
         AND name NOT IN (${nextNames.map(() => "?").join(", ")})`,
    ).run(workspaceId, ...nextNames);
    for (const channel of channels) {
      updateStoredChannelSync(channel.name, channel, workspaceId) ?? createStoredChannelSync(channel, workspaceId);
    }
  });
}

function mapStoredChannelRecord(row: Record<string, unknown>): ChannelRecord | null {
  if (
    typeof row.name !== "string" ||
    typeof row.humanMemberCount !== "number" ||
    typeof row.humanMemberNamesJson !== "string" ||
    typeof row.employeeNamesJson !== "string"
  ) {
    return null;
  }

  return {
    name: row.name,
    kind: row.kind === "direct" ? "direct" : "group",
    humanMemberNames: parseStringArray(row.humanMemberNamesJson),
    humanMembers: row.humanMemberCount,
    employeeNames: parseStringArray(row.employeeNamesJson),
  };
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
