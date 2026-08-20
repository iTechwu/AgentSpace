import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach, after } from "node:test";
import { getDatabase, listConversationsForEmployeeSync, resolveStoredEmployeeIdSync } from "@dofe-agent/db";
import {
  createEmployeeSync,
  initializeOrganizationSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "../index.ts";
import { backfillLegacyConversationsSync, buildConversationSummary } from "./conversations.ts";

const originalCwd = process.cwd();
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-conversations-service-"));

before(() => {
  process.env.NODE_ENV = "test";
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM conversation_provider_session");
  db.exec("DELETE FROM conversation_execution_lane");
  db.exec("DELETE FROM conversation_participant");
  db.exec("DELETE FROM conversation");
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });
  createEmployeeSync({
    name: "Atlas",
    role: "Planner",
    remarkName: "Atlas",
    summary: "Planner",
    fit: "Atlas",
    origin: "seed",
  });
  const state = readWorkspaceStateSync();
  state.channels = [
    ...state.channels,
    { name: "atlas-direct", kind: "direct", humanMemberNames: ["techwu"], humanMembers: 1, employeeNames: ["Atlas"] },
  ];
  state.messages = [
    { id: "m1", channel: "atlas-direct", speaker: "techwu", role: "human", time: "10:00", summary: "帮我优化视频脚本", status: "completed" },
    { id: "m2", channel: "atlas-direct", speaker: "Atlas", role: "agent", time: "10:01", summary: "已完成优化", status: "completed" },
  ];
  writeWorkspaceStateSync(state);
});

after(() => {
  process.chdir(originalCwd);
});

test("buildConversationSummary 去掉 Markdown 标题/列表/换行并截断到 60 字", () => {
  assert.equal(buildConversationSummary("## 优化视频脚本\n\n下面是详细步骤"), "优化视频脚本");
  assert.equal(buildConversationSummary("- 排查模型流式响应中断"), "排查模型流式响应中断");
  assert.equal(buildConversationSummary("   "), "新会话");
  assert.ok(buildConversationSummary("长".repeat(100)).length <= 60);
});

test("backfillLegacyConversationsSync 为既有消息建 legacy Conversation 并打标（幂等）", () => {
  const first = backfillLegacyConversationsSync();
  assert.equal(first.conversationsCreated, 1);
  assert.equal(first.messagesTagged, 2);

  const employeeId = resolveStoredEmployeeIdSync("Atlas", "default");
  assert.ok(employeeId);
  const conversations = listConversationsForEmployeeSync({ employeeId: employeeId! });
  assert.equal(conversations.length, 1, "应产生一个 legacy Conversation");
  assert.ok(conversations[0]!.id.startsWith("conversation-legacy-"));
  assert.equal(conversations[0]!.status, "active");

  const state = readWorkspaceStateSync();
  const tagged = state.messages.filter((message) => message.channel === "atlas-direct" && message.conversationId);
  assert.equal(tagged.length, 2, "既有消息应被标上 conversationId");

  // 幂等：重复回填不再创建新会话、不再重复打标。
  const second = backfillLegacyConversationsSync();
  assert.equal(second.conversationsCreated, 0);
  assert.equal(second.messagesTagged, 0);
});
