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
import {
  listLiveSkillRunnerEgressPolicyServiceIds,
  SKILL_RUNNER_EGRESS_POLICY_LABEL,
} from "./skill-runner-docker.ts";

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
      assert.equal(capability.status, "available", capability.denialReason ?? "");
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

/**
 * REAL-DOCKER regression guard for live-owner enumeration. The broker unit suite
 * injects a pre-built `Set` at the `enumerateLiveEgressPolicyOwners` seam, so it
 * never drives the real `docker ps` parse. This starts a real container carrying
 * the egress-policy label and asserts the production enumerator returns its
 * serviceId — the test that would have caught the P0 where `{{json .Labels}}`
 * serialized labels as a JSON STRING ("k=v,k=v"), `JSON.parse` yielded a String,
 * every label lookup was `undefined`, the live set was ALWAYS empty, and the
 * crash-recovery sweep revoked the firewall of every still-running Runner.
 */
test("REAL DOCKER: listLiveSkillRunnerEgressPolicyServiceIds enumerates a labeled running container", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  assertReleaseGateEnvironment();
  const dockerBin = process.env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker";
  const bashImage = process.env.DOFE_SKILL_RUNNER_BASH_IMAGE!;
  const serviceId = `e2e-live-owner-${createHash("sha256").update("live-owner-probe").digest("hex").slice(0, 12)}`;
  const containerName = `dofe-e2e-live-owner-${serviceId}`;

  try {
    // A long-lived container carrying the egress-policy label, like a live Runner
    // whose firewall the sweep must NOT revoke on the next daemon start.
    execFileSync(dockerBin, [
      "run", "-d", "--rm", "--init", "--name", containerName,
      "--label", `${SKILL_RUNNER_EGRESS_POLICY_LABEL}=${serviceId}`,
      "--entrypoint", "/bin/sh", bashImage, "-c", "sleep 120",
    ], { stdio: "ignore", timeout: 30_000 });

    const live = await listLiveSkillRunnerEgressPolicyServiceIds(process.env);
    assert.ok(
      live.has(serviceId),
      `the running container's serviceId ${serviceId} must be enumerated live (got ${JSON.stringify([...live])})`,
    );
  } finally {
    execFileSync(dockerBin, ["rm", "-f", containerName], { stdio: "ignore", timeout: 30_000 });
  }
});

