import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  buildAttachmentStorageKey,
  ContentAddressedBlobIntegrityError,
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

test("idempotent attachment keys remain stable across calendar partitions", () => {
  const input = {
    workspaceId: "workspace-mars",
    attachmentId: "att-idem-task-output",
    fileName: "report.txt",
  };
  const january = buildAttachmentStorageKey({ ...input, createdAt: new Date("2026-01-31T23:59:59.000Z") });
  const february = buildAttachmentStorageKey({ ...input, createdAt: new Date("2026-02-01T00:00:01.000Z") });

  assert.equal(january, february);
  assert.equal(
    january,
    "workspaces/workspace-mars/attachments/idempotent/att-idem-task-output/report.txt",
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

test("local attachment storage atomically replays a deterministic object key", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-local-attachment-replay-"));
  try {
    const storage = createAttachmentStorageClient({ provider: "local", local: { root } });
    const input = {
      workspaceId: "workspace-mars",
      attachmentId: "att-idem-task-1",
      fileName: "report.txt",
      contentBytes: Buffer.from("first", "utf8"),
      mediaType: "text/plain",
    };
    const first = storage.putObjectSync(input);
    const replay = storage.putObjectSync(input);
    assert.equal(replay.key, first.key);
    assert.deepEqual(
      storage.getObjectSync({ storedPath: replay.storedPath, storageKey: replay.key }),
      new Uint8Array(Buffer.from("first", "utf8")),
    );

    const replaced = storage.putObjectSync({ ...input, contentBytes: Buffer.from("second", "utf8") });
    assert.equal(replaced.key, first.key);
    assert.deepEqual(
      storage.getObjectSync({ storedPath: replaced.storedPath, storageKey: replaced.key }),
      new Uint8Array(Buffer.from("second", "utf8")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local content-addressed streaming upload verifies size and digest before publish", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-local-streaming-blobs-"));
  try {
    const storage = createAttachmentStorageClient({ provider: "local", local: { root } });
    const bytes = Buffer.from("verified OpenMontage output", "utf8");
    const sha256 = sha256Hex(bytes);
    const stored = await storage.putContentAddressedBlobStream!({
      workspaceId: "workspace-mars",
      sha256,
      content: Readable.from([bytes.subarray(0, 9), bytes.subarray(9)]),
      sizeBytes: bytes.byteLength,
      mediaType: "video/mp4",
    });

    assert.equal(stored.sha256, sha256);
    assert.equal(stored.sizeBytes, bytes.byteLength);
    assert.deepEqual(
      storage.getContentAddressedBlobSync({ workspaceId: "workspace-mars", sha256 }),
      new Uint8Array(bytes),
    );

    const tamperedDigest = sha256Hex(Buffer.from("expected bytes", "utf8"));
    await assert.rejects(
      storage.putContentAddressedBlobStream!({
        workspaceId: "workspace-mars",
        sha256: tamperedDigest,
        content: Readable.from([Buffer.from("tampered bytes", "utf8")]),
        sizeBytes: Buffer.byteLength("expected bytes"),
        mediaType: "video/mp4",
      }),
      ContentAddressedBlobIntegrityError,
    );
    assert.equal(
      storage.contentAddressedBlobExistsSync({
        workspaceId: "workspace-mars",
        sha256: tamperedDigest,
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
