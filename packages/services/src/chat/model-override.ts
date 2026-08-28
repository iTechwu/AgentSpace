import { findDirectChannelRecord } from "../channels/channels.ts";
import {
  clearAgentRouterSessionModelOverrideSync,
  DEFAULT_WORKSPACE_ID,
  readAgentRouterSessionSync,
  readAgentRuntimeSync,
  readEmployeeRuntimeBindingSync,
  readLatestChannelExecutionSync,
  readLatestConversationExecutionSync,
  readStoredEmployeeSync,
  recordAuditLogSync,
  setAgentRouterSessionModelOverrideSync,
  upsertAgentRouterSessionSync,
} from "@dofe-agent/db";
import type { DaemonProvider } from "@dofe-agent/domain";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { readConversationExecutionWorkspaceState } from "../shared/conversation-execution-workspaces.ts";
import { parseChannelMentionsSync } from "../messages/messages.ts";
import { sameValue } from "../shared/helpers.ts";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import {
  resolveEffectiveModelForBoundEmployeeAsync,
  validateModelOverrideForBoundEmployeeAsync,
} from "../models/model-resolution.ts";

export interface SetSessionModelOverrideForChatInput {
  workspaceId?: string;
  humanMemberName: string;
  content: string;
  channelName?: string;
  contactId?: string;
  modelId?: string;
}

export interface SetSessionModelOverrideForChatResult {
  routerSessionId: string;
  agentName: string;
  modelId?: string;
}

export interface ResolveChatModelOverrideInput {
  workspaceId?: string;
  humanMemberName: string;
  content?: string;
  channelName?: string;
  contactId?: string;
}

export interface ChatModelOverrideInfo {
  routerSessionId: string;
  agentName: string;
  sessionOverride?: {
    modelId: string;
    source: string;
  };
  effectiveModel?: {
    modelId: string;
    source:
      | "session_override"
      | "employee_default"
      | "skill_requirement"
      | "runtime_default"
      | "team_policy_default"
      | "protocol_fallback";
  };
  /** Provider of the bound managed Runtime, when available. */
  provider?: DaemonProvider;
}

interface ChatRouterSessionResolution {
  workspaceId: string;
  agentName: string;
  conversationKey: string;
  sourceType: string;
  routerSessionId: string;
}

/**
 * Resolve or create the `agent_router_session` for a chat conversation.
 */
function ensureChatRouterSessionIdSync(
  input: ResolveChatModelOverrideInput,
): ChatRouterSessionResolution {
  const state = ensureWorkspaceStateSync(input.workspaceId);
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const humanMemberName = input.humanMemberName.trim() || "你";

  let agentName: string;
  let conversationKey: string;
  let sourceType: string;
  let executionWorkspaceInput: { channelName: string; agentId: string; contactId?: string };

  if (input.contactId) {
    const contactId = input.contactId;
    const contact = state.activeEmployees.find((employee) => sameValue(employee.name, contactId));
    if (!contact) {
      throw new Error(`contact.not_found: ${contactId}`);
    }
    const directChannel = findDirectChannelRecord(state, { humanMemberName, employeeName: contact.name });
    agentName = contact.name;
    conversationKey = `direct_conversation:${contact.name}`;
    sourceType = "direct_conversation";
    executionWorkspaceInput = {
      channelName: directChannel?.name ?? "",
      agentId: agentName,
      contactId: contact.name,
    };
  } else if (input.channelName) {
    const channelName = input.channelName;
    const channel = state.channels.find((item) => sameValue(item.name, channelName));
    if (!channel) {
      throw new Error(`channel.not_found: ${channelName}`);
    }
    const mentionParse = parseChannelMentionsSync(state, channel.name, input.content ?? "");
    if (mentionParse.agentMentions.length !== 1) {
      throw new Error(
        "model_command.agent_required: in a group channel, /model must mention exactly one agent.",
      );
    }
    agentName = mentionParse.agentMentions[0].agentId;
    conversationKey = `channel_conversation:${channel.name}`;
    sourceType = "channel_conversation";
    executionWorkspaceInput = { channelName: channel.name, agentId: agentName };
  } else {
    throw new Error("model_command.context_required: channelName or contactId is required.");
  }

  const existingExecutionWorkspace = readConversationExecutionWorkspaceState(state, executionWorkspaceInput);
  const lastExecution = input.contactId
    ? readLatestConversationExecutionSync(
      agentName,
      { contactId: input.contactId },
      workspaceId,
    )
    : readLatestChannelExecutionSync(agentName, input.channelName!, workspaceId);

  const routerSessionCandidates = [
    lastExecution?.routerSessionId,
    // Compatibility only: execution-workspace sessionId normally identifies
    // the provider session, so never trust it without a router-table lookup.
    existingExecutionWorkspace?.sessionId,
  ];
  let routerSessionId = routerSessionCandidates.find(
    (candidate): candidate is string => Boolean(candidate && readAgentRouterSessionSync(candidate)),
  );

  if (!routerSessionId) {
    const session = upsertAgentRouterSessionSync({
      workspaceId,
      agentId: agentName,
      conversationKey,
      sourceType,
    });
    routerSessionId = session.id;
  }

  return {
    workspaceId,
    agentName,
    conversationKey,
    sourceType,
    routerSessionId,
  };
}

