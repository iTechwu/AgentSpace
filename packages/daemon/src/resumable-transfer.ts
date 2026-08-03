import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Chunked/resumable transfer utilities for large workspace blobs.
 *
 * Downloads use HTTP Range requests and a per-operation checkpoint file so an
 * interrupted materialization can resume from the last fully written chunk.
 * Uploads use a bounded concurrency pool; true multipart upload needs server-side
 * Content-Range PUT support and is marked as a future protocol extension.
 */

export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB
export const LARGE_BLOB_THRESHOLD_BYTES = 64 * 1024 * 1024; // 64 MiB
export const DEFAULT_TRANSFER_CONCURRENCY = 4;

export interface BlobDownloadCheckpoint {
  taskId: string;
  revisionId: string;
  sha256: string;
  size: number;
  chunkSize: number;
  completedChunks: number[];
  startedAt: string;
  updatedAt: string;
}

export interface DownloadBlobEntry {
  sha256: string;
  size: number;
  mediaType?: string;
}

export interface DownloadResult {
  downloadedBytes: number;
  reusedBytes: number;
  resumedChunks: number;
}

export interface UploadResult {
  uploadedBytes: number;
  uploadedFiles: number;
}

export interface FetchRange {
  (taskId: string, revisionId: string, sha256: string, start: number, end: number): Promise<Uint8Array>;
}

export interface UploadBlob {
  (taskId: string, sha256: string, bytes: Uint8Array): Promise<void>;
}

export interface ReadBlobBytes {
  (sha256: string, size: number): Promise<Uint8Array>;
}

function checkpointPath(stateDir: string, sha256: string): string {
  return resolve(stateDir, "workspace-blob-checkpoints", sha256.slice(0, 2), `${sha256}.json`);
}

export function readCheckpoint(stateDir: string, entry: DownloadBlobEntry, taskId: string, revisionId: string): BlobDownloadCheckpoint | undefined {
  const path = checkpointPath(stateDir, entry.sha256);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BlobDownloadCheckpoint;
    if (
      parsed.taskId === taskId &&
      parsed.revisionId === revisionId &&
      parsed.sha256 === entry.sha256 &&
      parsed.size === entry.size &&
      parsed.chunkSize > 0
    ) {
      return parsed;
    }
  } catch {
    // Invalid checkpoint: ignore and re-download.
  }
  return undefined;
}

function writeCheckpoint(stateDir: string, checkpoint: BlobDownloadCheckpoint): void {
  const path = checkpointPath(stateDir, checkpoint.sha256);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(checkpoint), { mode: 0o600 });
  renameSync(temp, path);
}

function deleteCheckpoint(stateDir: string, sha256: string): void {
  const path = checkpointPath(stateDir, sha256);
  if (existsSync(path)) rmSync(path, { force: true });
}

