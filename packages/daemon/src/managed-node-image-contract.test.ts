import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const deepSeekRuntimeDockerfileUrl = new URL(
  "../../../deploy/daemon/Dockerfile.deepseek-harness-runtime",
  import.meta.url,
);
const localRuntimeDockerfile = readFileSync(
  new URL("../../../deploy/daemon/Dockerfile", import.meta.url),
  "utf8",
);
const selfHostedDockerfile = readFileSync(
  new URL("../../../deploy/self-hosted/Dockerfile", import.meta.url),
  "utf8",
);
const workflowWorkerDockerfile = readFileSync(
  new URL("../../../deploy/workflow-worker/Dockerfile", import.meta.url),
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
const runtimeCompose = readFileSync(
  new URL("../../../deploy/daemon/docker-compose.runtimes.yml", import.meta.url),
  "utf8",
);
const remoteRuntimeCompose = readFileSync(
  new URL("../../../deploy/daemon/docker-compose.remote-images.yml", import.meta.url),
  "utf8",
);
const deepSeekRemoteCompose = readFileSync(
  new URL("../../../deploy/daemon/docker-compose.deepseek-runtime.yml", import.meta.url),
  "utf8",
);
const managedNodeEnvExample = readFileSync(
  new URL("../../../deploy/daemon/.env.example", import.meta.url),
  "utf8",
);
const ensureCiManagedNodesScript = readFileSync(
  new URL("../../../deploy/daemon/ensure-ci-managed-nodes.sh", import.meta.url),
  "utf8",
);
const managedNodeEntrypoint = readFileSync(
  new URL("../../../deploy/daemon/managed-node-entrypoint.sh", import.meta.url),
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
  assert.match(
    managedNodeCompose,
    /CURL_CA_BUNDLE: \$\{MANAGED_RUNTIME_TLS_CA_PATH:\+\/run\/dofe-agent-runtime-ca\.pem\}/,
  );
  assert.match(
    managedNodeCompose,
    /\$\{MANAGED_RUNTIME_TLS_CA_PATH:-\/dev\/null\}:\/run\/dofe-agent-runtime-ca\.pem:ro/,
  );
});

test("managed-node image does not embed shared data-plane services", () => {
  assert.doesNotMatch(dockerfile, /FROM\s+(?:postgres|redis|rabbitmq)(?::|\s)/i);
});

test("managed-node compose requires an explicit environment file", () => {
  assert.match(
    managedNodeCompose,
    /env_file:\s+\$\{MANAGED_NODE_ENV_FILE:\?Set MANAGED_NODE_ENV_FILE to the managed-node environment file\}/,
  );
  assert.match(managedNodeEnvExample, /^MANAGED_NODE_ENV_FILE=\.\/.env\.managed-node$/m);
});

test("CI managed-node lifecycle passes its environment file to every Compose call", () => {
  const composeCalls = ensureCiManagedNodesScript.match(/docker compose --project-name/g) ?? [];
  assert.equal(composeCalls.length, 2);
  assert.match(
    ensureCiManagedNodesScript,
    /MANAGED_NODE_ENV_FILE="\$env_file" MANAGED_NODE_SERVER_HOST="\$MANAGED_NODE_SERVER_HOST"\s+\\\n\s*docker compose --project-name "\$project" --env-file "\$env_file"[\s\S]*? up --build -d/,
  );
  assert.match(
    ensureCiManagedNodesScript,
    /node_id="\$\(MANAGED_NODE_ENV_FILE="\$env_file" MANAGED_NODE_SERVER_HOST="\$MANAGED_NODE_SERVER_HOST"\s+\\\n\s*docker compose --project-name "\$project" --env-file "\$env_file"[\s\S]*? ps -q managed-node\)"/,
  );
});

test("managed-node entrypoint repairs state-root ownership before dropping privileges", () => {
  assert.match(managedNodeEntrypoint, /chown -R 10001:10001 "\$daemon_state_dir\/workspaces"/);
  assert.doesNotMatch(managedNodeEntrypoint, /chown -R 10001:10001 "\$daemon_state_dir"\n/);
  assert.match(managedNodeCompose, /cap_add:\s+\- CHOWN/);
});

test("managed-node compose permits an unset egress proxy while enforcement is disabled", () => {
  assert.match(managedNodeCompose, /MCP_EGRESS_ENFORCE: \$\{MCP_EGRESS_ENFORCE:-false\}/);
  assert.match(managedNodeCompose, /MCP_EGRESS_PROXY_URL: \$\{MCP_EGRESS_PROXY_URL:-\}/);
  assert.match(managedNodeCompose, /MCP_EGRESS_PROXY_ADMIN_TOKEN: \$\{MCP_EGRESS_PROXY_ADMIN_TOKEN:-\}/);
});

