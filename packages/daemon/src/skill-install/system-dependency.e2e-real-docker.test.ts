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
import {
  buildManagedServiceEgressChainName,
  createIptablesManagedServiceEgressPolicy,
} from "../skill-service/egress-policy.ts";

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
 * Exercises the REAL two-layer egress enforcement end-to-end on one container.
 * A Runner entrypoint carrying a frozen approved allowlist joins the egress
 * docker network; while it runs the broker installs a real DOCKER-USER chain
 * for the container's source IP that allows ONLY the pinned host on :443.
 *
 * Layer 1 (hostname pinning + DNS poison): the pinned host is written into
 * /etc/hosts via `--add-host` and DNS is poisoned to an unroutable resolver;
 * the script proves the pin resolves to the pinned IP (positive baseline) and
 * that a REAL normally-resolvable non-allowlisted host does not resolve inside
 * the container. `getent` is a pre-flighted hard requirement: without it the
 * DNS layer cannot be measured and the gate FAILS rather than recording an
 * isolation it cannot observe (unit tests cover the flag shape separately).
 *
 * Layer 2 (L3/L4 firewall, real traffic): the script opens TCP sockets and
 * classifies each outcome so the gate only credits what it can actually
 * observe:
 *   - POSITIVE BASELINE FIRST: the one allowed flow (pinned host :443) must
 *     CONNECT. Without this, deny-all, a firewall-free node, or a node with no
 *     internet would "pass" every negative probe and the gate would prove
 *     nothing (05-运维服务与版本治理.md §7.1: allow-list 目标 + 精确端口成功).
 *   - deny probes target REAL routable internet IPs serving :443 (1.1.1.1 is
 *     the canonical DoH endpoint, 8.8.8.8 a generic third party) — never
 *     naturally-unroutable TEST-NET ranges that would pass trivially.
 *   - outcome codes distinguish connected / timed-out (DROP semantics — what
 *     the managed chain does) / failed-fast (REJECT·refused·no-route, which is
 *     NOT our chain and therefore not creditable evidence of enforcement).
 *   - IPv6 bypass: availability (a global IPv6 address) is reported separately
 *     from the probe outcome. When a v6 path exists the outcome must be a DROP
 *     (timed out) — a fast-fail is NOT creditable (REJECT/no-route, or the
 *     probe cannot form a v6 socket) and fails the gate instead of silently
 *     passing. Without a global v6 address the probe is honestly skipped.
 */
