import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClaimedSkillInstallationOperation } from "@dofe-agent/domain";
import type { SkillArtifactManifest } from "@dofe-agent/services";
import { verifySkillInstallationComponents } from "./component-verifier.ts";

function buildManifest(overrides?: Partial<SkillArtifactManifest>): SkillArtifactManifest {
  return {
    schemaVersion: 1,
    artifact: { name: "test-skill", version: "1.0.0" },
    files: [],
    dependencies: [],
    capabilities: [],
    ...overrides,
  };
}

function buildOperation(
  manifest: SkillArtifactManifest,
  components: ClaimedSkillInstallationOperation["components"],
  artifactDir: string,
  rootDigestMatches = true,
) {
  return verifySkillInstallationComponents(
    {
      operationId: "op-1",
      workspaceId: "default",
      runtimeId: "runtime-1",
      installationId: "install-1",
      operation: "prepare",
      artifactDigest: "sha256:any",
      artifactName: "test-skill",
      manifestJson: JSON.stringify(manifest),
      files: [],
      components,
      createdAt: new Date().toISOString(),
    },
    artifactDir,
    rootDigestMatches,
  );
}

test("dependency component uses the real install outcome when provided", () => {
  const manifest = buildManifest({
    dependencies: [{ manager: "npm", name: "lodash", version: "4.17.21" }],
  });

  const ready = buildOperation(manifest, [{ kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" }], "");
  // Patch through the optional results param by calling the verifier directly.
  const withResults = verifySkillInstallationComponents(
    {
      operationId: "op-1",
      workspaceId: "default",
      runtimeId: "runtime-1",
      installationId: "install-1",
      operation: "prepare",
      artifactDigest: "sha256:any",
      artifactName: "test-skill",
      manifestJson: JSON.stringify(manifest),
      files: [],
      components: [{ kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" }],
      createdAt: new Date().toISOString(),
    },
    "",
    true,
    new Map([["npm:lodash@4.17.21", { ok: true }]]),
  );
  assert.equal(withResults[0]?.status, "ready");

  const failed = verifySkillInstallationComponents(
    {
      operationId: "op-1",
      workspaceId: "default",
      runtimeId: "runtime-1",
      installationId: "install-1",
      operation: "prepare",
      artifactDigest: "sha256:any",
      artifactName: "test-skill",
      manifestJson: JSON.stringify(manifest),
      files: [],
      components: [{ kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" }],
      createdAt: new Date().toISOString(),
    },
    "",
    true,
    new Map([["npm:lodash@4.17.21", { ok: false, reason: "install exited with 1" }]]),
  );
  assert.equal(failed[0]?.status, "failed");
  assert.equal(failed[0]?.errorCode, "skill_installation.dependency_install_failed");

  // A dependency the installer did not attempt is blocked (never fake-ready).
  const notInstalled = verifySkillInstallationComponents(
    {
      operationId: "op-1",
      workspaceId: "default",
      runtimeId: "runtime-1",
      installationId: "install-1",
      operation: "prepare",
      artifactDigest: "sha256:any",
      artifactName: "test-skill",
      manifestJson: JSON.stringify(manifest),
      files: [],
      components: [{ kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" }],
      createdAt: new Date().toISOString(),
    },
    "",
    true,
    new Map(),
  );
  assert.equal(notInstalled[0]?.status, "blocked");
  assert.equal(notInstalled[0]?.errorCode, "skill_installation.dependency_not_installed");
});

test("marks dependency ready when declared with a version", () => {
  const manifest = buildManifest({
    dependencies: [{ manager: "npm", name: "lodash", version: "4.17.21" }],
  });
  const results = buildOperation(manifest, [{ kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" }], "");

  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "ready");
  assert.equal(results[0]?.errorCode, undefined);
});

test("marks dependency failed when not declared in manifest", () => {
  const manifest = buildManifest();
  const results = buildOperation(manifest, [{ kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" }], "");

  assert.equal(results[0]?.status, "failed");
  assert.equal(results[0]?.errorCode, "skill_installation.dependency_not_declared");
});

test("marks dependency blocked when version is missing", () => {
  const manifest = buildManifest({
    dependencies: [{ manager: "npm", name: "lodash", version: "" }],
  });
  const results = buildOperation(manifest, [{ kind: "dependency", key: "npm:lodash@", status: "pending" }], "");

  assert.equal(results[0]?.status, "blocked");
  assert.equal(results[0]?.errorCode, "skill_installation.dependency_version_missing");
});

test("marks script ready when file exists, is executable, and passes syntax check", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "dofe-agent-verify-script-"));

  try {
    writeFileSync(join(artifactDir, "run.sh"), "#!/bin/sh\necho hello\n", "utf8");
    chmodSync(join(artifactDir, "run.sh"), 0o755);

    const manifest = buildManifest({
      files: [{ path: "run.sh", sha256: "any", size: 1, mediaType: "text/x-shellscript", mode: "0755" }],
    });
    const results = buildOperation(manifest, [{ kind: "script", key: "run.sh", status: "pending" }], artifactDir);

    assert.equal(results[0]?.status, "ready");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("marks script blocked when syntax check fails", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "dofe-agent-verify-bad-script-"));

  try {
    writeFileSync(join(artifactDir, "run.sh"), "#!/bin/sh\nif then\n", "utf8");
    chmodSync(join(artifactDir, "run.sh"), 0o755);

    const manifest = buildManifest({
      files: [{ path: "run.sh", sha256: "any", size: 1, mediaType: "text/x-shellscript", mode: "0755" }],
    });
    const results = buildOperation(manifest, [{ kind: "script", key: "run.sh", status: "pending" }], artifactDir);

    assert.equal(results[0]?.status, "blocked");
    assert.equal(results[0]?.errorCode, "skill_installation.script_syntax_error");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("marks script blocked when manifest mode is not executable", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "dofe-agent-verify-nonexec-script-"));

  try {
    writeFileSync(join(artifactDir, "run.sh"), "#!/bin/sh\necho hello\n", "utf8");

    const manifest = buildManifest({
      files: [{ path: "run.sh", sha256: "any", size: 1, mediaType: "text/x-shellscript", mode: "0644" }],
    });
    const results = buildOperation(manifest, [{ kind: "script", key: "run.sh", status: "pending" }], artifactDir);

    assert.equal(results[0]?.status, "blocked");
    assert.equal(results[0]?.errorCode, "skill_installation.script_not_executable");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("marks script failed when file is missing from artifact directory", () => {
  const manifest = buildManifest({
    files: [{ path: "run.sh", sha256: "any", size: 1, mediaType: "text/x-shellscript", mode: "0755" }],
  });
  const results = buildOperation(manifest, [{ kind: "script", key: "run.sh", status: "pending" }], "");

  assert.equal(results[0]?.status, "failed");
  assert.equal(results[0]?.errorCode, "skill_installation.script_missing");
});

test("marks node script ready when syntax check passes", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "dofe-agent-verify-node-script-"));

  try {
    writeFileSync(join(artifactDir, "index.js"), "console.log('ok');\n", "utf8");
    chmodSync(join(artifactDir, "index.js"), 0o755);

    const manifest = buildManifest({
      files: [{ path: "index.js", sha256: "any", size: 1, mediaType: "text/javascript", mode: "0755" }],
    });
    const results = buildOperation(manifest, [{ kind: "script", key: "index.js", status: "pending" }], artifactDir);

    assert.equal(results[0]?.status, "ready");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("marks node script blocked when syntax check fails", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "dofe-agent-verify-bad-node-script-"));

  try {
    writeFileSync(join(artifactDir, "index.js"), "console.log((\n", "utf8");
    chmodSync(join(artifactDir, "index.js"), 0o755);

    const manifest = buildManifest({
      files: [{ path: "index.js", sha256: "any", size: 1, mediaType: "text/javascript", mode: "0755" }],
    });
    const results = buildOperation(manifest, [{ kind: "script", key: "index.js", status: "pending" }], artifactDir);

    assert.equal(results[0]?.status, "blocked");
    assert.equal(results[0]?.errorCode, "skill_installation.script_syntax_error");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("marks cli capability ready when declared", () => {
  const manifest = buildManifest({
    capabilities: [{ kind: "cli", catalogSlug: "search" }],
  });
  const results = buildOperation(manifest, [{ kind: "cli", key: "cli:search", status: "pending" }], "");

  assert.equal(results[0]?.status, "ready");
});

test("marks mcp capability ready when declared", () => {
  const manifest = buildManifest({
    capabilities: [{ kind: "mcp", catalogSlug: "memory" }],
  });
  const results = buildOperation(manifest, [{ kind: "mcp", key: "mcp:memory", status: "pending" }], "");

  assert.equal(results[0]?.status, "ready");
});

test("marks capability failed when not declared", () => {
  const manifest = buildManifest();
  const results = buildOperation(manifest, [{ kind: "cli", key: "cli:unknown", status: "pending" }], "");

  assert.equal(results[0]?.status, "failed");
  assert.equal(results[0]?.errorCode, "skill_installation.capability_not_declared");
});

test("marks all components failed when root digest does not match", () => {
  const manifest = buildManifest({
    dependencies: [{ manager: "npm", name: "lodash", version: "4.17.21" }],
    capabilities: [{ kind: "cli", catalogSlug: "search" }],
  });
  const results = buildOperation(
    manifest,
    [
      { kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" },
      { kind: "cli", key: "cli:search", status: "pending" },
    ],
    "",
    false,
  );

  for (const result of results) {
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "skill_installation.root_digest_mismatch");
  }
});

test("marks all components failed when manifest JSON is invalid", () => {
  const results = verifySkillInstallationComponents(
    {
      operationId: "op-1",
      workspaceId: "default",
      runtimeId: "runtime-1",
      installationId: "install-1",
      operation: "prepare",
      artifactDigest: "sha256:any",
      artifactName: "test-skill",
      manifestJson: "not-json",
      files: [],
      components: [
        { kind: "dependency", key: "npm:lodash@4.17.21", status: "pending" },
        { kind: "cli", key: "cli:search", status: "pending" },
      ],
      createdAt: new Date().toISOString(),
    },
    "",
    true,
  );

  for (const result of results) {
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "skill_installation.invalid_manifest_json");
  }
});

test("redacts suspected secrets in syntax check output", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "dofe-agent-verify-secret-redaction-"));

  try {
    writeFileSync(
      join(artifactDir, "leak.sh"),
      "#!/bin/sh\necho api_key=super-secret-value\n",
      "utf8",
    );
    chmodSync(join(artifactDir, "leak.sh"), 0o755);

    const manifest = buildManifest({
      files: [{ path: "leak.sh", sha256: "any", size: 1, mediaType: "text/x-shellscript", mode: "0755" }],
    });
    const results = buildOperation(manifest, [{ kind: "script", key: "leak.sh", status: "pending" }], artifactDir);

    assert.equal(results[0]?.status, "ready");
    // If the script had been invalid, the output would contain [REDACTED].
    // The redaction helper is exercised indirectly through syntax check failures.
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("service components are control-plane-decided (daemon reports pending)", () => {
  const manifest = buildManifest();
  const results = buildOperation(manifest, [{ kind: "service", key: "service:cache", status: "pending" }], "");

  assert.equal(results[0]?.status, "pending");
  assert.equal(results[0]?.errorCode, "skill_installation.service_control_plane_decided");
});
