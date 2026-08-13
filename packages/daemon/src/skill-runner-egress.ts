import { promises as dnsPromises } from "node:dns";
import { normalizeSkillEgressAllowlist } from "@dofe-agent/domain";
import { resolveManagedRuntimeDockerNetwork } from "./managed-provider-credentials.ts";
import { EGRESS_BLOCK_DNS } from "./skill-service/managed-service-runtime.ts";
import type { ManagedNetworkAddress, ManagedServiceEgressPolicyRuntime, ManagedServiceEgressTarget } from "./skill-service/egress-policy.ts";
import { parseContainerNetworkAddresses } from "./skill-service/egress-policy.ts";
import {
  executeDockerSkillRunner,
  forceRemoveDockerSkillRunnerContainer,
  type SkillRunnerExecutionResult,
} from "./skill-runner-docker.ts";

/**
 * Skill Runner egress enforcement (manifest network → first-install approval).
 *
 * Split out of skill-runner.ts so every egress security decision — origin
 * validation, DNS resolution, docker network flags and the L3/L4 firewall
 * execution path — lives in ONE module that can be reviewed and changed
 * without touching the Runner lifecycle (broker, output collection, audit).
 */

/**
 * Resolves an allowlisted hostname to its IPv4/IPv6 addresses. Injectable so
 * tests never touch real DNS. Mirrors the managed-service egress lookup shape.
 */
export type SkillRunnerEgressLookup = (hostname: string) => Promise<ManagedNetworkAddress[]>;

/** Default runtime resolver: the OS resolver via `dns.lookup`. Best-effort — an
 * unresolvable name yields `[]` and the broker fails the run closed. */
async function defaultRunnerEgressLookup(hostname: string): Promise<ManagedNetworkAddress[]> {
  try {
    const addresses = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({
      address,
      family: family === 6 ? "ipv6" as const : "ipv4" as const,
    }));
  } catch {
    return [];
  }
}

/**
 * The docker network a Skill Runner joins when it has been granted egress.
 * Defaults to the same isolated runtime network managed services use; override
 * with `DOFE_SKILL_RUNNER_EGRESS_NETWORK` (must be a user-defined bridge — the
 * default `bridge`/`host`/`none` are rejected because they are not isolated).
 */
export function resolveSkillRunnerEgressNetwork(environment: NodeJS.ProcessEnv = process.env): string {
  const network = environment.DOFE_SKILL_RUNNER_EGRESS_NETWORK?.trim();
  if (network) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(network)) {
      throw new Error("skill_runner.egress_network_invalid");
    }
    if (["bridge", "default", "host", "none"].includes(network.toLowerCase())) {
      throw new Error("skill_runner.egress_network_not_isolated");
    }
    return network;
  }
  // Fall back to the shared runtime network managed services already join.
  return resolveManagedRuntimeDockerNetwork(environment);
}

export interface SkillRunnerEgressNetworkInput {
  /** Frozen grant forwarded from the task skill snapshot entry. */
  egressAllowlist?: string[];
  /** Egress docker network name (from resolveSkillRunnerEgressNetwork). */
  network: string;
  /** Pre-resolved hostname→IP pins for the allowlisted hosts. */
  hostEntries?: Array<{ hostname: string; address: string }>;
}

/**
 * Pure builder for the docker network flags of a Skill Runner from its frozen
 * egress grant. Reuses the managed-service DNS-poison + /etc/hosts pattern:
 *   - absent / empty → `--network none` (fully isolated, the default).
 *   - sentinel `["*"]` → approved unrestricted grant → shared network, no DNS
 *     poisoning (full egress).
 *   - host list → shared network + unroutable `--dns` + `--add-host` pins for
 *     the allowlisted hosts only. DNS pinning alone cannot stop raw-IP or DoH
 *     egress, so a granted run additionally executes behind the L3/L4 firewall
 *     (see executeSkillRunnerWithEgressPolicy) — this layer stays as
 *     defense-in-depth name pinning.
 */
