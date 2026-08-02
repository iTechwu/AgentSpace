import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  getDatabase,
  listSkillArtifactBindingsForSkillSync,
  listSkillArtifactsForSkillSync,
  listStoredAgentSkillAssignmentsSync,
  listStoredSkillImportEventsSync,
  readSkillArtifactByDigestSync,
  readStoredSkillActiveArtifactDigestSync,
  readStoredWorkspaceSkillSync,
} from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  createEmployeeSync,
  createWorkspaceSkillSync,
  importWorkspaceSkillFromUrl,
  importWorkspaceSkillFromZipUpload,
  inspectWorkspaceSkillSourceUpdate,
  listWorkspaceSkillsSync,
  resetWorkspaceStateSync,
  setAttachmentStorageClientForTests,
  setEmployeeSkillIdsSync,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";
import { MAX_SKILL_ARCHIVE_BYTES, MAX_SKILL_PACKAGE_FILES } from "./package/archive-limits.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-skill-import-"));
const originalFetch = globalThis.fetch;
const testTosStorage = createTestTosAttachmentStorage();

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage.client);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  globalThis.fetch = createGitHubFetchMock();
});

after(() => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
});

test("importWorkspaceSkillFromUrl imports a GitHub skill directory with source metadata", async () => {
  const result = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
  });

  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill?.name, "research-pack");
  assert.equal(skill?.description, "Research helper");
  assert.equal(skill?.sourceType, "github");
  assert.equal(skill?.sourceUrl, "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack");
  assert.equal(skill?.files.some((file) => file.path === "templates/checklist.md"), true);
  assert.equal(result.created, true);
  assert.equal(result.renamed, false);
  assert.equal(listStoredSkillImportEventsSync(undefined, 5)[0]?.skillId, result.skillId);
});

test("importWorkspaceSkillFromUrl locks GitHub imports to an immutable commit SHA", async () => {
  const result = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
  });

  assert.ok(result.artifactDigest);
  const artifact = readSkillArtifactByDigestSync(result.artifactDigest, "default");
  assert.ok(artifact);
  const provenance = JSON.parse(artifact.provenanceJson) as { resolvedRef?: string; originalUrl?: string };
  assert.equal(provenance.resolvedRef, "abc123def456789012345678901234567890abcd");
  assert.equal(provenance.originalUrl, "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack");
  assert.deepEqual(listSkillArtifactBindingsForSkillSync(result.skillId), [result.artifactDigest]);
  assert.deepEqual(listSkillArtifactsForSkillSync(result.skillId).map((item) => item.digest), [result.artifactDigest]);
});

test("inspectWorkspaceSkillSourceUpdate detects a newer ref without creating a candidate", async () => {
  const imported = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
  });
  const artifactCountBefore = listSkillArtifactsForSkillSync(imported.skillId).length;
  const bindingsBefore = listSkillArtifactBindingsForSkillSync(imported.skillId);

  const unchanged = await inspectWorkspaceSkillSourceUpdate({ skillId: imported.skillId });
  assert.equal(unchanged.status, "up_to_date");
  assert.equal(unchanged.currentResolvedRef, "abc123def456789012345678901234567890abcd");
  assert.equal(unchanged.latestResolvedRef, unchanged.currentResolvedRef);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.github.com/repos/octo-org/skill-repo/commits/main") {
      return jsonResponse({ sha: "fedcba987654321001234567890123456789abcd" });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  try {
    const update = await inspectWorkspaceSkillSourceUpdate({ skillId: imported.skillId });
    assert.equal(update.status, "update_available");
    assert.equal(update.currentResolvedRef, "abc123def456789012345678901234567890abcd");
    assert.equal(update.latestResolvedRef, "fedcba987654321001234567890123456789abcd");
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(listSkillArtifactsForSkillSync(imported.skillId).length, artifactCountBefore);
  assert.deepEqual(listSkillArtifactBindingsForSkillSync(imported.skillId), bindingsBefore);
  assert.equal(readStoredSkillActiveArtifactDigestSync(imported.skillId), imported.artifactDigest);
});