function chunkCount(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/**
 * Downloads a single blob using Range requests when it exceeds the threshold.
 * Writes chunks to a temporary file next to the final path; once all chunks are
 * verified, atomically renames the temporary file to the target path and removes
 * the checkpoint. Smaller blobs fall through to a single fetch call.
 */
export async function downloadBlobWithResume(input: {
  taskId: string;
  revisionId: string;
  entry: DownloadBlobEntry;
  targetPath: string;
  stateDir: string;
  fetchRange?: FetchRange;
  fetchWhole?: (taskId: string, revisionId: string, sha256: string) => Promise<Uint8Array>;
  chunkSize?: number;
}): Promise<{ downloadedBytes: number; reusedBytes: number; resumedChunks: number }> {
  const { taskId, revisionId, entry, targetPath, stateDir, fetchRange, fetchWhole } = input;
  const chunkSize = input.chunkSize ?? CHUNK_SIZE_BYTES;

  if (entry.size <= LARGE_BLOB_THRESHOLD_BYTES || entry.size <= chunkSize || !fetchRange) {
    if (fetchWhole) {
      const bytes = await fetchWhole(taskId, revisionId, entry.sha256);
      assertBlobBytes(entry.sha256, entry.size, bytes);
      writeAtomic(targetPath, bytes);
      return { downloadedBytes: bytes.byteLength, reusedBytes: 0, resumedChunks: 0 };
    }
    if (!fetchRange) {
      throw new Error("workspace.no_fetch_provider: either fetchWhole or fetchRange must be provided.");
    }
    const bytes = await fetchRange(taskId, revisionId, entry.sha256, 0, entry.size - 1);
    assertBlobBytes(entry.sha256, entry.size, bytes);
    writeAtomic(targetPath, bytes);
    return { downloadedBytes: bytes.byteLength, reusedBytes: 0, resumedChunks: 0 };
  }

  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.chunked`;
  let checkpoint = readCheckpoint(stateDir, entry, taskId, revisionId);
  const completed = new Set(checkpoint?.completedChunks ?? []);
  const totalChunks = chunkCount(entry.size, chunkSize);
  let resumedChunks = completed.size;

  try {
    mkdirSync(dirname(tempPath), { recursive: true });
    // Pre-allocate/initialize the temp file if it does not exist or size is wrong.
    if (!existsSync(tempPath) || statSync(tempPath).size !== entry.size) {
      writeFileSync(tempPath, new Uint8Array(0));
      truncateSync(tempPath, entry.size);
      completed.clear();
      resumedChunks = 0;
    }

    for (let index = 0; index < totalChunks; index += 1) {
      if (completed.has(index)) continue;
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize - 1, entry.size - 1);
      const chunk = await fetchRange(taskId, revisionId, entry.sha256, start, end);
      if (chunk.byteLength !== end - start + 1) {
        throw new Error(`workspace.chunk_size_mismatch: expected ${end - start + 1} bytes, got ${chunk.byteLength}`);
      }
      const fd = openSync(tempPath, "r+");
      try {
        writeSync(fd, Buffer.from(chunk), 0, chunk.byteLength, start);
      } finally {
        closeSync(fd);
      }
      completed.add(index);
      checkpoint = {
        taskId,
        revisionId,
        sha256: entry.sha256,
        size: entry.size,
        chunkSize,
        completedChunks: Array.from(completed).sort((a, b) => a - b),
        startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeCheckpoint(stateDir, checkpoint);
    }

    const bytes = readFileSync(tempPath);
    assertBlobBytes(entry.sha256, entry.size, bytes);
    renameSync(tempPath, targetPath);
    deleteCheckpoint(stateDir, entry.sha256);
    return { downloadedBytes: entry.size, reusedBytes: 0, resumedChunks };
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Uploads a list of blob entries with bounded concurrency. Each upload is
 * retried independently. Large single blobs are still uploaded as one request;
 * server-side multipart/Content-Range PUT support is required for true chunking.
 */
export async function uploadBlobsWithConcurrency(input: {
  taskId: string;
  entries: Array<{ sha256: string; size: number; readBytes: () => Promise<Uint8Array> }>;
  uploadBlob: UploadBlob;
  concurrency?: number;
}): Promise<UploadResult> {
  const concurrency = input.concurrency ?? DEFAULT_TRANSFER_CONCURRENCY;
  const queue = [...input.entries];
  let uploadedBytes = 0;
  let uploadedFiles = 0;
  let firstError: unknown;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const entry = queue.shift();
      if (!entry) break;
      try {
        const bytes = await entry.readBytes();
        await input.uploadBlob(input.taskId, entry.sha256, bytes);
        uploadedBytes += bytes.byteLength;
        uploadedFiles += 1;
      } catch (error) {
        firstError = error;
      }
    }
  }));

  if (firstError) throw firstError;
  return { uploadedBytes, uploadedFiles };
}

function writeAtomic(targetPath: string, bytes: Uint8Array): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, targetPath);
  } finally {
    rmSync(temp, { force: true });
  }
}

function assertBlobBytes(sha256: string, size: number, bytes: Uint8Array): void {
  if (bytes.byteLength !== size) {
    throw new Error(`workspace.blob_size_mismatch: expected ${size}, got ${bytes.byteLength}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) {
    throw new Error(`workspace.blob_digest_mismatch: expected ${sha256}, got ${digest}`);
  }
}

function truncateSync(path: string, size: number): void {
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

/**
 * Formats a human-readable transfer rate.
 */
export function formatTransferRate(bytes: number, durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "N/A";
  const bytesPerSecond = (bytes / durationMs) * 1000;
  if (bytesPerSecond >= 1024 * 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(2)} GiB/s`;
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MiB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(2)} KiB/s`;
  return `${bytesPerSecond.toFixed(2)} B/s`;
}
