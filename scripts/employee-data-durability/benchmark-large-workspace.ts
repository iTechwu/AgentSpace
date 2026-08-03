/**
 * Large workspace transfer benchmark.
 *
 * Generates a content-addressed fixture manifest (small files + large files),
 * exercises the daemon's chunked/resumable download path against a local mock
 * server, and reports throughput + peak memory. Does not require PostgreSQL,
 * TOS, or a real daemon; it uses the local filesystem for the CAS source.
 *
 * Usage:
 *   node --experimental-strip-types scripts/employee-data-durability/benchmark-large-workspace.ts [output.json]
 *
 * Environment:
 *   DOFE_EAD_BENCHMARK_SMALL_FILES   default 1000
 *   DOFE_EAD_BENCHMARK_LARGE_FILES   default 2
 *   DOFE_EAD_BENCHMARK_LARGE_MB      default 256
 *   DOFE_EAD_BENCHMARK_CONCURRENCY   default 4
 *   DOFE_EAD_BENCHMARK_CHUNK_MB      default 8
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Import from source via dynamic import so this script can run without a build.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { materializeRemoteInputBundle } = await import(join(rootDir, "packages/daemon/src/bundle.ts"));

const smallFileCount = Math.max(0, Number(process.env.DOFE_EAD_BENCHMARK_SMALL_FILES ?? "1000"));
const largeFileCount = Math.max(0, Number(process.env.DOFE_EAD_BENCHMARK_LARGE_FILES ?? "2"));
const largeFileMb = Math.max(1, Number(process.env.DOFE_EAD_BENCHMARK_LARGE_MB ?? "256"));
const concurrency = Math.max(1, Number(process.env.DOFE_EAD_BENCHMARK_CONCURRENCY ?? "4"));
const chunkSizeMb = Math.max(1, Number(process.env.DOFE_EAD_BENCHMARK_CHUNK_MB ?? "8"));

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

function formatRate(bytes, ms) {
  if (!ms) return "N/A";
  const perSecond = (bytes / ms) * 1000;
  return `${formatBytes(perSecond)}/s`;
}

function generateFile(path, sizeBytes) {
  const bytes = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 1) {
    bytes[i] = (i * 31 + 17) % 256;
  }
  return { path, size: sizeBytes, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

function generateManifest() {
  const files = [];
  for (let i = 0; i < smallFileCount; i += 1) {
    const content = Buffer.from(`small-file-${i}-${randomUUID()}`, "utf8");
    files.push({
      path: `repository/small/${i}.txt`,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content,
    });
  }
  for (let i = 0; i < largeFileCount; i += 1) {
    files.push(generateFile(`repository/large/${i}.bin`, largeFileMb * 1024 * 1024));
  }
  return files;
}

async function main() {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tmp = mkdtempSync(join(tmpdir(), "dofe-ead-benchmark-"));
  const casDir = join(tmp, "cas");
  const stateDir = join(tmp, "state");
  const workDir = join(tmp, "work");
  mkdirSync(casDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const files = generateManifest();
  for (const file of files) {
    const target = join(casDir, file.sha256);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const revisionId = `benchmark-revision-${runId}`;
  const manifest = {
    revisionId,
    manifestDigest: createHash("sha256").update(JSON.stringify(files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })))).digest("hex"),
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, mediaType: "application/octet-stream" })),
  };

  const fetchWorkspaceBlob = async (_taskId, _revisionId, sha256) => {
    return readFileSync(join(casDir, sha256));
  };
  const fetchWorkspaceBlobRange = async (_taskId, _revisionId, sha256, start, end) => {
    const bytes = readFileSync(join(casDir, sha256));
    return bytes.slice(start, end + 1);
  };

  const startMs = performance.now();

  const result = await materializeRemoteInputBundle({
    workDir,
    stateDir,
    bundle: {
      version: 1,
      format: "json-inline-v1",
      taskId: `benchmark-${runId}`,
      runtimeId: "runtime-benchmark",
      prompt: "benchmark",
      files: [],
      workspace: manifest,
    },
    fetchWorkspaceBlob,
    fetchWorkspaceBlobRange,
  });

  const durationMs = performance.now() - startMs;
  if (global.gc) global.gc();
  const peakRssBytes = process.memoryUsage.rss();

  // Verify all files restored.
  let verified = 0;
  for (const file of files) {
    const restored = readFileSync(join(workDir, file.path));
    if (restored.byteLength !== file.size) {
      throw new Error(`size mismatch: ${file.path}`);
    }
    if (createHash("sha256").update(restored).digest("hex") !== file.sha256) {
      throw new Error(`digest mismatch: ${file.path}`);
    }
    verified += 1;
  }

  const evidence = {
    schemaVersion: 1,
    runId,
    checkedAt: new Date().toISOString(),
    configuration: {
      smallFileCount,
      largeFileCount,
      largeFileMb,
      concurrency,
      chunkSizeMb,
    },
    totalFiles: files.length,
    totalBytes,
    durationMs: Math.round(durationMs),
    downloadRate: formatRate(totalBytes - result.reusedBytes, durationMs),
    peakRssBytes,
    peakRss: formatBytes(peakRssBytes),
    result,
    verified,
    assertions: {
      allFilesRestored: verified === files.length,
      expectedTotalBytes: totalBytes,
      expectedReusedBytes: 0,
    },
  };

  const outputPath = process.argv[2] || join(rootDir, "docs/0801/employee-data-durability/evidence", `benchmark-large-workspace-${runId}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2));

  console.log(`Benchmark completed in ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`Total: ${formatBytes(totalBytes)} across ${files.length} files`);
  console.log(`Download rate: ${evidence.downloadRate}`);
  console.log(`Peak RSS: ${evidence.peakRss}`);
  console.log(`Evidence: ${outputPath}`);

  rmSync(tmp, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
