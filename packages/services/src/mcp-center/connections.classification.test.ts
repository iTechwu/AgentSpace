import assert from "node:assert/strict";
import test from "node:test";
import { classifyVerificationOutcome, findMissingApprovedMcpTools } from "./connections.ts";

test("missing approved tools downgrade verification and identify the unavailable tools", () => {
  const discoveredTools = [{ name: "search", description: "Search", inputSchema: {}, inputSchemaDigest: "search-v1" }];
  const approvedTools = ["search", "write"];

  assert.deepEqual(findMissingApprovedMcpTools(discoveredTools, approvedTools), ["write"]);
  assert.equal(classifyVerificationOutcome({ status: "ready", discoveredTools }, approvedTools), "degraded");
});

test("a discovery that contains every approved tool remains ready", () => {
  const discoveredTools = [{ name: "search", description: "Search", inputSchema: {}, inputSchemaDigest: "search-v1" }];

  assert.deepEqual(findMissingApprovedMcpTools(discoveredTools, ["search"]), []);
  assert.equal(classifyVerificationOutcome({ status: "ready", discoveredTools }, ["search"]), "ready");
});
