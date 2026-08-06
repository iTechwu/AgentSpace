import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkflowNodeInput } from "./inputs.ts";

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