export function buildSkillRunnerEgressNetworkArgs(input: SkillRunnerEgressNetworkInput): string[] {
  if (!input.egressAllowlist || input.egressAllowlist.length === 0) {
    return ["--network", "none"];
  }
  if (input.egressAllowlist.includes("*")) {
    return ["--network", input.network];
  }
  const args = ["--network", input.network, "--dns", EGRESS_BLOCK_DNS];
  for (const entry of input.hostEntries ?? []) {
    args.push("--add-host", `${entry.hostname}=${entry.address}`);
  }
  return args;
}

/**
 * Thrown when an allowlisted hostname fails to resolve — the broker fails the
 * run closed rather than executing a skill that declared egress it cannot
 * obtain.
 */
export class SkillRunnerEgressResolutionError extends Error {
  readonly hostname: string;
  constructor(hostname: string) {
    super(`skill_runner.egress_host_unresolved: ${hostname}`);
    this.name = "SkillRunnerEgressResolutionError";
    this.hostname = hostname;
  }
}

/** Thrown when a frozen egress grant fails the shared strict origin parser. */
export class SkillRunnerEgressOriginError extends Error {
  readonly entry: string;
  constructor(entry: string, reason: string) {
    super(`skill_runner.egress_origin_invalid: ${entry} (${reason})`);
    this.name = "SkillRunnerEgressOriginError";
    this.entry = entry;
  }
}

/**
 * Thrown when an allowlisted hostname resolves ONLY to non-global-unicast
 * addresses (loopback, RFC1918, link-local, cloud metadata, ULA, multicast,
 * unspecified). The broker fails the run closed rather than firewall-allowing a
 * destination that could reach host-local services or the metadata endpoint.
 */
export class SkillRunnerEgressAddressBlockedError extends Error {
  readonly hostname: string;
  constructor(hostname: string, addresses: ManagedNetworkAddress[]) {
    super(
      `skill_runner.egress_address_blocked: ${hostname} resolved only to non-global-unicast addresses`
      + ` (${addresses.map((addr) => addr.address).join(", ")}); the run was blocked.`,
    );
    this.name = "SkillRunnerEgressAddressBlockedError";
    this.hostname = hostname;
  }
}

/**
 * Permits only global-unicast destinations. A public-looking allowlisted
 * hostname can resolve — via split-horizon DNS, a poisoned resolver, or a
 * record that simply points inward — to loopback, RFC1918, link-local (incl.
 * the 169.254.169.254 cloud-metadata endpoint), IPv6 ULA/link-local, multicast
 * or unspecified space. Firewall-allowing such an address would let a Runner
 * reach host-local services or steal a metadata credential through an approved
 * name, so any resolved address that is not global unicast is dropped.
 */
export function isGlobalUnicastRunnerEgressAddress(address: ManagedNetworkAddress): boolean {
  if (address.family === "ipv4") {
    const octets = address.address.split(".").map((octet) => Number(octet));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return false;
    }
    const [a, b] = octets;
    if (a === 0) return false;                               // 0.0.0.0/8 unspecified / this-network
    if (a === 10) return false;                              // 10.0.0.0/8 private (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return false;      // 100.64.0.0/10 CGNAT (RFC6598)
    if (a === 127) return false;                             // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return false;                // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;       // 172.16.0.0/12 private (RFC1918)
    if (a === 192 && b === 168) return false;                // 192.168.0.0/16 private (RFC1918)
    if (a >= 224) return false;                              // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return true;
  }
  // IPv6: allow only the current global-unicast allocation 2000::/3 (first
  // 16-bit group in [0x2000, 0x3fff]). This conservative inverse rejects ::/0
  // special-use space — ::1 loopback, :: unspecified, fe80::/10 link-local,
  // fc00::/7 ULA, ff00::/8 multicast, IPv4-mapped ::ffff:0:0/96 — without
  // enumerating each, and fails closed on any exotic first-group form. The
  // first group is always lexically present (a leading "::" parses to "").
  const firstGroup = address.address.split(":", 1)[0] ?? "";
  const firstValue = Number.parseInt(firstGroup, 16);
  return Number.isFinite(firstValue) && firstValue >= 0x2000 && firstValue <= 0x3fff;
}