test("inspectWorkspaceSkillSourceUpdate honors the operations freeze before network access", async () => {
  const imported = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
  });
  const previousFlag = process.env.DOFE_SKILL_SOURCE_UPDATE_CHECKS_ENABLED;
  const previousFetch = globalThis.fetch;
  process.env.DOFE_SKILL_SOURCE_UPDATE_CHECKS_ENABLED = "false";
  globalThis.fetch = (async () => {
    throw new Error("network access must remain frozen");
  }) as typeof fetch;
  try {
    const inspection = await inspectWorkspaceSkillSourceUpdate({ skillId: imported.skillId });
    assert.equal(inspection.status, "disabled");
    assert.equal(inspection.reason, "skill_source_updates_disabled");
  } finally {
    restoreEnvironmentVariable("DOFE_SKILL_SOURCE_UPDATE_CHECKS_ENABLED", previousFlag);
    globalThis.fetch = previousFetch;
  }
});

test("inspectWorkspaceSkillSourceUpdate handles a deduplicated artifact with different provenance", async () => {
  const seeded = buildAndPersistSkillArtifactSync({
    name: "research-pack",
    files: [
      {
        path: "SKILL.md",
        bytes: strToU8("---\nname: research-pack\ndescription: Research helper\n---\n\n# Research Pack\n\nUse for structured research.\n"),
      },
      { path: "templates/checklist.md", bytes: strToU8("- confirm sources\n") },
    ],
    sourceType: "local",
    sourceUrl: "/seed/research-pack",
    provenance: { provider: "local" },
  });
  getDatabase().prepare(
    "UPDATE skill_artifact SET provenance_json = ? WHERE workspace_id = ? AND digest = ?",
  ).run(JSON.stringify({ provider: "local" }), "default", seeded.digest);

  const imported = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
  });
  const artifact = readSkillArtifactByDigestSync(imported.artifactDigest!, "default");
  assert.ok(artifact);
  assert.equal((JSON.parse(artifact.provenanceJson) as { provider?: string }).provider, "local");
  assert.deepEqual(listSkillArtifactBindingsForSkillSync(imported.skillId), [imported.artifactDigest]);

  const inspection = await inspectWorkspaceSkillSourceUpdate({ skillId: imported.skillId });
  assert.equal(inspection.status, "up_to_date");
  assert.equal(inspection.currentResolvedRef, "abc123def456789012345678901234567890abcd");
});

test("importWorkspaceSkillFromUrl imports a paginated GitLab directory at an immutable commit", async () => {
  const result = await importWorkspaceSkillFromUrl({
    url: "https://gitlab.com/octo-group/skill-repo/-/tree/main/skills/research-pack",
  });

  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill.sourceType, "gitlab");
  assert.equal(skill.name, "gitlab-research-pack");
  assert.equal(skill.files.some((file) => file.path === "references/checklist.md"), true);
  assert.equal(skill.files.some((file) => file.path === "scripts/run.sh"), true);

  const artifact = readSkillArtifactByDigestSync(result.artifactDigest!, "default");
  assert.ok(artifact);
  const provenance = JSON.parse(artifact.provenanceJson) as { resolvedRef?: string; originalUrl?: string };
  assert.equal(provenance.resolvedRef, "def456abc789012345678901234567890abcdef1");
  assert.equal(provenance.originalUrl, "https://gitlab.com/octo-group/skill-repo/-/tree/main/skills/research-pack");
  const manifest = JSON.parse(artifact.manifestJson) as { files: Array<{ path: string; mode?: string }> };
  assert.equal(manifest.files.find((file) => file.path === "scripts/run.sh")?.mode, "0755");
});

test("importWorkspaceSkillFromUrl imports a skills.sh page by resolving its GitHub source", async () => {
  const result = await importWorkspaceSkillFromUrl({
    url: "https://skills.sh/apollographql/skills/skill-creator",
  });

  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill?.sourceType, "skills.sh");
  assert.equal(skill?.name, "skill-creator");
});

test("importWorkspaceSkillFromUrl resolves quoted skills.sh skill names", async () => {
  const result = await importWorkspaceSkillFromUrl({
    url: "https://skills.sh/aj-geddes/claude-code-bmad-skills/product-manager",
    conflict: "rename",
  });

  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill?.sourceType, "skills.sh");
  assert.equal(skill?.name.startsWith("product-manager"), true);
  assert.equal(skill?.files.some((file) => file.path === "templates/prd.template.md"), true);
});

