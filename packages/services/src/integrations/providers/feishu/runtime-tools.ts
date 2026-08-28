export interface FeishuRuntimeToolIdentityRequirement {
  required: boolean;
  reasonCode?: string;
  externalActorReference?: string;
  agentId?: string;
  botBindingId?: string;
  externalChatId?: string;
  externalMessageId?: string;
}

export function evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput(
  inputJson: string,
): FeishuRuntimeToolIdentityRequirement {
  const payload = readRecordFromJson(inputJson);
  const externalInput = readRecord(payload.externalInput);
  if (externalInput?.provider !== "feishu") {
    return { required: false };
  }
  const actor = readRecord(externalInput.actor);
  if (actor?.actorType !== "external_guest") {
    return { required: false };
  }
  const requiredActions = readOptionalStringArray(actor.externalGuestRequireIdentityFor) ?? [
    "writes",
    "approvals",
    "private_resources",
    "runtime_sensitive_tools",
  ];
  if (!requiredActions.includes("runtime_sensitive_tools")) {
    return { required: false };
  }
  return {
    required: true,
    reasonCode: "feishu_external_guest_runtime_sensitive_tool_identity_required",
    externalActorReference: readString(actor.externalActorReference),
    agentId: readString(actor.agentId),
    botBindingId: readString(actor.botBindingId),
    externalChatId: readString(externalInput.externalChatId),
    externalMessageId: readString(externalInput.externalMessageId),
  };
}

function readRecordFromJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
