import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { before } from "node:test";
import type { RuntimeAppInstallPlan } from "@dofe-agent/domain";
import {
  buildManagedRuntimeAppPlan,
  executeRuntimeAppPlan,
} from "./runtime-apps.ts";

const execFileP = promisify(execFile);

/**
 * REAL-DOCKER Runtime baseline end-to-end: validates the exact docker-run
 * execution wrapper the managed node uses for baseline rollouts —
 * (1) a command runs inside the actual provider image, (2) files written to the
 * per-runtime HOME persist into a SECOND container (so a tool installed by a
 * baseline plan survives into later runtime-app installs).
 *
 * The tool-specific install (ensurepip / npm / a governed pinned artifact)
 * depends on the provider image's contents; the MECHANISM this test pins down is
 * the writable-HOME docker execution path.
 *
 * Gated: DOFE_AGENT_RUN_DOCKER_E2E=1 + a live docker daemon + a local provider
 * image (default dofe/agent-runtime-claude:latest). Runs standalone.
 */

const RUN = process.env.DOFE_AGENT_RUN_DOCKER_E2E === "1";
const PROVIDER_IMAGE = process.env.DOFE_AGENT_E2E_PROVIDER_IMAGE?.trim() || "dofe/agent-runtime-claude:latest";

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileP("docker", ["info"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function imagePresent(image: string): Promise<boolean> {
  try {
    await execFileP("docker", ["image", "inspect", image], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

let ready = false;

before(async () => {
  if (!RUN) return;
  ready = (await dockerAvailable()) && (await imagePresent(PROVIDER_IMAGE));
});

test("real-Docker baseline execution: a plan command runs inside the provider image", {
  skip: !RUN || undefined,
}, async () => {
  if (!RUN || !ready) return;
  const root = mkdtempSync(join(tmpdir(), "dofe-baseline-e2e-"));
  const runtimeHomeDir = join(root, "runtime-home");
  const depsRoot = join(root, "deps");
  mkdirSync(runtimeHomeDir, { recursive: true });
  mkdirSync(depsRoot, { recursive: true });
  try {
    const plan: RuntimeAppInstallPlan = {
      app: { source: "clihub_harness", name: "probe", version: "1", entryPoint: "probe" },
      strategy: "system",
      commands: [{ executable: "node", args: ["-e", "require('node:fs').writeFileSync(process.env.HOME + '/marker.txt', 'baseline-ok')"] }],
      verifyCommands: [{ executable: "node", args: ["-e", "process.stdout.write(require('node:fs').readFileSync(process.env.HOME + '/marker.txt','utf8'))"] }],
      risk: "low",
      requiresApproval: false,
      notes: [],
    };
    const dockerPlan = buildManagedRuntimeAppPlan(plan, {
      image: PROVIDER_IMAGE,
      runtimeHomeDir,
      depsRoot,
      dockerNetwork: "host",
      user: "0",
      registryEnvironment: {},
    });
    const result = await executeRuntimeAppPlan(dockerPlan, { runtimeHomeDir, onStage: () => undefined });
    assert.match(result.safeStdoutTail, /baseline-ok/, "the docker-run command must execute and verify inside the image");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real-Docker baseline persistence: HOME writes survive into a second container", {
  skip: !RUN || undefined,
}, async () => {
  if (!RUN || !ready) return;
  const root = mkdtempSync(join(tmpdir(), "dofe-baseline-e2e-"));
  const runtimeHomeDir = join(root, "runtime-home");
  const depsRoot = join(root, "deps");
  mkdirSync(runtimeHomeDir, { recursive: true });
  mkdirSync(depsRoot, { recursive: true });
  try {
    const writePlan: RuntimeAppInstallPlan = {
      app: { source: "clihub_harness", name: "probe", version: "1", entryPoint: "probe" },
      strategy: "system",
      commands: [{ executable: "node", args: ["-e", "require('node:fs').writeFileSync(process.env.HOME + '/persist.txt', 'persisted-' + Date.now())"] }],
      verifyCommands: [],
      risk: "low",
      requiresApproval: false,
      notes: [],
    };
    const readPlan: RuntimeAppInstallPlan = {
      app: { source: "clihub_harness", name: "probe", version: "1", entryPoint: "probe" },
      strategy: "system",
      commands: [],
      verifyCommands: [{ executable: "node", args: ["-e", "process.stdout.write(require('node:fs').readFileSync(process.env.HOME + '/persist.txt','utf8'))"] }],
      risk: "low",
      requiresApproval: false,
      notes: [],
    };
    const opts = {
      image: PROVIDER_IMAGE,
      runtimeHomeDir,
      depsRoot,
      dockerNetwork: "host",
      user: "0",
      registryEnvironment: {},
    };
    await executeRuntimeAppPlan(buildManagedRuntimeAppPlan(writePlan, opts), { runtimeHomeDir, onStage: () => undefined });
    const readResult = await executeRuntimeAppPlan(buildManagedRuntimeAppPlan(readPlan, opts), { runtimeHomeDir, onStage: () => undefined });
    assert.match(readResult.safeStdoutTail, /persisted-\d+/, "HOME write from container 1 must be visible in container 2 (baseline installs persist)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
