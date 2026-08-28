import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createWorkspaceSync,
  insertWorkspaceRuntimeAppReleaseSync,
  listWorkspaceRuntimeAppReleasesSync,
  readWorkspaceRuntimeAppReleaseSync,
} from "./index.ts";
import { DEFAULT_WORKSPACE_ID, getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-runtime-app-releases-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM runtime_app_release");
  db.exec("DELETE FROM runtime_app_package");
});

test("private CLI releases are immutable and retain artifact provenance", () => {
  const release = insertWorkspaceRuntimeAppReleaseSync(releaseInput(DEFAULT_WORKSPACE_ID));

  assert.equal(release.packageSlug, "internal-search");
  assert.equal(release.artifactIntegrity, "sha512-dGVzdA==");
  assert.equal(listWorkspaceRuntimeAppReleasesSync(DEFAULT_WORKSPACE_ID).length, 1);
  assert.throws(
    () => insertWorkspaceRuntimeAppReleaseSync(releaseInput(DEFAULT_WORKSPACE_ID)),
    /unique|duplicate/i,
  );
});

test("private CLI releases cannot be read from another workspace", () => {
  const otherWorkspaceId = `private-cli-${Date.now()}`;
  createWorkspaceSync({ id: otherWorkspaceId, slug: otherWorkspaceId, name: "Private CLI Test", createdBy: "test" });
  const release = insertWorkspaceRuntimeAppReleaseSync(releaseInput(DEFAULT_WORKSPACE_ID));

  assert.equal(readWorkspaceRuntimeAppReleaseSync(release.id, otherWorkspaceId), null);
  assert.deepEqual(listWorkspaceRuntimeAppReleasesSync(otherWorkspaceId), []);
});

test.after(() => {
  process.chdir(originalCwd);
});

function releaseInput(workspaceId: string) {
  return {
    workspaceId,
    slug: "internal-search",
    displayName: "Internal Search",
    version: "1.4.2",
    artifactKind: "npm" as const,
    artifactName: "@example/internal-search",
    artifactUrl: "https://registry.npmjs.org/@example/internal-search/-/internal-search-1.4.2.tgz",
    artifactIntegrity: "sha512-dGVzdA==",
    entryPoint: "internal-search",
    manifestJson: "{}",
  };
}
