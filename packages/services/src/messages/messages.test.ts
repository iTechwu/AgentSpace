import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

// 部分用例依赖 managed runtime 夹具（bindRuntimeForAgent / bindAtlasRuntime）；
// 本仓库默认环境无该夹具，需 MANAGED_RUNTIME_AVAILABLE=1 才跑，否则以
// { skip: !runtime } 选项降级为 skip，避免 pnpm test 在普通工作站必败。
const RUNTIME_AVAILABLE = process.env.MANAGED_RUNTIME_AVAILABLE === "1";
const runtimeSkip = { skip: !RUNTIME_AVAILABLE } as const;
import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import {
  createUserSync,
  createWorkspaceMembershipSync,
  DEFAULT_WORKSPACE_ID,
  listQueuedTasksSync,
  registerDaemonRuntimesSync,
} from "@dofe-agent/db";
import {
  AUTO_CONTINUATION_REPLY,
  acknowledgeMessageSync,
  bindEmployeeRuntimeSync,
  completeAgentChannelReplySync,
  continueAutoContinuationAfterTaskSync,
  createRuntimeToolApprovalRequestSync,
  createEmployeeSync,
  createTaskSync,
  formatConversationFailureSummary,
  formatTaskFailureSummary,
  initializeOrganizationSync,
  pinMessageSync,
  persistWorkspaceAttachmentFromBytesSync,
  postMessageSync,
  readWorkspaceStateSync,
  readWorkspaceAttachmentBytesSync,
  recordAgentChannelProgressSync,
  replacePendingChannelMessageSync,
  reviewApprovalSync,
  resetWorkspaceStateSync,
  sendContactMessageForHumanWithAttachmentsSync,
  sendChannelHumanMessageSync,
  sendContactMessageSync,
  sendHumanDirectMessageSync,
  setAttachmentStorageClientForTests,
  setEmployeeChannelMemberAccessSync,
  stopAutoContinuationSync,
  subscribeWorkspaceRealtimeEvents,
  unpinMessageSync,
  updatePendingAgentChannelReplySync,
  writeWorkspaceStateSync,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";
import { buildChannelHistorySnapshot, toTaskPayloadAttachment } from "../shared/messaging.ts";

const originalCwd = process.cwd();
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-message-attachments-"));
const testTos = createTestTosAttachmentStorage();

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTos.client);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
});

test.after(() => {
  setAttachmentStorageClientForTests(undefined);
});

function seedWorkspace(): void {
  testTos.clear();
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
    summary: "Trip planner",
    fit: "Atlas",
    origin: "seed",
  });

  const state = readWorkspaceStateSync();
  state.activeEmployees = state.activeEmployees.map((employee) =>
    employee.name === "Atlas"
      ? {
          ...employee,
          channels: ["tour visit"],
        }
      : employee,
  );
  state.channels = state.channels.map((channel) =>
    channel.name === "tour visit"
      ? {
          ...channel,
          employeeNames: ["Atlas"],
        }
      : channel,
  );
  writeWorkspaceStateSync(state);
}

function createAttachment(id: string, fileName: string, mediaType: string): MessageAttachment {
  const stored = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("attachment-content", "utf8"),
    fileName,
    mediaType,
  });
  return {
    ...stored,
    id,
  };
}

function bindAtlasRuntime(): string {
  return bindRuntimeForAgent("Atlas");
}

function bindRuntimeForAgent(agentName: string): string {
  const runtime = registerDaemonRuntimesSync({
    daemonKey: `test-auto-${agentName}-${Math.random().toString(36).slice(2)}`,
    deviceName: "Test machine",
    runtimes: [{ provider: "codex", name: `${agentName} Runtime` }],
  }).runtimes[0];
  assert.ok(runtime);
  bindEmployeeRuntimeSync(agentName, runtime.id);
  return runtime.id;
}

function addAgentToTourVisit(agentName: string, input?: { ownerUserId?: string }): void {
  createEmployeeSync({
    name: agentName,
    role: "Collaborator",
    remarkName: agentName,
    summary: `${agentName} helper`,
    fit: agentName,
    origin: "seed",
    ownerUserId: input?.ownerUserId,
    channelMemberAccess: "enabled",
  });
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    activeEmployees: state.activeEmployees.map((employee) =>
      employee.name === agentName
        ? {
            ...employee,
            channels: ["tour visit"],
          }
        : employee,
    ),
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            employeeNames: Array.from(new Set([...channel.employeeNames, agentName])),
          }
        : channel,
    ),
  });
}

function addHumanToTourVisit(name: string): void {
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: state.humanMembers.some((member) => member.name === name)
      ? state.humanMembers
      : [...state.humanMembers, { name, role: "Operator" }],
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: Array.from(new Set([...(channel.humanMemberNames ?? ["techwu"]), name])),
            humanMembers: Math.max(channel.humanMembers, Array.from(new Set([...(channel.humanMemberNames ?? ["techwu"]), name])).length),
          }
        : channel,
    ),
  });
}

test("failure summaries hide provider diagnostics in user-visible chat text", () => {
  const rootClaudeError = 'claude exited with code 1. (code=provider.runtime_generic_failure; exitCode=1; timedOut=false; events=none; resultEvent=false; textEvent=false; toolEvent=false; parseErrors=0; nonJsonLines=0; stderrTail="--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons")';
  const directSummary = formatConversationFailureSummary({
    agentName: "测试aget",
    channelName: "direct-mou319fy-bkuner",
    errorText: rootClaudeError,
    isDirectConversation: true,
  });

  assert.match(directSummary, /在私聊 direct-mou319fy-bkuner 中执行失败/);
  assert.match(directSummary, /root\/sudo 环境不兼容/);
  assert.doesNotMatch(directSummary, /stderrTail|exitCode|events=none|dangerously-skip-permissions/);

  const approvalSummary = formatTaskFailureSummary({
    title: "读取 test 表格",
    errorText: 'This command requires approval: acme-tool records get --format json --params "{}"',
  });

  assert.match(approvalSummary, /当前会话无法交互审批/);
  assert.doesNotMatch(approvalSummary, /acme-tool records/);

  const codexResumeSummary = formatTaskFailureSummary({
    title: "继续会话",
    errorText: "Codex CLI exited with code 2. (stderrTail=\"error: unexpected argument '--sandbox' found\")",
  });
  assert.match(codexResumeSummary, /不支持当前会话续接参数/);
  assert.doesNotMatch(codexResumeSummary, /exited with code 2|stderrTail/);

  const codexStreamingSummary = formatTaskFailureSummary({
    title: "生成晨间简报",
    errorText: "Codex CLI exited with code 1. Model metadata for deepseek-v4-pro not found. Codex stream disconnected prior to response.completed; turn.failed after retry 5/5.",
  });
  assert.match(codexStreamingSummary, /流式响应在完成前中断/);
  assert.doesNotMatch(codexStreamingSummary, /执行配置不完整/);
  assert.doesNotMatch(codexStreamingSummary, /Codex CLI exited|deepseek-v4-pro|retry 5\/5/);

  const approvalTimeoutSummary = formatTaskFailureSummary({
    title: "读取资料",
    errorText: "Runtime approval timed out after 15 minutes.",
  });
  assert.match(approvalTimeoutSummary, /等待你的工具审批已超时/);

  const upstream500Summary = formatConversationFailureSummary({
    agentName: "Codex E2E 员工 0801",
    channelName: "direct-ms9ratd0-mgwz9n",
    errorText: "500 Internal Server Error",
    isDirectConversation: true,
  });
  assert.match(upstream500Summary, /上游模型服务暂时不可用/);
  assert.doesNotMatch(upstream500Summary, /500 Internal Server Error/);

  const missingRuntimeImageSummary = formatConversationFailureSummary({
    agentName: "Aim",
    channelName: "direct-aim",
    errorText: [
      'Codex CLI exited with code 125. (code=provider.runtime_generic_failure; exitCode=125; stderrTail="docker: Error response from daemon: No such image: dofe/agent-runtime-codex:latest")',
      "provider diagnostic: code=provider.runtime_generic_failure; category=runtime; provider=codex; raw=docker: Error response from daemon: No such image: dofe/agent-runtime-codex:latest",
    ].join("\n"),
    isDirectConversation: true,
  });
  assert.match(missingRuntimeImageSummary, /执行环境尚未就绪/);
  assert.match(missingRuntimeImageSummary, /联系管理员/);
  assert.doesNotMatch(missingRuntimeImageSummary, /Codex CLI|provider diagnostic|No such image|dofe\/agent-runtime/);

  const upstreamProviderAuthSummary = formatTaskFailureSummary({
    title: "生成晨间简报",
    errorText: "Codex CLI exited with code 1. (code=provider.model_unavailable; raw=unexpected status 401 Unauthorized: 该令牌状态不可用)",
  });
  assert.match(upstreamProviderAuthSummary, /供应商凭证不可用/);
  assert.match(upstreamProviderAuthSummary, /切换模型/);
});

