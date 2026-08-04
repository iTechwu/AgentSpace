import { describe, expect, it } from "vitest";
import { parseMcpDeclaredTools } from "@/features/market/mcp-declared-tools";

describe("parseMcpDeclaredTools", () => {
  it("preserves structured catalog tools for connection totals", () => {
    const tools = parseMcpDeclaredTools(JSON.stringify([
      { name: "navigate_page", description: "Navigate", risk: "low" },
      { name: "evaluate_script", description: "Evaluate", risk: "high" },
    ]));

    expect(tools).toEqual([
      { name: "navigate_page", description: "Navigate", risk: "low" },
      { name: "evaluate_script", description: "Evaluate", risk: "high" },
    ]);
  });

  it("drops invalid entries and assigns a conservative risk", () => {
    expect(parseMcpDeclaredTools(JSON.stringify([
      "invalid",
      { name: "", risk: "low" },
      { name: "unknown_risk", risk: "unexpected" },
    ]))).toEqual([{ name: "unknown_risk", description: "", risk: "medium" }]);
    expect(parseMcpDeclaredTools("not-json")).toEqual([]);
  });
});
