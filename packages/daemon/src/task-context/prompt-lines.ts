// 3.5-4：自 task-context.ts 拆出——prompt 各上下文块的行渲染器，以及
// router 会话/飞书资源/引用的脱敏、截断与 opaque-reference 格式化。
import type { AgentRuntimeRecord } from "@dofe-agent/db";
import type { RuntimeAppContextEntry } from "@dofe-agent/domain";
import type { ActiveEmployee, KnowledgePage, WorkspaceSkill } from "@dofe-agent/domain/workspace";
import type { ContactAgentContext } from "@dofe-agent/services/content";
import { BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME } from "@dofe-agent/services/skills";
import { FEISHU_LARK_CLI_RESULT_MANIFEST_KIND, FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH, type FeishuLarkCliResourceGrant } from "@dofe-agent/services/integrations";
import { type DocumentPermissionRequestRecord } from "@dofe-agent/services/operations";
import { type WorkspaceNotificationRecord } from "@dofe-agent/services/workspace";

export interface RouterSessionPromptContext {
  routerSessionId: string;
  conversationKey?: string;
  sourceType?: string;
  memorySummary?: string;
  providerSessionId?: string;
  continuationMode?: "same_provider_resume" | "cold_rebuild" | "fallback";
  previousRuntimeId?: string;
  selectedRuntimeId?: string;
  fallbackReason?: string;
  transcriptLines?: string[];
  latestHandoffSnapshot?: string;
  attemptCount?: number;
}

export interface AgentKnowledgePromptContext {
  pages: KnowledgePage[];
  contextDir?: string;
}

export function buildAgentNotificationLines(notifications: WorkspaceNotificationRecord[]): string[] {
  if (notifications.length === 0) {
    return [];
  }
  return [
    "以下是当前任务相关的未读 Agent 通知；只把它们作为状态事实使用，不要自动触发额外执行：",
    ...notifications.map((notification) => {
      const parts = [
        `- ${notification.type}`,
        notification.resourceType,
        notification.resourceId ? `resource ${notification.resourceId}` : "",
        notification.channelName ? `channel ${notification.channelName}` : "",
        `${notification.title}: ${truncateNotificationText(notification.body)}`,
      ].filter(Boolean);
      return parts.join(" | ");
    }),
  ];
}

export function buildRouterSessionContextLines(context: RouterSessionPromptContext | undefined): string[] {
  if (!context) {
    return [];
  }
  const lines = [
    "以下是 DofeAgent 平台级 Router Session 状态；它是连续性的事实源，provider 原生 session 只是不可靠的可复用缓存：",
    `- routerSessionId: ${context.routerSessionId}`,
    context.conversationKey ? `- conversationKey: ${context.conversationKey}` : "",
    context.sourceType ? `- sourceType: ${context.sourceType}` : "",
    context.continuationMode ? `- continuationMode: ${formatContinuationMode(context.continuationMode)}` : "",
    context.selectedRuntimeId ? `- selectedRuntimeId: ${context.selectedRuntimeId}` : "",
    context.previousRuntimeId && context.previousRuntimeId !== context.selectedRuntimeId
      ? `- previousRuntimeId: ${context.previousRuntimeId}`
      : "",
    context.providerSessionId
      ? `- providerSessionId: ${context.providerSessionId}（只可在当前 provider/runtime 兼容时作为 resume hint）`
      : "- providerSessionId: none（请基于平台上下文冷启动继续）",
    typeof context.attemptCount === "number" ? `- attemptCount: ${context.attemptCount}` : "",
    context.fallbackReason ? `- fallbackReason: ${context.fallbackReason}` : "",
    context.memorySummary?.trim() ? "Router memory summary:" : "",
    context.memorySummary?.trim() ? sanitizeRouterContextBlock(context.memorySummary) : "",
    context.latestHandoffSnapshot?.trim()
      ? "A prior provider handoff is available to DofeAgent for recovery. Continue from the stable session metadata and conversation history above; do not rely on raw provider diagnostics."
      : "",
    context.transcriptLines && context.transcriptLines.length > 0
      ? "Compact router transcript / event log:"
      : "",
    ...(context.transcriptLines ?? []).slice(-40)
      .map((line) => sanitizeRouterContextLine(truncateRouterLine(line)))
      .filter(Boolean)
      .map((line) => `- ${line}`),
    "如果 provider session 缺失、失效或 provider/runtime 已切换，不要假设隐藏会话状态仍存在；请根据上面的平台状态、频道历史、文档、知识和附件继续。",
  ];
  return lines.filter(Boolean);
}

