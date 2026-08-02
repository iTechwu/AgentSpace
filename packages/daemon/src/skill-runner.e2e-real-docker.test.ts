import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getDaemonSkillInstallCachePath, getDaemonSkillInstallEnvsDirPath } from "@dofe-agent/db";
import type { DaemonSkillRunnerEntrypoint, SkillEntrypointRuntime } from "@dofe-agent/domain";
import {
  publishSkillDependencyEnvironment,
  resetSkillDependencyEnvironment,
} from "./skill-install/task-environment.ts";
import { startSkillRunnerBroker } from "./skill-runner.ts";

const execFileAsync = promisify(execFile);
const RUN_E2E = process.env.DOFE_AGENT_RUN_SKILL_RUNNER_E2E === "1";
const WORKSPACE_ID = "skill-runner-real-e2e";
const ARTIFACT_DIGEST = "a".repeat(64);
const RELEASE_LOCK_DIGEST = "b".repeat(64);

function assertReleaseGateEnvironment(): void {
  assert.equal(process.platform, "linux", "real Skill Runner release gate must run on a Linux managed node");
  for (const key of [
    "DOFE_SKILL_RUNNER_NODE_IMAGE",
    "DOFE_SKILL_RUNNER_PYTHON_IMAGE",
    "DOFE_SKILL_RUNNER_BASH_IMAGE",
  ] as const) {
    const image = process.env[key] ?? "";
    assert.match(image, /@sha256:[a-f0-9]{64}$/i, `${key} must use an immutable image digest`);
    execFileSync(process.env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", ["image", "inspect", image], {
      stdio: "ignore",
      timeout: 30_000,
    });
  }
  execFileSync(process.env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", ["version"], {
    stdio: "ignore",
    timeout: 30_000,
  });
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createArtifact(input: {
  stateDir: string;
  artifactDigest: string;
  scriptName: string;
  script: string;
}): { artifactDir: string; scriptBytes: Buffer } {
  const artifactDir = getDaemonSkillInstallCachePath(input.stateDir, {
    workspaceId: WORKSPACE_ID,
    artifactDigest: input.artifactDigest,
  });
  const scriptsDir = join(artifactDir, "scripts");
  const scriptBytes = Buffer.from(input.script, "utf8");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, input.scriptName), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(scriptsDir, 0o555);
  chmodSync(artifactDir, 0o555);
  return { artifactDir, scriptBytes };
}