/**
 * Apply a `/model` override for a chat conversation.
 *
 * - Direct contact: `contactId` is the agent; no mention parsing needed.
 * - Group channel: the remaining `content` must mention exactly one agent;
 *   the override applies to that agent's router session for the channel.
 *
 * If no router session exists yet, one is created so the override takes effect
 * on the next turn.
 */
export function setSessionModelOverrideForChatCommandSync(
  input: SetSessionModelOverrideForChatInput,
): SetSessionModelOverrideForChatResult {
  const resolution = ensureChatRouterSessionIdSync(input);
  const normalizedModelId = input.modelId?.trim();
  const humanMemberName = input.humanMemberName.trim() || "你";

  if (normalizedModelId && normalizedModelId.toLowerCase() !== "clear") {
    setAgentRouterSessionModelOverrideSync({
      routerSessionId: resolution.routerSessionId,
      modelOverride: normalizedModelId,
      source: "manual",
    });
  } else {
    clearAgentRouterSessionModelOverrideSync(resolution.routerSessionId);
  }

  recordAuditLogSync({
    workspaceId: resolution.workspaceId,
    title: normalizedModelId ? "Session model override set from chat" : "Session model override cleared from chat",
    note: `${humanMemberName} ${normalizedModelId ? `set model override to "${normalizedModelId}"` : "cleared the model override"} for ${resolution.agentName}.`,
    code: normalizedModelId ? "session.model_overridden" : "session.model_override_cleared",
    source: "runtime_model",
    data: {
      actorType: "human",
      actorId: humanMemberName,
      resourceType: "router_session",
      resourceId: resolution.routerSessionId,
      agentId: resolution.agentName,
      modelId: normalizedModelId,
    },
  });

  return { routerSessionId: resolution.routerSessionId, agentName: resolution.agentName, modelId: normalizedModelId };
}

/**
 * Structured validation error for `/model` overrides.
 *
 * `code` is machine-readable so the UI can show an actionable message.
 */
export class ChatModelOverrideValidationError extends Error {
  readonly code:
    | "model_required"
    | "no_bound_runtime"
    | "not_a_managed_runtime"
    | "model_unavailable"
    | "remote_mode_required";

  constructor(
    code: ChatModelOverrideValidationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ChatModelOverrideValidationError";
    this.code = code;
  }
}

/**
 * Validate a requested override against the selected AI employee's bound
 * Runtime before a caller writes it to the router session.
 */
export async function validateSessionModelOverrideForChatCommandAsync(
  input: SetSessionModelOverrideForChatInput,
): Promise<{ agentName: string; modelId: string }> {
  const requestedModelId = input.modelId?.trim();
  if (!requestedModelId || requestedModelId.toLowerCase() === "clear") {
    throw new ChatModelOverrideValidationError("model_required", "A model id is required.");
  }
  const resolution = ensureChatRouterSessionIdSync(input);
  try {
    const validated = await validateModelOverrideForBoundEmployeeAsync({
      workspaceId: resolution.workspaceId,
      employeeName: resolution.agentName,
      modelId: requestedModelId,
    });
    return { agentName: resolution.agentName, modelId: validated.modelId };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "model_resolution.remote_mode_required") {
        throw new ChatModelOverrideValidationError(
          "remote_mode_required",
          "Model overrides are only available in remote mode.",
        );
      }
      if (error.message === "model_resolution.no_bound_runtime") {
        throw new ChatModelOverrideValidationError(
          "no_bound_runtime",
          `AI employee "${resolution.agentName}" is not bound to a Runtime.`,
        );
      }
      if (error.message === "model_resolution.not_a_managed_runtime") {
        throw new ChatModelOverrideValidationError(
          "not_a_managed_runtime",
          `The bound Runtime for "${resolution.agentName}" is not a managed runtime.`,
        );
      }
      if (error.message === "model_resolution.model_unavailable") {
        throw new ChatModelOverrideValidationError(
          "model_unavailable",
          `Model "${requestedModelId}" is not available for the bound Runtime.`,
        );
      }
    }
    throw error;
  }
}

