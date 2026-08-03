import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadBlobWithResume } from "./resumable-transfer.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("small blobs download whole and verify the sha256", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-resume-"));
  const target = join(stateDir, "small.bin");
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const result = await downloadBlobWithResume({
    taskId: "t-1",
    revisionId: "r-1",
    entry: { sha256: sha256(bytes), size: bytes.byteLength, mediaType: "application/octet-stream" },
    targetPath: target,
    stateDir,
    fetchWhole: async () => bytes,
  });
  assert.equal(result.downloadedBytes, 5);
  assert.equal(result.resumedChunks, 0);
  assert.deepEqual([...readFileSync(target)], [...bytes]);
});

test("large blobs are downloaded in chunks via Range and verified", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-resume-"));
  const target = join(stateDir, "large.bin");
  const size = 65 * 1024 * 1024; // > LARGE_BLOB_THRESHOLD_BYTES → chunked path
  const blob = Buffer.alloc(size);
  blob.fill(0x42);
  const digest = sha256(blob);

  const requested: Array<[number, number]> = [];
  const fetchRange = async (_t: string, _r: string, _s: string, start: number, end: number) => {
    requested.push([start, end]);
    return blob.subarray(start, end + 1);
  };

  const result = await downloadBlobWithResume({
    taskId: "t-2",
    revisionId: "r-2",
    entry: { sha256: digest, size, mediaType: "application/octet-stream" },
    targetPath: target,
    stateDir,
    fetchRange,
    chunkSize: 8 * 1024 * 1024,
  });
  assert.equal(result.downloadedBytes, size);
  assert.ok(requested.length > 1, "large blob should be fetched in multiple Range requests");
  assert.equal(sha256(readFileSync(target)), digest, "downloaded content is verified against the sha256");
});

test("an interrupted chunked download recovers on retry and verifies", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-resume-"));
  const target = join(stateDir, "resume.bin");
  const size = 65 * 1024 * 1024;
  const blob = Buffer.alloc(size);
  blob.fill(0x24);
  const digest = sha256(blob);

  // First attempt fails after the first chunk (simulated daemon crash).
  let calls = 0;
  const flakyFetchRange = async (_t: string, _r: string, _s: string, start: number, end: number) => {
    calls += 1;
    if (calls === 2) {
      throw new Error("simulated network interruption");
    }
    return blob.subarray(start, end + 1);
  };
  await assert.rejects(
    () =>
      downloadBlobWithResume({
        taskId: "t-3",
        revisionId: "r-3",
        entry: { sha256: digest, size, mediaType: "application/octet-stream" },
        targetPath: target,
        stateDir,
        fetchRange: flakyFetchRange,
        chunkSize: 8 * 1024 * 1024,
      }),
    /simulated network interruption/,
  );
  assert.equal(existsSync(target), false, "an incomplete download never leaves a final target");

  // Retry with a healthy provider recovers and produces the verified blob.
  const retry = await downloadBlobWithResume({
    taskId: "t-3",
    revisionId: "r-3",
    entry: { sha256: digest, size, mediaType: "application/octet-stream" },
    targetPath: target,
    stateDir,
    fetchRange: async (_t: string, _r: string, _s: string, start: number, end: number) =>
      blob.subarray(start, end + 1),
    chunkSize: 8 * 1024 * 1024,
  });
  assert.equal(retry.downloadedBytes, size);
  assert.equal(sha256(readFileSync(target)), digest);
});
