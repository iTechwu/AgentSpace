import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceState } from "@dofe-agent/domain/workspace";
import {
  createChannelDocument,
  rollbackChannelDocumentVersion,
  updateChannelDocument,
} from "./service.ts";

function createStateWithChannel() {
  const state = createDefaultWorkspaceState();
  state.channels.push({
    name: "tour visit",
    humanMembers: 1,
    employeeNames: [],
  });
  return state;
}

test("rollbackChannelDocumentVersion restores a previous version", () => {
  const state = createStateWithChannel();
  const created = createChannelDocument({
    state,
    channelName: "tour visit",
    title: "大阪-濑户内海行程",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "techwu",
    createdByType: "human",
  });
  const updated = updateChannelDocument({
    state,
    documentId: created.document.id,
    contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n宇治",
    updatedBy: "Atlas",
    updatedByType: "agent",
    triggerType: "agent",
  });

  const rolledBack = rollbackChannelDocumentVersion({
    state,
    documentId: created.document.id,
    versionId: created.version.id,
    updatedBy: "techwu",
    updatedByType: "human",
  });

  assert.match(updated.version.contentMarkdown, /Day 2/);
  assert.equal(rolledBack.document.currentVersionId, rolledBack.version.id);
  assert.equal(rolledBack.version.contentMarkdown, created.version.contentMarkdown);
});