function createDependencyEnvironment(input: {
  stateDir: string;
  installationId: string;
  artifactDigest: string;
}): string {
  const envsDir = getDaemonSkillInstallEnvsDirPath(input.stateDir, {
    workspaceId: WORKSPACE_ID,
    installationId: input.installationId,
  });
  mkdirSync(join(envsDir, "node_modules", "dofe-runner-fixture"), { recursive: true });
  writeFileSync(
    join(envsDir, "node_modules", "dofe-runner-fixture", "package.json"),
    JSON.stringify({ name: "dofe-runner-fixture", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(
    join(envsDir, "node_modules", "dofe-runner-fixture", "index.js"),
    "module.exports = 'node-dependency-ready';\n",
  );
  writeFileSync(join(envsDir, "dofe_runner_fixture.py"), "VALUE = 'python-dependency-ready'\n");
  publishSkillDependencyEnvironment({
    envsDir,
    installationId: input.installationId,
    artifactDigest: input.artifactDigest,
    releaseLockDigest: RELEASE_LOCK_DIGEST,
  });
  return envsDir;
}

function entrypoint(input: {
  id: string;
  installationId: string;
  artifactDigest: string;
  scriptName: string;
  scriptBytes: Buffer;
  runtime: SkillEntrypointRuntime;
  configKeys?: string[];
}): DaemonSkillRunnerEntrypoint {
  return {
    key: `${input.installationId}:${input.id}`,
    skillId: `skill-${input.id}`,
    skillName: `Real ${input.runtime} Runner`,
    installationId: input.installationId,
    artifactDigest: input.artifactDigest,
    sha256: digest(input.scriptBytes),
    id: input.id,
    path: `scripts/${input.scriptName}`,
    runtime: input.runtime,
    configKeys: input.configKeys,
  };
}

test("REAL DOCKER: Node, Python and Bash Runner isolation and dependency consumption", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  assertReleaseGateEnvironment();

  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-real-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-real-work-"));
  const nodeDigest = `1${ARTIFACT_DIGEST.slice(1)}`;
  const pythonDigest = `2${ARTIFACT_DIGEST.slice(1)}`;
  const bashDigest = `3${ARTIFACT_DIGEST.slice(1)}`;
  const nodeInstallation = "real-node-installation";
  const pythonInstallation = "real-python-installation";
  const dependencyDirs: string[] = [];
  const artifacts: string[] = [];
  let broker: Awaited<ReturnType<typeof startSkillRunnerBroker>> | undefined;

  try {
    const nodeArtifact = createArtifact({
      stateDir,
      artifactDigest: nodeDigest,
      scriptName: "node.cjs",
      script: `const fs = require("node:fs");
const dependency = require("dofe-runner-fixture");
let workspaceReadOnly = false;
try { fs.writeFileSync("/workspace/runner-must-not-write", "blocked"); } catch { workspaceReadOnly = true; }
const config = JSON.parse(fs.readFileSync(process.env.DOFE_SKILL_CONFIG_FILE, "utf8"));
const result = {
  runtime: "node",
  dependency,
  workspaceReadOnly,
  interfaces: fs.readdirSync("/sys/class/net").sort(),
  dockerSocketVisible: fs.existsSync("/var/run/docker.sock"),
  hostSecretVisible: Boolean(process.env.DOFE_E2E_HOST_SECRET),
  configMounted: config.REAL_RUNNER_TOKEN === "mounted-only",
};
fs.writeFileSync(process.env.DOFE_SKILL_OUTPUT_DIR + "/node.json", JSON.stringify(result));
`,
    });
    artifacts.push(nodeArtifact.artifactDir);
    const pythonArtifact = createArtifact({
      stateDir,
      artifactDigest: pythonDigest,
      scriptName: "python.py",
      script: `import json, os
import dofe_runner_fixture
workspace_read_only = False
try:
    open("/workspace/runner-must-not-write-python", "w").write("blocked")
except OSError:
    workspace_read_only = True
result = {
    "runtime": "python",
    "dependency": dofe_runner_fixture.VALUE,
    "workspaceReadOnly": workspace_read_only,
    "interfaces": sorted(os.listdir("/sys/class/net")),
    "dockerSocketVisible": os.path.exists("/var/run/docker.sock"),
    "hostSecretVisible": bool(os.environ.get("DOFE_E2E_HOST_SECRET")),
}
with open(os.environ["DOFE_SKILL_OUTPUT_DIR"] + "/python.json", "w") as output:
    json.dump(result, output)
`,
    });
    artifacts.push(pythonArtifact.artifactDir);
    const bashArtifact = createArtifact({
      stateDir,
      artifactDigest: bashDigest,
      scriptName: "bash.sh",
      script: `#!/usr/bin/env bash
set -euo pipefail
interfaces=(/sys/class/net/*)
[[ \${#interfaces[@]} -eq 1 && \${interfaces[0]##*/} == "lo" ]]
[[ ! -S /var/run/docker.sock ]]
[[ -z "\${DOFE_E2E_HOST_SECRET:-}" ]]
if printf blocked > /workspace/runner-must-not-write-bash 2>/dev/null; then exit 41; fi
printf '{"runtime":"bash","isolated":true}\n' > "\${DOFE_SKILL_OUTPUT_DIR}/bash.json"
`,
    });
    artifacts.push(bashArtifact.artifactDir);

    dependencyDirs.push(createDependencyEnvironment({
      stateDir,
      installationId: nodeInstallation,
      artifactDigest: nodeDigest,
    }));
    dependencyDirs.push(createDependencyEnvironment({
      stateDir,
      installationId: pythonInstallation,
      artifactDigest: pythonDigest,
    }));

    const entrypoints = [
      entrypoint({
        id: "node",
        installationId: nodeInstallation,
        artifactDigest: nodeDigest,
        scriptName: "node.cjs",
        scriptBytes: nodeArtifact.scriptBytes,
        runtime: "node",
        configKeys: ["REAL_RUNNER_TOKEN"],
      }),
      entrypoint({
        id: "python",
        installationId: pythonInstallation,
        artifactDigest: pythonDigest,
        scriptName: "python.py",
        scriptBytes: pythonArtifact.scriptBytes,
        runtime: "python",
      }),
      entrypoint({
        id: "bash",
        installationId: "real-bash-installation",
        artifactDigest: bashDigest,
        scriptName: "bash.sh",
        scriptBytes: bashArtifact.scriptBytes,
        runtime: "bash",
      }),
    ];
    broker = await startSkillRunnerBroker({
      stateDir,
      workspaceId: WORKSPACE_ID,
      workDir,
      entrypoints,
      dependencyEnvironments: [
        { installationId: nodeInstallation, artifactDigest: nodeDigest, releaseLockDigest: RELEASE_LOCK_DIGEST },
        { installationId: pythonInstallation, artifactDigest: pythonDigest, releaseLockDigest: RELEASE_LOCK_DIGEST },
      ],
      skillEnv: { REAL_RUNNER_TOKEN: "mounted-only" },
      environment: { ...process.env, DOFE_E2E_HOST_SECRET: "must-not-enter-container" },
    });

    for (const capability of broker.capabilities) {
      assert.equal(capability.status, "available", capability.denialReason);
      assert.ok(capability.binPath);
      await execFileAsync(capability.binPath, [], { timeout: 120_000 });
    }

    const outputRoot = join(workDir, "runtime-output", "skill-runs");
    const nodeResult = JSON.parse(readFileSync(join(outputRoot, "real-node-installation-node", "node.json"), "utf8"));
    const pythonResult = JSON.parse(readFileSync(join(outputRoot, "real-python-installation-python", "python.json"), "utf8"));
    const bashResult = JSON.parse(readFileSync(join(outputRoot, "real-bash-installation-bash", "bash.json"), "utf8"));
    assert.deepEqual(nodeResult, {
      runtime: "node",
      dependency: "node-dependency-ready",
      workspaceReadOnly: true,
      interfaces: ["lo"],
      dockerSocketVisible: false,
      hostSecretVisible: false,
      configMounted: true,
    });
    assert.deepEqual(pythonResult, {
      runtime: "python",
      dependency: "python-dependency-ready",
      workspaceReadOnly: true,
      interfaces: ["lo"],
      dockerSocketVisible: false,
      hostSecretVisible: false,
    });
    assert.deepEqual(bashResult, { runtime: "bash", isolated: true });
    assert.equal(readdirSync(workDir).some((name) => name.startsWith("runner-must-not-write")), false);
  } finally {
    await broker?.close().catch(() => {});
    for (const envDir of dependencyDirs) resetSkillDependencyEnvironment(envDir);
    for (const artifactDir of artifacts) {
      chmodSync(artifactDir, 0o755);
      const scriptsDir = join(artifactDir, "scripts");
      chmodSync(scriptsDir, 0o755);
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