test("sendContactMessageSync creates a direct conversation channel", () => {
  seedWorkspace();
  sendContactMessageSync("Atlas", "请查看附件。");

  const state = readWorkspaceStateSync();
  const directChannel = state.channels.find((channel) => channel.kind === "direct" && channel.employeeNames.includes("Atlas"));
  assert.ok(directChannel);
  const directMessages = state.messages.filter((message) => message.channel === directChannel?.name);
  assert.equal(directMessages.some((message) => message.summary === "请查看附件。"), true);
});

test("sendContactMessageForHumanWithAttachmentsSync backfills missing legacy human members", () => {
  seedWorkspace();
  sendContactMessageForHumanWithAttachmentsSync("Mina", "Atlas", "请查看附件。");

  const state = readWorkspaceStateSync();
  assert.equal(state.humanMembers.some((member) => member.name === "Mina"), true);
  const directChannel = state.channels.find(
    (channel) => channel.kind === "direct" && channel.humanMemberNames?.includes("Mina"),
  );
  assert.ok(directChannel);
  assert.equal(directChannel.employeeNames.includes("Atlas"), true);
});

test("sendHumanDirectMessageSync creates a human direct channel without agent queue messages", () => {
  resetWorkspaceStateSync();
  const suffix = Math.random().toString(36).slice(2, 8);
  const techwu = createUserSync({
    displayName: `techwu ${suffix}`,
    primaryEmail: `techwu-${suffix}@example.com`,
  });
  const mina = createUserSync({
    displayName: `Mina ${suffix}`,
    primaryEmail: `mina-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: techwu.id,
    role: "owner",
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: mina.id,
    role: "member",
  });

  sendHumanDirectMessageSync({
    actorUserId: techwu.id,
    targetUserId: mina.id,
    content: "hello Mina",
  });
  sendHumanDirectMessageSync({
    actorUserId: mina.id,
    targetUserId: techwu.id,
    content: "hello techwu",
  });

  const state = readWorkspaceStateSync();
  const directChannels = state.channels.filter((channel) => channel.kind === "direct" && channel.employeeNames.length === 0);
  assert.equal(directChannels.length, 1);
  assert.deepEqual(new Set(directChannels[0]?.humanMemberNames), new Set([techwu.displayName, mina.displayName]));

  const directMessages = state.messages.filter((message) => message.channel === directChannels[0]?.name);
  assert.deepEqual(directMessages.map((message) => message.summary), ["hello techwu", "hello Mina"]);
  assert.equal(directMessages.some((message) => message.code === "agent.pending"), false);
  assert.equal(state.tasks.some((task) => task.channel === directChannels[0]?.name), false);
});

test("sendChannelHumanMessageSync keeps mentions and attachments on the same source message", () => {
  seedWorkspace();
  const attachment = createAttachment("att-human", "briefs/trip-plan.md", "text/markdown");

  sendChannelHumanMessageSync("tour visit", "techwu", "@Atlas 请结合附件继续完善这版行程。", [attachment]);

  const humanMessage = readWorkspaceStateSync().messages.find((message) => message.role === "human");
  assert.equal(humanMessage?.attachments?.[0]?.id, attachment.id);
  assert.equal(humanMessage?.mentions?.[0]?.token, "Atlas");
});

test("toTaskPayloadAttachment preserves full storage location fields", () => {
  seedWorkspace();
  const attachment = createAttachment("att-human", "briefs/trip-plan.md", "text/markdown");

  const payload = toTaskPayloadAttachment(attachment);

  assert.equal(payload.fileName, attachment.fileName);
  assert.equal(payload.storedPath, attachment.storedPath);
  assert.equal(payload.storageProvider, attachment.storageProvider);
  assert.equal(payload.storageBucket, attachment.storageBucket);
  assert.equal(payload.storageKey, attachment.storageKey);
});

test("readWorkspaceAttachmentBytesSync recovers the object key from storedPath for legacy payloads", () => {
  seedWorkspace();
  const attachment = createAttachment("att-legacy", "briefs/legacy-plan.md", "text/markdown");

  const legacyPayload: MessageAttachment = { ...attachment, storageKey: undefined };
  const bytes = readWorkspaceAttachmentBytesSync(legacyPayload);

  assert.equal(Buffer.from(bytes).toString("utf8"), "attachment-content");
});

test("sendChannelHumanMessageSync passes full attachment storage fields into the queued task payload", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();
  const attachment = createAttachment("att-human", "briefs/trip-plan.md", "text/markdown");

  sendChannelHumanMessageSync("tour visit", "techwu", "@Atlas 请结合附件继续完善这版行程。", [attachment]);

  const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas");
  assert.ok(queued);
  const payload = JSON.parse(queued.inputJson) as {
    attachments?: Array<{
      fileName?: string;
      storedPath?: string;
      storageProvider?: string;
      storageBucket?: string;
      storageKey?: string;
    }>;
  };
  assert.equal(payload.attachments?.length, 1);
  assert.equal(payload.attachments?.[0]?.storedPath, attachment.storedPath);
  assert.equal(payload.attachments?.[0]?.storageKey, attachment.storageKey);
  assert.equal(payload.attachments?.[0]?.storageBucket, attachment.storageBucket);
});

test("sendChannelHumanMessageSync stores untrusted external source metadata on the human message", () => {
  seedWorkspace();

  sendChannelHumanMessageSync(
    "tour visit",
    "techwu",
    "来自飞书的一条普通消息",
    undefined,
    undefined,
    DEFAULT_WORKSPACE_ID,
    undefined,
    {
      provider: "feishu",
      providerLabel: "Feishu/Lark",
      externalEventId: "evt-1",
      externalMessageId: "om-1",
      externalChatId: "oc-general",
      trust: "untrusted_user_message",
    },
  );

  const humanMessage = readWorkspaceStateSync(DEFAULT_WORKSPACE_ID).messages.find((message) =>
    message.role === "human" &&
    message.summary === "来自飞书的一条普通消息"
  );
  assert.deepEqual(humanMessage?.data, {
    external_provider: "feishu",
    external_provider_label: "Feishu/Lark",
    external_event_id: "evt-1",
    external_message_id: "om-1",
    external_chat_id: "oc-general",
    external_trust: "untrusted_user_message",
    workspace_data_policy_decision: "allow",
    workspace_data_policy_reason: "workspace_data.external_untrusted_user_message_allowed",
    workspace_data_classification: "external_untrusted_user_content",
    workspace_data_store: "true",
    workspace_data_search: "true",
    workspace_data_agent_context: "true",
  });
});

test("buildChannelHistorySnapshot can isolate history from a new conversation message", () => {
  seedWorkspace();
  sendChannelHumanMessageSync("tour visit", "techwu", "旧会话内容");
  sendChannelHumanMessageSync("tour visit", "techwu", "新会话内容");
  const state = readWorkspaceStateSync();
  const newMessage = state.messages.find((message) => message.summary === "新会话内容");
  assert.ok(newMessage);

  const history = buildChannelHistorySnapshot(state, "tour visit", newMessage.id);
  assert.deepEqual(history.map((message) => message.summary), ["新会话内容"]);
});

test("sendChannelHumanMessageSync stores the requester user id and publishes realtime message events", () => {
  seedWorkspace();
  const suffix = Math.random().toString(36).slice(2, 8);
  const requester = createUserSync({
    displayName: `techwu ${suffix}`,
    primaryEmail: `requester-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: requester.id,
    role: "member",
  });
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [{ name: requester.displayName, role: "Founder" }],
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: [requester.displayName],
            humanMembers: 1,
          }
        : channel,
    ),
  });
  const events: Array<{ type: string; channelName: string; messageId?: string }> = [];
  const unsubscribe = subscribeWorkspaceRealtimeEvents(DEFAULT_WORKSPACE_ID, (event) => events.push(event));

  sendChannelHumanMessageSync(
    "tour visit",
    requester.displayName,
    "普通消息",
    undefined,
    undefined,
    DEFAULT_WORKSPACE_ID,
    requester.id,
  );
  unsubscribe();

  const humanMessage = readWorkspaceStateSync().messages.find((message) => message.summary === "普通消息");
  assert.equal(humanMessage?.speakerUserId, requester.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "channel.message.created");
  assert.equal(events[0]?.channelName, "tour visit");
  assert.equal(events[0]?.messageId, humanMessage?.id);
});

