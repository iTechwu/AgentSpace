import { describe, expect, it } from "vitest";
import { buildAgentFocusReference, resolveAgentUrlReference, type AgentUrlReferenceRecord } from "./agent-url-reference";

const agents: AgentUrlReferenceRecord[] = [
  { id: "agent:legacy-ops", employeeId: "employee-ops", internalName: "ops-bot", name: "运营助手" },
  { id: "agent:legacy-support", employeeId: "employee-support", internalName: "support-bot", name: "运营助手" },
];

describe("agent URL references", () => {
  it("resolves employee IDs and emits the canonical reference", () => {
    expect(resolveAgentUrlReference(agents, "agent-employee-ops")).toEqual({
      selectedId: "agent:legacy-ops",
    });
    expect(buildAgentFocusReference("employee-ops")).toBe("agent-employee-ops");
  });

  it("still resolves legacy colon-separated references", () => {
    expect(resolveAgentUrlReference(agents, "agent:employee-ops")).toEqual({
      selectedId: "agent:legacy-ops",
      canonicalReference: "agent-employee-ops",
    });
    expect(resolveAgentUrlReference(agents, "workspace:employee-support")).toEqual({
      selectedId: "agent:legacy-support",
      canonicalReference: "agent-employee-support",
    });
  });

  it("prioritizes legacy record IDs over names", () => {
    const collidingAgents = [
      { id: "agent:other", employeeId: "legacy-ops", internalName: "other", name: "Other" },
      ...agents,
    ];

    expect(resolveAgentUrlReference(collidingAgents, "agent:legacy-ops")).toEqual({
      selectedId: "agent:legacy-ops",
      canonicalReference: "agent-employee-ops",
    });
  });

  it("supports internal names but refuses ambiguous display names", () => {
    expect(resolveAgentUrlReference(agents, "agent-support-bot")?.selectedId).toBe("agent:legacy-support");
    expect(resolveAgentUrlReference(agents, "agent-运营助手")).toEqual({ selectedId: null });
  });

  it("does not request replacement for a canonical reference", () => {
    expect(resolveAgentUrlReference(agents, "agent-employee-ops")).toEqual({
      selectedId: "agent:legacy-ops",
    });
  });
});
