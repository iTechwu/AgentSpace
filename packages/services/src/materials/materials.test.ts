import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listStoredAttachmentsSync } from "@dofe-agent/db";
import {
  importMaterialFileSync,
  parseMaterialSync,
  resetWorkspaceStateSync,
} from "../index.ts";
import { setAttachmentStorageClientForTests } from "../attachments/storage.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-materials-"));
const testTos = createTestTosAttachmentStorage();

test.before(() => {
  process.env.NODE_ENV = "test";
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
  setAttachmentStorageClientForTests(testTos.client);
});

test.after(() => {
  setAttachmentStorageClientForTests(undefined);
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});

test("material imports persist to TOS and remain parseable after the source file is removed", () => {
  testTos.clear();
  resetWorkspaceStateSync();
  const sourcePath = join(tempRoot, "brief.md");
  writeFileSync(sourcePath, "# Launch brief\n\nShip the TOS-only flow.", "utf8");

  const imported = importMaterialFileSync({
    filePath: sourcePath,
    label: "Launch brief",
    status: "imported",
  });
  const material = imported.materials[0];
  assert.ok(material?.id);
  assert.equal(material.storageProvider, "tos");
  assert.match(material.storedPath ?? "", /^tos:\/\/test-bucket\//);
  assert.ok(material.storageKey);
  assert.equal(existsSync(join(tempRoot, "data", "materials")), false);

  rmSync(sourcePath);
  const parsed = parseMaterialSync(material.id);
  assert.match(parsed.materials[0]?.preview ?? "", /Ship the TOS-only flow/);
  assert.equal(listStoredAttachmentsSync().some((attachment) => attachment.id === material.id), true);
});