/**
 * The full egress plan for a granted run: docker network flags (DNS poison +
 * /etc/hosts pins) plus the L3/L4 firewall targets. `targets` are PORT-LESS —
 * the approved grant object is a hostname, so the firewall allows any TCP port
 * to the resolved addresses and drops everything else (raw-IP and DoH bypasses
 * included).
 */
export interface SkillRunnerEgressPlan {
  networkArgs: string[];
  targets: ManagedServiceEgressTarget[];
}

/**
 * Resolves the egress plan for a Runner entrypoint at run time. Returns
 * `undefined` when the entrypoint has no egress grant (the docker plan then
 * defaults to `--network none`). Throws {@link SkillRunnerEgressResolutionError}
 * when an allowlisted hostname fails to resolve and
 * {@link SkillRunnerEgressOriginError} when a frozen grant entry fails the
 * shared strict origin parser — the broker fails the run closed rather than
 * executing a skill whose grant it cannot enforce exactly.
 */
export async function resolveSkillRunnerEgressPlan(input: {
  egressAllowlist?: string[];
  environment: NodeJS.ProcessEnv;
  lookupHost?: SkillRunnerEgressLookup;
}): Promise<SkillRunnerEgressPlan | undefined> {
  if (!input.egressAllowlist || input.egressAllowlist.length === 0) {
    return undefined;
  }
  const network = resolveSkillRunnerEgressNetwork(input.environment);
  if (input.egressAllowlist.includes("*")) {
    return {
      networkArgs: buildSkillRunnerEgressNetworkArgs({ egressAllowlist: input.egressAllowlist, network }),
      targets: [],
    };
  }
  // The grant must survive the shared strict parser with ports rejected — the
  // approved object is a hostname, so port-qualified entries can never be
  // enforced exactly and fail closed.
  const { hostnames, invalid } = normalizeSkillEgressAllowlist(input.egressAllowlist);
  if (invalid.length > 0) {
    throw new SkillRunnerEgressOriginError(invalid[0]!.entry, invalid[0]!.reason);
  }
  const lookupHost = input.lookupHost ?? defaultRunnerEgressLookup;
  const hostEntries: Array<{ hostname: string; address: string }> = [];
  const targets: ManagedServiceEgressTarget[] = [];
  for (const hostname of hostnames) {
    const resolved = await lookupHost(hostname);
    if (resolved.length === 0) {
      throw new SkillRunnerEgressResolutionError(hostname);
    }
    // Drop any resolved address that is not global-unicast (loopback, RFC1918,
    // link-local, metadata, ULA, multicast, unspecified). A hostname that
    // resolves ONLY to such space fails the run closed; a mixed resolution
    // keeps only the public addresses, so the firewall and /etc/hosts pin never
    // open an inward path.
    const addresses = resolved.filter(isGlobalUnicastRunnerEgressAddress);
    if (addresses.length === 0) {
      throw new SkillRunnerEgressAddressBlockedError(hostname, resolved);
    }
    for (const addr of addresses) {
      hostEntries.push({ hostname, address: addr.address });
    }
    targets.push({ hostname, addresses });
  }
  return {
    networkArgs: buildSkillRunnerEgressNetworkArgs({ egressAllowlist: input.egressAllowlist, network, hostEntries }),
    targets,
  };
}

export async function resolveSkillRunnerNetworkArgs(input: {
  egressAllowlist?: string[];
  environment: NodeJS.ProcessEnv;
  lookupHost?: SkillRunnerEgressLookup;
}): Promise<string[]> {
  const plan = await resolveSkillRunnerEgressPlan(input);
  return plan?.networkArgs ?? ["--network", "none"];
}

