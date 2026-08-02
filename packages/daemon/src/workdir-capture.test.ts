import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { collectWorkDirChanges, WORKDIR_CAPTURE_INCLUDE_DIRS } from "./workdir-capture.ts";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-wdc-"));
});

function writeWorkDir(filePath: string, content: string | Uint8Array): void {
  const absolutePath = join(tempRoot, filePath);
  mkdirSync(join(tempRoot, filePath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(absolutePath, content);
}

function sha256Of(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

test("captures only the bounded include subtrees, ignoring transient dirs", () => {
  writeWorkDir("repository/src/a.ts", "export const a = 1;");
  writeWorkDir("state/checkpoint.json", "{\"step\": 2}");
  writeWorkDir("artifacts/report.pdf", "pdf-bytes");
  writeWorkDir("checkpoints/run-1.json", "{}");
  // Transient / rebuilt subtrees must never be captured.
  writeWorkDir(".codex/skills/foo/SKILL.md", "skill");
  writeWorkDir(".agent_context/skills/foo/SKILL.md", "skill");
  writeWorkDir("runtime-output/agent-output.json", "{}");
  writeWorkDir("node_modules/pkg/index.js", "transient");

  const result = collectWorkDirChanges(tempRoot);
  const paths = result.files.map((f) => f.path).sort();

  assert.deepEqual(
    paths,
    ["artifacts/report.pdf", "checkpoints/run-1.json", "repository/src/a.ts", "state/checkpoint.json"],
  );
  assert.equal(result.skippedUnchanged, 0);
  assert.equal(result.truncated, false);
  for (const includeDir of WORKDIR_CAPTURE_INCLUDE_DIRS) {
    assert.ok(paths.some((p) => p.startsWith(`${includeDir}/`)), `${includeDir} present`);
  }
});

test("drops files whose sha256 matches the head manifest", () => {
  const bytes = new TextEncoder().encode("unchanged-file");
  writeWorkDir("repository/src/unchanged.ts", bytes);
  writeWorkDir("repository/src/changed.ts", "new-content");

  const headManifest = {
    files: [{ path: "repository/src/unchanged.ts", sha256: sha256Of(bytes) }],
  };
  const result = collectWorkDirChanges(tempRoot, headManifest);

  assert.equal(result.skippedUnchanged, 1);
  const paths = result.files.map((f) => f.path);
  assert.ok(!paths.includes("repository/src/unchanged.ts"), "unchanged file dropped");
  assert.ok(paths.includes("repository/src/changed.ts"), "changed file kept");
  const changed = result.files.find((f) => f.path === "repository/src/changed.ts")!;
  assert.equal(changed.sha256, sha256Of(new TextEncoder().encode("new-content")));
});

test("truncates when the single-file budget is exceeded", () => {
  const big = new Uint8Array(11 * 1024 * 1024); // > 10 MB
  writeWorkDir("repository/src/big.bin", big);
  writeWorkDir("repository/src/small.ts", "ok");

  const result = collectWorkDirChanges(tempRoot);

  assert.equal(result.truncated, true);
  assert.ok(!result.files.some((f) => f.path === "repository/src/big.bin"), "oversized file dropped");
  assert.ok(result.files.some((f) => f.path === "repository/src/small.ts"), "small file kept");
});

test("refuses to follow a file symlink that points outside the workDir", () => {
  // External secret file OUTSIDE the workDir that a provider would try to smuggle in.
  const outsideSecret = join(tmpdir(), `dofe-wdc-secret-${Date.now()}`);
  writeFileSync(outsideSecret, "super-secret");
  writeWorkDir("repository/src/ok.ts", "fine");
  symlinkSync(outsideSecret, join(tempRoot, "repository/leaked-secret.txt"));

  const result = collectWorkDirChanges(tempRoot);
  const paths = result.files.map((f) => f.path);
  assert.ok(!paths.includes("repository/leaked-secret.txt"), "symlink target must not be captured");
  assert.ok(paths.includes("repository/src/ok.ts"), "regular file still captured");
  rmSync(outsideSecret, { force: true });
});

test("refuses to capture when a top-level include dir is a symlink to outside", () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "dofe-wdc-top-"));
  writeFileSync(join(outsideDir, "secret.txt"), "top-level-secret");
  // `repository` itself points outside the workDir — inner-entry checks alone
  // would be bypassed; the root lstat+realpath gate must drop the whole subtree.
  symlinkSync(outsideDir, join(tempRoot, "repository"));
  writeWorkDir("state/checkpoint.json", "{}");

  const result = collectWorkDirChanges(tempRoot);
  const paths = result.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith("repository/")), "top-level symlink contents must not be captured");
  assert.ok(paths.includes("state/checkpoint.json"), "sibling subtree still captured");
  rmSync(outsideDir, { recursive: true, force: true });
});

test("reports deleted paths for head files missing under the workDir", () => {
  const goneBytes = new TextEncoder().encode("will-be-deleted");
  writeWorkDir("repository/gone.ts", goneBytes);
  const keptBytes = new TextEncoder().encode("still-there");
  writeWorkDir("repository/kept.ts", keptBytes);
  const headManifest = {
    files: [
      { path: "repository/gone.ts", sha256: sha256Of(goneBytes) },
      { path: "repository/kept.ts", sha256: sha256Of(keptBytes) },
      { path: "report.txt", sha256: "1111" }, // non-captured path must be ignored
    ],
  };
  // gone.ts exists in head but is removed from the workDir; kept.ts remains.
  rmSync(join(tempRoot, "repository/gone.ts"), { force: true });

  const result = collectWorkDirChanges(tempRoot, headManifest);
  assert.deepEqual(result.deletedPaths, ["repository/gone.ts"]);
});

test("refuses to follow a directory symlink that points outside the workDir", () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "dofe-wdc-dir-"));
  writeFileSync(join(outsideDir, "credentials.json"), "{" + '"k": "v"' + "}");
  mkdirSync(join(tempRoot, "state"), { recursive: true });
  symlinkSync(outsideDir, join(tempRoot, "state/linked"));
  writeWorkDir("state/checkpoint.json", "{}");

  const result = collectWorkDirChanges(tempRoot);
  const paths = result.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.includes("linked/")), "directory symlink contents must not be captured");
  assert.ok(paths.includes("state/checkpoint.json"), "regular sibling still captured");
  rmSync(outsideDir, { recursive: true, force: true });
});

test("captured files carry path, sha256 and size matching the on-disk bytes", () => {
  const content = new TextEncoder().encode("hello workdir");
  writeWorkDir("state/state.bin", content);

  const result = collectWorkDirChanges(tempRoot);
  assert.equal(result.files.length, 1);
  const file = result.files[0]!;
  assert.equal(file.path, "state/state.bin");
  assert.equal(file.size, content.byteLength);
  assert.equal(file.sha256, sha256Of(content));
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(content));
});

test("capture root itself must exist; missing include dirs are skipped", () => {
  const result = collectWorkDirChanges(join(tempRoot, "does-not-exist"));
  assert.equal(result.files.length, 0);
  assert.equal(result.truncated, false);
});

test("capture is a no-op when the workDir has no include subtrees", () => {
  mkdirSync(join(tempRoot, "only-transient"), { recursive: true });
  writeFileSync(join(tempRoot, "only-transient", "x.txt"), "x");
  const result = collectWorkDirChanges(tempRoot);
  assert.equal(result.files.length, 0);
  assert.equal(existsSync(tempRoot), true);
  rmSync(tempRoot, { recursive: true, force: true });
});
