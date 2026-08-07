export interface TaskCompletionTokenUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  gatewayRequestId: string;
  providerAccountId?: string;
  runtimeCredentialId?: string;
  routerSessionId?: string;
  channelName?: string;
}

export function buildTaskCompletionTokenUsage(input: {
  taskId: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  gatewayRequestId?: string;
  providerAccountId?: string;
  runtimeCredentialId?: string;
  routerSessionId?: string;
  channelName?: string;
}): TaskCompletionTokenUsage | undefined {
  const modelId = input.modelId?.trim();
  if (!modelId
    || !Number.isSafeInteger(input.inputTokens)
    || input.inputTokens < 0
    || !Number.isSafeInteger(input.outputTokens)
    || input.outputTokens < 0
    || (input.inputTokens === 0 && input.outputTokens === 0)) return undefined;
  return {
    modelId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    gatewayRequestId: input.gatewayRequestId?.trim() || `task:${input.taskId}:completion`,
    ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
    ...(input.runtimeCredentialId ? { runtimeCredentialId: input.runtimeCredentialId } : {}),
    ...(input.routerSessionId ? { routerSessionId: input.routerSessionId } : {}),
    ...(input.channelName ? { channelName: input.channelName } : {}),
  };
}
