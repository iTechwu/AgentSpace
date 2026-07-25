import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { before, beforeEach } from "node:test";
import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import {
  createChannelDocumentSync,
  createEmployeeSync,
  createKnowledgePageSync,
  createKnowledgePageFromSharedDocumentSync,
  deleteEmployeeSync,
  deleteKnowledgePageSync,
  listEmployeeKnowledgePageIdsSync,
  listKnowledgeAssignmentsByPageIdSync,
  setEmployeeKnowledgePageIdsSync,
  setKnowledgePageAssignedEmployeesSync,
  setKnowledgePageAssignmentModeSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-knowledge-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    organizationName: "Northstar Labs",
    humanMembers: [
      { name: "techwu", role: "Founder" },
      { name: "Mina", role: "Operator" },
    ],
    channels: [
      {
        name: "tour visit",
        humanMemberNames: ["techwu", "Mina"],
        humanMembers: 2,
        employeeNames: [],
      },
    ],
    messages: [],
  });
});

function createAttachment(id: string, fileName: string, mediaType: string, content: string): MessageAttachment {
  const attachmentsDir = join(tempRoot, "data", "workspaces", "default", "attachments");
  mkdirSync(attachmentsDir, { recursive: true });
  const storedPath = join(attachmentsDir, `${id}-${basename(fileName.replace(/\\/g, "/"))}`);
  writeFileSync(storedPath, content, "utf8");
  return {
    id,
    fileName,
    mediaType,
    sizeBytes: Buffer.byteLength(content),
    kind: mediaType.startsWith("image/") ? "image" : "file",
    storedPath,
  };
}

test("createKnowledgePageFromSharedDocumentSync imports markdown attachments and tracks their source", () => {
  const attachment = createAttachment("att-itinerary", "shared/itinerary.md", "text/markdown", "# Osaka Trip");
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    messages: [
      {
        id: "message-1",
        channel: "tour visit",
        speaker: "techwu",
        role: "human",
        time: "2026-04-18T09:00:00.000Z",
        summary: "Shared itinerary",
        status: "completed",
        attachments: [attachment],
      },
    ],
  });

  const page = createKnowledgePageFromSharedDocumentSync({
    sourceType: "attachment",
    sourceId: attachment.id,
    createdBy: "techwu",
    createdByType: "human",
  });

  assert.equal(page.title, "itinerary");
  assert.equal(page.sourceAttachmentId, attachment.id);
  assert.equal(page.sourceAttachmentStoredPath, attachment.storedPath);
  assert.equal(page.sourceChannelDocumentId, undefined);
  assert.match(page.contentMarkdown, /Osaka Trip/);
});

test("createKnowledgePageFromSharedDocumentSync imports visible shared documents and tracks their source", () => {
  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "Trip notes",
    contentMarkdown: "# Shared Plan\n\nKyoto",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
  });

  const page = createKnowledgePageFromSharedDocumentSync({
    sourceType: "channelDocument",
    sourceId: created.document.id,
    createdBy: "techwu",
    createdByType: "human",
  });

  assert.equal(page.title, "Trip notes");
  assert.equal(page.sourceAttachmentId, undefined);
  assert.equal(page.sourceChannelDocumentId, created.document.id);
  assert.match(page.contentMarkdown, /Shared Plan/);
});

test("knowledge assignments expose all-agent and selected-agent pages without leaking unassigned pages", () => {
  createEmployeeSync({ name: "Planner" });
  createEmployeeSync({ name: "Legal" });
  createKnowledgePageSync({ title: "Shared handbook", contentMarkdown: "Common" });
  createKnowledgePageSync({ title: "Planner playbook", contentMarkdown: "Plan" });
  createKnowledgePageSync({ title: "Legal memo", contentMarkdown: "Law" });

  const pages = readWorkspaceStateSync().knowledgePages;
  const shared = pages.find((page) => page.title === "Shared handbook")!;
  const planner = pages.find((page) => page.title === "Planner playbook")!;
  const legal = pages.find((page) => page.title === "Legal memo")!;

  setKnowledgePageAssignmentModeSync(planner.id, "selected_agents", "techwu");
  setKnowledgePageAssignedEmployeesSync(planner.id, ["Planner"], "techwu");
  setKnowledgePageAssignmentModeSync(legal.id, "selected_agents", "techwu");

  assert.deepEqual(
    listEmployeeKnowledgePageIdsSync("Planner").sort(),
    [shared.id, planner.id].sort(),
  );
  assert.deepEqual(
    listEmployeeKnowledgePageIdsSync("Legal").sort(),
    [shared.id].sort(),
  );
});

test("agent-side knowledge assignment only accepts selected-agent pages and cleans up lifecycle rows", () => {
  createEmployeeSync({ name: "Planner" });
  createKnowledgePageSync({ title: "Shared handbook", contentMarkdown: "Common" });
  createKnowledgePageSync({ title: "Planner playbook", contentMarkdown: "Plan" });

  const pages = readWorkspaceStateSync().knowledgePages;
  const shared = pages.find((page) => page.title === "Shared handbook")!;
  const planner = pages.find((page) => page.title === "Planner playbook")!;

  assert.throws(
    () => setEmployeeKnowledgePageIdsSync("Planner", [shared.id]),
    /Only selected-agent knowledge pages/,
  );

  setKnowledgePageAssignmentModeSync(planner.id, "selected_agents", "techwu");
  setEmployeeKnowledgePageIdsSync("Planner", [planner.id], "techwu");
  assert.equal(listKnowledgeAssignmentsByPageIdSync(planner.id).length, 1);

  deleteEmployeeSync("Planner");
  assert.equal(listKnowledgeAssignmentsByPageIdSync(planner.id).length, 0);

  createEmployeeSync({ name: "Planner" });
  setEmployeeKnowledgePageIdsSync("Planner", [planner.id], "techwu");
  deleteKnowledgePageSync(planner.id);
  assert.equal(listKnowledgeAssignmentsByPageIdSync(planner.id).length, 0);
});

test.after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
