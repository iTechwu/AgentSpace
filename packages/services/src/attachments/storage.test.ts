import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAttachmentStorageKey,
  createAttachmentStorageClient,
  sha256Hex,
} from "./storage.ts";

test("attachment content hashes remain stable for TOS metadata", () => {
  assert.equal(
    sha256Hex(Buffer.from("storage bytes", "utf8")),
    "62025326492ddeada4ec6738b2a1c0ba11159328f154787738e92dc11f8b065c",
  );
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

test("explicit local fallback persists an attachment below its configured root", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-local-attachments-"));
  try {
    const storage = createAttachmentStorageClient({
      provider: "local",
      local: { root },
    });
    const stored = storage.putObjectSync({
      workspaceId: "workspace-mars",
      attachmentId: "att-local",
      fileName: "skill.zip",
      contentBytes: Buffer.from("local skill", "utf8"),
      mediaType: "application/zip",
    });

    assert.equal(stored.provider, "local");
    assert.match(stored.storedPath, /^local:\/\/\/workspaces\//);
    assert.deepEqual(
      storage.getObjectSync({ storedPath: stored.storedPath, storageKey: stored.key }),
      new Uint8Array(Buffer.from("local skill", "utf8")),
    );
    assert.throws(
      () => storage.getObjectSync({ storedPath: "local:///outside", storageKey: "../outside" }),
      /outside the configured local attachment root/,
    );

    storage.deleteObjectSync({ storedPath: stored.storedPath, storageKey: stored.key });
    assert.equal(await storage.headObject({ storedPath: stored.storedPath, storageKey: stored.key }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
