import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { materializeRemoteInputBundle } from "../../packages/daemon/src/bundle.ts";

const phase = process.argv[2];
const expectedDownloaded = Number(process.argv[3]);
const expectedReused = Number(process.argv[4]);
const requiredExistingPath = process.argv[5] || "";
if (!phase || !Number.isInteger(expectedDownloaded) || !Number.isInteger(expectedReused)) {
  throw new Error("usage: runtime-volume-worker.mjs <phase> <downloaded> <reused> [required-existing-path]");
}
if (requiredExistingPath && !existsSync(requiredExistingPath)) {
  throw new Error(`required persisted file is missing: ${requiredExistingPath}`);
}

const casRoot = "/drill/cas";
const manifest = JSON.parse(readFileSync("/drill/manifest.json", "utf8"));
const workDir = `/home/dofe-agent/work/${phase}`;
let fetchCount = 0;
const bundle = {
  taskId: `ead-${phase}`,
  workspaceId: "ead-isolated-drill",
  agentId: "employee-ead-drill",
  runtimeId: `runtime-${phase}`,
  prompt: "D-07/D-08 isolated recovery drill",
  files: [],
  workspace: manifest,
};
const result = await materializeRemoteInputBundle({
  stateDir: "/home/dofe-agent/state",
  workDir,
  bundle,
  fetchWorkspaceBlob: async (_taskId, _revisionId, sha256) => {
    fetchCount += 1;
    return readFileSync(join(casRoot, sha256));
  },
});

if (result.downloadedBlobs !== expectedDownloaded || result.reusedBlobs !== expectedReused) {
  throw new Error(`unexpected cache result: ${JSON.stringify(result)}`);
}
if (fetchCount !== expectedDownloaded) {
  throw new Error(`unexpected CAS fetch count: ${fetchCount}`);
}
for (const file of manifest.files) {
  const bytes = readFileSync(join(workDir, file.path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== file.sha256 || bytes.byteLength !== file.size) {
    throw new Error(`restored file mismatch: ${file.path}`);
  }
}

process.stdout.write(`${JSON.stringify({ phase, workDir, fetchCount, ...result, filesVerified: manifest.files.length })}\n`);