test("importWorkspaceSkillFromUrl can rename on conflict", async () => {
  createWorkspaceSkillSync({
    name: "research-pack",
    description: "Manual version",
  });

  const result = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
    conflict: "rename",
  });

  assert.equal(result.created, true);
  assert.equal(result.renamed, true);
  assert.ok(listWorkspaceSkillsSync().some((skill) => skill.id === result.skillId && skill.name !== "research-pack"));
});

test("importWorkspaceSkillFromUrl can replace existing skills without dropping assignments", async () => {
  createEmployeeSync({ name: "Planner" });
  const original = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Manual version",
  });
  setEmployeeSkillIdsSync("Planner", [original.id]);

  const result = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
    conflict: "replace",
  });

  assert.equal(result.created, false);
  assert.equal(result.replaced, true);
  assert.equal(result.skillId, original.id);
  const replaced = listWorkspaceSkillsSync().find((skill) => skill.id === original.id);
  assert.ok(replaced);
  assert.equal(replaced?.description, "Research helper");
  assert.equal(
    listStoredAgentSkillAssignmentsSync().some((assignment) => assignment.employeeName === "Planner" && assignment.skillId === original.id),
    true,
  );
});

test("importWorkspaceSkillFromUrl rejects a ClawHub archive exceeding the download limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://clawhub.ai/oversized/skill") {
      return new Response(
        '<html><body><a href="https://wry-manatee-359.convex.site/api/v1/download?slug=oversized">Download</a></body></html>',
        { status: 200 },
      );
    }
    if (url.includes("oversized")) {
      return new Response(Buffer.alloc(MAX_SKILL_ARCHIVE_BYTES + 1), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    return originalFetch(input);
  }) as typeof fetch;

  try {
    await assert.rejects(
      async () =>
        importWorkspaceSkillFromUrl({
          url: "https://clawhub.ai/oversized/skill",
        }),
      /exceeds.*byte (download|upload) limit/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importWorkspaceSkillFromUrl imports a ClawHub zip package", async () => {
  const result = await importWorkspaceSkillFromUrl({
    url: "https://clawhub.ai/fangkelvin/find-skills-skill",
  });

  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill?.name, "find-skills");
  assert.equal(skill?.sourceType, "clawhub");
  assert.equal(skill?.files.some((file) => file.path === "_meta.json"), false);
});

test("importWorkspaceSkillFromUrl imports a local skill directory", async () => {
  const localSkillDir = join(tempRoot, "local-skill");
  mkdirSync(join(localSkillDir, "references"), { recursive: true });
  mkdirSync(join(localSkillDir, "bin"), { recursive: true });
  mkdirSync(join(localSkillDir, "assets"), { recursive: true });
  writeFileSync(join(localSkillDir, "SKILL.md"), `---
name: local-research
description: Local skill
---

# Local Research
  `);
  writeFileSync(join(localSkillDir, "references", "notes.md"), "- local notes\n");
  writeFileSync(join(localSkillDir, "bin", "render.mjs"), "export default {};\n");
  chmodSync(join(localSkillDir, "bin", "render.mjs"), 0o755);
  writeFileSync(join(localSkillDir, "assets", "template.html"), "<main>template</main>\n");

  const result = await importWorkspaceSkillFromUrl({
    url: localSkillDir,
  });

  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill?.sourceType, "local");
  assert.equal(skill?.files.some((file) => file.path === "references/notes.md"), true);
  assert.equal(skill?.files.some((file) => file.path === "bin/render.mjs"), true);
  assert.equal(skill?.files.some((file) => file.path === "assets/template.html"), true);
  const artifact = readSkillArtifactByDigestSync(result.artifactDigest!, "default");
  assert.ok(artifact);
  const manifest = JSON.parse(artifact.manifestJson) as { files: Array<{ path: string; mode?: string }> };
  assert.equal(manifest.files.find((file) => file.path === "bin/render.mjs")?.mode, "0755");
});

test("local directory import rejects packages that exceed the file-count budget", async () => {
  const localSkillDir = mkdtempSync(join(tempRoot, "oversized-local-skill-"));
  writeFileSync(join(localSkillDir, "SKILL.md"), "---\nname: oversized-local\ndescription: Too many files\n---\n# Skill\n");
  for (let index = 0; index < MAX_SKILL_PACKAGE_FILES; index += 1) {
    writeFileSync(join(localSkillDir, `file-${index}.txt`), "x");
  }

  await assert.rejects(
    () => importWorkspaceSkillFromUrl({ url: localSkillDir }),
    new RegExp(`more than ${MAX_SKILL_PACKAGE_FILES} files`),
  );
});