export interface SkillRunnerEgressPolicyExecutionInput {
  /** Full `docker run --rm …` plan from buildSkillRunnerDockerArgs (with networkArgs). */
  runArgs: string[];
  containerName: string;
  /** Unique per run — the firewall policy/chain id derives from it. */
  runId: string;
  /** Port-less L3/L4 targets from the resolved egress plan. */
  targets: ManagedServiceEgressTarget[];
  policy: ManagedServiceEgressPolicyRuntime;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  /** Injectable phase runner (tests); production uses the docker spawn path. */
  execute?: (args: string[], timeoutMs: number, containerName?: string, environment?: NodeJS.ProcessEnv) => Promise<SkillRunnerExecutionResult>;
}

/**
 * Executes a granted run behind the L3/L4 egress firewall. A plain
 * `docker run` starts the container before any host rule can name its source
 * IP, so the run is split into phases:
 *   create → inspect assigned IPs → apply per-run chain (allow the resolved
 *   target IPs, drop everything else) → start -a → remove chain + container.
 * The firewall closes the raw-IP / DoH bypass that DNS pinning alone leaves
 * open. Every failure before `start` fails closed: the container is removed
 * and the policy chain's default verdict is DROP. A crashed daemon can leave
 * a chain behind; the broker sweeps persisted policy state on startup.
 */
export async function executeSkillRunnerWithEgressPolicy(
  input: SkillRunnerEgressPolicyExecutionInput,
): Promise<SkillRunnerExecutionResult> {
  const environment = input.environment ?? process.env;
  const execute = input.execute ?? executeDockerSkillRunner;
  if (input.runArgs[0] !== "run") {
    throw new Error("skill_runner.egress_plan_invalid");
  }
  const createArgs = ["create", ...input.runArgs.slice(1).filter((arg) => arg !== "--rm")];
  const createRunner = async (): Promise<SkillRunnerExecutionResult> => execute(createArgs, 30_000);
  let created = await createRunner();
  if (created.exitCode !== 0) {
    // Deterministic name → a stale container from a crashed run may exist;
    // clear and retry once (mirrors the managed-service provision flow).
    if (!/already in use|already exists/i.test(`${created.stderr}\n${created.stdout}`)) {
      throw new Error(`skill_runner.container_create_failed: ${(created.stderr || created.stdout).trim()}`);
    }
    await forceRemoveDockerSkillRunnerContainer(input.containerName, environment);
    created = await createRunner();
    if (created.exitCode !== 0) {
      throw new Error(`skill_runner.container_create_failed: ${(created.stderr || created.stdout).trim()}`);
    }
  }
  let policyApplied = false;
  try {
    const inspected = await execute(
      ["inspect", "--format", "{{json .NetworkSettings.Networks}}", input.containerName],
      15_000,
    );
    let sourceAddresses: ManagedNetworkAddress[] = [];
    try {
      if (inspected.exitCode === 0) {
        sourceAddresses = parseContainerNetworkAddresses(inspected.stdout.trim());
      }
    } catch {
      // Fall through to the missing-source failure below.
    }
    if (sourceAddresses.length === 0) {
      throw new Error("skill_runner.egress_policy_source_missing: Docker assigned no container IP before start.");
    }
    await input.policy.apply({
      serviceId: input.runId,
      sourceAddresses,
      targets: input.targets,
    });
    policyApplied = true;
    return await execute(["start", "-a", input.containerName], input.timeoutMs, input.containerName, environment);
  } finally {
    // Fail-closed teardown: confirm the container is gone BEFORE revoking the
    // firewall. Removing the policy first would leave a still-running container
    // with no DOCKER-USER restriction (network fail-open). If container removal
    // fails (Docker hung / rm timeout), the SkillRunnerContainerCleanupError
    // propagates and the policy stays applied — the chain's default verdict is
    // DROP, so the live container remains locked down until a retry succeeds.
    await forceRemoveDockerSkillRunnerContainer(input.containerName, environment);
    if (policyApplied) {
      // Container confirmed gone — a failed policy removal now only leaks a
      // stale chain (swept on the next daemon start), never an open container.
      await input.policy.remove({ serviceId: input.runId }).catch(() => undefined);
    }
  }
}
