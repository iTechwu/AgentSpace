import { spawnSync } from "node:child_process";
import {
  persistReleaseEvidence,
  evaluateEgressProbeEvidence,
  requiredEnv,
  splitList,
  validateManagedNetworkInspection,
} from "./managed-runtime-release-gates.mjs";

let evidence = { passed: false };
let exitCode = 2;
try {
  const required = requiredEnv(process.env, [
    "MANAGED_RUNTIME_DOCKER_NETWORK",
    "MODELS_GATEWAY_BASE_URL",
    "MANAGED_RUNTIME_BLOCKED_EGRESS_URLS",
    "MANAGED_RUNTIME_BLOCKED_EGRESS_IPS",
    "MANAGED_RUNTIME_BLOCKED_PROXY_URLS",
  ]);
  const network = required.MANAGED_RUNTIME_DOCKER_NETWORK;
  const policyLabel = process.env.MANAGED_RUNTIME_NETWORK_POLICY_LABEL?.trim()
    || "dofe.managed-egress=restricted";
  const inspectionResult = spawnSync("docker", ["network", "inspect", network], {
    encoding: "utf8",
  });
  if (inspectionResult.error) throw inspectionResult.error;
  if (inspectionResult.status !== 0) {
    throw new Error(`docker_network_inspect_failed:${inspectionResult.stderr.trim()}`);
  }
  const inspection = JSON.parse(inspectionResult.stdout)?.[0];
  const networkEvidence = validateManagedNetworkInspection(inspection, { network, policyLabel });
  const imageTag = process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest";
  const image = process.env.MANAGED_RUNTIME_EGRESS_CHECK_IMAGE?.trim()
    || `dofe/agent-runtime-codex:${imageTag}`;
  const probeInput = {
    gateway: required.MODELS_GATEWAY_BASE_URL,
    blockedUrls: splitList(required.MANAGED_RUNTIME_BLOCKED_EGRESS_URLS),
    blockedIps: splitList(required.MANAGED_RUNTIME_BLOCKED_EGRESS_IPS),
    blockedProxies: splitList(required.MANAGED_RUNTIME_BLOCKED_PROXY_URLS),
  };
  for (const [name, targets] of Object.entries(probeInput).filter(([name]) => name !== "gateway")) {
    if (!Array.isArray(targets) || targets.length === 0) throw new Error(`egress_probe_targets_empty:${name}`);
  }
  const result = spawnSync("docker", [
    "run", "--rm", "--network", network,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--entrypoint", "node", image, "--input-type=module", "-e", getContainerProbeScript(),
    JSON.stringify(probeInput),
  ], { encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const probeEvidence = parseContainerEvidence(result.stdout);
  const probesPassed = evaluateEgressProbeEvidence(probeEvidence.probes);
  evidence = {
    passed: result.status === 0 && probesPassed,
    image,
    network: networkEvidence,
    probes: probeEvidence.probes,
  };
  exitCode = evidence.passed ? 0 : 1;
} catch (error) {
  evidence = {
    ...evidence,
    error: error instanceof Error ? error.message : String(error),
  };
}

try {
  const stored = persistReleaseEvidence("managed-runtime-egress", evidence);
  console.log(JSON.stringify({ ...stored.payload, evidenceFile: stored.filePath }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 2;
}
process.exit(exitCode);

function parseContainerEvidence(output) {
  const line = output.split(/\r?\n/).find((value) => value.startsWith("EVIDENCE_JSON:"));
  if (!line) throw new Error("container_probe_evidence_missing");
  return JSON.parse(line.slice("EVIDENCE_JSON:".length));
}

function getContainerProbeScript() {
  return String.raw`
import net from "node:net";

const input = JSON.parse(process.argv[1]);
const timeoutMs = 5000;
const fetchProbe = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return { target: url, reachable: true, status: response.status };
  } catch (error) {
    return { target: url, reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
};
const tcpProbe = async (target, defaultPort) => {
  const url = new URL(target.includes("://") ? target : "tcp://" + target);
  const port = Number(url.port || defaultPort);
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port });
    const finish = (reachable, error) => {
      socket.destroy();
      resolve({ target, host: url.hostname, port, reachable, ...(error ? { error } : {}) });
    };
    socket.setTimeout(timeoutMs, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error.message));
  });
};

const gateway = await fetchProbe(input.gateway);
const blockedUrls = await Promise.all(input.blockedUrls.map(async (target) => {
  const application = await fetchProbe(target);
  const url = new URL(target);
  const transport = await tcpProbe(target, url.protocol === "http:" ? 80 : 443);
  return { ...application, tcpReachable: transport.reachable, tcpError: transport.error };
}));
const blockedIps = await Promise.all(input.blockedIps.map((target) => tcpProbe(target, 443)));
const blockedProxies = await Promise.all(input.blockedProxies.map((target) => tcpProbe(target, 8080)));
const proxyEnvironment = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
  .filter((name) => process.env[name]);
console.log("EVIDENCE_JSON:" + JSON.stringify({
  probes: { gateway, blockedUrls, blockedIps, blockedProxies, proxyEnvironment },
}));
`;
}