test("sendChannelHumanMessageSync accepts human mentions without dispatching agent work", () => {
  seedWorkspace();
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: "Mina", role: "Operator" },
    ],
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: ["techwu", "Mina"],
            humanMembers: 2,
          }
        : channel,
    ),
  });

  sendChannelHumanMessageSync("tour visit", "techwu", "@Mina 看下这个安排");

  const humanMessage = readWorkspaceStateSync().messages.find((message) => message.role === "human");
  assert.equal(humanMessage?.mentions?.[0]?.mentionType, "human");
  assert.equal(humanMessage?.mentions?.[0]?.token, "Mina");
  assert.equal(listQueuedTasksSync().length, 0);
});

test("completeAgentChannelReplySync stores human mentions from agent output without dispatching work", () => {
  seedWorkspace();
  addHumanToTourVisit("Mina");

  const result = completeAgentChannelReplySync({
    channel: "tour visit",
    speaker: "Atlas",
    summary: "@Mina 这版数据口径需要你确认一下。",
    sourceTaskQueueId: "queue-source",
  });

  assert.equal(result.warnings.length, 0);
  const message = readWorkspaceStateSync().messages.find((item) => item.id === result.message.id);
  assert.equal(message?.mentions?.[0]?.mentionType, "human");
  assert.equal(message?.mentions?.[0]?.token, "Mina");
  assert.equal(listQueuedTasksSync().length, 0);
});

test("completeAgentChannelReplySync dispatches mentioned agents and records source metadata", runtimeSkip, () => {
  seedWorkspace();
  addHumanToTourVisit("Mina");
  addAgentToTourVisit("Nova");
  bindRuntimeForAgent("Nova");

  const result = completeAgentChannelReplySync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    speaker: "Atlas",
    summary: "@Mina 请确认预算口径。@Nova 你先根据当前口径生成草案。",
    sourceTaskQueueId: "queue-atlas",
    requestedByDisplayName: "techwu",
    mentionRootMessageId: "message-root",
  });

  assert.deepEqual(result.dispatchedAgentIds, ["Nova"]);
  const agentMessage = readWorkspaceStateSync().messages.find((item) => item.id === result.message.id);
  assert.equal(agentMessage?.mentions?.some((mention) => mention.mentionType === "human" && mention.token === "Mina"), true);
  assert.equal(agentMessage?.mentions?.some((mention) => mention.mentionType === "agent" && mention.token === "Nova"), true);

  const queued = listQueuedTasksSync().find((task) => task.agentId === "Nova");
  assert.ok(queued);
  assert.equal(queued.triggerType, "mention_chat");
  const payload = JSON.parse(queued.inputJson) as {
    mentionSource?: string;
    initiatorAgentId?: string;
    sourceMessageId?: string;
    sourceTaskQueueId?: string;
    mentionCascadeDepth?: number;
    mentionRootMessageId?: string;
    channelMessage?: string;
  };
  assert.equal(payload.mentionSource, "agent_output");
  assert.equal(payload.initiatorAgentId, "Atlas");
  assert.equal(payload.sourceMessageId, result.message.id);
  assert.equal(payload.sourceTaskQueueId, "queue-atlas");
  assert.equal(payload.mentionCascadeDepth, 1);
  assert.equal(payload.mentionRootMessageId, "message-root");
  assert.equal(payload.channelMessage, "@Mina 请确认预算口径。@Nova 你先根据当前口径生成草案。");
  assert.equal(readWorkspaceStateSync().messages.some((message) => message.speaker === "Nova" && message.status === "pending"), true);
});

