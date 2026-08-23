import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getDatabase,
  recordMcpToolAuditSync,
} from "@dofe-agent/db";
import {
  claimMcpTaskSessionSync,
  listMcpConnectionActivitySync,
  validateMcpConnectionForGatewaySync,
} from "@dofe-agent/services/mcp-center";
import { McpGateway } from "../src/mcp/gateway.ts";

const workspaceId = process.env.DOFE_AGENT_LIVE_WORKSPACE_ID ?? "sso-team-c8c8d97ffcb845311387e967";
const employeeName = requiredEnv("DOFE_AGENT_LIVE_GEO_EMPLOYEE_NAME");
const serviceName = requiredEnv("DOFE_AGENT_LIVE_GEO_SERVICE_NAME");
const suffix = Date.now().toString(36);
const taskId = `task-geo-live-${suffix}`;
const attemptId = `attempt-geo-live-${suffix}`;
const conversationId = `conversation-geo-live-${suffix}`;
const db = getDatabase();

const employee = db.prepare(
  `SELECT e.id, e.name, b.runtime_id AS "runtimeId"
     FROM workspace_employee e
     JOIN employee_runtime_binding b
       ON b.workspace_id = e.workspace_id AND b.employee_id = e.id
    WHERE e.workspace_id = ? AND e.name = ?
    LIMIT 1`,
).get(workspaceId, employeeName) as { id?: string; name?: string; runtimeId?: string } | undefined;
assert.ok(employee?.id && employee.runtimeId, "The GEO employee must exist and have a Runtime binding.");

const queuedAt = new Date().toISOString();
db.prepare(
  `INSERT INTO agent_task_queue (
     id, workspace_id, agent_id, employee_id, employee_name, runtime_id,
     conversation_id, trigger_type, priority, status, input_json,
     queued_at, claimed_at, started_at, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 0, 'running', ?::jsonb, ?, ?, ?, ?, ?)`,
).run(
  taskId,
  workspaceId,
  employee.id,
  employee.id,
  employee.name,
  employee.runtimeId,
  conversationId,
  JSON.stringify({ title: "Docker GEOFlow MCP live regression", employeeName, serviceName }),
  queuedAt,
  queuedAt,
  queuedAt,
  queuedAt,
  queuedAt,
);

const grant = claimMcpTaskSessionSync({
  workspaceId,
  runtimeId: employee.runtimeId,
  taskId,
  attemptId,
});
const connection = grant.connections.find((candidate) => candidate.displayName === serviceName);
assert.ok(connection, `Ready MCP connection not found for ${serviceName}.`);

const gateway = new McpGateway(
  (audit) => {
    recordMcpToolAuditSync({
      workspaceId,
      connectionId: audit.connectionId,
      taskId: audit.taskId,
      toolName: audit.toolName,
      outcome: audit.outcome,
      latencyMs: audit.latencyMs,
      safeSummary: audit.safeSummary,
      eventId: audit.eventId,
      actorType: "agent",
      actorId: employee.id!,
      runtimeId: employee.runtimeId!,
    });
  },
  undefined,
  async ({ connectionId, toolName }) => validateMcpConnectionForGatewaySync({
    workspaceId,
    runtimeId: employee.runtimeId!,
    taskId,
    connectionId,
    toolName,
  }),
);

await gateway.start();
const session = gateway.createTaskSession({
  taskId,
  runtimeId: employee.runtimeId,
  workspaceId,
  employeeId: employee.id,
  conversationId,
  connections: [connection],
});
const client = new Client({ name: "dofe-geo-live-regression", version: "1" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(session.url)));
let flowSucceeded = false;

