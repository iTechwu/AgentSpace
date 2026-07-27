import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAttachmentStorageKey,
  createAttachmentStorageClient,
  sha256Hex,
} from "./storage.ts";

test("local attachment storage writes, reads, and deletes bytes", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-attachment-storage-"));
  const localPath = join(tempRoot, "data", "workspaces", "default", "attachments", "att-storage-note.txt");

  try {
    const storage = createAttachmentStorageClient({
      provider: "local",
      localRoot: join(tempRoot, "data", "workspaces"),
      maxUploadBytes: 1024,
      signedUrlTtlSeconds: 300,
    });
    const contentBytes = Buffer.from("storage bytes", "utf8");

    const stored = storage.putObjectSync({
      workspaceId: "default",
      attachmentId: "att-storage",
      fileName: "notes/storage.txt",
      contentBytes,
      localPath,
      mediaType: "text/plain",
    });

    assert.equal(stored.provider, "local");
    assert.equal(stored.storedPath, localPath);
    assert.equal(stored.sizeBytes, contentBytes.byteLength);
    assert.equal(stored.sha256, sha256Hex(contentBytes));
    assert.equal(readFileSync(localPath, "utf8"), "storage bytes");
    assert.deepEqual(await storage.getObject({ storedPath: localPath }), contentBytes);
    await assert.doesNotReject(async () => storage.headObject({ storedPath: localPath }));
    assert.equal((await storage.headObject({ storedPath: localPath }))?.sizeBytes, contentBytes.byteLength);
    assert.equal(await storage.createReadUrl({ storedPath: localPath }), null);

    storage.deleteObjectSync({ storedPath: localPath });
    assert.equal(existsSync(localPath), false);
    assert.equal(await storage.headObject({ storedPath: localPath }), null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("object storage keys are workspace-scoped, date-partitioned, and sanitized", () => {
  const key = buildAttachmentStorageKey({
    workspaceId: "workspace/mars",
    attachmentId: "att:01",
    fileName: "../reports/日本一周 itinerary.md",
    createdAt: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.equal(
    key,
    "workspaces/workspace-mars/attachments/2026/05/att_01/reports-_itinerary.md",
  );
});