test("completeAgentChannelReplySync is idempotent for the same task output", runtimeSkip, () => {
  seedWorkspace();
  addAgentToTourVisit("Nova");
  bindRuntimeForAgent("Nova");

  const first = completeAgentChannelReplySync({
    channel: "tour visit",
    speaker: "Atlas",
    summary: "@Nova 请生成草案。",
    sourceTaskQueueId: "queue-idempotent",
  });
  const second = completeAgentChannelReplySync({
    channel: "tour visit",
    speaker: "Atlas",
    summary: "@Nova 请生成草案。",
    sourceTaskQueueId: "queue-idempotent",
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.message.id, first.message.id);
  assert.equal(
    readWorkspaceStateSync().messages.filter((message) =>
      message.data?.source_task_queue_id === "queue-idempotent" &&
      message.role === "agent" &&
      message.status === "completed",
    ).length,
    1,
  );
  assert.equal(listQueuedTasksSync().filter((task) => task.agentId === "Nova").length, 1);
});

test("completeAgentChannelReplySync keeps bad mentions non-fatal and writes warnings", () => {
  seedWorkspace();
  addAgentToTourVisit("Nova");

  const result = completeAgentChannelReplySync({
    channel: "tour visit",
    speaker: "Atlas",
    summary: "@Ghost 看一下。@Nova 继续。",
    sourceTaskQueueId: "queue-atlas",
  });

  assert.equal(result.queuedTaskIds.length, 0);
  assert.equal(result.warnings.some((warning) => warning.includes("@Ghost")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("@Nova")), true);
  const state = readWorkspaceStateSync();
  const agentMessage = state.messages.find((item) => item.id === result.message.id);
  assert.equal(agentMessage?.summary, "@Ghost 看一下。@Nova 继续。");
  assert.equal(agentMessage?.mentions?.some((mention) => mention.mentionType === "agent" && mention.token === "Nova"), true);
  assert.equal(state.ledger.some((item) => item.code === "agent_output_mentions.warning"), true);
});

test("completeAgentChannelReplySync does not dispatch self mentions or duplicate target mentions", runtimeSkip, () => {
  seedWorkspace();
  addAgentToTourVisit("Nova");
  bindRuntimeForAgent("Nova");

  const result = completeAgentChannelReplySync({
    channel: "tour visit",
    speaker: "Atlas",
    summary: "@Atlas 我自己继续记录。@Nova 你接一下。@Nova 再提醒一次。",
    sourceTaskQueueId: "queue-atlas",
  });

  assert.equal(result.dispatchedAgentIds.length, 1);
  assert.equal(result.dispatchedAgentIds[0], "Nova");
  assert.equal(result.warnings.some((warning) => warning.includes("self-mentions")), true);
  assert.equal(listQueuedTasksSync().filter((task) => task.agentId === "Nova").length, 1);
});

test("completeAgentChannelReplySync blocks cascade depth over the limit", runtimeSkip, () => {
  seedWorkspace();
  addAgentToTourVisit("Nova");
  bindRuntimeForAgent("Nova");

  const result = completeAgentChannelReplySync({
    channel: "tour visit",
    speaker: "Atlas",
    summary: "@Nova 继续。",
    sourceTaskQueueId: "queue-atlas",
    mentionCascadeDepth: 2,
    mentionRootMessageId: "message-root",
  });

  assert.equal(result.queuedTaskIds.length, 0);
  assert.equal(result.warnings.some((warning) => warning.includes("cascade depth")), true);
  assert.equal(listQueuedTasksSync().length, 0);
});

test("completeAgentChannelReplySync dispatches at most three agents from one reply", runtimeSkip, () => {
  seedWorkspace();
  for (const agentName of ["Nova", "Vega", "Orion", "Lyra"]) {
    addAgentToTourVisit(agentName);
    bindRuntimeForAgent(agentName);
  }

  const result = completeAgentChannelReplySync({
    channel: "tour visit",
    speaker: "Atlas",
    summary: "@Nova 先处理。@Vega 复核。@Orion 出摘要。@Lyra 准备下一版。",
    sourceTaskQueueId: "queue-atlas",
  });

  assert.equal(result.queuedTaskIds.length, 3);
  assert.equal(listQueuedTasksSync().filter((task) => task.triggerType === "mention_chat").length, 3);
  assert.equal(result.warnings.some((warning) => warning.includes("at most 3")), true);
});

test("sendChannelHumanMessageSync starts auto continuation for continuous work directives", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();

  sendChannelHumanMessageSync("tour visit", "techwu", "@Atlas，从现在起连续工作12h");

  const queued = listQueuedTasksSync().filter((task) => task.agentId === "Atlas");
  assert.equal(queued.length, 1);
  const payload = JSON.parse(queued[0]!.inputJson) as {
    autoContinuation?: {
      status: string;
      startedAt: string;
      until: string;
      instruction: string;
    };
  };
  assert.equal(payload.autoContinuation?.status, "active");
  assert.equal(payload.autoContinuation?.instruction, AUTO_CONTINUATION_REPLY);
  assert.equal(
    Date.parse(payload.autoContinuation!.until) - Date.parse(payload.autoContinuation!.startedAt),
    12 * 60 * 60 * 1000,
  );

  const executionWorkspace = readWorkspaceStateSync().conversationExecutionWorkspaces?.[0];
  assert.equal(executionWorkspace?.autoContinuation?.status, "active");
  assert.equal(executionWorkspace?.autoContinuation?.until, payload.autoContinuation?.until);
  assert.equal(
    readWorkspaceStateSync().messages.some((message) =>
      message.code === "auto_continuation.started_notice" &&
      message.data?.agent_name === "Atlas" &&
      message.data?.until === payload.autoContinuation?.until,
    ),
    true,
  );
});

test("sendChannelHumanMessageSync starts /new without the previous session or history", runtimeSkip, () => {
  seedWorkspace();
  sendChannelHumanMessageSync("tour visit", "techwu", "旧会话内容");
  const state = readWorkspaceStateSync();
  state.conversationExecutionWorkspaces = [{
    conversationKey: "group:tour visit:Atlas",
    conversationKind: "group",
    channelName: "tour visit",
    agentId: "Atlas",
    sessionId: "session-old",
    workDir: "/tmp/tour-visit",
    updatedAt: new Date().toISOString(),
  }];
  writeWorkspaceStateSync(state);
  bindAtlasRuntime();

  sendChannelHumanMessageSync(
    "tour visit",
    "techwu",
    "@Atlas 新会话内容",
    undefined,
    undefined,
    DEFAULT_WORKSPACE_ID,
    undefined,
    undefined,
    { startNewConversation: true },
  );

  const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas");
  assert.ok(queued);
  const payload = JSON.parse(queued.inputJson) as {
    channelSessionId?: string;
    channelHistoryPath?: string;
    channelHistory: Array<{ summary: string }>;
  };
  assert.equal(payload.channelSessionId, undefined);
  assert.equal(payload.channelHistoryPath, undefined);
  assert.deepEqual(payload.channelHistory.map((message) => message.summary), ["@Atlas 新会话内容"]);
  assert.equal(readWorkspaceStateSync().conversationExecutionWorkspaces?.[0]?.sessionId, undefined);
});

