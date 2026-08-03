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

test("managed-node image installs a checksum-pinned multi-arch cosign binary", () => {
  assert.match(dockerfile, /ARG COSIGN_VERSION=v\d+\.\d+\.\d+/);
  assert.match(dockerfile, /amd64\) COSIGN_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /arm64\) COSIGN_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /COPY --from=cosign-download \/usr\/local\/bin\/cosign \/usr\/local\/bin\/cosign/);
});

test("managed-node image does not embed shared data-plane services", () => {
  assert.doesNotMatch(dockerfile, /FROM\s+(?:postgres|redis|rabbitmq)(?::|\s)/i);
});

test("local managed-node recovery preserves required operational settings", () => {
  const resolved = resolveManagedNodeOperationalEnv(
    [
      "MCP_EGRESS_PROXY_URL=http://172.31.240.2:8080",
      "MCP_EGRESS_PROXY_ADMIN_TOKEN=existing-secret",
      "PROXY_RUNTIME_IP=172.31.240.2",
      "DOFE_SKILL_RUNNER_TIMEOUT_MS=45000",
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
  assert.ok(formatManagedNodeOperationalEnv(resolved).includes("MCP_EGRESS_PROXY_ADMIN_TOKEN=existing-secret"));
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
