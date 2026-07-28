import { spawnSync } from "node:child_process";

const network = process.env.MANAGED_RUNTIME_DOCKER_NETWORK?.trim();
const gateway = process.env.MODELS_GATEWAY_BASE_URL?.trim();
const blocked = (process.env.MANAGED_RUNTIME_BLOCKED_EGRESS_URLS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const imageTag = process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest";
const image = process.env.MANAGED_RUNTIME_EGRESS_CHECK_IMAGE?.trim()
  || `dofe/agent-runtime-codex:${imageTag}`;

if (!network || !gateway || blocked.length === 0) {
  console.error("MANAGED_RUNTIME_DOCKER_NETWORK, MODELS_GATEWAY_BASE_URL, and MANAGED_RUNTIME_BLOCKED_EGRESS_URLS are required.");
  process.exit(2);
}
if (["bridge", "default", "host", "none"].includes(network.toLowerCase())) {
  console.error(`Refusing to validate permissive Docker network: ${network}`);
  process.exit(2);
}

const script = `
const [gateway, ...blocked] = process.argv.slice(1);
const probe = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
};
if (!(await probe(gateway))) {
  console.error("models gateway is unreachable");
  process.exit(1);
}
for (const url of blocked) {
  if (await probe(url)) {
    console.error("blocked Provider endpoint is reachable: " + url);
    process.exit(1);
  }
}
console.log("managed Runtime egress policy passed");
`;

const result = spawnSync("docker", [
  "run", "--rm", "--network", network,
  "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--entrypoint", "node", image, "-e", script, gateway, ...blocked,
], { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}
process.exit(result.status ?? 2);