test("provider runtime image includes operational tools required by provider checks and installs", () => {
  assert.match(
    providerDockerfile,
    /apt-get install --yes --no-install-recommends ca-certificates chromium curl python3 python3-pip/,
  );
  assert.match(providerDockerfile, /apt-get install --yes --no-install-recommends git/);
  assert.match(providerDockerfile, /npm_config_registry=https:\/\/registry\.npmmirror\.com/);
  assert.match(providerDockerfile, /--mount=type=cache,id=dofe-provider-runtime-pnpm,target=\/pnpm\/store/);
  assert.match(providerDockerfile, /pnpm --filter @dofe-agent\/db run prisma:generate/);
  assert.match(
    providerDockerfile,
    /command -v claude-entrypoint[\s\S]*! command -v claude[\s\S]*claude-entrypoint --version/,
    "provider wrapper must prepare CLIs that are normally installed by the base image entrypoint",
  );
});

test("DeepSeek managed runtime image assembles a digest-pinned JSON-RPC bundle", () => {
  const deepSeekRuntimeDockerfile = readFileSync(deepSeekRuntimeDockerfileUrl, "utf8");

  assert.match(deepSeekRuntimeDockerfile, /COPY --from=deepseek-runtime-bundle \/dsh-jsonrpc-agent /);
  assert.match(deepSeekRuntimeDockerfile, /COPY --from=deepseek-runtime-bundle \/dsh-jsonrpc-agent-rg /);
  assert.match(deepSeekRuntimeDockerfile, /COPY --from=deepseek-runtime-bundle \/provenance\.json /);
  assert.match(deepSeekRuntimeDockerfile, /ARG DEEPSEEK_JSONRPC_EXECUTABLE_SHA256/);
  assert.match(deepSeekRuntimeDockerfile, /ARG DEEPSEEK_JSONRPC_RIPGREP_SHA256/);
  assert.match(deepSeekRuntimeDockerfile, /ARG DEEPSEEK_RUNTIME_WHEEL_SHA256/);
  assert.match(deepSeekRuntimeDockerfile, /ARG DEEPSEEK_RUNTIME_SOURCE_COMMIT/);
  assert.match(deepSeekRuntimeDockerfile, /python3 \/usr\/local\/sbin\/verify-deepseek-runtime-bundle\.py/);
  assert.match(deepSeekRuntimeDockerfile, /sha256sum --check --strict/);
  assert.match(
    deepSeekRuntimeDockerfile,
    /COPY deploy\/daemon\/runtimes\/deepseek-jsonrpc\/cordis\.yml \/etc\/dofe-agent\/deepseek-jsonrpc\/cordis\.yml/,
  );
  assert.match(deepSeekRuntimeDockerfile, /048031be7331f2b68c81b3cbfacacc06ee767dae1e8f00cbdc3137c1e55001af/);
  assert.match(deepSeekRuntimeDockerfile, /DOFE_AGENT_DEEPSEEK_JSONRPC_MANAGED_BUNDLE=1/);
  assert.match(deepSeekRuntimeDockerfile, /DOFE_AGENT_DEEPSEEK_JSONRPC_PROVENANCE=\/usr\/local\/lib\/deepseek-harness\/provenance\.json/);
  assert.match(deepSeekRuntimeDockerfile, /DOFE_AGENT_DEEPSEEK_JSONRPC_SOURCE_COMMIT=\$\{DEEPSEEK_RUNTIME_SOURCE_COMMIT\}/);
  assert.match(deepSeekRuntimeDockerfile, /DOFE_AGENT_DEEPSEEK_JSONRPC_WHEEL_SHA256=\$\{DEEPSEEK_RUNTIME_WHEEL_SHA256\}/);
  assert.match(deepSeekRuntimeDockerfile, /ai\.dofe\.deepseek-harness\.source-ref="dsh-v0\.1\.1-rc\.2"/);
  assert.match(deepSeekRuntimeDockerfile, /ai\.dofe\.deepseek-harness\.source-commit="\$\{DEEPSEEK_RUNTIME_SOURCE_COMMIT\}"/);
  assert.match(deepSeekRuntimeDockerfile, /ai\.dofe\.deepseek-harness\.wheel-sha256="\$\{DEEPSEEK_RUNTIME_WHEEL_SHA256\}"/);
  assert.match(deepSeekRuntimeDockerfile, /ai\.dofe\.deepseek-jsonrpc\.executable-sha256="\$\{DEEPSEEK_JSONRPC_EXECUTABLE_SHA256\}"/);
  assert.match(deepSeekRuntimeDockerfile, /ai\.dofe\.deepseek-jsonrpc\.ripgrep-sha256="\$\{DEEPSEEK_JSONRPC_RIPGREP_SHA256\}"/);
  assert.match(deepSeekRuntimeDockerfile, /ai\.dofe\.deepseek-jsonrpc\.cordis-sha256="048031be7331f2b68c81b3cbfacacc06ee767dae1e8f00cbdc3137c1e55001af"/);
  assert.doesNotMatch(deepSeekRuntimeDockerfile, /FROM\s+(?:postgres|redis|rabbitmq)(?::|\s)/i);

  assert.match(runtimeCompose, /dockerfile: deploy\/daemon\/Dockerfile\.deepseek-harness-runtime/);
  assert.match(runtimeCompose, /deepseek-runtime-bundle:/);
  assert.match(runtimeCompose, /DEEPSEEK_RUNTIME_WHEEL_SHA256:/);
  assert.match(runtimeCompose, /DEEPSEEK_RUNTIME_SOURCE_COMMIT:/);

  assert.doesNotMatch(remoteRuntimeCompose, /runtime-deepseek-harness:/);
  const remoteDeepSeekService = deepSeekRemoteCompose.match(
    /  runtime-deepseek-harness:\n([\s\S]*?)(?=\nvolumes:)/,
  )?.[1] ?? "";
  assert.match(
    remoteDeepSeekService,
    /image: \$\{DEEPSEEK_RUNTIME_IMAGE_REPOSITORY:\?[^}]+\}@sha256:\$\{DEEPSEEK_RUNTIME_IMAGE_SHA256:\?[^}]+\}/,
  );
  assert.doesNotMatch(remoteDeepSeekService, /^\s{4}build:/m);
  assert.doesNotMatch(remoteDeepSeekService, /MANAGED_RUNTIME_IMAGE_TAG/);
  assert.match(runtimeBuildScript, /DEEPSEEK_HARNESS_RUNTIME_BUNDLE_CONTEXT/);
  assert.match(runtimeBuildScript, /DEEPSEEK_JSONRPC_EXECUTABLE_SHA256/);
  assert.match(runtimeBuildScript, /DEEPSEEK_JSONRPC_RIPGREP_SHA256/);
  assert.match(runtimeBuildScript, /DEEPSEEK_RUNTIME_WHEEL_SHA256/);
  assert.match(runtimeBuildScript, /DEEPSEEK_RUNTIME_SOURCE_COMMIT/);
  assert.match(runtimeBuildScript, /provenance\.json/);
  assert.match(runtimeBuildScript, /dsh-jsonrpc-agent-rg/);
  assert.match(runtimeBuildScript, /verify-deepseek-runtime-bundle\.py/);
  assert.doesNotMatch(
    runtimeBuildScript,
    /deepseek-harness\) echo "npm install --global @deepseek-ai\/dsh/,
  );
});