/**
 * Read the current effective model source for a chat conversation.
 * Returns undefined if no override is set.
 */
export function readSessionModelOverrideForChatSync(input: {
  workspaceId?: string;
  routerSessionId: string;
}): { modelId?: string; source?: string } | null {
  const session = readAgentRouterSessionSync(input.routerSessionId.trim());
  if (!session || !session.modelOverride) {
    return null;
  }
  return {
    modelId: session.modelOverride,
    source: session.modelOverrideSource,
  };
}

/**
 * Resolve the current model-override and effective model for a chat conversation.
 *
 * - Returns the active session override when one is set.
 * - In `remote` mode, also resolves the effective model through the bound
 *   managed Runtime (including AI employee / Runtime default / policy fallback).
 * - Returns the bound managed Runtime's provider so the UI can show a
 *   protocol-filtered model catalog.
 */
export async function resolveChatModelOverrideAsync(
  input: ResolveChatModelOverrideInput,
): Promise<ChatModelOverrideInfo> {
  const resolution = ensureChatRouterSessionIdSync(input);
  const session = readAgentRouterSessionSync(resolution.routerSessionId);
  const info: ChatModelOverrideInfo = {
    routerSessionId: resolution.routerSessionId,
    agentName: resolution.agentName,
  };

  if (session?.modelOverride) {
    info.sessionOverride = {
      modelId: session.modelOverride,
      source: session.modelOverrideSource ?? "manual",
    };
    // 有会话覆盖时，会话覆盖即为当前生效模型，无需异步验证。
    info.effectiveModel = {
      modelId: session.modelOverride,
      source: "session_override",
    };
  }

  const binding = readEmployeeRuntimeBindingSync(resolution.agentName, resolution.workspaceId);
  // 当没有会话覆盖时，先从数据库同步读取员工已配置的默认模型，
  // 确保 UI 即时显示模型名，无需等待 models API 异步调用返回。
  if (!info.effectiveModel) {
    const employee = readStoredEmployeeSync(resolution.agentName, resolution.workspaceId);
    if (employee?.defaultModel) {
      info.effectiveModel = {
        modelId: employee.defaultModel,
        source: "employee_default",
      };
    }
  }

  if (binding) {
    const runtime = readAgentRuntimeSync(binding.runtimeId);
    if (runtime?.managedCredentialId) {
      info.provider = runtime.provider;
    }

    if (resolveAgentRuntimeMode() === "remote" && runtime?.managedCredentialId) {
      // 在后台异步验证模型是否在 RuntimeCredential 允许列表中可用，
      // 这不阻塞 UI 渲染——默认模型已同步返回。
      resolveEffectiveModelForBoundEmployeeAsync({
        workspaceId: resolution.workspaceId,
        employeeName: resolution.agentName,
        routerSessionId: resolution.routerSessionId,
      }).then((effective) => {
        // 后台验证成功后无需更新 UI——当前函数已返回。
        // 后续 getChatModelOverrideAction 再次调用时会
        // 拿到验证后的结果。
      }).catch((error) => {
        try {
          recordAuditLogSync({
            workspaceId: resolution.workspaceId,
            title: "Chat model resolution preview failed",
            note: `Failed to resolve effective model for "${resolution.agentName}" in chat preview. Reason: ${error instanceof Error ? error.message : String(error)}`,
            code: "chat.model_resolution_preview_failed",
            source: "runtime_model",
            data: {
              actorType: "system",
              resourceType: "employee",
              resourceId: resolution.agentName,
              reason: error instanceof Error ? error.message : String(error),
            },
          });
        } catch {
          // Best-effort audit; do not surface audit failure.
        }
      });
    }
  }

  return info;
}
