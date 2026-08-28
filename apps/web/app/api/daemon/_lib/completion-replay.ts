export function shouldPersistManagedTaskUsages(input: {
  taskStatus: string;
  runtimeMode: string;
  hasManagedCredential: boolean;
}): boolean {
  return input.taskStatus !== "preparing_commit"
    && input.runtimeMode === "remote"
    && input.hasManagedCredential;
}

export function resolveManagedTaskUsageGatewayRequestId(input: {
  taskId: string;
  usageIndex: number;
  gatewayRequestId?: string;
  gatewayUsageId?: string;
}): string {
  return input.gatewayRequestId?.trim()
    || (input.gatewayUsageId?.trim() ? `gateway-usage:${input.gatewayUsageId.trim()}` : undefined)
    || `task:${input.taskId}:usage:${input.usageIndex}`;
}
