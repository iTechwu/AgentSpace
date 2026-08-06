import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowNodeRuntimeContext,
  collectWorkflowArtifactRefs,
  getWorkflowInputResolutionErrorCode,
  mergeWorkflowArtifactManifests,
  resolveWorkflowNodeInput,
  validateWorkflowInputReferences,
} from "./inputs.ts";

test("input resolution exposes only stable permanent error codes", () => {
  assert.equal(
    getWorkflowInputResolutionErrorCode(new Error("workflow_input_reference_missing")),
    "workflow_input_reference_missing",
  );
  assert.equal(getWorkflowInputResolutionErrorCode(new Error("sensitive runtime detail")), undefined);
});

test("resolves only declared run, node, and join references", () => {
  const result = resolveWorkflowNodeInput({
    runInput: { topic: "automation" },
    nodeConfig: {
      input: {
        topic: "${run.input.topic}",
        report: "${nodes.research.output.report}",
        joined: "${join.outputs}",
      },
    },
    predecessorOutputs: { research: { report: "artifact://report" }, audit: { ok: true } },
  });
  assert.deepEqual(result, {
    topic: "automation",
    report: "artifact://report",
    joined: { research: { report: "artifact://report" }, audit: { ok: true } },
  });
});

test("rejects unknown input references without evaluating code", () => {
  assert.throws(
    () => resolveWorkflowNodeInput({ runInput: {}, nodeConfig: { input: { value: "${process.env.SECRET}" } }, predecessorOutputs: {} }),
    /workflow_input_reference_missing/,
  );
});

test("builds a downstream context from immutable graph configuration and all upstream outputs", () => {
  const graph = {
    schemaVersion: 1 as const,
    nodes: [
      { id: "research", type: "employee_task" as const, employeeId: "emp-1", config: { input: { topic: "${run.input.topic}" } } },
      { id: "review", type: "employee_task" as const, employeeId: "emp-2", config: { input: { report: "${nodes.research.output.report}" } } },
      { id: "publish", type: "employee_task" as const, employeeId: "emp-3", config: { title: "发布", channelName: "交付群", input: { report: "${nodes.research.output.report}" } } },
    ],
    edges: [{ source: "research", target: "review" }, { source: "review", target: "publish" }],
  };
  const context = buildWorkflowNodeRuntimeContext({
    graph,
    nodeId: "publish",
    runInput: { topic: "automation" },
    nodeRuns: [
      { nodeId: "research", nodeType: "employee_task", status: "succeeded", outputJson: JSON.stringify({ report: "完成" }) },
      { nodeId: "review", nodeType: "employee_task", status: "succeeded", artifactManifestJson: JSON.stringify([{ id: "attachment-1" }]) },
      { nodeId: "publish", nodeType: "employee_task", status: "ready" },
    ],
  });

  assert.deepEqual(context.nodeConfig, graph.nodes[2]!.config);
  assert.deepEqual(context.resolvedInput, { report: "完成" });
  assert.deepEqual(context.artifactRefs, ["attachment-1"]);
});

test("join output and artifact manifests converge without duplicate references", () => {
  const graph = {
    schemaVersion: 1 as const,
    nodes: [
      { id: "a", type: "employee_task" as const, employeeId: "emp-1", config: {} },
      { id: "b", type: "employee_task" as const, employeeId: "emp-2", config: {} },
      { id: "join", type: "join" as const, config: { policy: "all_success" } },
      { id: "summary", type: "employee_task" as const, employeeId: "emp-3", config: { input: { results: "${join.outputs}" } } },
    ],
    edges: [
      { source: "a", target: "join" },
      { source: "b", target: "join" },
      { source: "join", target: "summary" },
    ],
  };
  const merged = mergeWorkflowArtifactManifests([
    JSON.stringify([{ id: "attachment-1", fileName: "a.md" }]),
    JSON.stringify([{ id: "attachment-1", fileName: "a.md" }, { id: "attachment-2" }]),
  ]);
  const context = buildWorkflowNodeRuntimeContext({
    graph,
    nodeId: "summary",
    runInput: {},
    nodeRuns: [
      { nodeId: "join", nodeType: "join", status: "succeeded", outputJson: JSON.stringify({ outputs: { a: { text: "A" }, b: { text: "B" } } }), artifactManifestJson: JSON.stringify(merged) },
      { nodeId: "summary", nodeType: "employee_task", status: "ready" },
    ],
  });

  assert.deepEqual(context.resolvedInput, { results: { a: { text: "A" }, b: { text: "B" } } });
  assert.deepEqual(context.artifactRefs, ["attachment-1", "attachment-2"]);
  assert.deepEqual(collectWorkflowArtifactRefs(["not-json", JSON.stringify(["artifact://report"])]), ["artifact://report"]);
});

test("publish input reference validation only accepts upstream and join references", () => {
  const graph = {
    schemaVersion: 1 as const,
    nodes: [
      { id: "a", type: "employee_task" as const, employeeId: "emp-1", config: {} },
      { id: "b", type: "employee_task" as const, employeeId: "emp-2", config: { input: { invalid: "${nodes.future.output.text}" } } },
      { id: "future", type: "employee_task" as const, employeeId: "emp-3", config: { input: { invalidJoin: "${join.outputs}", valid: "${run.input.topic}" } } },
    ],
    edges: [{ source: "a", target: "b" }, { source: "b", target: "future" }],
  };

  assert.deepEqual(validateWorkflowInputReferences(graph).map((error) => error.code), [
    "workflow_input_reference_not_upstream",
    "workflow_join_reference_missing",
  ]);
});
