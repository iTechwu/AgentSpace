import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createManagedDaemonBootstrapTokenSync,
  revokeDaemonApiTokenSync,
  validateDaemonApiTokenSync,
} from "../../packages/db/src/daemon-tokens.ts";

const WORKSPACE_ID = process.env.MANAGED_NODE_WORKSPACE_ID?.trim();
if (!WORKSPACE_ID?.startsWith("sso-team-")) {
  throw new Error("MANAGED_NODE_WORKSPACE_ID must identify an sso-team workspace.");
}

const daemonDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(daemonDirectory, "../..");
const envPath = resolve(daemonDirectory, ".env.managed-node");
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const daemonId = `local-docker-managed-node-${timestamp}`;
const stateDirectory = resolve(repositoryRoot, `data/${daemonId}`);
const tlsCaPath = resolve(homedir(), "Library/Application Support/mkcert/rootCA.pem");

let revokedTokenId: string | null = null;
if (existsSync(envPath)) {
  const previousToken = readEnvValue(readFileSync(envPath, "utf8"), "DOFE_AGENT_DAEMON_TOKEN");
  if (previousToken) {
    const previousRecord = validateDaemonApiTokenSync(previousToken);
    if (previousRecord?.status === "active") {
      revokeDaemonApiTokenSync(previousRecord.id);
      revokedTokenId = previousRecord.id;
    }
  }
}

const created = createManagedDaemonBootstrapTokenSync({
  workspaceId: WORKSPACE_ID,
  label: `Local managed node ${timestamp}`,
  createdBy: "local-admin-runtime-recovery",
});

const lines = [
  "DOFE_AGENT_SERVER_URL=http://host.docker.internal:1455",
  `DOFE_AGENT_DAEMON_TOKEN=${created.token}`,
  `DOFE_AGENT_DAEMON_ID=${daemonId}`,
  "DOFE_AGENT_DEVICE_NAME=Local Docker managed node",
  "DOFE_AGENT_RUNTIME_NAME=Managed execution node",
  `MANAGED_NODE_STATE_DIR=${stateDirectory}`,
  "MANAGED_NODE_USER=0:0",
  "MANAGED_RUNTIME_DOCKER_EXTRA_HOSTS=model.local.dofe.ai:host-gateway",
  `MANAGED_RUNTIME_TLS_CA_PATH=${existsSync(tlsCaPath) ? tlsCaPath : ""}`,
  "MANAGED_RUNTIME_DOCKER_NETWORK=dofe-managed-egress",
  "MANAGED_RUNTIME_IMAGE_TAG=latest",
  "",
];

const temporaryPath = `${envPath}.tmp`;
writeFileSync(temporaryPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, envPath);

process.stdout.write(`${JSON.stringify({
  workspaceId: WORKSPACE_ID,
  daemonId,
  tokenId: created.id,
  revokedTokenId,
  envPath,
  stateDirectory,
  runtimeTlsCaConfigured: existsSync(tlsCaPath),
})}\n`);

function readEnvValue(source: string, key: string): string | null {
  const prefix = `${key}=`;
  const line = source.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value || null;
}
