import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type ManagedNetworkFamily = "ipv4" | "ipv6";

export interface ManagedNetworkAddress {
  family: ManagedNetworkFamily;
  address: string;
}

export interface ManagedServiceEgressTarget {
  hostname: string;
  /**
   * TCP destination port. `undefined` = ANY port to the target addresses —
   * used by the Skill Runner, whose approved grant object is a hostname (the
   * DNS-pin layer cannot express ports, so the grant covers all of them).
   */
  port?: number;
  addresses: ManagedNetworkAddress[];
}

export interface ParsedManagedServiceEgressTarget {
  hostname: string;
  port: number;
}

export type ManagedFirewallExec = (
  family: ManagedNetworkFamily,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

export interface ManagedServiceEgressPolicyRuntime {
  apply(input: {
    serviceId: string;
    sourceAddresses: ManagedNetworkAddress[];
    targets: ManagedServiceEgressTarget[];
  }): Promise<void>;
  remove(input: { serviceId: string }): Promise<void>;
}

interface PersistedEgressPolicy {
  serviceId: string;
  sourceAddresses: ManagedNetworkAddress[];
}

export class ManagedServiceEgressPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ManagedServiceEgressPolicyError";
    this.code = code;
  }
}

/** L3/L4 policy is intentionally origin-shaped; URL paths and credentials are not enforceable here. */
export function parseManagedServiceEgressTargets(entries: string[]): ParsedManagedServiceEgressTarget[] {
  const targets = new Map<string, ParsedManagedServiceEgressTarget>();
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    let url: URL;
    try {
      url = new URL(entry.includes("://") ? entry : `https://${entry}`);
    } catch {
      throw new ManagedServiceEgressPolicyError(
        "skill_service.egress_policy_invalid_target",
        `Invalid egress origin: ${entry}`,
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ManagedServiceEgressPolicyError(
        "skill_service.egress_policy_invalid_target",
        `Unsupported egress protocol ${url.protocol}; expected http or https.`,
      );
    }
    if (url.username || url.password) {
      throw new ManagedServiceEgressPolicyError(
        "skill_service.egress_policy_invalid_target",
        "Egress origins must not contain credentials.",
      );
    }
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
      throw new ManagedServiceEgressPolicyError(
        "skill_service.egress_policy_invalid_target",
        "Egress allow-list entries must be origins without a path, query or fragment.",
      );
    }
    const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !url.hostname) {
      throw new ManagedServiceEgressPolicyError(
        "skill_service.egress_policy_invalid_target",
        `Invalid egress host or port: ${entry}`,
      );
    }
    const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    targets.set(`${hostname.toLowerCase()}:${port}`, { hostname: hostname.toLowerCase(), port });
  }
  return [...targets.values()];
}

/** iptables chain names are kept below the historical 28-character limit. */
export function buildManagedServiceEgressChainName(serviceId: string): string {
  return `DFE_${createHash("sha256").update(serviceId).digest("hex").slice(0, 20)}`;
}