try {
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 5, "The employee task gateway must expose exactly the approved GEO tools.");
  assert.equal(connection.tools.length, listed.tools.length, "Gateway and grant tool counts must match.");
  const toolNames = new Map(connection.tools.map((tool, index) => [tool.name, listed.tools[index]!.name]));
  for (const required of [
    "geoflow.enterprise_knowledge.create",
    "geoflow.enterprise_knowledge.status",
    "geoflow.enterprise_knowledge.autosave",
    "geoflow.enterprise_knowledge.validate",
    "geoflow.enterprise_knowledge.publish",
  ]) {
    assert.ok(toolNames.has(required), `Task gateway did not expose ${required}.`);
  }

  const created = await callGeoTool("geoflow.enterprise_knowledge.create", {
    name: `AgentSpace GEO regression ${suffix}`,
    description: "Docker-backed AgentSpace employee MCP regression",
    content: "# 企业介绍\n星河智能提供 GEO 内容工程、企业知识治理与内容发布服务。\n\n## 产品能力\n知识采集、校验、分块与发布。",
    idempotency_key: `agentspace-geo-create-${suffix}`,
  });
  const projectId = Number(created.id);
  assert.ok(Number.isInteger(projectId) && projectId > 0, "Create must return a project id.");

  let status = await callGeoTool("geoflow.enterprise_knowledge.status", { project_id: projectId });
  const deadline = Date.now() + 120_000;
  while (["queued", "processing"].includes(String(status.status)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    status = await callGeoTool("geoflow.enterprise_knowledge.status", { project_id: projectId });
  }
  assert.equal(status.status, "reviewing", `Draft generation must reach reviewing, received ${String(status.status)}.`);

  const reviewedContent = "# 企业介绍\n星河智能面向企业提供可审计的 GEO 内容工程服务。\n\n## 核心能力\n- 企业知识治理\n- 内容生成与校验\n- 多渠道发布\n\n## 数据边界\n所有知识按租户隔离并保留发布修订记录。";
  const saved = await callGeoTool("geoflow.enterprise_knowledge.autosave", { project_id: projectId, content: reviewedContent });
  assert.equal(saved.saved, true);
  const validated = await callGeoTool("geoflow.enterprise_knowledge.validate", { project_id: projectId });
  assert.ok(Number(validated.validation_count) >= 0);
  const published = await callGeoTool("geoflow.enterprise_knowledge.publish", {
    project_id: projectId,
    confirmation: "PUBLISH",
    idempotency_key: `agentspace-geo-publish-${suffix}`,
  });
  assert.equal(published.status, "published");
  assert.ok(Number(published.knowledge_base_id) > 0);
  assert.ok(Number(published.chunk_count) > 0);

  const activity = listMcpConnectionActivitySync({ workspaceId, connectionId: connection.connectionId, limit: 100 });
  const succeededNames = new Set(activity.audits
    .filter((audit) => audit.taskId === taskId && audit.outcome === "succeeded")
    .map((audit) => audit.toolName));
  for (const required of toolNames.keys()) assert.ok(succeededNames.has(required), `Missing succeeded audit for ${required}.`);

  console.log(JSON.stringify({
    workspaceId,
    employeeName,
    serviceName,
    taskId,
    projectId,
    generationStatus: status.status,
    knowledgeBaseId: Number(published.knowledge_base_id),
    chunkCount: Number(published.chunk_count),
    auditedTools: [...succeededNames].sort(),
  }));
  flowSucceeded = true;

  async function callGeoTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gatewayName = toolNames.get(name);
    assert.ok(gatewayName, `Gateway name missing for ${name}.`);
    const result = await client.callTool({ name: gatewayName, arguments: args });
    assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
    const gatewayText = result.content.find((item) => item.type === "text")?.text;
    assert.equal(typeof gatewayText, "string", `${name} returned no text content.`);
    const remoteContent = JSON.parse(gatewayText!) as Array<{ type?: string; text?: string }>;
    const remoteText = remoteContent.find((item) => item.type === "text")?.text;
    assert.equal(typeof remoteText, "string", `${name} returned no remote text content.`);
    return JSON.parse(remoteText!) as Record<string, unknown>;
  }
} finally {
  await client.close().catch(() => undefined);
  session.revoke();
  await gateway.close();
  const finishedAt = new Date().toISOString();
  db.prepare(
    `UPDATE agent_task_queue
        SET status = ?, result_json = ?::jsonb, error_text = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
  ).run(
    flowSucceeded ? "completed" : "failed",
    JSON.stringify({ liveRegression: true, serviceName }),
    flowSucceeded ? null : "Docker GEOFlow MCP live regression failed.",
    finishedAt,
    finishedAt,
    taskId,
    workspaceId,
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