test("managed runtime build preflight verifies DeepSeek bundle bytes before Docker", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-deepseek-bundle-preflight-"));
  const bundleDir = join(workDir, "bundle");
  const binDir = join(workDir, "bin");
  const executablePath = join(bundleDir, "dsh-jsonrpc-agent");
  const ripgrepPath = join(bundleDir, "dsh-jsonrpc-agent-rg");
  const dockerLogPath = join(workDir, "docker.log");
  const fakeEvidencePath = join(workDir, "fake-evidence.json");
  const evidenceOutputPath = join(workDir, "release-evidence.json");
  const sourceCommit = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
  const wheelSha256 = "1".repeat(64);
  try {
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(executablePath, "carrier-bytes", { mode: 0o755 });
    writeFileSync(ripgrepPath, "ripgrep-bytes", { mode: 0o755 });
    writeFileSync(
      join(binDir, "docker"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_LOG\"\nif [ \"${1:-}\" = run ]; then cat \"$FAKE_DEEPSEEK_EVIDENCE\"; fi\n",
      { mode: 0o755 },
    );
    chmodSync(executablePath, 0o755);
    chmodSync(ripgrepPath, 0o755);
    chmodSync(join(binDir, "docker"), 0o755);
    const executableSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
    const ripgrepSha256 = createHash("sha256").update(readFileSync(ripgrepPath)).digest("hex");
    const evidence = {
      schemaVersion: 1,
      kind: "deepseek-jsonrpc-release-evidence",
      source: {
        repository: "https://github.com/iTechwu/deepseek-harness",
        ref: "dsh-v0.1.1-rc.2",
        commit: sourceCommit,
      },
      wheel: {
        filename: "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl",
        sha256: wheelSha256,
        distribution: "deepseek-harness-runtime-bin",
        version: "0.1.1rc2",
        tag: "py3-none-manylinux_2_28_x86_64",
      },
      artifacts: {
        "dsh-jsonrpc-agent": executableSha256,
        "dsh-jsonrpc-agent-rg": ripgrepSha256,
      },
      composition: {
        id: "dsh-v0.1.1-rc.2-default",
        sha256: "048031be7331f2b68c81b3cbfacacc06ee767dae1e8f00cbdc3137c1e55001af",
      },
      wire: {
        protocol: "jsonrpc-2.0-ndjson",
        serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
        initialize: true,
        shutdown: true,
        stdoutPurity: true,
      },
    };
    writeFileSync(fakeEvidencePath, JSON.stringify(evidence), "utf8");
    writeFileSync(join(bundleDir, "provenance.json"), JSON.stringify({
      schemaVersion: 1,
      source: {
        repository: "https://github.com/iTechwu/deepseek-harness",
        ref: "dsh-v0.1.1-rc.2",
        commit: sourceCommit,
      },
      wheel: {
        filename: "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl",
        sha256: wheelSha256,
        distribution: "deepseek-harness-runtime-bin",
        version: "0.1.1rc2",
        tag: "py3-none-manylinux_2_28_x86_64",
      },
      artifacts: {
        "dsh-jsonrpc-agent": {
          source: "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64",
          sha256: executableSha256,
        },
        "dsh-jsonrpc-agent-rg": {
          source: "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64-rg",
          sha256: ripgrepSha256,
        },
      },
    }));
    const environment = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEEPSEEK_HARNESS_RUNTIME_BUNDLE_CONTEXT: bundleDir,
      DEEPSEEK_JSONRPC_EXECUTABLE_SHA256: executableSha256,
      DEEPSEEK_JSONRPC_RIPGREP_SHA256: ripgrepSha256,
      DEEPSEEK_RUNTIME_WHEEL_SHA256: wheelSha256,
      DEEPSEEK_RUNTIME_SOURCE_COMMIT: sourceCommit,
      DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT: evidenceOutputPath,
      FAKE_DOCKER_LOG: dockerLogPath,
      FAKE_DEEPSEEK_EVIDENCE: fakeEvidencePath,
    };

    const accepted = spawnSync("bash", [new URL("../../../deploy/staging/build-managed-runtime-images.sh", import.meta.url).pathname, "deepseek-harness"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(readFileSync(evidenceOutputPath, "utf8")), evidence);
    assert.match(readFileSync(dockerLogPath, "utf8"), /run --rm -e DOFE_AGENT_DEEPSEEK_JSONRPC_ENABLED=1 .* verify-deepseek-release/);

    const missingEvidenceOutput = spawnSync("bash", [new URL("../../../deploy/staging/build-managed-runtime-images.sh", import.meta.url).pathname, "deepseek-harness"], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT: "" },
    });
    assert.notEqual(missingEvidenceOutput.status, 0);

    const rejected = spawnSync("bash", [new URL("../../../deploy/staging/build-managed-runtime-images.sh", import.meta.url).pathname, "deepseek-harness"], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_JSONRPC_EXECUTABLE_SHA256: "0".repeat(64) },
    });
    assert.notEqual(rejected.status, 0);

    const provenanceRejected = spawnSync("bash", [new URL("../../../deploy/staging/build-managed-runtime-images.sh", import.meta.url).pathname, "deepseek-harness"], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_SOURCE_COMMIT: "0".repeat(40) },
    });
    assert.notEqual(provenanceRejected.status, 0);

    writeFileSync(fakeEvidencePath, "{}", "utf8");
    const invalidEvidence = spawnSync("bash", [new URL("../../../deploy/staging/build-managed-runtime-images.sh", import.meta.url).pathname, "deepseek-harness"], {
      encoding: "utf8",
      env: environment,
    });
    assert.notEqual(invalidEvidence.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(evidenceOutputPath, "utf8")), evidence);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("DeepSeek model canary requires an immutable image and atomically publishes redacted evidence", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-deepseek-canary-runner-"));
  const binDir = join(workDir, "bin");
  const dockerLogPath = join(workDir, "docker.log");
  const operationLogPath = join(workDir, "operations.log");
  const cosignLogPath = join(workDir, "cosign.log");
  const cosignPublicKeyPath = join(workDir, "deepseek-runtime-cosign.pub");
  const cosignRejectPath = join(workDir, "cosign-reject");
  const cosignHangPath = join(workDir, "cosign-hang");
  const cosignMutateKeyPath = join(workDir, "cosign-mutate-key");
  const replacementPublicKeyPath = join(workDir, "replacement-cosign.pub");
  const releaseEvidencePath = join(workDir, "release-evidence.json");
  const fakeCanaryPath = join(workDir, "fake-canary.json");
  const outputPath = join(workDir, "model-canary-evidence.json");
  const imageDigest = `sha256:${"2".repeat(64)}`;
  const image = `registry.example/dofe/agent-runtime-deepseek-harness@${imageDigest}`;
  const wheelSha256 = "1".repeat(64);
  const executableSha256 = "3".repeat(64);
  const ripgrepSha256 = "4".repeat(64);
  const cordisConfigSha256 = "048031be7331f2b68c81b3cbfacacc06ee767dae1e8f00cbdc3137c1e55001af";
  const sourceCommit = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
  const cosignPublicKey = [
    "-----BEGIN PUBLIC KEY-----",
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFqpQUB2kqJXqZq9Y0Jq0N6nRqZb6",
    "vY1Q6GZPZ5aB0nR4Lz1S8u4jT2qVwzKQm0xEb7jHkY9x0o0I9sM0w==",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n");
  const cosignPublicKeySha256 = createHash("sha256").update(cosignPublicKey).digest("hex");
  const releaseEvidence = {
    schemaVersion: 1,
    kind: "deepseek-jsonrpc-release-evidence",
    source: { repository: "https://github.com/iTechwu/deepseek-harness", ref: "dsh-v0.1.1-rc.2", commit: sourceCommit },
    wheel: {
      filename: "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl",
      sha256: wheelSha256,
      distribution: "deepseek-harness-runtime-bin",
      version: "0.1.1rc2",
      tag: "py3-none-manylinux_2_28_x86_64",
    },
    artifacts: { "dsh-jsonrpc-agent": executableSha256, "dsh-jsonrpc-agent-rg": ripgrepSha256 },
    composition: { id: "dsh-v0.1.1-rc.2-default", sha256: cordisConfigSha256 },
    wire: {
      protocol: "jsonrpc-2.0-ndjson",
      serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
      initialize: true,
      shutdown: true,
      stdoutPurity: true,
    },
  };
  const usage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 1 };
  const canaryEvidence = {
    schemaVersion: 1,
    kind: "deepseek-native-model-canary-evidence",
    checkedAt: new Date().toISOString(),
    imageDigest,
    release: { sourceCommit, wheelSha256, executableSha256, ripgrepSha256, cordisConfigSha256 },
    protocol: "deepseek_native",
    serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
    endpoint: { kind: "official" },
    attestation: { kind: "cosign-public-key", publicKeySha256: cosignPublicKeySha256 },
    models: [
      { id: "deepseek-v4-flash", status: "passed", usage },
      { id: "deepseek-v4-pro", status: "passed", usage },
    ],
  };

  try {
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "docker"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_LOG\"",
        "if [ \"${1:-}\" = run ]; then",
        "  printf '%s\\n' docker >> \"$FAKE_OPERATION_LOG\"",
        "  if [ \"${FAKE_DOCKER_HANG:-0}\" = 1 ]; then",
        "    if [ \"${FAKE_DOCKER_IGNORE_TERM:-0}\" = 1 ]; then trap '' TERM; fi",
        "    exec sleep 5",
        "  fi",
        "  if [ \"${FAKE_DOCKER_FAIL:-0}\" = 1 ]; then exit 45; fi",
        "  cat \"$FAKE_DEEPSEEK_CANARY\"",
        "fi",
        "if [ \"${1:-}\" = compose ]; then printf '%s\\n' compose >> \"$FAKE_OPERATION_LOG\"; fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(binDir, "cosign"),
      [
        "#!/bin/sh",
        "if [ -n \"${DEEPSEEK_API_KEY:-}\" ]; then exit 43; fi",
        `printf '%s\\n' \"$*\" >> ${JSON.stringify(cosignLogPath)}`,
        `printf '%s\\n' cosign >> ${JSON.stringify(operationLogPath)}`,
        `if [ -f ${JSON.stringify(cosignRejectPath)} ]; then exit 44; fi`,
        `if [ -f ${JSON.stringify(cosignHangPath)} ]; then exec sleep 5; fi`,
        `if [ -f ${JSON.stringify(cosignMutateKeyPath)} ]; then cp ${JSON.stringify(replacementPublicKeyPath)} ${JSON.stringify(cosignPublicKeyPath)}; fi`,
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(cosignPublicKeyPath, cosignPublicKey, "utf8");
    writeFileSync(replacementPublicKeyPath, cosignPublicKey.replace("FqpQ", "AqpQ"), "utf8");
    writeFileSync(releaseEvidencePath, JSON.stringify(releaseEvidence), "utf8");
    writeFileSync(fakeCanaryPath, JSON.stringify(canaryEvidence), "utf8");
    const environment = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DEEPSEEK_RUNTIME_IMAGE: image,
      DEEPSEEK_RUNTIME_IMAGE_REPOSITORY: "registry.example/dofe/agent-runtime-deepseek-harness",
      DEEPSEEK_RUNTIME_IMAGE_SHA256: imageDigest.slice("sha256:".length),
      DEEPSEEK_RUNTIME_RELEASE_EVIDENCE: releaseEvidencePath,
      DEEPSEEK_MODEL_CANARY_EVIDENCE_OUTPUT: outputPath,
      DEEPSEEK_API_KEY: "deepseek-secret-must-not-appear",
      DEEPSEEK_BASE_URL: "",
      DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY: cosignPublicKeyPath,
      DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY_SHA256: cosignPublicKeySha256,
      COSIGN_BIN: join(binDir, "cosign"),
      FAKE_DOCKER_LOG: dockerLogPath,
      FAKE_OPERATION_LOG: operationLogPath,
      FAKE_DEEPSEEK_CANARY: fakeCanaryPath,
    };
    const script = new URL("../../../deploy/staging/run-deepseek-runtime-canary.sh", import.meta.url).pathname;
    const accepted = spawnSync("bash", [script], { encoding: "utf8", env: environment });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), canaryEvidence);
    assert.deepEqual(readFileSync(operationLogPath, "utf8").trim().split(/\r?\n/), ["cosign", "docker"]);
    const firstCosignArgs = readFileSync(cosignLogPath, "utf8").trim();
    assert.match(
      firstCosignArgs,
      new RegExp(`^verify --key /tmp/dofe-deepseek-canary\\.[^/]+/cosign-public-key\\.pem --insecure-ignore-sct=true --insecure-ignore-tlog=true ${image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
    assert.equal(firstCosignArgs.includes(realpathSync(cosignPublicKeyPath)), false);
    const dockerLog = readFileSync(dockerLogPath, "utf8");
    assert.match(dockerLog, new RegExp(`run --rm --pull=never --name dofe-deepseek-canary-.* --entrypoint dofe-agent-daemon .* -e DEEPSEEK_API_KEY -- ${image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} verify-deepseek-model-canary`));
    assert.equal(dockerLog.includes("deepseek-secret-must-not-appear"), false);

    const deployScript = new URL("../../../deploy/staging/deploy-deepseek-runtime.sh", import.meta.url).pathname;
    const deployed = spawnSync("bash", [deployScript], { encoding: "utf8", env: environment });
    assert.equal(deployed.status, 0, deployed.stderr);
    assert.deepEqual(
      readFileSync(operationLogPath, "utf8").trim().split(/\r?\n/).slice(-3),
      ["cosign", "docker", "compose"],
    );
    assert.match(
      readFileSync(dockerLogPath, "utf8"),
      /compose -f .*docker-compose\.deepseek-runtime\.yml up -d --pull never --no-build runtime-deepseek-harness/,
    );

    writeFileSync(cosignMutateKeyPath, "mutate", "utf8");
    const snapshottedInputs = spawnSync("bash", [script], { encoding: "utf8", env: environment });
    rmSync(cosignMutateKeyPath);
    writeFileSync(cosignPublicKeyPath, cosignPublicKey, "utf8");
    assert.equal(snapshottedInputs.status, 0, snapshottedInputs.stderr);
    const latestCosignArgs = readFileSync(cosignLogPath, "utf8").trim().split(/\r?\n/).at(-1) ?? "";
    assert.equal(latestCosignArgs.includes(realpathSync(cosignPublicKeyPath)), false);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), canaryEvidence);

    const dockerBeforeSignatureFailure = readFileSync(dockerLogPath, "utf8");
    writeFileSync(cosignRejectPath, "reject", "utf8");
    const signatureRejected = spawnSync("bash", [script], {
      encoding: "utf8",
      env: environment,
    });
    rmSync(cosignRejectPath);
    assert.notEqual(signatureRejected.status, 0);
    assert.equal(readFileSync(dockerLogPath, "utf8"), dockerBeforeSignatureFailure);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), canaryEvidence);

    writeFileSync(cosignHangPath, "hang", "utf8");
    const cosignHangStartedAt = Date.now();
    const signatureHung = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_COSIGN_TIMEOUT_SECONDS: "1" },
    });
    rmSync(cosignHangPath);
    assert.notEqual(signatureHung.status, 0);
    assert.ok(Date.now() - cosignHangStartedAt < 4_000);
    assert.equal(readFileSync(dockerLogPath, "utf8"), dockerBeforeSignatureFailure);

    const missingPublicKey = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY: "" },
    });
    assert.notEqual(missingPublicKey.status, 0);
    assert.equal(readFileSync(dockerLogPath, "utf8"), dockerBeforeSignatureFailure);

    const mismatchedPublicKeyDigest = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY_SHA256: "0".repeat(64) },
    });
    assert.notEqual(mismatchedPublicKeyDigest.status, 0);
    assert.equal(readFileSync(dockerLogPath, "utf8"), dockerBeforeSignatureFailure);

    const logBeforeInvalidInputs = readFileSync(dockerLogPath, "utf8");
    const mismatchedImageDigest = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_IMAGE_SHA256: "0".repeat(64) },
    });
    assert.notEqual(mismatchedImageDigest.status, 0);
    assert.equal(readFileSync(dockerLogPath, "utf8"), logBeforeInvalidInputs);

    const optionLike = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_IMAGE: `--label=review@${imageDigest}` },
    });
    assert.notEqual(optionLike.status, 0);
    assert.equal(readFileSync(dockerLogPath, "utf8"), logBeforeInvalidInputs);

    const wrongRepository = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...environment,
        DEEPSEEK_RUNTIME_IMAGE: `registry.example/other/signed-runtime@${imageDigest}`,
      },
    });
    assert.notEqual(wrongRepository.status, 0);
    assert.equal(readFileSync(dockerLogPath, "utf8"), logBeforeInvalidInputs);

    const directoryOutput = join(workDir, "evidence-directory");
    mkdirSync(directoryOutput);
    const directoryRejected = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_MODEL_CANARY_EVIDENCE_OUTPUT: directoryOutput },
    });
    assert.notEqual(directoryRejected.status, 0);
    assert.equal(readFileSync(dockerLogPath, "utf8"), logBeforeInvalidInputs);

    const mutable = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, DEEPSEEK_RUNTIME_IMAGE: "registry.example/deepseek:latest" },
    });
    assert.notEqual(mutable.status, 0);

    const hangStartedAt = Date.now();
    const hung = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...environment,
        FAKE_DOCKER_HANG: "1",
        FAKE_DOCKER_IGNORE_TERM: "1",
        DEEPSEEK_MODEL_CANARY_HOST_TIMEOUT_SECONDS: "1",
      },
    });
    assert.notEqual(hung.status, 0);
    assert.ok(Date.now() - hangStartedAt < 4_000);
    assert.match(readFileSync(dockerLogPath, "utf8"), /rm --force dofe-deepseek-canary-/);

    const dockerLogBeforeFailure = readFileSync(dockerLogPath, "utf8");
    const dockerFailed = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...environment, FAKE_DOCKER_FAIL: "1" },
    });
    assert.notEqual(dockerFailed.status, 0);
    assert.match(readFileSync(dockerLogPath, "utf8").slice(dockerLogBeforeFailure.length), /rm --force dofe-deepseek-canary-/);

    writeFileSync(fakeCanaryPath, JSON.stringify({ ...canaryEvidence, checkedAt: "2020-01-01T00:00:00.000Z" }), "utf8");
    const invalid = spawnSync("bash", [script], { encoding: "utf8", env: environment });
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), canaryEvidence);

    writeFileSync(fakeCanaryPath, JSON.stringify({
      ...canaryEvidence,
      checkedAt: new Date().toISOString(),
      attestation: { kind: "cosign-public-key", publicKeySha256: "0".repeat(64) },
    }), "utf8");
    const mismatchedAttestation = spawnSync("bash", [script], { encoding: "utf8", env: environment });
    assert.notEqual(mismatchedAttestation.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), canaryEvidence);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("DeepSeek runtime wheel importer verifies release metadata and writes a canonical provenance bundle", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-deepseek-wheel-import-"));
  const wheelPath = join(
    workDir,
    "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl",
  );
  const outputDir = join(workDir, "bundle");
  const carrierBytes = "real-carrier-fixture";
  const ripgrepBytes = "real-ripgrep-fixture";
  const sourceCommit = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
  try {
    const createWheel = spawnSync("python3", ["-c", [
      "import sys, zipfile",
      "wheel = sys.argv[1]",
      "with zipfile.ZipFile(wheel, 'w') as archive:",
      " archive.writestr('deepseek_harness_runtime_bin-0.1.1rc2.dist-info/METADATA', 'Metadata-Version: 2.4\\nName: deepseek-harness-runtime-bin\\nVersion: 0.1.1rc2\\n')",
      " archive.writestr('deepseek_harness_runtime_bin-0.1.1rc2.dist-info/WHEEL', 'Wheel-Version: 1.0\\nTag: py3-none-manylinux_2_28_x86_64\\n')",
      " archive.writestr('deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64', sys.argv[2])",
      " archive.writestr('deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64-rg', sys.argv[3])",
    ].join("\n"), wheelPath, carrierBytes, ripgrepBytes], { encoding: "utf8" });
    assert.equal(createWheel.status, 0, createWheel.stderr);

    const wheelSha256 = createHash("sha256").update(readFileSync(wheelPath)).digest("hex");
    const carrierSha256 = createHash("sha256").update(carrierBytes).digest("hex");
    const ripgrepSha256 = createHash("sha256").update(ripgrepBytes).digest("hex");
    const imported = spawnSync("python3", [
      new URL("../../../deploy/staging/prepare-deepseek-runtime-bundle.py", import.meta.url).pathname,
      "--wheel", wheelPath,
      "--wheel-sha256", wheelSha256,
      "--executable-sha256", carrierSha256,
      "--ripgrep-sha256", ripgrepSha256,
      "--source-commit", sourceCommit,
      "--output-dir", outputDir,
    ], { encoding: "utf8" });

    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(readFileSync(join(outputDir, "dsh-jsonrpc-agent"), "utf8"), carrierBytes);
    assert.equal(readFileSync(join(outputDir, "dsh-jsonrpc-agent-rg"), "utf8"), ripgrepBytes);
    assert.equal(statSync(join(outputDir, "dsh-jsonrpc-agent")).mode & 0o777, 0o555);
    assert.equal(statSync(join(outputDir, "dsh-jsonrpc-agent-rg")).mode & 0o777, 0o555);
    assert.deepEqual(
      JSON.parse(readFileSync(join(outputDir, "provenance.json"), "utf8")),
      {
        schemaVersion: 1,
        source: {
          repository: "https://github.com/iTechwu/deepseek-harness",
          ref: "dsh-v0.1.1-rc.2",
          commit: sourceCommit,
        },
        wheel: {
          filename: "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl",
          sha256: wheelSha256,
          distribution: "deepseek-harness-runtime-bin",
          version: "0.1.1rc2",
          tag: "py3-none-manylinux_2_28_x86_64",
        },
        artifacts: {
          "dsh-jsonrpc-agent": {
            source: "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64",
            sha256: carrierSha256,
          },
          "dsh-jsonrpc-agent-rg": {
            source: "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64-rg",
            sha256: ripgrepSha256,
          },
        },
      },
    );
    const provenanceBeforeRejection = readFileSync(join(outputDir, "provenance.json"), "utf8");
    const rejected = spawnSync("python3", [
      new URL("../../../deploy/staging/prepare-deepseek-runtime-bundle.py", import.meta.url).pathname,
      "--wheel", wheelPath,
      "--wheel-sha256", "0".repeat(64),
      "--executable-sha256", carrierSha256,
      "--ripgrep-sha256", ripgrepSha256,
      "--source-commit", sourceCommit,
      "--output-dir", outputDir,
    ], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.equal(readFileSync(join(outputDir, "provenance.json"), "utf8"), provenanceBeforeRejection);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
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
  assert.match(localRuntimeDockerfile, /pnpm --filter @dofe-agent\/db run prisma:generate[\s\S]*pnpm --filter dofe-agent-daemon run build/);
});

test("managed-node builds generate Prisma Client before bundling", () => {
  assert.match(
    dockerfile,
    /pnpm --filter @dofe-agent\/db run prisma:generate[\s\S]*pnpm --filter dofe-agent-daemon run build/,
  );
});

test("self-hosted application runtime includes curl for TOS-backed Skill artifacts", () => {
  assert.match(
    selfHostedDockerfile,
    /apt-get install --yes --no-install-recommends ca-certificates curl/,
  );
});

test("self-hosted application build generates Prisma Client before bundling", () => {
  assert.match(
    selfHostedDockerfile,
    /pnpm --filter @dofe-agent\/db run prisma:generate[\s\S]*pnpm --filter dofe-agent-daemon run build/,
  );
});

test("workflow worker image generates Prisma Client before startup", () => {
  assert.match(
    workflowWorkerDockerfile,
    /pnpm --filter @dofe-agent\/db run prisma:generate[\s\S]*chown -R node:node/,
  );
});

test("local managed-node recovery preserves required operational settings", () => {
  const resolved = resolveManagedNodeOperationalEnv(
    [
      "MCP_EGRESS_PROXY_URL=http://172.31.240.2:8080",
      "MCP_EGRESS_PROXY_ADMIN_TOKEN=existing-secret",
      "PROXY_RUNTIME_IP=172.31.240.2",
      "MCP_CODEX_EXPERIMENTAL_ENABLED=1",
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
  assert.equal(resolved.MCP_CODEX_EXPERIMENTAL_ENABLED, "1");
  assert.equal(resolved.PROXY_RUNTIME_IP, "172.31.240.2");
  assert.equal(resolved.DOFE_SKILL_RUNNER_TIMEOUT_MS, "45000");
  assert.equal(resolved.DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS, "720000");
  assert.ok(formatManagedNodeOperationalEnv(resolved).includes("MCP_EGRESS_PROXY_ADMIN_TOKEN=existing-secret"));
  assert.ok(formatManagedNodeOperationalEnv(resolved).includes("MCP_CODEX_EXPERIMENTAL_ENABLED=1"));
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

test("local managed-node recovery validates the Codex MCP canary switch", () => {
  // 传入显式空环境，避免 --env-file-if-exists=../../.env 加载的
  // MCP_CODEX_EXPERIMENTAL_ENABLED=1 遮蔽 previousSource 中的 "true"，
  // 导致 readEnvValue 短路、验证分支不再触发（确定性回归）。
  assert.throws(
    () => resolveManagedNodeOperationalEnv(
      "MCP_EGRESS_PROXY_URL=http://127.0.0.1:8080\nMCP_EGRESS_PROXY_ADMIN_TOKEN=secret\nMCP_CODEX_EXPERIMENTAL_ENABLED=true",
      {},
    ),
    /must be 0 or 1/,
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