test("REAL DOCKER: Runner egress allows ONLY the pinned host on :443 (positive baseline + DROP-verified deny probes)", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  const bashImage = assertBashImageGate();
  const env = { ...process.env };
  // The probe mechanism itself must exist in the Runner image: a missing
  // `timeout`/`date` must fail the gate outright instead of every probe quietly
  // "failing" (and thus counting as blocked).
  for (const binary of ["timeout", "date", "getent"]) {
    assert.equal(
      runSkillRunnerSystemProbe({ image: bashImage, binary }, env),
      true,
      `Runner image must ship '${binary}' — the egress probe mechanism depends on it`,
    );
  }
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
# POSITIVE RESOLUTION BASELINE: the pinned host must resolve (via the --add-host
# /etc/hosts pin) to the pinned IP. This proves getent and the hosts database
# are functional, so the cloudflare.com probe below failing is attributable to
# the DNS layer (unroutable resolver), not a broken resolution tool.
pinnedResolves=0
if [ "\${has_getent}" = "1" ]; then
  if getent hosts ${PINNED_HOST} 2>/dev/null | grep -q '${PINNED_IP}'; then pinnedResolves=1; fi
fi
# DNS isolation probe. The container's resolver is the unroutable EGRESS_BLOCK_DNS,
# so a REAL normally-resolvable non-allowlisted host must NOT resolve inside the
# container. Never probe an RFC-2606 .invalid TLD — it is guaranteed
# unresolvable everywhere, so it would "pass" even with the DNS layer disabled.
#   dnsProbe: 0 = host RESOLVED      (DNS isolation broken — regression)
#             1 = host did not resolve (DNS isolation verified)
#             2 = getent unavailable   (cannot measure — NOT credited as success)
dnsProbe=2
if [ "\${has_getent}" = "1" ]; then
  if timeout 8 getent hosts cloudflare.com >/dev/null 2>&1; then dnsProbe=0; else dnsProbe=1; fi
fi
# Layer-2 (L3/L4 firewall) real-traffic probes. While this script runs the
# broker has installed a real DOCKER-USER chain for THIS container's source IP
# that allows ONLY ${PINNED_HOST} on :443 and DROPs everything else.
# Outcome codes:
#   0 = TCP open SUCCEEDED (for a deny target: the permissive regression)
#   1 = timed out after 5s  (DROP semantics — the only creditable "blocked")
#   2 = failed fast <1.5s   (REJECT / refused / no-route — NOT our chain's DROP,
#                           cannot be credited as enforcement evidence)
probe_port() {
  local host="\$1" port="\$2" start end delta
  start=$(date +%s%N)
  if timeout 5 bash -c "exec 3<>/dev/tcp/\$host/\$port" >/dev/null 2>&1; then echo 0; return; fi
  end=$(date +%s%N)
  delta=$(( (end - start) / 1000000 ))
  if [ "\$delta" -lt 1500 ]; then echo 2; else echo 1; fi
}
# Positive baseline FIRST: the one allowed flow must genuinely connect, else
# nothing below can be trusted (deny-all and no-internet both look "blocked").
allowed443=$(probe_port ${PINNED_IP} 443)
# Approved IP on a NON-approved port (80): only :443 RETURNs, so :80 must DROP.
# example.com serves :80, so a permissive egress regression would connect here.
port80=$(probe_port ${PINNED_IP} 80)
# Real routable non-allowlisted destinations on :443 — never TEST-NET ranges,
# which fail even with no firewall at all. 1.1.1.1 doubles as the canonical DoH
# endpoint (DoH bypass probe); 8.8.8.8 is a generic third-party 443 listener.
doh443=$(probe_port 1.1.1.1 443)
other443=$(probe_port 8.8.8.8 443)
# IPv6 availability — a global IPv6 address (scope 00 in /proc/net/if_inet6,
# excluding lo) is the only honest signal a v6 egress path exists to bypass with.
ipv6Available=0
if awk '\$4=="00" && \$6!="lo"' /proc/net/if_inet6 2>/dev/null | grep -q .; then
  ipv6Available=1
fi
# IPv6 deny-probe outcome, ONLY meaningful when ipv6Available=1. The SKIP case
# gets its own code (3) so it is never conflated with a fast-fail (2):
#   0 = CONNECTED     — regression: v6 egress is open (the bypass this guards)
#   1 = timed out 5s  — DROP: creditable evidence the firewall engaged v6 traffic
#   2 = failed fast   — REJECT/refused/no-route (or the probe cannot form a v6
#                       socket): NOT creditable, never silently passed
#   3 = skipped       — no global IPv6 path, nothing to test
# 2606:4700:4700::1111 is Cloudflare DNS over IPv6, a real routable :443 listener.
ipv6=3
if [ "\${ipv6Available}" = "1" ]; then
  ipv6=$(probe_port 2606:4700:4700::1111 443)
fi
printf '{"pinnedInHosts":%s,"pinnedResolves":%s,"dnsProbe":%s,"allowed443":%s,"port80":%s,"doh443":%s,"other443":%s,"ipv6Available":%s,"ipv6":%s}\\n' \\
  "\${pinned}" "\${pinnedResolves}" "\${dnsProbe}" "\${allowed443}" "\${port80}" "\${doh443}" "\${other443}" "\${ipv6Available}" "\${ipv6}" > "\${DOFE_SKILL_OUTPUT_DIR}/egress.json"
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
    ) as {
      pinnedInHosts: number;
      pinnedResolves: number;
      dnsProbe: number;
      allowed443: number;
      port80: number;
      doh443: number;
      other443: number;
      ipv6Available: number;
      ipv6: number;
    };
    assert.ok(
      result.pinnedInHosts >= 1,
      "the approved host must be pinned into /etc/hosts via --add-host",
    );
    // Positive resolution baseline: getent must resolve the pinned host to the
    // pinned IP via the /etc/hosts pin. This proves the resolution mechanism
    // works, so the DNS-isolation probe below measures the DNS layer itself.
    assert.equal(
      result.pinnedResolves,
      1,
      "getent must resolve the pinned host to the pinned IP (via --add-host) — " +
        "if this fails the resolution tooling is broken and the DNS probe below proves nothing",
    );
    // DNS isolation: a REAL normally-resolvable non-allowlisted host (cloudflare.com)
    // must NOT resolve inside the container. The old probe used an RFC-2606
    // `.invalid` hostname, which never resolves anywhere, so it "passed" even
    // with the DNS layer disabled; a getent-missing environment likewise recorded
    // success. dnsProbe=2 (getent unavailable) must FAIL the gate rather than be
    // silently credited — the gate never records an isolation it cannot measure.
    assert.equal(
      result.dnsProbe,
      1,
      "a real normally-resolvable non-allowlisted host (cloudflare.com) must not resolve " +
        "inside the container (DNS isolated via the unroutable resolver) — dnsProbe=0 means " +
        "normal DNS is reachable (regression); dnsProbe=2 means getent was unavailable and " +
        "the DNS layer could not be measured (not credited as success)",
    );
    // POSITIVE BASELINE (checked first on purpose): the one allowed flow must
    // genuinely connect. If it cannot, deny-all and "node without internet" are
    // indistinguishable from correct enforcement — the gate proves NOTHING and
    // must fail rather than credit its own blindness.
    assert.equal(
      result.allowed443,
      0,
      "positive baseline failed: the allow-listed host on :443 must CONNECT — " +
        "if the pinned IP is stale or the gate node lacks internet, fix that before " +
        "trusting any deny result (deny-all would otherwise pass every probe)",
    );
    // Deny probes must show DROP semantics (code 1 = timed out), not merely
    // "did not connect": code 0 means egress became permissive (regression),
    // code 2 means something ELSE rejected the flow (REJECT/refused/no-route),
    // which is not evidence that OUR chain enforced anything.
    assert.equal(
      result.port80,
      1,
      "the approved IP on a non-approved port (80) must be DROPped — only :443 returns",
    );
    assert.equal(
      result.doh443,
      1,
      "the canonical DoH endpoint (1.1.1.1:443, a real routable listener) must be DROPped — DoH bypass closed",
    );
    assert.equal(
      result.other443,
      1,
      "a non-allowlisted third-party 443 listener (8.8.8.8) must be DROPped — raw-IP bypass closed",
    );
    // IPv6 bypass — availability is split from the outcome so a non-creditable
    // fast-fail is never conflated with an honest "no v6 path" skip (the old
    // single `ipv6` field used code 2 for both, silently passing either). There
    // is no allowlisted IPv6 destination, so a connect-baseline is impossible;
    // the creditable evidence is instead a DROP (code 1) on a real routable v6
    // :443 listener when a v6 path exists — proving the firewall engaged v6
    // traffic rather than the probe being structurally unable to form a v6 socket.
    if (result.ipv6Available === 1) {
      assert.equal(
        result.ipv6,
        1,
        "a global IPv6 path exists, so the v6 deny probe must DROP (time out) — " +
          "code 0 means v6 egress is open (the bypass); code 2 (fast-fail) is NOT " +
          "creditable (REJECT/no-route, or bash /dev/tcp cannot form an IPv6 socket); " +
          "either way v6 isolation cannot be credited, so the gate fails closed instead " +
          "of passing",
      );
    } else {
      assert.equal(
        result.ipv6,
        3,
        "with no global IPv6 address there is no v6 egress path to bypass with — " +
          "the probe must be honestly skipped (3), not silently credited as enforcement",
      );
    }
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
 * RULE-LEVEL inspection of the REAL iptables the production policy lands on the
 * managed node — NOT a live-traffic proof. The companion Runner test above
 * proves Layer 1 (hostname pinning + DNS poison) on a real container; this
 * drives a real `iptables` through the production policy and asserts the landed
 * kernel RULES are shaped to close the three bypass vectors a pinned /etc/hosts
 * alone cannot stop:
 *   - raw-IP egress   → no RETURN rule matches → the chain ends in DROP,
 *   - DoH endpoints   → a DoH server is a non-allowlisted IP → DROP,
 *   - non-approved ports → the only RETURN to the approved IP carries --dport
 *     443, so any other port to that IP falls through to DROP.
 *
 * Caveat (why this is labeled "rule inspection"): it uses a source address in
 * 203.0.113.0/24 (RFC 5737 TEST-NET-3, reserved for documentation) that a Docker
 * bridge can NEVER assign to a container, so the DOCKER-USER jump is provably
 * inert to live packets — there is no production container whose traffic this
 * test rule could accidentally intercept. (The earlier hardcoded 172.18.0.99 sat
 * inside Docker's default pool and was only "probably" free.) It proves the
 * rules LAND correctly, not that a running Runner's traffic is actually dropped;
 * the live Layer-2 negative probe lives in the companion Runner test below.
 */
test("REAL IPTABLES (rule inspection only): managed egress policy lands a port-443-only allow + final DROP rule shape", async (t) => {
  if (!RUN_E2E) {
    t.skip("set DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1 on a Linux managed node to run the release gate");
    return;
  }
  assert.equal(process.platform, "linux", "real iptables gate must run on a Linux managed node");

  const stateRootDir = mkdtempSync(join(tmpdir(), "dofe-real-egress-policy-"));
  // Default exec shells out to the real iptables/ip6tables on PATH.
  const policy = createIptablesManagedServiceEgressPolicy({ stateRootDir, platform: "linux" });
  const serviceId = "release-gate-egress-probe";
  const chain = buildManagedServiceEgressChainName(serviceId);
  // A source address in TEST-NET-3 (203.0.113.0/24, RFC 5737): Docker never
  // assigns documentation-reserved ranges to containers, so this DOCKER-USER
  // jump is provably inert to live traffic while still being a real kernel rule
  // available for inspection — no risk of colliding with a production container.
  const sourceIp = "203.0.113.99";
  const approvedIp = "203.0.113.10";

  const listRules = (chainName?: string) =>
    execFileSync("iptables", chainName ? ["-S", chainName] : ["-S"], {
      encoding: "utf8",
      timeout: 30_000,
    });

  try {
    await policy.apply({
      serviceId,
      sourceAddresses: [{ family: "ipv4", address: sourceIp }],
      targets: [{
        hostname: "approved.example",
        addresses: [{ family: "ipv4", address: approvedIp }],
        port: 443,
      }],
    });

    // DOCKER-USER carries the per-source-IP jump into the run's chain.
    const dockerUser = listRules("DOCKER-USER");
    assert.ok(
      dockerUser.split("\n").some((line) => line.includes(`-s ${sourceIp}/32`) && line.includes(`-j ${chain}`)),
      "DOCKER-USER must jump per source IP into the managed chain",
    );

    const chainRules = listRules(chain).split("\n").filter((line) => line.trim().length > 0);
    // Approved host narrowed to port 443 only.
    assert.ok(
      chainRules.some((line) =>
        line.includes(`-d ${approvedIp}/32`)
        && line.includes("-p tcp")
        && line.includes("--dport 443")
        && line.includes("-j RETURN")),
      "the approved host is allowed only on its declared port (443)",
    );
    // No any-port RETURN: a connection to the approved IP on any other port
    // matches no RETURN rule and hits the DROP below (non-approved-port guarantee).
    assert.equal(
      chainRules.some((line) =>
        line.includes(`-d ${approvedIp}/32`)
        && line.includes("-j RETURN")
        && !line.includes("--dport")),
      false,
      "no any-port RETURN: non-approved ports to the approved IP stay blocked",
    );
    // Final DROP: raw IPs, DoH endpoints and every other destination match no
    // RETURN rule and are dropped (raw-IP / DoH guarantee).
    assert.ok(
      chainRules.some((line) => line.trim() === `-A ${chain} -j DROP`),
      "the chain ends in a default DROP that closes raw-IP / DoH / other-port bypasses",
    );
  } finally {
    await policy.remove({ serviceId }).catch(() => {});
    // Retire must leave no trace of the run on the host firewall.
    assert.ok(
      !listRules().includes(chain),
      "the managed chain must be removed from the host after retire",
    );
    rmSync(stateRootDir, { recursive: true, force: true });
  }
});
