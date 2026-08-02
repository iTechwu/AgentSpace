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
  port: number;
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
      await runFirewallChecked(exec, family, [
        "-w", "5", "-A", chain,
        "-d", `${destination.address}/${family === "ipv4" ? "32" : "128"}`,
        "-p", "tcp", "--dport", String(destination.port),
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

function dedupeDestinations<T extends ManagedNetworkAddress & { port: number }>(destinations: T[]): T[] {
  const unique = new Map<string, T>();
  for (const destination of destinations) {
    unique.set(`${destination.family}:${destination.address}:${destination.port}`, destination);
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
