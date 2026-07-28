import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import { createEmployeeSync, resetWorkspaceStateSync } from "@dofe-agent/services";
import { appendDocumentPermissionRequest } from "./runtime-output-manifests.ts";
import { applyDocumentRuntimeOutputOperations } from "./document-runtime-output.ts";

beforeEach(() => {
  resetWorkspaceStateSync();
  getDatabase().exec("DELETE FROM document_permission_request");
  createEmployeeSync({ name: "Planner" });
});

test("document runtime output rejects hand-written permission manifests", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-document-runtime-output-"));
  try {
    mkdirSync(join(workDir, "runtime-output"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "permission-requests.json"),
      JSON.stringify({ version: 1, requests: [{ requestedRole: "viewer", reason: "Need access", documentId: "doc-1" }] }),
      "utf8",
    );

    const result = applyDocumentRuntimeOutputOperations({
      workDir,
      workspaceId: "default",
      actorName: "Planner",
      sourceTaskQueueId: "task-1",
    });

    assert.equal(result.permissionRequests.length, 0);
    assert.match(result.warnings[0] ?? "", /permission-requests\.json 已被拒绝/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
