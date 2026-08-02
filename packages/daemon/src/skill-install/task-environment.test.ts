import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { getDaemonSkillInstallEnvsDirPath } from "@dofe-agent/db";
import { buildSkillDependencyTaskEnvironment, publishSkillDependencyEnvironment, resetSkillDependencyEnvironment } from "./task-environment.ts";

test("buildSkillDependencyTaskEnvironment makes frozen npm and Python dependencies importable", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-task-env-"));
  const workspaceId = "workspace-1";
  const installationId = "installation-1";
  const envsDir = getDaemonSkillInstallEnvsDirPath(stateDir, { workspaceId, installationId });
  mkdirSync(join(envsDir, "node_modules", "fixture-package"), { recursive: true });
  mkdirSync(join(envsDir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(envsDir, "bin"), { recursive: true });
  writeFileSync(join(envsDir, "node_modules", "fixture-package", "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(envsDir, "node_modules", "fixture-package", "index.js"), "module.exports = 'node-ready';\n");
  writeFileSync(join(envsDir, "fixture_python.py"), "VALUE = 'python-ready'\n");
  publishSkillDependencyEnvironment({
    envsDir,
    installationId,
    artifactDigest: "b".repeat(64),
    releaseLockDigest: "a".repeat(64),
  });

  try {
    const env = buildSkillDependencyTaskEnvironment({
      stateDir,
      workspaceId,
      environments: [{ installationId, artifactDigest: "b".repeat(64), releaseLockDigest: "a".repeat(64) }],
      baseEnv: { PATH: "/usr/bin", NODE_PATH: "/existing/node", PYTHONPATH: "/existing/python" },
    });
    assert.equal(execFileSync(process.execPath, ["-e", "process.stdout.write(require('fixture-package'))"], { env }).toString(), "node-ready");
    assert.equal(execFileSync("python3", ["-c", "import fixture_python; print(fixture_python.VALUE, end='')"], { env }).toString(), "python-ready");
    assert.equal(env.NODE_PATH, `${join(envsDir, "node_modules")}${delimiter}/existing/node`);
    assert.equal(env.PYTHONPATH, `${envsDir}${delimiter}/existing/python`);
    assert.equal(statSync(join(envsDir, "fixture_python.py")).mode & 0o222, 0);
  } finally {
    resetSkillDependencyEnvironment(envsDir);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("dependency environments fail closed when missing or pinned to another release", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-task-env-fail-"));
  try {
    assert.throws(() => buildSkillDependencyTaskEnvironment({
      stateDir,
      workspaceId: "workspace-1",
      environments: [{ installationId: "missing", artifactDigest: "b".repeat(64), releaseLockDigest: "a".repeat(64) }],
    }), /skill_dependency_environment_missing.*missing/);

    const envsDir = getDaemonSkillInstallEnvsDirPath(stateDir, { workspaceId: "workspace-1", installationId: "stale" });
    mkdirSync(envsDir, { recursive: true });
    publishSkillDependencyEnvironment({ envsDir, installationId: "stale", artifactDigest: "b".repeat(64), releaseLockDigest: "a".repeat(64) });
    assert.throws(() => buildSkillDependencyTaskEnvironment({
      stateDir,
      workspaceId: "workspace-1",
      environments: [{ installationId: "stale", artifactDigest: "b".repeat(64), releaseLockDigest: "c".repeat(64) }],
    }), /skill_dependency_environment_mismatch.*stale/);
  } finally {
    const staleEnv = getDaemonSkillInstallEnvsDirPath(stateDir, { workspaceId: "workspace-1", installationId: "stale" });
    resetSkillDependencyEnvironment(staleEnv);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