test("sendContactMessageForHumanWithAttachmentsSync starts /new without the previous session or history", runtimeSkip, () => {
  seedWorkspace();
  sendContactMessageForHumanWithAttachmentsSync("techwu", "Atlas", "旧私聊内容");
  const state = readWorkspaceStateSync();
  const directChannel = state.channels.find((channel) =>
    channel.kind === "direct" && channel.employeeNames.includes("Atlas")
  );
  assert.ok(directChannel);
  state.conversationExecutionWorkspaces = [{
    conversationKey: `direct:${directChannel.name}:Atlas`,
    conversationKind: "direct",
    channelName: directChannel.name,
    agentId: "Atlas",
    contactId: "Atlas",
    humanMemberName: "techwu",
    sessionId: "session-old",
    workDir: "/tmp/direct-atlas",
    updatedAt: new Date().toISOString(),
  }];
  writeWorkspaceStateSync(state);
  bindAtlasRuntime();

  sendContactMessageForHumanWithAttachmentsSync(
    "techwu",
    "Atlas",
    "新私聊内容",
    undefined,
    DEFAULT_WORKSPACE_ID,
    undefined,
    undefined,
    { startNewConversation: true },
  );

  const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas");
  assert.ok(queued);
  const payload = JSON.parse(queued.inputJson) as {
    channelSessionId?: string;
    channelHistoryPath?: string;
    channelHistory: Array<{ summary: string }>;
  };
  assert.equal(payload.channelSessionId, undefined);
  assert.equal(payload.channelHistoryPath, undefined);
  assert.deepEqual(payload.channelHistory.map((message) => message.summary), ["新私聊内容"]);
  const executionWorkspace = readWorkspaceStateSync().conversationExecutionWorkspaces?.find((workspace) =>
    workspace.conversationKey === `direct:${directChannel.name}:Atlas`
  );
  assert.equal(executionWorkspace?.sessionId, undefined);
});

test("sendChannelHumanMessageSync lets channel members mention enabled workspace agents in that channel", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();
  const suffix = Math.random().toString(36).slice(2, 8);
  const mina = createUserSync({
    displayName: `Mina ${suffix}`,
    primaryEmail: `mina-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: mina.id,
    role: "member",
  });
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: mina.displayName, role: "Member" },
    ],
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: ["techwu", mina.displayName],
            humanMembers: 2,
          }
        : channel,
    ),
  });

  sendChannelHumanMessageSync(
    "tour visit",
    mina.displayName,
    "@Atlas 帮我整理一下重点",
    undefined,
    undefined,
    DEFAULT_WORKSPACE_ID,
    mina.id,
  );

  const queued = listQueuedTasksSync().filter((task) => task.agentId === "Atlas");
  assert.equal(queued.length, 1);
  const humanMessage = readWorkspaceStateSync().messages.find((message) => message.speaker === mina.displayName);
  assert.equal(humanMessage?.mentions?.[0]?.mentionType, "agent");
  assert.equal(humanMessage?.mentions?.[0]?.token, "Atlas");
});

test("sendChannelHumanMessageSync lets channel members mention enabled personal agents in that channel", runtimeSkip, () => {
  seedWorkspace();
  const suffix = Math.random().toString(36).slice(2, 8);
  const agentOwner = createUserSync({
    displayName: `Agent Owner ${suffix}`,
    primaryEmail: `agent-owner-${suffix}@example.com`,
  });
  const mina = createUserSync({
    displayName: `Mina ${suffix}`,
    primaryEmail: `mina-personal-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: agentOwner.id,
    role: "member",
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: mina.id,
    role: "member",
  });
  createEmployeeSync({
    name: "Nova",
    role: "Reviewer",
    remarkName: "Nova",
    summary: "Personal reviewer",
    fit: "Nova",
    origin: "seed",
    ownerUserId: agentOwner.id,
    channelMemberAccess: "enabled",
  });
  const runtime = registerDaemonRuntimesSync({
    daemonKey: `test-personal-${suffix}`,
    deviceName: "Test machine",
    runtimes: [{ provider: "codex", name: "Nova Runtime" }],
  }).runtimes[0];
  assert.ok(runtime);
  bindEmployeeRuntimeSync("Nova", runtime.id);
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: mina.displayName, role: "Member" },
    ],
    activeEmployees: state.activeEmployees.map((employee) =>
      employee.name === "Nova"
        ? {
            ...employee,
            channels: ["tour visit"],
          }
        : employee,
    ),
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: ["techwu", mina.displayName],
            humanMembers: 2,
            employeeNames: [...channel.employeeNames, "Nova"],
          }
        : channel,
    ),
  });

  sendChannelHumanMessageSync(
    "tour visit",
    mina.displayName,
    "@Nova 帮我整理一下重点",
    undefined,
    undefined,
    DEFAULT_WORKSPACE_ID,
    mina.id,
  );

  const queued = listQueuedTasksSync().filter((task) => task.agentId === "Nova");
  assert.equal(queued.length, 1);
});

test("sendChannelHumanMessageSync rejects channel members when agent channel access is disabled", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();
  setEmployeeChannelMemberAccessSync("Atlas", "disabled");
  const suffix = Math.random().toString(36).slice(2, 8);
  const mina = createUserSync({
    displayName: `Mina ${suffix}`,
    primaryEmail: `mina-disabled-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: mina.id,
    role: "member",
  });
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: mina.displayName, role: "Member" },
    ],
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: ["techwu", mina.displayName],
            humanMembers: 2,
          }
        : channel,
    ),
  });

  assert.throws(
    () =>
      sendChannelHumanMessageSync(
        "tour visit",
        mina.displayName,
        "@Atlas 帮我整理一下重点",
        undefined,
        undefined,
        DEFAULT_WORKSPACE_ID,
        mina.id,
      ),
    /This agent is not available to the current user/,
  );
});

test("sendChannelHumanMessageSync preflights every sequential handoff before enqueueing", () => {
  const previousRuntimeMode = process.env.DOFE_AGENT_RUNTIME_MODE;
  process.env.DOFE_AGENT_RUNTIME_MODE = "local";
  try {
    seedWorkspace();
    addAgentToTourVisit("Nova");
    bindRuntimeForAgent("Atlas");
    bindRuntimeForAgent("Nova");
    setEmployeeChannelMemberAccessSync("Nova", "disabled");

    const suffix = Math.random().toString(36).slice(2, 8);
    const mina = createUserSync({
      displayName: `Mina sequential ${suffix}`,
      primaryEmail: `mina-sequential-${suffix}@example.com`,
    });
    createWorkspaceMembershipSync({
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: mina.id,
      role: "member",
    });
    const state = readWorkspaceStateSync();
    writeWorkspaceStateSync({
      ...state,
      humanMembers: [
        ...state.humanMembers,
        { name: mina.displayName, role: "Member" },
      ],
      channels: state.channels.map((channel) =>
        channel.name === "tour visit"
          ? {
              ...channel,
              humanMemberNames: ["techwu", mina.displayName],
              humanMembers: 2,
            }
          : channel,
      ),
    });

    assert.throws(
      () =>
        sendChannelHumanMessageSync(
          "tour visit",
          mina.displayName,
          "@Atlas 先起草，然后 @Nova 审阅",
          undefined,
          undefined,
          DEFAULT_WORKSPACE_ID,
          mina.id,
        ),
      /This agent is not available to the current user/,
    );
    assert.equal(listQueuedTasksSync().length, 0);
  } finally {
    if (previousRuntimeMode === undefined) delete process.env.DOFE_AGENT_RUNTIME_MODE;
    else process.env.DOFE_AGENT_RUNTIME_MODE = previousRuntimeMode;
  }
});

test("createTaskSync lets channel members dispatch enabled workspace agents in joined channels", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();
  const suffix = Math.random().toString(36).slice(2, 8);
  const mina = createUserSync({
    displayName: `Mina ${suffix}`,
    primaryEmail: `mina-task-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: mina.id,
    role: "member",
  });
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: mina.displayName, role: "Member" },
    ],
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: ["techwu", mina.displayName],
            humanMembers: 2,
          }
        : channel,
    ),
  });

  const nextState = createTaskSync({
    title: "整理群里的公开资料",
    channel: "tour visit",
    assignee: "Atlas",
    priority: "medium",
    requestedByUserId: mina.id,
    requestedByDisplayName: mina.displayName,
  });

  assert.equal(nextState.tasks[0]?.assignee, "Atlas");
  assert.equal(
    listQueuedTasksSync().some((task) => {
      const payload = JSON.parse(task.inputJson) as { title?: string };
      return task.agentId === "Atlas" && payload.title === "整理群里的公开资料";
    }),
    true,
  );
});

