import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatManagedNodeOperationalEnv,
  resolveManagedNodeOperationalEnv,
} from "../../../deploy/daemon/local-managed-node-env-config.ts";

const dockerfile = readFileSync(
  new URL("../../../deploy/daemon/Dockerfile.managed-node", import.meta.url),
  "utf8",
);
const providerDockerfile = readFileSync(
  new URL("../../../deploy/daemon/Dockerfile.provider-runtime", import.meta.url),
  "utf8",
);
const localRuntimeDockerfile = readFileSync(
  new URL("../../../deploy/daemon/Dockerfile", import.meta.url),
  "utf8",
);
const runtimeBuildScript = readFileSync(
  new URL("../../../deploy/staging/build-managed-runtime-images.sh", import.meta.url),
  "utf8",
);
const managedNodeCompose = readFileSync(
  new URL("../../../deploy/daemon/docker-compose.managed-node.yml", import.meta.url),
  "utf8",
);

test("managed-node image installs a checksum-pinned multi-arch cosign binary", () => {
  assert.match(dockerfile, /ARG COSIGN_VERSION=v\d+\.\d+\.\d+/);
  assert.match(dockerfile, /amd64\) COSIGN_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /arm64\) COSIGN_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /curl .*--http1\.1/);
  assert.match(dockerfile, /--retry 5 --retry-all-errors --retry-delay 2/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /COPY --from=cosign-download \/usr\/local\/bin\/cosign \/usr\/local\/bin\/cosign/);
});

test("managed-node runtime stage includes provider probe tools and cached package installs", () => {
  assert.match(
    dockerfile,
    /apt-get install --yes --no-install-recommends ca-certificates curl docker\.io iptables/,
  );
  assert.match(dockerfile, /npm_config_registry=https:\/\/registry\.npmmirror\.com/);
  assert.match(dockerfile, /--mount=type=cache,id=dofe-managed-node-pnpm,target=\/pnpm\/store/);
  assert.match(
    managedNodeCompose,
    /\$\{MANAGED_NODE_MODELS_GATEWAY_HOST:-model\.local\.dofe\.ai\}:host-gateway/,
  );
});

test("managed-node image does not embed shared data-plane services", () => {
  assert.doesNotMatch(dockerfile, /FROM\s+(?:postgres|redis|rabbitmq)(?::|\s)/i);
});

test("provider runtime image includes operational tools required by provider checks and installs", () => {
  assert.match(
    providerDockerfile,
    /apt-get install --yes --no-install-recommends ca-certificates chromium curl python3 python3-pip/,
  );
  assert.match(providerDockerfile, /apt-get install --yes --no-install-recommends git/);
  assert.match(providerDockerfile, /npm_config_registry=https:\/\/registry\.npmmirror\.com/);
  assert.match(providerDockerfile, /--mount=type=cache,id=dofe-provider-runtime-pnpm,target=\/pnpm\/store/);
});

test("local runtime builds include provider probe tools and a pinned Codex CLI", () => {
  assert.match(localRuntimeDockerfile, /apt-get install --yes --no-install-recommends ca-certificates curl/);
  assert.match(localRuntimeDockerfile, /npm install --global pnpm@10\.26\.2/);
  assert.match(localRuntimeDockerfile, /--mount=type=cache,id=dofe-local-runtime-pnpm,target=\/pnpm\/store/);
  assert.match(localRuntimeDockerfile, /--mount=type=cache,id=dofe-local-runtime-provider-cli,target=\/pnpm\/store/);
  assert.equal(
    localRuntimeDockerfile.match(/npm_config_registry=https:\/\/registry\.npmmirror\.com/g)?.length,
    2,
  );
  assert.match(runtimeBuildScript, /@openai\/codex@0\.145\.0/);
  assert.doesNotMatch(runtimeBuildScript, /codex\).*@openai\/codex@latest/);
});