test("zip import rejects traversal entries before path normalization", async () => {
  const archive = zipSync({
    "SKILL.md": strToU8("---\nname: unsafe-zip\ndescription: Unsafe zip\n---\n# Skill\n"),
    "../escape.txt": strToU8("escape"),
  });

  await assert.rejects(
    () => importWorkspaceSkillFromZipUpload({ fileName: "unsafe.zip", contentBytes: archive }),
    /unsafe entry.*Parent-directory/,
  );
});

test("importWorkspaceSkillFromUrl renames a builtin-named local skill with conflict: rename", async () => {
  const localSkillDir = join(tempRoot, "local-product-manager");
  mkdirSync(join(localSkillDir, "templates"), { recursive: true });
  writeFileSync(join(localSkillDir, "SKILL.md"), `---
name: product-manager
description: Local product manager clone
---

# Local PM
`);
  writeFileSync(join(localSkillDir, "templates", "prd.template.md"), "# PRD\n");

  const result = await importWorkspaceSkillFromUrl({
    url: localSkillDir,
    conflict: "rename",
  });

  assert.equal(result.created, true);
  assert.equal(result.renamed, true);
  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill?.name.startsWith("product-manager"), true);
  assert.notEqual(skill?.name, "product-manager");
  assert.equal(skill?.files.some((file) => file.path === "templates/prd.template.md"), true);
});