test("createTaskSync lets channel members dispatch enabled personal agents in joined channels", runtimeSkip, () => {
  seedWorkspace();
  const suffix = Math.random().toString(36).slice(2, 8);
  const agentOwner = createUserSync({
    displayName: `Agent Owner ${suffix}`,
    primaryEmail: `agent-owner-task-${suffix}@example.com`,
  });
  const mina = createUserSync({
    displayName: `Mina ${suffix}`,
    primaryEmail: `mina-personal-task-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: agentOwner.id,
    role: "member",
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: mina.id,
    role: "member",
  });
  createEmployeeSync({
    name: "Nova",
    role: "Reviewer",
    remarkName: "Nova",
    summary: "Personal reviewer",
    fit: "Nova",
    origin: "seed",
    ownerUserId: agentOwner.id,
    channelMemberAccess: "enabled",
  });
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: mina.displayName, role: "Member" },
    ],
    activeEmployees: state.activeEmployees.map((employee) =>
      employee.name === "Nova"
        ? {
            ...employee,
            channels: ["tour visit"],
          }
        : employee,
    ),
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: ["techwu", mina.displayName],
            humanMembers: 2,
            employeeNames: [...channel.employeeNames, "Nova"],
          }
        : channel,
    ),
  });

  const nextState = createTaskSync({
    title: "整理个人 Agent 资料",
    channel: "tour visit",
    assignee: "Nova",
    priority: "medium",
    requestedByUserId: mina.id,
    requestedByDisplayName: mina.displayName,
  });

  assert.equal(nextState.tasks[0]?.assignee, "Nova");
});

test("createTaskSync rejects channel members when agent channel access is disabled", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();
  setEmployeeChannelMemberAccessSync("Atlas", "disabled");
  const suffix = Math.random().toString(36).slice(2, 8);
  const mina = createUserSync({
    displayName: `Mina ${suffix}`,
    primaryEmail: `mina-task-disabled-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: mina.id,
    role: "member",
  });
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: mina.displayName, role: "Member" },
    ],
    channels: state.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            humanMemberNames: ["techwu", mina.displayName],
            humanMembers: 2,
          }
        : channel,
    ),
  });

  assert.throws(
    () =>
      createTaskSync({
        title: "整理群里的公开资料",
        channel: "tour visit",
        assignee: "Atlas",
        priority: "medium",
        requestedByUserId: mina.id,
        requestedByDisplayName: mina.displayName,
      }),
    /This agent is not available to the current user/,
  );
});

test("continueAutoContinuationAfterTaskSync replies and queues the next takeover task", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();
  sendChannelHumanMessageSync("tour visit", "techwu", "@Atlas，从现在起连续工作12h");
  const firstTask = listQueuedTasksSync().find((task) => task.agentId === "Atlas");
  assert.ok(firstTask);
  const firstPayload = JSON.parse(firstTask!.inputJson) as { autoContinuation: { startedAt: string } };

  const result = continueAutoContinuationAfterTaskSync({
    taskId: firstTask!.id,
    sessionId: "session-auto",
    workDir: "/tmp/auto-work",
    now: new Date(Date.parse(firstPayload.autoContinuation.startedAt) + 1000),
  });

  assert.equal(result.queued, true);
  const queued = listQueuedTasksSync().filter((task) => task.agentId === "Atlas");
  assert.equal(queued.length, 2);
  const nextTask = queued.find((task) => task.id === result.queuedTaskId);
  assert.ok(nextTask);
  const nextPayload = JSON.parse(nextTask!.inputJson) as {
    channelMessage: string;
    channelSessionId?: string;
    autoContinuation?: { iteration: number };
  };
  assert.equal(nextPayload.channelMessage, AUTO_CONTINUATION_REPLY);
  assert.equal(nextPayload.channelSessionId, "session-auto");
  assert.equal(nextPayload.autoContinuation?.iteration, 1);

  const state = readWorkspaceStateSync();
  assert.equal(state.messages.some((message) => message.summary === AUTO_CONTINUATION_REPLY && message.role === "human"), true);
  assert.equal(state.conversationExecutionWorkspaces?.[0]?.lastTaskQueueId, nextTask!.id);
});

test("stopAutoContinuationSync stops active continuation and cancels queued follow-up", runtimeSkip, () => {
  seedWorkspace();
  bindAtlasRuntime();
  sendChannelHumanMessageSync("tour visit", "techwu", "@Atlas，从现在起连续工作12h");
  const firstTask = listQueuedTasksSync().find((task) => task.agentId === "Atlas");
  assert.ok(firstTask);
  const firstPayload = JSON.parse(firstTask!.inputJson) as { autoContinuation: { startedAt: string } };
  const continuationResult = continueAutoContinuationAfterTaskSync({
    taskId: firstTask!.id,
    sessionId: "session-auto",
    workDir: "/tmp/auto-work",
    now: new Date(Date.parse(firstPayload.autoContinuation.startedAt) + 1000),
  });
  assert.equal(continuationResult.queued, true);

  const stopResult = stopAutoContinuationSync({
    channelName: "tour visit",
    agentId: "Atlas",
    requestedByDisplayName: "techwu",
  });

  assert.equal(stopResult.stopped, true);
  assert.equal(stopResult.cancelledTaskId, continuationResult.queuedTaskId);
  const cancelledTask = listQueuedTasksSync().find((task) => task.id === continuationResult.queuedTaskId);
  assert.equal(cancelledTask?.status, "cancelled");
  const state = readWorkspaceStateSync();
  assert.equal(state.conversationExecutionWorkspaces?.[0]?.autoContinuation?.status, "stopped");
  assert.equal(state.messages.some((message) => message.code === "auto_continuation.stopped_notice"), true);
});

test("sendChannelHumanMessageSync rejects mentions for agents outside the channel", () => {
  seedWorkspace();
  createEmployeeSync({
    name: "Nova",
    role: "Reviewer",
    remarkName: "Nova",
    summary: "QA reviewer",
    fit: "Nova",
    origin: "seed",
  });

  assert.throws(
    () => sendChannelHumanMessageSync("tour visit", "techwu", "@Nova 帮我看一下"),
    /以下 Agent 不在当前群组中：@Nova。/,
  );
  assert.equal(readWorkspaceStateSync().messages.length, 0);
});

