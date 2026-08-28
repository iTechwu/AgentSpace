export interface McpDeclaredTool {
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
}

export function parseMcpDeclaredTools(value: string | undefined): McpDeclaredTool[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        description: typeof entry.description === "string" ? entry.description : "",
        risk: normalizeMcpRisk(entry.risk),
      }))
      .filter((tool) => tool.name);
  } catch {
    return [];
  }
}

function normalizeMcpRisk(value: unknown): McpDeclaredTool["risk"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}