function dockerImageIsPresent(image: string): boolean {
  try {
    execFileSync(
      process.env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker",
      ["image", "inspect", image],
      { stdio: "ignore", timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * §13 production gate: 删除本地 Runner image 后新任务能力立即 blocked，任务执行
 * 不会触发 pull。Exercised with a properly digest-pinned image reference that is
 * NOT present locally (the same state `docker rmi` leaves behind): the capability
 * must come up `missing` (never `available`), executing it must fail closed, and
 * the image must STILL be absent afterwards — proving `--pull never` kept the
 * missing image missing instead of fetching it.
 */
test("REAL DOCKER: a locally missing Runner image blocks the capability and never pulls", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  assertReleaseGateEnvironment();
  const configuredBashImage = process.env.DOFE_SKILL_RUNNER_BASH_IMAGE!;
  // Same repository, digest that was never pulled — indistinguishable from a
  // deleted image except we never had to remove the real one.
  const missingImage = configuredBashImage.replace(/@sha256:[a-fA-F0-9]{64}$/, `@sha256:${"f".repeat(64)}`);
  assert.equal(dockerImageIsPresent(missingImage), false, "precondition: the fake digest must not be present locally");

  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-missing-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-missing-work-"));
  const installationId = "real-missing-image";
  const artifactDigest = `4${ARTIFACT_DIGEST.slice(1)}`;
  let broker: Awaited<ReturnType<typeof startSkillRunnerBroker>> | undefined;
  let artifactDir: string | undefined;

  try {
    const materialized = createArtifact({
      stateDir,
      artifactDigest,
      scriptName: "noop.sh",
      script: "#!/usr/bin/env bash\nexit 0\n",
    });
    artifactDir = materialized.artifactDir;
    broker = await startSkillRunnerBroker({
      stateDir,
      workspaceId: WORKSPACE_ID,
      workDir,
      entrypoints: [entrypoint({
        id: "noop",
        installationId,
        artifactDigest,
        scriptName: "noop.sh",
        scriptBytes: materialized.scriptBytes,
        runtime: "bash",
      })],
      environment: { ...process.env, DOFE_SKILL_RUNNER_BASH_IMAGE: missingImage },
    });

    const capability = broker.capabilities[0]!;
    assert.equal(capability.status, "missing", "a locally absent image must block the capability at build time");
    assert.match(capability.denialReason ?? "", /not available locally/);

    // Executing the blocked capability must fail closed…
    await assert.rejects(execFileAsync(capability.binPath!, [], { timeout: 60_000 }));
    // …without pulling the image as a side effect.
    assert.equal(
      dockerImageIsPresent(missingImage),
      false,
      "the missing image must still be missing after a run attempt (--pull never)",
    );
  } finally {
    await broker?.close().catch(() => {});
    if (artifactDir) {
      chmodSync(artifactDir, 0o755);
      chmodSync(join(artifactDir, "scripts"), 0o755);
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

/**
 * §13 production gate: timeout、输出超限产生结构化失败，且 `docker ps -a` 不存在
 * 对应随机容器。A 120s sleeper under a 2s runner timeout must be killed well
 * before its natural end; a stdout flood past the 64KiB per-run cap must surface
 * the structured `skill_runner.output_limit_exceeded` failure. Both must leave no
 * container behind — container names embed the spawning process's pid, so
 * filtering on `dofe-skill-run-${process.pid}-` isolates THIS test's runs.
 */
test("REAL DOCKER: timeout and output overrun fail closed and leave no container behind", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  assertReleaseGateEnvironment();
  const dockerBin = process.env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker";

  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-failclosed-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-failclosed-work-"));
  const timeoutDigest = `5${ARTIFACT_DIGEST.slice(1)}`;
  const overrunDigest = `6${ARTIFACT_DIGEST.slice(1)}`;
  const artifacts: string[] = [];
  let broker: Awaited<ReturnType<typeof startSkillRunnerBroker>> | undefined;

  try {
    const sleeper = createArtifact({
      stateDir,
      artifactDigest: timeoutDigest,
      scriptName: "sleeper.sh",
      script: "#!/usr/bin/env bash\nsleep 120\n",
    });
    artifacts.push(sleeper.artifactDir);
    // ~300KB of stdout — far past the 64KiB per-run cap (SKILL_RUNNER_MAX_OUTPUT_BYTES).
    const flooder = createArtifact({
      stateDir,
      artifactDigest: overrunDigest,
      scriptName: "flooder.sh",
      script: `#!/usr/bin/env bash
set -euo pipefail
line=$(printf 'x%.0s' {1..100})
for ((i = 0; i < 3000; i++)); do printf '%s\\n' "\$line"; done
`,
    });
    artifacts.push(flooder.artifactDir);

    broker = await startSkillRunnerBroker({
      stateDir,
      workspaceId: WORKSPACE_ID,
      workDir,
      entrypoints: [
        entrypoint({
          id: "sleeper",
          installationId: "real-timeout-installation",
          artifactDigest: timeoutDigest,
          scriptName: "sleeper.sh",
          scriptBytes: sleeper.scriptBytes,
          runtime: "bash",
        }),
        entrypoint({
          id: "flooder",
          installationId: "real-overrun-installation",
          artifactDigest: overrunDigest,
          scriptName: "flooder.sh",
          scriptBytes: flooder.scriptBytes,
          runtime: "bash",
        }),
      ],
      environment: { ...process.env, DOFE_SKILL_RUNNER_TIMEOUT_MS: "2000" },
    });

    const byId = new Map(broker.capabilities.map((capability) => [capability.id.split(":").pop(), capability]));
    const sleeperCapability = byId.get("sleeper")!;
    const flooderCapability = byId.get("flooder")!;
    assert.equal(sleeperCapability.status, "available", sleeperCapability.denialReason ?? "");
    assert.equal(flooderCapability.status, "available", flooderCapability.denialReason ?? "");

    // Timeout: the 120s sleeper must be killed by the 2s runner timeout — well
    // before the execFileAsync 60s ceiling.
    const startedAt = Date.now();
    await assert.rejects(execFileAsync(sleeperCapability.binPath!, [], { timeout: 60_000 }));
    assert.ok(
      Date.now() - startedAt < 30_000,
      "the 120s sleeper must be stopped by the 2s runner timeout, not run to completion",
    );

    // Output overrun: failing the 64KiB cap must surface the structured marker.
    const overrunFailure = await execFileAsync(flooderCapability.binPath!, [], { timeout: 60_000 })
      .then(() => null, (error) => error as Error & { stderr?: string });
    assert.ok(overrunFailure, "an output-overrunning run must exit non-zero");
    assert.match(String(overrunFailure.stderr), /skill_runner\.output_limit_exceeded/);

    // §13: docker ps -a shows no leftover random container from THIS process.
    const leftovers = execFileSync(dockerBin, ["ps", "-a", "--format", "{{.Names}}"], {
      encoding: "utf8",
      timeout: 30_000,
    }).split("\n")
      .filter((name) => name.startsWith(`dofe-skill-run-${process.pid}-`));
    assert.deepEqual(
      leftovers,
      [],
      "timed-out / output-overrunning containers must be force-removed, not left in docker ps -a",
    );
  } finally {
    await broker?.close().catch(() => {});
    for (const artifactDir of artifacts) {
      chmodSync(artifactDir, 0o755);
      chmodSync(join(artifactDir, "scripts"), 0o755);
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

/**
 * §13 production gate: entrypoint hash 篡改 fail-closed。The broker re-verifies the
 * cached entrypoint's sha256 on EVERY run (assertSkillRunnerCacheEntry), so a
 * script modified after materialization — even with the read-only mode restored —
 * must be rejected with the structured digest-mismatch failure, never executed.
 */
test("REAL DOCKER: a tampered artifact cache entry is rejected by the per-run entrypoint hash check", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  assertReleaseGateEnvironment();

  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-tamper-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-tamper-work-"));
  const artifactDigest = `7${ARTIFACT_DIGEST.slice(1)}`;
  let broker: Awaited<ReturnType<typeof startSkillRunnerBroker>> | undefined;
  let artifactDir: string | undefined;

  try {
    const materialized = createArtifact({
      stateDir,
      artifactDigest,
      scriptName: "victim.sh",
      script: "#!/usr/bin/env bash\nprintf 'original\\n'\n",
    });
    artifactDir = materialized.artifactDir;
    broker = await startSkillRunnerBroker({
      stateDir,
      workspaceId: WORKSPACE_ID,
      workDir,
      entrypoints: [entrypoint({
        id: "victim",
        installationId: "real-tamper-installation",
        artifactDigest,
        scriptName: "victim.sh",
        scriptBytes: materialized.scriptBytes,
        runtime: "bash",
      })],
    });
    const capability = broker.capabilities[0]!;
    assert.equal(capability.status, "available", capability.denialReason ?? "");

    // Tamper AFTER the broker built the capability: rewrite the script and
    // restore the read-only mode, so only the CONTENT differs.
    const scriptPath = join(artifactDir, "scripts", "victim.sh");
    chmodSync(scriptPath, 0o755);
    writeFileSync(scriptPath, "#!/usr/bin/env bash\nprintf 'tampered\\n'\n");
    chmodSync(scriptPath, 0o555);

    const failure = await execFileAsync(capability.binPath!, [], { timeout: 60_000 })
      .then(() => null, (error) => error as Error & { stderr?: string });
    assert.ok(failure, "a tampered entrypoint must not execute");
    assert.match(String(failure.stderr), /skill_runner\.entrypoint_digest_mismatch/);
  } finally {
    await broker?.close().catch(() => {});
    if (artifactDir) {
      chmodSync(artifactDir, 0o755);
      chmodSync(join(artifactDir, "scripts"), 0o755);
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