test("sendChannelHumanMessageSync rejects mentions for humans outside the channel", () => {
  seedWorkspace();
  const state = readWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      ...state.humanMembers,
      { name: "Mina", role: "Operator" },
    ],
  });

  assert.throws(
    () => sendChannelHumanMessageSync("tour visit", "techwu", "@Mina 帮我看一下"),
    /以下成员不在当前群组中：@Mina。/,
  );
  assert.equal(readWorkspaceStateSync().messages.length, 0);
});

test("sendChannelHumanMessageSync rejects humans outside the channel", () => {
  seedWorkspace();
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    humanMembers: [
      ...readWorkspaceStateSync().humanMembers,
      { name: "Mina", role: "Operator" },
    ],
  });

  assert.throws(
    () => sendChannelHumanMessageSync("tour visit", "Mina", "让我也发一条"),
    /does not belong to channel/,
  );
});

test("pinMessageSync and unpinMessageSync reject humans outside the channel when actor is provided", () => {
  seedWorkspace();
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    humanMembers: [
      ...readWorkspaceStateSync().humanMembers,
      { name: "Mina", role: "Operator" },
    ],
  });
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "报告已生成。",
  });
  const messageId = readWorkspaceStateSync().messages[0]?.id;
  assert.ok(messageId);

  assert.throws(
    () => pinMessageSync(messageId!, undefined, "Mina"),
    /does not belong to channel/,
  );
  assert.throws(
    () => unpinMessageSync(messageId!, undefined, "Mina"),
    /does not belong to channel/,
  );
});

test("acknowledgeMessageSync stores one OK acknowledgement per actor", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "报告已生成。",
  });
  const messageId = readWorkspaceStateSync().messages[0]?.id;
  assert.ok(messageId);

  acknowledgeMessageSync(messageId!, undefined, "techwu", "user-techwu");
  acknowledgeMessageSync(messageId!, undefined, "techwu", "user-techwu");

  const message = readWorkspaceStateSync().messages.find((item) => item.id === messageId);
  assert.equal(message?.acknowledgements?.length, 1);
  assert.equal(message?.acknowledgements?.[0]?.label, "techwu");
  assert.equal(message?.acknowledgements?.[0]?.userId, "user-techwu");
});

test("acknowledgeMessageSync rejects humans outside the channel when actor is provided", () => {
  seedWorkspace();
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    humanMembers: [
      ...readWorkspaceStateSync().humanMembers,
      { name: "Mina", role: "Operator" },
    ],
  });
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "报告已生成。",
  });
  const messageId = readWorkspaceStateSync().messages[0]?.id;
  assert.ok(messageId);

  assert.throws(
    () => acknowledgeMessageSync(messageId!, undefined, "Mina"),
    /does not belong to channel/,
  );
});

test("postMessageSync stores attachments and writes them into channel history", () => {
  seedWorkspace();
  const attachment = createAttachment("att-post", "exports/report.pdf", "application/pdf");

  postMessageSync({
    channel: "tour visit",
    speaker: "系统提示",
    role: "agent",
    summary: "报告已生成。",
    attachments: [attachment],
  });

  const state = readWorkspaceStateSync();
  assert.equal(state.messages[0]?.attachments?.[0]?.id, attachment.id);

  const history = readFileSync(
    join(tempRoot, "data", "workspaces", "default", "channel-history", "tour-visit.md"),
    "utf8",
  );
  assert.match(history, /exports\/report\.pdf/);
});

test("replacePendingChannelMessageSync swaps pending messages without dropping attachments", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
  });
  const attachment = createAttachment("att-replaced", "runtime-output/chart.png", "image/png");

  replacePendingChannelMessageSync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    speaker: "Atlas",
    role: "agent",
    summary: "图表已完成。",
    attachments: [attachment],
  });

  const state = readWorkspaceStateSync();
  assert.equal(
    state.messages.some((message) => message.role === "agent" && message.status === "pending" && message.speaker === "Atlas"),
    false,
  );
  assert.equal(state.messages[0]?.attachments?.[0]?.id, attachment.id);

  const history = readFileSync(
    join(tempRoot, "data", "workspaces", "default", "channel-history", "tour-visit.md"),
    "utf8",
  );
  assert.match(history, /runtime-output\/chart\.png/);
});

test("replacePendingChannelMessageSync can stop one task without removing the next queued reply", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
    data: { source_task_queue_id: "task-atlas-current" },
  });
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
    data: { source_task_queue_id: "task-atlas-next" },
  });

  replacePendingChannelMessageSync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    pendingTaskId: "task-atlas-current",
    speaker: "系统提示",
    role: "agent",
    summary: "Atlas 的执行已停止。",
  });

  const state = readWorkspaceStateSync();
  assert.equal(
    state.messages.some((message) =>
      message.data?.source_task_queue_id === "task-atlas-current" && message.status === "pending",
    ),
    false,
  );
  assert.equal(
    state.messages.some((message) =>
      message.data?.source_task_queue_id === "task-atlas-current" && message.summary === "Atlas 的执行已停止。",
    ),
    true,
  );
  assert.equal(
    state.messages.some((message) => message.data?.source_task_queue_id === "task-atlas-next" && message.status === "pending"),
    true,
  );
});

test("replacePendingChannelMessageSync falls back only to one unambiguous legacy pending reply", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Legacy thinking",
    status: "pending",
  });

  replacePendingChannelMessageSync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    pendingTaskId: "task-atlas-current",
    speaker: "系统提示",
    role: "agent",
    summary: "Atlas 执行失败。",
    status: "error",
  });

  assert.equal(
    readWorkspaceStateSync().messages.some((message) => message.summary === "Legacy thinking"),
    false,
  );
});

test("streaming task output only updates its own pending reply", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
    data: { source_task_queue_id: "task-atlas-1" },
  });
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
    data: { source_task_queue_id: "task-atlas-2" },
  });

  const updated = updatePendingAgentChannelReplySync({
    channel: "tour visit",
    sourceTaskQueueId: "task-atlas-1",
    pendingSpeaker: "Atlas",
    delta: "第一段",
  });
  updatePendingAgentChannelReplySync({
    channel: "tour visit",
    sourceTaskQueueId: "task-atlas-1",
    pendingSpeaker: "Atlas",
    delta: "，第二段",
  });
  completeAgentChannelReplySync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    speaker: "Atlas",
    sourceTaskQueueId: "task-atlas-1",
    summary: "最终回复",
  });

  const state = readWorkspaceStateSync();
  assert.equal(updated?.summary, "第一段");
  assert.equal(
    state.messages.some((message) => message.data?.source_task_queue_id === "task-atlas-2" && message.status === "pending"),
    true,
  );
  assert.equal(
    state.messages.some((message) => message.data?.source_task_queue_id === "task-atlas-1" && message.status === "pending"),
    false,
  );
  assert.equal(state.messages[0]?.summary, "最终回复");
});