function formatContinuationMode(mode: NonNullable<RouterSessionPromptContext["continuationMode"]>): string {
  if (mode === "same_provider_resume") {
    return "same provider resume";
  }
  if (mode === "fallback") {
    return "runtime fallback with cold rebuild";
  }
  return "cold rebuild";
}

function sanitizeRouterContextBlock(value: string): string {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => sanitizeRouterContextLine(line))
    .filter(Boolean);
  return truncateRouterContextBlock(lines.join("\n"));
}

function sanitizeRouterContextLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || /^provider detail\s*:/i.test(normalized)) {
    return "";
  }
  const diagnosticStart = normalized.search(/\b(?:rawProviderMessage|stderrTail)\s*=/i);
  if (diagnosticStart < 0) {
    return normalized;
  }
  return normalized.slice(0, diagnosticStart).replace(/[\s(;,:-]+$/, "").trim();
}

function truncateRouterContextBlock(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2400 ? normalized : `${normalized.slice(0, 2397)}...`;
}

function truncateRouterLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217)}...`;
}

function truncateNotificationText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
}

export function buildDocumentPermissionRequestLines(
  requests: DocumentPermissionRequestRecord[],
): string[] {
  const relevantRequests = requests
    .filter((request) => request.status === "pending" || request.status === "rejected")
    .slice(0, 10);
  if (relevantRequests.length === 0) {
    return [];
  }

  return [
    "以下是当前 Agent 已有的文档权限申请状态；不要重复提交同一文档/角色/目标频道申请，除非用户提供新的明确理由：",
    ...relevantRequests.map((request) => {
      const target = request.documentId ?? request.externalUrl ?? request.externalFileId ?? "unknown";
      const parts = [
        `- ${request.status}`,
        `role ${request.requestedRole}`,
        `target ${target}`,
        request.requestedForChannelName ? `channel ${request.requestedForChannelName}` : "",
        request.reason ? `reason ${request.reason}` : "",
        request.decisionNote ? `decision ${request.decisionNote}` : "",
      ].filter(Boolean);
      return parts.join(" | ");
    }),
  ];
}

export function buildRuntimeAppContextLines(runtimeApps: RuntimeAppContextEntry[]): string[] {
  if (runtimeApps.length === 0) {
    return ["当前绑定 runtime 未报告已安装的 CLI-Hub runtime app；不要声称可以直接调用未列出的 CLI。"];
  }

  const lines = [
    `当前绑定 runtime 已安装并启用的 CLI-Hub runtime apps: ${runtimeApps.length} 个。`,
  ];
  for (const app of runtimeApps.slice(0, 20)) {
    const parts = [
      `- ${app.displayName} (${app.source}:${app.name})`,
      app.entryPoint ? `entry point: ${app.entryPoint}` : "",
      app.version ? `version: ${app.version}` : "",
      app.category ? `category: ${app.category}` : "",
      app.requiresText ? `requires: ${app.requiresText}` : "",
      app.skillMd ? `SKILL.md: ${app.skillMd}` : "",
    ].filter(Boolean);
    lines.push(parts.join(" | "));
  }
  if (runtimeApps.length > 20) {
    lines.push(`还有 ${runtimeApps.length - 20} 个 runtime app 未在 prompt 中逐项列出。`);
  }
  lines.push("只有上面列出的 runtime app 可被视为当前任务真实可用；workspace skill 只是使用说明，不代表软件已安装。");
  return lines;
}

export function buildFeishuLarkCliResourceGrantLines(grants: FeishuLarkCliResourceGrant[]): string[] {
  if (grants.length === 0) {
    return [];
  }
  const lines = [
    `当前频道有 ${grants.length} 个已由 DofeAgent 绑定并授权给本任务上下文的 Feishu/Lark Docs/Sheets/Base 资源。`,
    "只能通过官方 lark-cli 访问下面列出的资源 token；不得读取、搜索或写入未列出的飞书资源。",
    ...grants.slice(0, 20).map((grant) => {
      const operations = grant.allowedOperations?.join(",") || "read";
      const parts = [
        `- ${grant.providerResourceType}`,
        `token ${truncateFeishuResourceValue(grant.providerResourceToken)}`,
        grant.baseToken ? `base ${truncateFeishuResourceValue(grant.baseToken)}` : "",
        grant.tableId ? `table ${truncateFeishuResourceValue(grant.tableId)}` : "",
        grant.viewId ? `view ${truncateFeishuResourceValue(grant.viewId)}` : "",
        `allowed ${operations}`,
        grant.providerResourceUrl ? `url ${formatPromptOpaqueReference(grant.providerResourceUrl)}` : "",
      ].filter(Boolean);
      return parts.join(" | ");
    }),
  ];
  if (grants.length > 20) {
    lines.push(`还有 ${grants.length - 20} 个 Feishu/Lark 绑定资源未逐项列出。`);
  }
  lines.push(
    "读取示例：Doc 用 lark-cli docs +fetch --api-version v2；Sheet 用 lark-cli sheets +workbook-info / +csv-get / +cells-get；Base 用 lark-cli base +table-list / +record-list。命令必须包含上面列出的 token。",
  );
  lines.push(
    `如果使用 lark-cli 读取 Feishu/Lark 资源并希望这次读取计入 DofeAgent evidence，请把安全结果摘要写入 ${FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH}，JSON 至少包含 kind="${FEISHU_LARK_CLI_RESULT_MANIFEST_KIND}"、schemaVersion=1、ok/status、operationType、providerResourceType 和 providerResourceToken；不要写入文档正文、表格单元格值、Base record 字段值或原始 provider 响应。`,
  );
  lines.push(
    "allowed write 只表示可以通过 DofeAgent 申请受控写入；如需修改 Feishu/Lark Docs/Sheets/Base，请使用 dofe-agent output feishu data-operation-approval --operation <docs.update_document|sheets.update_range|base.mutate_records> --type <doc|sheet|base_table> --resource <上方 token> ... 创建审批申请。",
  );
  lines.push(
    "写入 Feishu/Lark Docs/Sheets/Base 前必须先有 DofeAgent policy/approval 和带 payload hash 的 operation manifest，不得直接运行 +update、+csv-put、+cells-set、+batch-update、+record-create 或 +record-update。",
  );
  lines.push("不要在 headless runtime 里运行 lark-cli config init 或 auth login；如果 lark-cli 未登录或权限不足，报告 runtime 配置问题。");
  return lines;
}

function truncateFeishuResourceValue(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function formatPromptOpaqueReference(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ref_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function formatPromptIdentifier(label: string, value: string | undefined): string | undefined {
  const reference = formatPromptOpaqueReference(value);
  return reference ? `${label} ${reference}` : undefined;
}

export function buildAgentContextLines(
  agentProfile: ActiveEmployee | undefined,
  agentSkills: WorkspaceSkill[],
  provider: AgentRuntimeRecord["provider"],
  skillContextDir?: string,
  providerSkillContextDir?: string,
  projectWorkDir?: string,
): string[] {
  if (!agentProfile) {
    return [];
  }

  const lines = [
    `Agent 展示名: ${agentProfile.remarkName?.trim() || agentProfile.name}`,
    `Agent 内部名: ${agentProfile.name}`,
    agentProfile.role.trim().length > 0 && agentProfile.role !== "Agent" ? `角色: ${agentProfile.role}` : "",
    agentProfile.summary.trim().length > 0 ? `定位: ${agentProfile.summary.trim()}` : "",
    agentProfile.instructions?.trim() ? `Instructions:\n${agentProfile.instructions.trim()}` : "",
  ].filter(Boolean);

  if (projectWorkDir) {
    lines.push(`项目工作目录: ${projectWorkDir}`);
    lines.push("若任务涉及该项目，请在该目录下工作（如需可先确认目录存在再进入）。");
  }

  if (agentSkills.length > 0) {
    lines.push(`已分配 Skills: ${agentSkills.map((skill) => skill.name).join(", ")}`);
    if (providerSkillContextDir) {
      lines.push(`当前 provider(${provider}) 原生技能目录: ${providerSkillContextDir}`);
    }
    if (skillContextDir) {
      lines.push(`兼容技能目录: ${skillContextDir}`);
      lines.push("每个 skill 子目录里都包含 SKILL.md 和 supporting files；开始工作前，请按需阅读与你当前任务相关的 skill。若当前 provider 支持原生 skills，请优先按照原生目录加载。");
    }
  }

  lines.push("如需回传文件、群文档、skill import 或飞书受控数据操作，只使用 dofe-agent output ...；CLI 会生成 runtime-output manifest，daemon 会在任务结束后回收。");
  lines.push(`如需回传文件或图片，请遵循 ${BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME} skill，使用 dofe-agent output attach ...，然后运行 dofe-agent output validate。`);
  lines.push("如需把新 skill 导入工作区，使用 dofe-agent output skill import ...，然后运行 dofe-agent output validate。");
  lines.push("如果本次任务总结出可复用的规则、流程、约束或已验证事实，可以用 dofe-agent output knowledge propose-create/propose-update 提交 workspace knowledge 候选；这只会进入人类审批，不会直接写入全局知识库。");
  lines.push("只沉淀长期有用且已验证的内容；不要把临时任务结果、隐私信息、凭据、token、未经验证的推测或只对当前对话有效的细节提交为 workspace knowledge。");
  lines.push("提交知识候选时，先把 Markdown 正文写到 runtime-output/artifacts/knowledge/*.md，再用 output CLI 生成 manifest；不要手写 runtime-output/knowledge-proposals.json。reason 必须说明来源任务上下文和为什么值得复用。");

  return lines;
}

export function buildContactContextLines(contactContext: ContactAgentContext | undefined): string[] {
  if (!contactContext) {
    return [];
  }

  const lines: string[] = [];
  if (contactContext.self.channels.length > 0) {
    lines.push(`当前 Agent 所在频道: ${contactContext.self.channels.join("、")}`);
  }

  if (contactContext.knownEntities.length === 0) {
    lines.push("当前还没有可确认的 workspace 协作实体。");
    return lines;
  }

  lines.push(`当前可确认的 workspace 协作者: ${contactContext.knownEntities.length} 个`);
  for (const entity of contactContext.knownEntities) {
    const parts = [
      `- ${entity.name}`,
      entity.role.trim().length > 0 ? `角色 ${entity.role}` : "",
      entity.sharedChannels.length > 0 ? `共同频道 ${entity.sharedChannels.join("、")}` : "",
      entity.observedLabels.length > 0 ? `可见历史称呼 ${entity.observedLabels.join("、")}` : "",
      entity.recentSharedInteractionSummary
        ? `最近协作 ${entity.recentSharedInteractionChannel ?? "未知频道"}${entity.recentSharedInteractionTime ? ` ${entity.recentSharedInteractionTime}` : ""} · ${entity.recentSharedInteractionSummary}`
        : "",
    ].filter(Boolean);
    lines.push(parts.join(" | "));
  }

  return lines;
}

export function buildKnowledgeContextLines(knowledgeContext: AgentKnowledgePromptContext | undefined): string[] {
  if (!knowledgeContext) {
    return [];
  }

  const pages = knowledgeContext.pages;
  if (pages.length === 0) {
    return ["当前 Agent 未分配额外知识；不要隐式读取整个 workspace 知识库。"];
  }

  const titleLines = pages.slice(0, 12).map((page) => `- ${page.title} (${page.id})`);
  return [
    `当前 Agent 可用知识页: ${pages.length} 篇。`,
    ...titleLines,
    pages.length > titleLines.length ? `还有 ${pages.length - titleLines.length} 篇知识页未在 prompt 中逐项列出。` : "",
    knowledgeContext.contextDir ? `可用知识目录: ${knowledgeContext.contextDir}；manifest.json 列出全部页面，pages/ 下是 Markdown 正文。` : "",
  ].filter(Boolean);
}
