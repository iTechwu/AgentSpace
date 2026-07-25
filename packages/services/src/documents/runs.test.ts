import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceState } from "@dofe-agent/domain/workspace";
import { createChannelDocumentRun, markChannelDocumentRunStepCompleted } from "./runs.ts";

test("channel document run promotes dependent step after the upstream document step completes", () => {
  const state = createDefaultWorkspaceState();
  const { run, steps } = createChannelDocumentRun({
    state,
    channelName: "tour visit",
    sourceMessageId: "msg-1",
    sourceSummary: "@Test 先整理，再让 @Nova 完善",
    plan: {
      mode: "sequential",
      steps: [
        {
          id: "step-1",
          agentId: "Test",
          agentLabel: "Test",
          instruction: "先整理文档",
          dependsOnStepIds: [],
          handoffKind: "document",
        },
        {
          id: "step-2",
          agentId: "Nova",
          agentLabel: "Nova",
          instruction: "再完善文档",
          dependsOnStepIds: ["step-1"],
          handoffKind: "document",
        },
      ],
      warnings: [],
      unknownMentions: [],
    },
  });

  const result = markChannelDocumentRunStepCompleted(state, {
    stepId: steps[0]!.id,
    documentUpdates: [{ documentId: "doc-1", documentVersionId: "ver-2" }],
  });

  assert.equal(result.step.documentId, "doc-1");
  assert.equal(result.step.documentVersionId, "ver-2");
  assert.equal(result.readySteps.length, 1);
  assert.equal(result.readySteps[0]!.agentId, "Nova");
  assert.equal(result.readySteps[0]!.status, "ready");
  assert.equal(run.status, "pending");
});

test("channel document run treats warning-completed steps as satisfied dependencies", () => {
  const state = createDefaultWorkspaceState();
  const { run, steps } = createChannelDocumentRun({
    state,
    channelName: "tour visit",
    sourceMessageId: "msg-1",
    sourceSummary: "@Test 先整理，再让 @Nova 完善",
    plan: {
      mode: "sequential",
      steps: [
        {
          id: "step-1",
          agentId: "Test",
          agentLabel: "Test",
          instruction: "先整理文档",
          dependsOnStepIds: [],
          handoffKind: "document",
        },
        {
          id: "step-2",
          agentId: "Nova",
          agentLabel: "Nova",
          instruction: "再完善文档",
          dependsOnStepIds: ["step-1"],
          handoffKind: "document",
        },
      ],
      warnings: [],
      unknownMentions: [],
    },
  });

  const result = markChannelDocumentRunStepCompleted(state, {
    stepId: steps[0]!.id,
    warningText: "No new document version was written.",
  });

  assert.equal(result.step.status, "completed_with_warning");
  assert.equal(result.step.lastWarning, "No new document version was written.");
  assert.equal(result.readySteps.length, 1);
  assert.equal(result.readySteps[0]!.status, "ready");
  assert.equal(run.status, "pending");
});