test("task progress keeps concise summaries and expandable runtime details", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
    data: { source_task_queue_id: "task-progress-1" },
  });

  recordAgentChannelProgressSync({
    channel: "tour visit",
    sourceTaskQueueId: "task-progress-1",
    speaker: "Atlas",
    type: "thinking",
    content: "Provider reasoning is available in the detail view.",
    detail: "Provider reasoning is available in the detail view.",
  });
  recordAgentChannelProgressSync({
    channel: "tour visit",
    sourceTaskQueueId: "task-progress-1",
    speaker: "Atlas",
    type: "tool_use",
    tool: "web_search",
  });
  recordAgentChannelProgressSync({
    channel: "tour visit",
    sourceTaskQueueId: "task-progress-1",
    speaker: "Atlas",
    type: "tool_result",
    tool: "web_search",
  });
  completeAgentChannelReplySync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    speaker: "Atlas",
    sourceTaskQueueId: "task-progress-1",
    summary: "行程已整理。",
  });

  const progress = readWorkspaceStateSync().messages.filter((message) => message.kind === "process");
  assert.equal(progress.length, 2);
  assert.equal(progress.some((message) => message.summary.includes("Provider reasoning")), false);
  assert.equal(progress.find((message) => message.processType === "thinking")?.data?.execution_detail, "Provider reasoning is available in the detail view.");
  assert.equal(progress.find((message) => message.tool === "web_search")?.processType, "tool_result");
  assert.equal(progress.some((message) => message.status === "pending"), false);
});

test("failed task replacement preserves progress details and task association", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
    data: { source_task_queue_id: "task-progress-failed" },
  });
  recordAgentChannelProgressSync({
    channel: "tour visit",
    sourceTaskQueueId: "task-progress-failed",
    speaker: "Atlas",
    type: "thinking",
    content: "Preparing the video workflow.",
    detail: "Preparing the video workflow with deterministic inputs.",
  });
  recordAgentChannelProgressSync({
    channel: "tour visit",
    sourceTaskQueueId: "task-progress-failed",
    speaker: "Atlas",
    type: "tool_use",
    tool: "openmontage",
    detail: "Submitting the video generation job.",
  });

  replacePendingChannelMessageSync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    pendingTaskId: "task-progress-failed",
    speaker: "系统提示",
    role: "agent",
    summary: "Atlas 执行失败。",
    status: "error",
  });

  const taskMessages = readWorkspaceStateSync().messages.filter(
    (message) => message.data?.source_task_queue_id === "task-progress-failed",
  );
  const progress = taskMessages.filter((message) => message.kind === "process");
  const failure = taskMessages.find((message) => message.summary === "Atlas 执行失败。");
  assert.equal(progress.length, 2);
  assert.equal(progress.every((message) => message.status === "completed"), true);
  assert.equal(
    progress.find((message) => message.processType === "thinking")?.data?.execution_detail,
    "Preparing the video workflow with deterministic inputs.",
  );
  assert.equal(failure?.status, "error");
});

test("postMessageSync publishes realtime message events", () => {
  seedWorkspace();
  const events: Array<{ type: string; channelName: string; messageId?: string }> = [];
  const unsubscribe = subscribeWorkspaceRealtimeEvents(DEFAULT_WORKSPACE_ID, (event) => events.push(event));

  postMessageSync({
    channel: "tour visit",
    speaker: "系统提示",
    role: "agent",
    summary: "报告已生成。",
  });
  unsubscribe();

  const message = readWorkspaceStateSync().messages[0];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "channel.message.created");
  assert.equal(events[0]?.channelName, "tour visit");
  assert.equal(events[0]?.messageId, message?.id);
});

test("replacePendingChannelMessageSync publishes realtime thread change events", () => {
  seedWorkspace();
  postMessageSync({
    channel: "tour visit",
    speaker: "Atlas",
    role: "agent",
    summary: "Thinking",
    status: "pending",
  });
  const events: Array<{ type: string; channelName: string }> = [];
  const unsubscribe = subscribeWorkspaceRealtimeEvents(DEFAULT_WORKSPACE_ID, (event) => events.push(event));

  replacePendingChannelMessageSync({
    channel: "tour visit",
    pendingSpeaker: "Atlas",
    speaker: "Atlas",
    role: "agent",
    summary: "图表已完成。",
  });
  unsubscribe();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "channel.thread.changed");
  assert.equal(events[0]?.channelName, "tour visit");
});

test("runtime tool approval requests are visible and reviewable in channel messages", () => {
  seedWorkspace();
  const approval = createRuntimeToolApprovalRequestSync({
    sourceId: "queue-approval",
    agentId: "Atlas",
    channelName: "tour visit",
    toolName: "Bash",
    toolInput: { command: "npm run test" },
    contentPreview: "Bash: npm run test",
    provider: "claude",
    runtimeId: "runtime-1",
    sessionId: "session-1",
  });

  let state = readWorkspaceStateSync();
  const createdMessage = state.messages.find((message) => message.data?.approval_id === approval.id);
  assert.equal(createdMessage?.code, "approval.created");
  assert.equal(createdMessage?.data?.approval_status, "pending");
  assert.equal(createdMessage?.data?.tool_name, "Bash");

  reviewApprovalSync(approval.id, "approved", "ok");

  state = readWorkspaceStateSync();
  const reviewedMessage = state.messages.find((message) => message.data?.approval_id === approval.id);
  assert.equal(reviewedMessage?.data?.approval_status, "approved");
  assert.equal(reviewedMessage?.data?.reviewer_comment, "ok");
});

test("cancelled task approvals keep their audit state without appearing after the stop message", () => {
  seedWorkspace();
  const approval = createRuntimeToolApprovalRequestSync({
    sourceId: "queue-cancelled-approval",
    agentId: "Atlas",
    channelName: "tour visit",
    toolName: "WebSearch",
    contentPreview: "WebSearch: trending projects",
    provider: "claude",
    runtimeId: "runtime-1",
  });

  reviewApprovalSync(
    approval.id,
    "rejected",
    "Task stopped by the user.",
    undefined,
    { suppressConversationMessage: true },
  );

  const state = readWorkspaceStateSync();
  assert.equal(state.approvals.find((item) => item.id === approval.id)?.status, "rejected");
  assert.equal(state.approvals.find((item) => item.id === approval.id)?.reviewerComment, "Task stopped by the user.");
  assert.equal(state.messages.some((message) => message.data?.approval_id === approval.id), false);
});

test("runtime tool approvals remain actionable in direct conversations", () => {
  seedWorkspace();
  sendContactMessageSync("Atlas", "请检索资料。");
  const directChannel = readWorkspaceStateSync().channels.find((channel) =>
    channel.kind === "direct" && channel.employeeNames.includes("Atlas"),
  );
  assert.ok(directChannel);

  const approval = createRuntimeToolApprovalRequestSync({
    sourceId: "queue-direct-approval",
    agentId: "Atlas",
    channelName: directChannel.name,
    toolName: "WebFetch",
    contentPreview: "WebFetch: https://example.com",
    provider: "claude",
    runtimeId: "runtime-1",
  });
  const state = readWorkspaceStateSync();
  const message = state.messages.find((item) => item.data?.approval_id === approval.id);
  assert.equal(message?.code, "approval.created");
  assert.equal(message?.channel, directChannel.name);
});

test.after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