test("imports an uploaded zip by reading the persisted TOS object", async () => {
  const archive = zipSync({
    "SKILL.md": strToU8(`---
name: tos-research
description: TOS upload
---

# TOS Research
`),
    "references/checklist.md": strToU8("- read from TOS\n"),
  });

  const result = await importWorkspaceSkillFromZipUpload({
    fileName: "research-pack.zip",
    contentBytes: archive,
  });

  const skill = listWorkspaceSkillsSync().find((item) => item.id === result.skillId);
  assert.ok(skill);
  assert.equal(skill?.sourceType, "tos");
  assert.match(skill?.sourceUrl ?? "", /^tos:\/\/test-bucket\/workspaces\//);
  assert.equal(skill?.files.some((file) => file.path === "references/checklist.md"), true);
  assert.match(result.sourceUrl, /^tos:\/\/test-bucket\/workspaces\//);

  const reimported = await importWorkspaceSkillFromUrl({
    url: result.sourceUrl,
    conflict: "replace",
  });
  assert.equal(reimported.replaced, true);
  assert.equal(reimported.sourceType, "tos");
});

test("zip manifest version and executable mode survive validation into the stored artifact", async () => {
  const skillBytes = strToU8("---\nname: manifest-skill\ndescription: Manifest contract\n---\n# Skill\n");
  const toolBytes = new Uint8Array([1, 2, 3, 4]);
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: 1,
    artifact: { name: "manifest-skill", version: "2.3.4" },
    files: [
      { path: "SKILL.md", sha256: digest(skillBytes), size: skillBytes.byteLength, mediaType: "text/markdown", mode: "0644" },
      { path: "bin/tool", sha256: digest(toolBytes), size: toolBytes.byteLength, mediaType: "application/octet-stream", mode: "0755" },
    ],
  };
  const archive = zipSync({
    "SKILL.md": skillBytes,
    "bin/tool": toolBytes,
    ".dofe/manifest.json": strToU8(JSON.stringify(manifest)),
  });

  const result = await importWorkspaceSkillFromZipUpload({ fileName: "manifest-skill.zip", contentBytes: archive });
  const artifact = readSkillArtifactByDigestSync(result.artifactDigest!, "default");
  assert.ok(artifact);
  const storedManifest = JSON.parse(artifact.manifestJson) as typeof manifest;
  assert.equal(storedManifest.artifact.version, "2.3.4");
  assert.equal(storedManifest.files.find((file) => file.path === "bin/tool")?.mode, "0755");
  assert.equal(storedManifest.files.some((file) => file.path === ".dofe/manifest.json"), false);
});

test("imports and reimports an uploaded zip from explicit local attachment storage", async () => {
  const localRoot = mkdtempSync(join(tmpdir(), "dofe-agent-local-skill-import-"));
  const originalProvider = process.env.ATTACHMENT_STORAGE_PROVIDER;
  const originalFallback = process.env.ATTACHMENT_ENABLE_LOCAL_FALLBACK;
  const originalRoot = process.env.SELF_HOSTED_ATTACHMENT_LOCAL_ROOT;
  setAttachmentStorageClientForTests(undefined);
  process.env.ATTACHMENT_STORAGE_PROVIDER = "local";
  process.env.ATTACHMENT_ENABLE_LOCAL_FALLBACK = "true";
  process.env.SELF_HOSTED_ATTACHMENT_LOCAL_ROOT = localRoot;
  try {
    const archive = zipSync({
      "SKILL.md": strToU8("---\nname: local-upload-research\ndescription: Local upload\n---\n\n# Local Upload Research\n"),
    });
    const result = await importWorkspaceSkillFromZipUpload({
      fileName: "local-research.zip",
      contentBytes: archive,
    });
    assert.equal(result.sourceType, "local");
    assert.match(result.sourceUrl, /^local:\/\/\/workspaces\//);

    const reimported = await importWorkspaceSkillFromUrl({
      url: result.sourceUrl,
      conflict: "replace",
    });
    assert.equal(reimported.replaced, true);
    assert.equal(reimported.sourceType, "local");
  } finally {
    setAttachmentStorageClientForTests(testTosStorage.client);
    restoreEnvironmentVariable("ATTACHMENT_STORAGE_PROVIDER", originalProvider);
    restoreEnvironmentVariable("ATTACHMENT_ENABLE_LOCAL_FALLBACK", originalFallback);
    restoreEnvironmentVariable("SELF_HOSTED_ATTACHMENT_LOCAL_ROOT", originalRoot);
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test("importWorkspaceSkillFromUrl can skip an existing conflict", async () => {
  const existing = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Existing manual version",
  });

  const result = await importWorkspaceSkillFromUrl({
    url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
    conflict: "skip",
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skillId, existing.id);
});

test("a failed zip import leaves no new skill, files, active digest or import event", async () => {
  const beforeSkillIds = new Set(listWorkspaceSkillsSync().map((skill) => skill.id));
  const beforeEventCount = listStoredSkillImportEventsSync(undefined, 100).length;

  const badArchive = zipSync({
    "README.md": strToU8("# missing SKILL.md"),
  });

  await assert.rejects(
    () =>
      importWorkspaceSkillFromZipUpload({
        fileName: "bad.zip",
        contentBytes: badArchive,
      }),
    /must contain SKILL\.md/,
  );

  const newSkills = listWorkspaceSkillsSync().filter((skill) => !beforeSkillIds.has(skill.id));
  assert.deepEqual(newSkills, []);
  assert.equal(listStoredSkillImportEventsSync(undefined, 100).length, beforeEventCount);
});

test("a failed zip replace leaves the existing skill and assignment pin unchanged", async () => {
  const archive = zipSync({
    "SKILL.md": strToU8(`---
name: atomic-replace
description: Original
---

# Original
`),
    "script.sh": strToU8("#!/bin/sh\necho ok\n"),
  });

  const original = await importWorkspaceSkillFromZipUpload({
    fileName: "original.zip",
    contentBytes: archive,
  });

  createEmployeeSync({ name: "Tester" });
  setEmployeeSkillIdsSync("Tester", [original.skillId]);

  const originalSkill = readStoredWorkspaceSkillSync(original.skillId);
  assert.ok(originalSkill);
  const originalDigest = readStoredSkillActiveArtifactDigestSync(original.skillId);
  const originalFileIds = originalSkill.files.map((file) => file.id).sort();
  const beforeEventCount = listStoredSkillImportEventsSync(undefined, 100).length;

  const badArchive = zipSync({
    "SKILL.md": strToU8(`---
name: atomic-replace
description: Bad replace
---

# Bad
`),
    ".dofe/manifest.json": strToU8("{ not json"),
  });

  await assert.rejects(
    () =>
      importWorkspaceSkillFromZipUpload({
        fileName: "bad.zip",
        contentBytes: badArchive,
        conflict: "replace",
      }),
    /manifest/i,
  );

  const afterSkill = readStoredWorkspaceSkillSync(original.skillId);
  assert.ok(afterSkill);
  assert.equal(afterSkill.name, originalSkill.name);
  assert.equal(afterSkill.description, originalSkill.description);
  assert.deepEqual(afterSkill.files.map((file) => file.id).sort(), originalFileIds);
  assert.equal(readStoredSkillActiveArtifactDigestSync(original.skillId), originalDigest);
  assert.ok(
    listStoredAgentSkillAssignmentsSync().some(
      (assignment) => assignment.employeeName === "Tester" && assignment.skillId === original.skillId,
    ),
  );
  assert.equal(listStoredSkillImportEventsSync(undefined, 100).length, beforeEventCount);
});

test("a successful replace records a candidate artifact without activating it", async () => {
  const first = await importWorkspaceSkillFromZipUpload({
    fileName: "candidate-v1.zip",
    contentBytes: zipSync({
      "SKILL.md": strToU8("---\nname: candidate-import\ndescription: Version one\n---\n# v1\n"),
    }),
  });
  const activeBefore = readStoredSkillActiveArtifactDigestSync(first.skillId);
  assert.equal(activeBefore, first.artifactDigest);

  const second = await importWorkspaceSkillFromZipUpload({
    fileName: "candidate-v2.zip",
    contentBytes: zipSync({
      "SKILL.md": strToU8("---\nname: candidate-import\ndescription: Version two\n---\n# v2\n"),
    }),
    conflict: "replace",
  });

  assert.notEqual(second.artifactDigest, activeBefore);
  assert.equal(readStoredSkillActiveArtifactDigestSync(first.skillId), activeBefore);
  assert.deepEqual(
    new Set(listSkillArtifactBindingsForSkillSync(first.skillId)),
    new Set([activeBefore!, second.artifactDigest!]),
  );
});

function createGitHubFetchMock(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://gitlab.com/api/v4/projects/octo-group%2Fskill-repo/repository/commits/main") {
      return jsonResponse({
        id: "def456abc789012345678901234567890abcdef1",
      });
    }
    if (url.startsWith("https://gitlab.com/api/v4/projects/octo-group%2Fskill-repo/repository/tree?")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("path"), "skills/research-pack");
      assert.equal(parsed.searchParams.get("ref"), "def456abc789012345678901234567890abcdef1");
      assert.equal(parsed.searchParams.get("recursive"), "true");
      if (parsed.searchParams.get("page") === "2") {
        return jsonResponse([
          { type: "blob", path: "skills/research-pack/scripts/run.sh", mode: "100755" },
        ]);
      }
      return jsonResponse([
        { type: "blob", path: "skills/research-pack/SKILL.md", mode: "100644" },
        { type: "blob", path: "skills/research-pack/references/checklist.md", mode: "100644" },
      ], { "x-next-page": "2" });
    }
    if (url.startsWith("https://gitlab.com/api/v4/projects/octo-group%2Fskill-repo/repository/files/")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("ref"), "def456abc789012345678901234567890abcdef1");
      const filePath = decodeURIComponent(parsed.pathname.split("/repository/files/")[1]!.replace(/\/raw$/, ""));
      const contents: Record<string, string> = {
        "skills/research-pack/SKILL.md": "---\nname: gitlab-research-pack\ndescription: GitLab research helper\n---\n# GitLab Research\n",
        "skills/research-pack/references/checklist.md": "- verify immutable ref\n",
        "skills/research-pack/scripts/run.sh": "#!/bin/sh\necho ready\n",
      };
      return contents[filePath] === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(contents[filePath], { status: 200 });
    }
    if (url === "https://api.github.com/repos/apollographql/skills") {
      return jsonResponse({
        default_branch: "main",
      });
    }
    if (url === "https://api.github.com/repos/octo-org/skill-repo/commits/main" ||
        url === "https://api.github.com/repos/apollographql/skills/commits/main" ||
        url === "https://api.github.com/repos/aj-geddes/claude-code-bmad-skills/commits/main") {
      return jsonResponse({
        sha: "abc123def456789012345678901234567890abcd",
      });
    }
    if (url.includes("/git/trees/") && url.includes("?recursive=1")) {
      if (url.includes("/apollographql/skills/")) {
        return jsonResponse({
          tree: [
            {
              path: "packages/skill-creator/SKILL.md",
              type: "blob",
            },
            {
              path: "packages/skill-creator/references/checklist.md",
              type: "blob",
            },
          ],
        });
      }
      if (url.includes("/aj-geddes/claude-code-bmad-skills/")) {
        return jsonResponse({
          tree: [
            {
              path: "bmad-skills/product-manager/SKILL.md",
              type: "blob",
            },
            {
              path: "bmad-skills/product-manager/templates/prd.template.md",
              type: "blob",
            },
          ],
        });
      }
    }
    if (url === "https://skills.sh/apollographql/skills/skill-creator") {
      return new Response(
        '<html><body><code>npx skills add https://github.com/apollographql/skills --skill skill-creator</code></body></html>',
        { status: 200 },
      );
    }
    if (url === "https://skills.sh/aj-geddes/claude-code-bmad-skills/product-manager") {
      return new Response(
        "<html><body><code>npx skills add https://github.com/aj-geddes/claude-code-bmad-skills --skill &#x27;Product Manager&#x27;</code></body></html>",
        { status: 200 },
      );
    }
    if (url === "https://api.github.com/repos/aj-geddes/claude-code-bmad-skills") {
      return jsonResponse({
        default_branch: "main",
      });
    }
    if (url.includes("/contents/bmad-skills/product-manager?")) {
      return jsonResponse([
        {
          type: "file",
          name: "SKILL.md",
          path: "bmad-skills/product-manager/SKILL.md",
        },
        {
          type: "dir",
          name: "templates",
          path: "bmad-skills/product-manager/templates",
        },
      ]);
    }
    if (url.includes("/contents/bmad-skills/product-manager/templates?")) {
      return jsonResponse([
        {
          type: "file",
          name: "prd.template.md",
          path: "bmad-skills/product-manager/templates/prd.template.md",
        },
      ]);
    }
    if (url.includes("/contents/bmad-skills/product-manager/SKILL.md?")) {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from(`---
name: product-manager
description: Product requirements and planning specialist
---

# Product Manager
`).toString("base64"),
      });
    }
    if (url.includes("/contents/bmad-skills/product-manager/templates/prd.template.md?")) {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from("# PRD template\n").toString("base64"),
      });
    }
    if (url.includes("/contents/skills/research-pack?")) {
      return jsonResponse([
        {
          type: "file",
          name: "SKILL.md",
          path: "skills/research-pack/SKILL.md",
        },
        {
          type: "dir",
          name: "templates",
          path: "skills/research-pack/templates",
        },
      ]);
    }
    if (url.includes("/contents/skills/research-pack/templates?")) {
      return jsonResponse([
        {
          type: "file",
          name: "checklist.md",
          path: "skills/research-pack/templates/checklist.md",
        },
      ]);
    }
    if (url.includes("/contents/skills/research-pack/SKILL.md?")) {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from(`---
name: research-pack
description: Research helper
---

# Research Pack

Use for structured research.
`).toString("base64"),
      });
    }
    if (url.includes("/contents/skills/research-pack/templates/checklist.md?")) {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from("- confirm sources\n").toString("base64"),
      });
    }
    if (url.includes("/contents/packages/skill-creator?")) {
      return jsonResponse([
        {
          type: "file",
          name: "SKILL.md",
          path: "packages/skill-creator/SKILL.md",
        },
        {
          type: "dir",
          name: "references",
          path: "packages/skill-creator/references",
        },
      ]);
    }
    if (url.includes("/contents/packages/skill-creator/references?")) {
      return jsonResponse([
        {
          type: "file",
          name: "checklist.md",
          path: "packages/skill-creator/references/checklist.md",
        },
      ]);
    }
    if (url.includes("/contents/packages/skill-creator/SKILL.md?")) {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from(`---
name: skill-creator
description: Create high-quality skills
---

# Skill Creator
`).toString("base64"),
      });
    }
    if (url.includes("/contents/packages/skill-creator/references/checklist.md?")) {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from("- write good frontmatter\n").toString("base64"),
      });
    }
    if (url === "https://clawhub.ai/fangkelvin/find-skills-skill") {
      return new Response(
        '<html><body><a href="https://wry-manatee-359.convex.site/api/v1/download?slug=find-skills-skill">Download</a></body></html>',
        { status: 200 },
      );
    }
    if (url === "https://wry-manatee-359.convex.site/api/v1/download?slug=find-skills-skill") {
      const zip = zipSync({
        "SKILL.md": Buffer.from(`---
name: find-skills
description: Search and discover skills
---

# Find Skills
`),
        "_meta.json": Buffer.from(JSON.stringify({ slug: "find-skills-skill", version: "1.0.0" })),
      });
      return new Response(zip, {
        status: 200,
        headers: {
          "content-type": "application/zip",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