test("local managed-node recovery preserves required operational settings", () => {
  const resolved = resolveManagedNodeOperationalEnv(
    [
      "MCP_EGRESS_PROXY_URL=http://172.31.240.2:8080",
      "MCP_EGRESS_PROXY_ADMIN_TOKEN=existing-secret",
      "PROXY_RUNTIME_IP=172.31.240.2",
      "DOFE_SKILL_RUNNER_TIMEOUT_MS=45000",
      "DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS=720000",
    ].join("\n"),
    {
      MCP_EGRESS_PROXY_URL: "http://127.0.0.1:8080",
      MCP_EGRESS_ENFORCE: "true",
    },
  );

  assert.equal(resolved.MCP_EGRESS_PROXY_URL, "http://127.0.0.1:8080");
  assert.equal(resolved.MCP_EGRESS_PROXY_ADMIN_TOKEN, "existing-secret");
  assert.equal(resolved.MCP_EGRESS_ENFORCE, "true");
  assert.equal(resolved.PROXY_RUNTIME_IP, "172.31.240.2");
  assert.equal(resolved.DOFE_SKILL_RUNNER_TIMEOUT_MS, "45000");
  assert.equal(resolved.DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS, "720000");
  assert.ok(formatManagedNodeOperationalEnv(resolved).includes("MCP_EGRESS_PROXY_ADMIN_TOKEN=existing-secret"));
  assert.ok(formatManagedNodeOperationalEnv(resolved).includes("DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS=720000"));
});

test("local managed-node recovery preserves paired OpenMontage service settings", () => {
  const resolved = resolveManagedNodeOperationalEnv(
    [
      "MCP_EGRESS_PROXY_URL=http://172.31.240.2:8080",
      "MCP_EGRESS_PROXY_ADMIN_TOKEN=existing-secret",
      "OPENMONTAGE_MCP_URL=http://host.docker.internal:8765/mcp",
      "OPENMONTAGE_SERVICE_TOKEN=openmontage-secret",
    ].join("\n"),
  );

  assert.equal(resolved.OPENMONTAGE_MCP_URL, "http://host.docker.internal:8765/mcp");
  assert.equal(resolved.OPENMONTAGE_SERVICE_TOKEN, "openmontage-secret");
});

test("local managed-node recovery fails closed for partial or unsafe OpenMontage settings", () => {
  assert.throws(
    () =>
      resolveManagedNodeOperationalEnv(
        "MCP_EGRESS_PROXY_URL=http://127.0.0.1:8080\nMCP_EGRESS_PROXY_ADMIN_TOKEN=secret\nOPENMONTAGE_MCP_URL=http://openmontage:8765/mcp",
      ),
    /must be configured together/,
  );
  assert.throws(
    () =>
      resolveManagedNodeOperationalEnv(
        "MCP_EGRESS_PROXY_URL=http://127.0.0.1:8080\nMCP_EGRESS_PROXY_ADMIN_TOKEN=secret\nOPENMONTAGE_MCP_URL=http://user:pass@openmontage:8765/mcp\nOPENMONTAGE_SERVICE_TOKEN=secret",
      ),
    /credential-free HTTP\(S\) URL/,
  );
});

test("local managed-node recovery fails before rotation when proxy settings are incomplete", () => {
  assert.throws(
    () => resolveManagedNodeOperationalEnv("", {}),
    /MCP_EGRESS_PROXY_URL is required/,
  );
  assert.throws(
    () => resolveManagedNodeOperationalEnv("MCP_EGRESS_PROXY_URL=http:\/\/127.0.0.1:8080", {}),
    /MCP_EGRESS_PROXY_ADMIN_TOKEN is required/,
  );
  assert.throws(
    () =>
      resolveManagedNodeOperationalEnv(
        "MCP_EGRESS_PROXY_URL=http:\/\/127.0.0.1:8080\/path\nMCP_EGRESS_PROXY_ADMIN_TOKEN=secret",
        {},
      ),
    /must be an HTTP\(S\) origin/,
  );
});
