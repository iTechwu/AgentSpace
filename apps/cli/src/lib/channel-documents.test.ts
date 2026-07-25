import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ActiveEmployee, ChannelRecord } from "@agent-space/domain/workspace";
import { applyChannelDocumentOperations } from "./channel-documents.ts";
import {
  createEmployeeSync,
  initializeOrganizationSync,
  listChannelDocumentsSync,
  readChannelDocumentSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "@agent-space/services";

test("applyChannelDocumentOperations accepts a valid relative contentPath for document creation", () => {
  const originalCwd = process.cwd();
  const repoRoot = mkdtempSync(join(tmpdir(), "agent-space-channel-docs-"));

  try {
    writeFileSync(join(repoRoot, "Target.md"), "# test\n");
    mkdirSync(join(repoRoot, "data"), { recursive: true });
    process.chdir(repoRoot);

    resetWorkspaceStateSync();
    initializeOrganizationSync({
      organizationName: "Northstar Labs",
      ownerName: "techwu",
      ownerRole: "Founder",
      firstChannelName: "tour visit",
    });
    createEmployeeSync({
      name: "Test",
      role: "Planner",
    });
    const state = readWorkspaceStateSync();
    writeWorkspaceStateSync({
      ...state,
      channels: state.channels.map((channel: ChannelRecord) =>
        channel.name === "tour visit"
          ? {
              ...channel,
              employeeNames: [...channel.employeeNames, "Test"],
            }
          : channel,
      ),
      activeEmployees: state.activeEmployees.map((employee: ActiveEmployee) =>
        employee.name === "Test"
          ? {
              ...employee,
              channels: [...employee.channels, "tour visit"],
            }
          : employee,
      ),
    });

    const workDir = join(
      repoRoot,
      "data",
      "daemon",
      "workspaces",
      "default",
      "workdirs",
      "channels",
      "tour-visit",
      "Test",
    );
    mkdirSync(join(workDir, "runtime-output", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "trip-plan.md"), "# Osaka\n\n- Day 1", "utf8");
    writeFileSync(
      join(workDir, "runtime-output", "channel-documents.json"),
      JSON.stringify(
        {
          documents: [
            {
              title: "大阪-濑户内海行程",
              contentPath: "runtime-output/artifacts/trip-plan.md",
              mode: "create_or_update",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = applyChannelDocumentOperations(workDir, {
      channelName: "tour visit",
      sourceTaskQueueId: "queue-test-1",
      actorName: "Test",
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.documentUpdates.length, 1);

    const createdDocument = listChannelDocumentsSync("tour visit")[0];
    assert.ok(createdDocument);
    assert.equal(createdDocument?.title, "大阪-濑户内海行程");

    const persisted = readChannelDocumentSync(createdDocument!.id);
    assert.match(persisted.currentVersion.contentMarkdown, /Day 1/);
  } finally {
    process.chdir(originalCwd);
  }
});
