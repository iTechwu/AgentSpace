export interface AuditLogFilters {
  code?: string;
  actorId?: string;
  employeeId?: string;
  runtimeId?: string;
  sessionId?: string;
  taskId?: string;
  modelId?: string;
  createdFrom?: string;
  createdTo?: string;
}

export function parseAuditLogFilters(input: Record<string, string | string[] | undefined>): AuditLogFilters {
  const read = (key: keyof AuditLogFilters) => typeof input[key] === "string" && input[key] ? String(input[key]) : undefined;
  const timestamp = (key: "createdFrom" | "createdTo") => {
    const value = read(key);
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  return { code: read("code"), actorId: read("actorId"), employeeId: read("employeeId"), runtimeId: read("runtimeId"), sessionId: read("sessionId"), taskId: read("taskId"), modelId: read("modelId"), createdFrom: timestamp("createdFrom"), createdTo: timestamp("createdTo") };
}
