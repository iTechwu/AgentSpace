import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getDaemonSkillInstallCachePath } from "@dofe-agent/db";
import type { DaemonSkillRunnerEntrypoint } from "@dofe-agent/domain";
import { runSkillRunnerSystemProbe, startSkillRunnerBroker } from "../skill-runner.ts";

const execFileAsync = promisify(execFile);
const RUN_E2E = process.env.DOFE_AGENT_RUN_SKILL_RUNNER_E2E === "1";
const WORKSPACE_ID = "skill-install-real-e2e";
const DOCKER_BIN = () => process.env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker";
// example.com's documented reserved address; we inject it via the egress lookup
// so the pinned host is resolvable inside the container without real outbound.
const PINNED_HOST = "example.com";
const PINNED_IP = "93.184.216.34";

function assertBashImageGate(): string {
  assert.equal(process.platform, "linux", "real Skill Runner e2e must run on a Linux managed node");
  const image = process.env.DOFE_SKILL_RUNNER_BASH_IMAGE ?? "";
  assert.match(image, /@sha256:[a-f0-9]{64}$/i, "DOFE_SKILL_RUNNER_BASH_IMAGE must be a digest-pinned image");
  execFileSync(DOCKER_BIN(), ["image", "inspect", image], { stdio: "ignore", timeout: 30_000 });
  execFileSync(DOCKER_BIN(), ["version"], { stdio: "ignore", timeout: 30_000 });
  return image;
}

/** Creates the isolated egress docker network if it does not already exist. */
function ensureEgressNetwork(name: string): void {
  try {
    execFileSync(DOCKER_BIN(), ["network", "create", name], { stdio: "ignore", timeout: 30_000 });
  } catch {
    // Already exists (or creation is raced) — presence is what matters.
  }
  execFileSync(DOCKER_BIN(), ["network", "inspect", name], { stdio: "ignore", timeout: 30_000 });
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function materializeArtifact(input: {
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

/**
 * Exercises the REAL docker system-dependency probe (`runSkillRunnerSystemProbe`)
 * against a digest-pinned bash Runner image. This closes the P2 gap that every
 * system-dependency test mocked the probe: here a binary guaranteed on PATH (`sh`,
 * `ls`) is detected as present, and a non-existent binary is detected as absent —
 * the same mechanism `verifySystemDependenciesInRunner` relies on per-runtime.
 */
test("REAL DOCKER: Skill Runner system binary probe detects presence and absence in the image", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  const image = assertBashImageGate();
  const env = { ...process.env };

  // Binaries guaranteed on PATH in any bash Runner image.
  assert.equal(runSkillRunnerSystemProbe({ image, binary: "sh" }, env), true);
  assert.equal(runSkillRunnerSystemProbe({ image, binary: "ls" }, env), true);
  // A binary that does not exist must be reported absent (the fail-closed path).
  assert.equal(
    runSkillRunnerSystemProbe({ image, binary: "dofe-no-such-binary-xyz" }, env),
    false,
    "an absent catalog binary must probe false so a missing dependency blocks the install",
  );
});

/**
 * Exercises the REAL egress enforcement end-to-end: a Runner entrypoint carrying a
 * frozen approved allowlist joins the egress docker network with the pinned host
 * written into /etc/hosts (via `--add-host`) and DNS poisoned to 192.0.2.1. The
 * script proves the pin took effect. DNS poisoning of non-pinned hosts is verified
 * when `getent` is available; otherwise the `--dns`/`--add-host` flags themselves
 * are asserted by the F5 unit tests.
 */
test("REAL DOCKER: Runner egress allowlist pins the approved host into /etc/hosts", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  const bashImage = assertBashImageGate();
  const egressNetwork = process.env.DOFE_SKILL_RUNNER_EGRESS_NETWORK ?? "dofe-skill-runner-egress-e2e";
  ensureEgressNetwork(egressNetwork);

  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-install-real-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-install-real-work-"));
  const installationId = "real-egress-installation";
  const artifactDigest = "e".repeat(64);
  let broker: Awaited<ReturnType<typeof startSkillRunnerBroker>> | undefined;
  let artifactDir: string | undefined;

  const script = `#!/usr/bin/env bash
set -uo pipefail
pinned=$(grep -c '${PINNED_HOST}' /etc/hosts || true)
has_getent=0
if command -v getent >/dev/null 2>&1; then has_getent=1; fi
poisoned_ok=0
if [ "\${has_getent}" = "1" ]; then
  if ! timeout 8 getent hosts evil-egress-example.invalid >/dev/null 2>&1; then poisoned_ok=1; fi
else
  poisoned_ok=1
fi
printf '{"pinnedInHosts":%s,"poisonedOk":%s}\\n' "\${pinned}" "\${poisoned_ok}" > "\${DOFE_SKILL_OUTPUT_DIR}/egress.json"
`;

  try {
    const materialized = materializeArtifact({
      stateDir,
      artifactDigest,
      scriptName: "egress.sh",
      script,
    });
    artifactDir = materialized.artifactDir;
    const entrypoint: DaemonSkillRunnerEntrypoint = {
      key: `${installationId}:egress`,
      skillId: "skill-egress",
      skillName: "Real Egress Runner",
      installationId,
      artifactDigest,
      sha256: digest(materialized.scriptBytes),
      id: "egress",
      path: "scripts/egress.sh",
      runtime: "bash",
      egressAllowlist: [PINNED_HOST],
    };

    broker = await startSkillRunnerBroker({
      stateDir,
      workspaceId: WORKSPACE_ID,
      workDir,
      entrypoints: [entrypoint],
      environment: { ...process.env, DOFE_SKILL_RUNNER_EGRESS_NETWORK: egressNetwork },
      // Inject the pinned IP so the host resolves without real outbound DNS in CI.
      lookupHost: async () => [{ family: "ipv4", address: PINNED_IP }],
    });

    assert.equal(broker.capabilities.length, 1);
    const capability = broker.capabilities[0]!;
    assert.equal(capability.status, "available", capability.denialReason ?? "");
    assert.ok(capability.binPath);
    // Running the launcher drives the entrypoint through the broker, which derives
    // the egress network args from the entrypoint's frozen allowlist.
    await execFileAsync(capability.binPath, [], { timeout: 120_000 });

    const result = JSON.parse(
      readFileSync(join(workDir, "runtime-output", "skill-runs", entrypoint.key, "egress.json"), "utf8"),
    ) as { pinnedInHosts: number; poisonedOk: number };
    assert.ok(
      result.pinnedInHosts >= 1,
      "the approved host must be pinned into /etc/hosts via --add-host",
    );
    assert.equal(result.poisonedOk, 1, "a non-allowlisted host must not resolve (DNS poisoned)");
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