export function createIptablesManagedServiceEgressPolicy(options: {
  stateRootDir: string;
  exec?: ManagedFirewallExec;
  platform?: NodeJS.Platform;
}): ManagedServiceEgressPolicyRuntime {
  const exec = options.exec ?? defaultFirewallExec;
  const platform = options.platform ?? process.platform;

  return {
    async apply(input) {
      if (platform !== "linux") {
        throw new ManagedServiceEgressPolicyError(
          "skill_service.egress_policy_unsupported_platform",
          `Managed service egress enforcement requires a Linux node; got ${platform}.`,
        );
      }
      if (input.sourceAddresses.length === 0) {
        throw new ManagedServiceEgressPolicyError(
          "skill_service.egress_policy_source_missing",
          "Docker did not assign an IPv4 or IPv6 source address before container start.",
        );
      }

      const previous = await readPolicyState(options.stateRootDir, input.serviceId);
      if (previous) {
        try {
          await removeFirewallRules(exec, previous);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ManagedServiceEgressPolicyError("skill_service.egress_policy_apply_failed", message);
        }
      }
      const state: PersistedEgressPolicy = {
        serviceId: input.serviceId,
        sourceAddresses: dedupeAddresses(input.sourceAddresses),
      };
      await writePolicyState(options.stateRootDir, state);
      try {
        await applyFirewallRules(exec, state, input.targets);
      } catch (error) {
        await removeFirewallRules(exec, state).catch(() => undefined);
        await removePolicyState(options.stateRootDir, input.serviceId).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new ManagedServiceEgressPolicyError("skill_service.egress_policy_apply_failed", message);
      }
    },

    async remove(input) {
      const state = await readPolicyState(options.stateRootDir, input.serviceId);
      if (!state) {
        return;
      }
      try {
        await removeFirewallRules(exec, state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ManagedServiceEgressPolicyError("skill_service.egress_policy_remove_failed", message);
      }
      await removePolicyState(options.stateRootDir, input.serviceId);
    },
  };
}

async function applyFirewallRules(
  exec: ManagedFirewallExec,
  state: PersistedEgressPolicy,
  targets: ManagedServiceEgressTarget[],
): Promise<void> {
  const chain = buildManagedServiceEgressChainName(state.serviceId);
  const families = [...new Set(state.sourceAddresses.map((source) => source.family))];
  for (const family of families) {
    const create = await exec(family, ["-w", "5", "-N", chain]);
    if (create.exitCode !== 0 && !/already exists/i.test(create.stderr)) {
      throw new Error(create.stderr || create.stdout || `Could not create ${chain}.`);
    }
    await runFirewallChecked(exec, family, ["-w", "5", "-F", chain]);
    await runFirewallChecked(exec, family, [
      "-w", "5", "-A", chain,
      "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED",
      "-j", "RETURN",
    ]);
    const destinations = targets.flatMap((target) => target.addresses
      .filter((address) => address.family === family)
      .map((address) => ({ ...address, port: target.port })));
    for (const destination of dedupeDestinations(destinations)) {
      // A port-less destination matches ANY TCP port (Skill Runner hostname
      // grants); managed services always carry an explicit port.
      await runFirewallChecked(exec, family, [
        "-w", "5", "-A", chain,
        "-d", `${destination.address}/${family === "ipv4" ? "32" : "128"}`,
        "-p", "tcp",
        ...(destination.port === undefined ? [] : ["--dport", String(destination.port)]),
        "-j", "RETURN",
      ]);
    }
    await runFirewallChecked(exec, family, ["-w", "5", "-A", chain, "-j", "DROP"]);

    for (const source of state.sourceAddresses.filter((address) => address.family === family)) {
      const sourceCidr = `${source.address}/${family === "ipv4" ? "32" : "128"}`;
      const check = await exec(family, ["-w", "5", "-C", "DOCKER-USER", "-s", sourceCidr, "-j", chain]);
      if (check.exitCode !== 0) {
        await runFirewallChecked(exec, family, [
          "-w", "5", "-I", "DOCKER-USER", "1", "-s", sourceCidr, "-j", chain,
        ]);
      }
    }
  }
}

async function removeFirewallRules(exec: ManagedFirewallExec, state: PersistedEgressPolicy): Promise<void> {
  const chain = buildManagedServiceEgressChainName(state.serviceId);
  for (const source of state.sourceAddresses) {
    const sourceCidr = `${source.address}/${source.family === "ipv4" ? "32" : "128"}`;
    await runFirewallCleanup(exec, source.family, [
      "-w", "5", "-D", "DOCKER-USER", "-s", sourceCidr, "-j", chain,
    ]);
  }
  for (const family of [...new Set(state.sourceAddresses.map((source) => source.family))]) {
    await runFirewallCleanup(exec, family, ["-w", "5", "-F", chain]);
    await runFirewallCleanup(exec, family, ["-w", "5", "-X", chain]);
  }
}

async function runFirewallCleanup(
  exec: ManagedFirewallExec,
  family: ManagedNetworkFamily,
  args: string[],
): Promise<void> {
  const result = await exec(family, args);
  if (result.exitCode === 0) {
    return;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (/no chain|does a matching rule exist|bad rule|no such file or directory/i.test(output)) {
    return;
  }
  throw new Error(result.stderr || result.stdout || `Firewall cleanup failed: ${args.join(" ")}`);
}

async function runFirewallChecked(
  exec: ManagedFirewallExec,
  family: ManagedNetworkFamily,
  args: string[],
): Promise<void> {
  const result = await exec(family, args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Firewall command failed: ${args.join(" ")}`);
  }
}

function dedupeAddresses(addresses: ManagedNetworkAddress[]): ManagedNetworkAddress[] {
  const unique = new Map<string, ManagedNetworkAddress>();
  for (const address of addresses) {
    if ((address.family === "ipv4" && isIP(address.address) === 4)
      || (address.family === "ipv6" && isIP(address.address) === 6)) {
      unique.set(`${address.family}:${address.address}`, address);
    }
  }
  return [...unique.values()];
}

function dedupeDestinations<T extends ManagedNetworkAddress & { port?: number }>(destinations: T[]): T[] {
  const unique = new Map<string, T>();
  for (const destination of destinations) {
    unique.set(`${destination.family}:${destination.address}:${destination.port ?? "any"}`, destination);
  }
  return [...unique.values()];
}

function policyStatePath(rootDir: string, serviceId: string): string {
  const name = createHash("sha256").update(serviceId).digest("hex");
  return join(rootDir, `${name}.json`);
}

async function writePolicyState(rootDir: string, state: PersistedEgressPolicy): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  await fs.chmod(rootDir, 0o700);
  const target = policyStatePath(rootDir, state.serviceId);
  const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(staging, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(staging, target);
}

async function readPolicyState(rootDir: string, serviceId: string): Promise<PersistedEgressPolicy | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(policyStatePath(rootDir, serviceId), "utf8")) as PersistedEgressPolicy;
    if (value.serviceId !== serviceId || !Array.isArray(value.sourceAddresses)) {
      return undefined;
    }
    return { serviceId, sourceAddresses: dedupeAddresses(value.sourceAddresses) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removePolicyState(rootDir: string, serviceId: string): Promise<void> {
  await fs.rm(policyStatePath(rootDir, serviceId), { force: true });
}

/**
 * Parses `docker inspect --format '{{json .NetworkSettings.Networks}}'` output
 * into the container's assigned addresses (both families). Shared by managed
 * services and the Skill Runner firewall path.
 */
export function parseContainerNetworkAddresses(networksJson: string): ManagedNetworkAddress[] {
  const networks = JSON.parse(networksJson) as Record<string, {
    IPAddress?: string;
    GlobalIPv6Address?: string;
  }>;
  const addresses: ManagedNetworkAddress[] = [];
  for (const network of Object.values(networks)) {
    if (network.IPAddress && isIP(network.IPAddress) === 4) {
      addresses.push({ family: "ipv4", address: network.IPAddress });
    }
    if (network.GlobalIPv6Address && isIP(network.GlobalIPv6Address) === 6) {
      addresses.push({ family: "ipv6", address: network.GlobalIPv6Address });
    }
  }
  return addresses;
}

/**
 * Crash-recovery removal of persisted egress policies under `stateRootDir`.
 * Used when a broker/daemon starts: a crash can leave a per-container chain and
 * DOCKER-USER jump behind.
 *
 * A policy is revoked ONLY when its owning container is confirmed gone. The
 * caller may pass `enumerateLivePolicyOwners`, which returns the serviceIds of
 * still-running Runner containers; a policy in that set is KEPT — removing its
 * chain would re-open a live container's network (the chain's default verdict is
 * DROP, so keeping it is fail-closed). Policies whose owner is absent (or every
 * policy when no enumerator is supplied) are removed as stale. If the enumerator
 * itself fails, nothing is removed and `enumerationFailed` is `true` so the
 * caller retries on its next start instead of caching the sweep as done.
 *
 * Individual remove failures are counted in `removalFailed` but do NOT abort the
 * sweep — a misbehaving firewall must not block daemon startup. The candidate's
 * state file survives a failed `remove` (the firewall rules are torn down BEFORE
 * the state file is deleted, see the `remove` runtime), so it stays on disk and
 * the NEXT sweep retries it. A `serviceId` is a per-run lease that is never
 * re-applied, so the retry has to come from a future sweep — callers must drop
 * any "sweep done" cache when `removalFailed > 0` so that next sweep runs.
 */
export async function sweepPersistedEgressPolicies(
  stateRootDir: string,
  runtime: ManagedServiceEgressPolicyRuntime,
  options?: { enumerateLivePolicyOwners?: () => Promise<Set<string>> },
): Promise<{ removed: number; kept: number; enumerationFailed: boolean; removalFailed: number }> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateRootDir);
  } catch {
    return { removed: 0, kept: 0, enumerationFailed: false, removalFailed: 0 };
  }
  // Collect candidate policies first so the (possibly docker-shelling) live-owner
  // enumeration only runs when there is actually something to evaluate.
  const candidates: Array<{ entry: string; serviceId: string }> = [];
  let kept = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await fs.readFile(join(stateRootDir, entry), "utf8")) as { serviceId?: unknown };
      if (typeof value.serviceId !== "string" || !value.serviceId) continue;
      candidates.push({ entry, serviceId: value.serviceId });
    } catch {
      // A broken state file is ignored, not removed here (its filename is opaque).
    }
  }
  let liveOwners: Set<string> | undefined;
  if (options?.enumerateLivePolicyOwners && candidates.length > 0) {
    try {
      liveOwners = await options.enumerateLivePolicyOwners();
    } catch {
      // Could not prove any owner dead. Keep everything (fail-closed: a stale
      // chain DROPs, an opened live container does not) and signal the caller to
      // retry rather than cache this sweep as complete.
      return { removed: 0, kept: candidates.length, enumerationFailed: true, removalFailed: 0 };
    }
  }
  let removed = 0;
  let removalFailed = 0;
  for (const { serviceId } of candidates) {
    if (liveOwners?.has(serviceId)) {
      kept += 1;
      continue;
    }
    try {
      await runtime.remove({ serviceId });
      removed += 1;
    } catch {
      // Best-effort sweep: a failing firewall must not block daemon startup. The
      // candidate's state file survives this failure (remove() deletes it only
      // AFTER the firewall rules are gone), so it stays on disk and the next
      // sweep retries. Count it so the caller can drop its "sweep done" cache.
      removalFailed += 1;
    }
  }
  return { removed, kept, enumerationFailed: false, removalFailed };
}

const defaultFirewallExec: ManagedFirewallExec = (family, args) => {
  const command = family === "ipv4"
    ? process.env.DOFE_AGENT_IPTABLES_BIN?.trim() || "iptables"
    : process.env.DOFE_AGENT_IP6TABLES_BIN?.trim() || "ip6tables";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
};
