import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendAgentOutputAttachment,
  appendChannelDocumentManifestEntry,
  appendDocumentPermissionRequest,
  appendKnowledgeProposalManifestEntry,
  collectRuntimeOutputBundleFiles,
  createRuntimeOutputPreview,
  prepareRuntimeOutputArtifactReference,
  setAgentOutputText,
  validateRuntimeOutputManifests,
} from "./runtime-output-manifests.ts";

test("runtime output helpers create and validate agent-output manifests", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-manifest-"));
  try {
    mkdirSync(join(workDir, "source"), { recursive: true });
    writeFileSync(join(workDir, "source", "chart.png"), "image", "utf8");

    const prepared = prepareRuntimeOutputArtifactReference({
      workDir,
      sourcePath: "source/chart.png",
    });
    assert.equal(prepared.relativePath, "runtime-output/artifacts/chart.png");
    assert.equal(prepared.copied, true);

    appendAgentOutputAttachment(workDir, {
      path: prepared.relativePath,
      name: "chart.png",
      mediaType: "image/png",
    });
    setAgentOutputText(workDir, "done");

    const manifest = JSON.parse(readFileSync(join(workDir, "runtime-output", "agent-output.json"), "utf8")) as {
      text?: string;
      attachments?: Array<{ path: string }>;
    };
    assert.equal(manifest.text, "done");
    assert.equal(manifest.attachments?.[0]?.path, "runtime-output/artifacts/chart.png");
    assert.deepEqual(validateRuntimeOutputManifests(workDir).errors, []);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runtime output validation rejects path traversal and empty attachments", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-manifest-"));
  try {
    mkdirSync(join(workDir, "runtime-output", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "empty.txt"), "", "utf8");
    writeFileSync(
      join(workDir, "runtime-output", "agent-output.json"),
      JSON.stringify({
        attachments: [
          { path: "../escape.txt" },
          { path: "runtime-output/artifacts/empty.txt" },
        ],
      }),
      "utf8",
    );

    const result = validateRuntimeOutputManifests(workDir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("relative path")));
    assert.ok(result.errors.some((error) => error.includes("is empty")));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runtime output helpers append supported operations for preview", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-manifest-"));
  try {
    mkdirSync(join(workDir, "runtime-output", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "notes.md"), "# Notes\n", "utf8");

    appendChannelDocumentManifestEntry(workDir, {
      title: "Research Notes",
      contentPath: "runtime-output/artifacts/notes.md",
      mode: "create_or_update",
    });
    appendKnowledgeProposalManifestEntry(workDir, {
      operation: "create",
      title: "Approval checklist",
      contentPath: "runtime-output/artifacts/notes.md",
      assignmentMode: "selected_agents",
      reason: "Reusable workflow",
    });
    writeFileSync(
      join(workDir, "runtime-output", "feishu-data-operation-requests.json"),
      JSON.stringify({
        kind: "dofe-agent.feishu.data-operation.requests",
        schemaVersion: 1,
        generatedBy: "dofe-agent-cli",
        requests: [{
          operationType: "sheets.update_range",
          providerResourceType: "sheet",
          providerResourceToken: "shtcnABC123",
          parameters: { range: "Sheet1!A1:B1" },
        }],
      }),
      "utf8",
    );

    const preview = createRuntimeOutputPreview(workDir);
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.manifests.channelDocuments.documentOperations, 1);
    assert.equal(preview.manifests.knowledgeProposals.proposals, 1);
    assert.equal(preview.manifests.feishuDataOperationRequests.requests, 1);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("knowledge proposal manifests must be CLI generated and reference markdown artifacts", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-manifest-"));
  try {
    mkdirSync(join(workDir, "runtime-output", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "notes.txt"), "hello", "utf8");
    writeFileSync(
      join(workDir, "runtime-output", "knowledge-proposals.json"),
      JSON.stringify({
        version: 1,
        proposals: [{
          operation: "create",
          title: "Bad proposal",
          contentPath: "runtime-output/artifacts/notes.txt",
        }],
      }),
      "utf8",
    );

    const result = validateRuntimeOutputManifests(workDir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("generatedBy")));
    assert.ok(result.errors.some((error) => error.includes(".md")));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("document permission manifests must be generated through the output CLI helpers", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-manifest-"));
  try {
    mkdirSync(join(workDir, "runtime-output"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "permission-requests.json"),
      JSON.stringify({
        version: 1,
        requests: [{
          requestedRole: "forwarder",
          reason: "Need to share it.",
          documentId: "doc-1",
        }],
      }),
      "utf8",
    );

    const handWritten = validateRuntimeOutputManifests(workDir);
    assert.equal(handWritten.valid, false);
    assert.ok(handWritten.errors.some((error) => error.includes("permission-requests.json.generatedBy")));
    appendDocumentPermissionRequest(workDir, {
      requestedRole: "forwarder",
      reason: "Need to share it.",
      documentId: "doc-1",
    });
    writeFileSync(
      join(workDir, "runtime-output", "feishu-data-operation-requests.json"),
      JSON.stringify({
        kind: "dofe-agent.feishu.data-operation.requests",
        schemaVersion: 1,
        generatedBy: "dofe-agent-cli",
        requests: [{
          operationType: "sheets.update_range",
          providerResourceType: "sheet",
          providerResourceToken: "shtcnABC123",
        }],
      }),
      "utf8",
    );

    assert.deepEqual(validateRuntimeOutputManifests(workDir).errors, []);
    assert.equal(
      collectRuntimeOutputBundleFiles(workDir).some((file) => file.path === "runtime-output/feishu-data-operation-requests.json"),
      true,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

