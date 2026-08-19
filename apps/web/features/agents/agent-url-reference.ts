export interface AgentUrlReferenceRecord {
  id: string;
  employeeId: string;
  internalName: string;
  name: string;
}

export function buildAgentFocusReference(employeeId: string): string {
  return "agent:" + employeeId;
}

export function resolveAgentUrlReference(
  agents: readonly AgentUrlReferenceRecord[],
  focus: string | null,
): {
  selectedId: string | null;
  canonicalReference?: string;
} {
  if (!focus) {
    return { selectedId: null };
  }

  const rawReference = focus.startsWith("agent:")
    ? focus.slice("agent:".length)
    : focus.startsWith("workspace:")
      ? focus.slice("workspace:".length)
      : null;
  if (!rawReference) {
    return { selectedId: null };
  }

  const legacyIdMatch = agents.find((agent) => agent.id === focus);
  const employeeIdMatch = legacyIdMatch
    ? undefined
    : agents.find((agent) => agent.employeeId === rawReference);
  const internalNameMatch = legacyIdMatch || employeeIdMatch
    ? undefined
    : agents.find((agent) => agent.internalName === rawReference);
  const nameMatches = agents.filter((agent) => agent.name === rawReference);
  const match = legacyIdMatch
    ?? employeeIdMatch
    ?? internalNameMatch
    ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);
  if (!match) {
    return { selectedId: null };
  }

  const canonicalReference = buildAgentFocusReference(match.employeeId);
  return {
    selectedId: match.id,
    ...(focus === canonicalReference ? {} : { canonicalReference }),
  };
}
