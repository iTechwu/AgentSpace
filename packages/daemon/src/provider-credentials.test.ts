import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { applyProviderCredentialProfile, resolveProviderCredentialProfile } from "./provider-credentials.ts";
import {
  buildManagedRuntimeDockerConnectivityArgs,
  buildManagedRuntimeAttributionHeaders,
  createManagedCredentialResolver,
  extractManagedGatewayUsage,
  resolveManagedRuntimeDockerNetwork,
} from "./managed-provider-credentials.ts";

process.env.MANAGED_RUNTIME_DOCKER_NETWORK = "dofe-models-egress";

test("resolves account-scoped provider files and environment without exposing references", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-provider-credentials-"));
  const credentialRoot = join(root, "credentials");
  const stateDir = join(root, "state");
  try {
    const configPath = join(credentialRoot, "team-a.config.json");
    const secretPath = join(credentialRoot, "team-a.secret.json");
    writeJson(configPath, {
      version: 1,
      environment: { ANTHROPIC_BASE_URL: "https://gateway.team-a.example" },
      files: { ".config/openclaw/models.json": "{\"models\":[]}" },
    });
    writeJson(secretPath, {
      version: 1,
      environment: { ANTHROPIC_API_KEY: "team-a-key" },
      files: { ".claude.json": "{\"oauthAccount\":{}}" },
    });
    const mapPath = join(credentialRoot, "provider-accounts.json");
    writeJson(mapPath, { accounts: { "provider-account-team-a": { configRef: `file://${configPath}`, secretRef: `file://${secretPath}` } } });

    const profile = resolveProviderCredentialProfile({
      stateDir,
      environment: {
        DOFE_AGENT_PROVIDER_ACCOUNT_ID: "provider-account-team-a",
        DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: credentialRoot,
        DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF: `file://${mapPath}`,
      },
    });

    assert.ok(profile);
    assert.equal(profile.environment.ANTHROPIC_BASE_URL, "https://gateway.team-a.example");
    assert.equal(profile.environment.ANTHROPIC_API_KEY, "team-a-key");
    assert.equal(readFileSync(join(profile.profileDir, ".claude.json"), "utf8"), "{\"oauthAccount\":{}}");
    assert.equal(existsSync(join(profile.profileDir, ".config/openclaw/models.json")), true);

    const targetEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "host-key",
    };
    applyProviderCredentialProfile(profile, targetEnv);
    assert.equal(targetEnv.HOME, profile.profileDir);
    assert.equal(targetEnv.ANTHROPIC_API_KEY, "team-a-key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects credential symlinks which resolve outside the runtime credential root", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-provider-credentials-"));
  try {
    const credentialRoot = join(root, "credentials");
    const outsidePath = join(root, "outside.json");
    writeJson(outsidePath, { environment: { ANTHROPIC_API_KEY: "not-for-this-runtime" } });
    mkdirSync(credentialRoot, { recursive: true });
    const linkedPath = join(credentialRoot, "linked.json");
    symlinkSync(outsidePath, linkedPath);

    assert.throws(() => resolveProviderCredentialProfile({
      stateDir: join(root, "state"),
      environment: {
        DOFE_AGENT_PROVIDER_ACCOUNT_ID: "provider-account-team-a",
        DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: credentialRoot,
        DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF: `file://${linkedPath}`,
      },
    }), /must stay within/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects credential references outside the runtime credential root", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-provider-credentials-"));
  try {
    assert.throws(() => resolveProviderCredentialProfile({
      stateDir: join(root, "state"),
      environment: {
        DOFE_AGENT_PROVIDER_ACCOUNT_ID: "provider-account-team-a",
        DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT: join(root, "credentials"),
        DOFE_AGENT_PROVIDER_CREDENTIAL_MAP_REF: "file:///etc/passwd",
      },
    }), /must stay within/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed credentials are atomically refreshed when their credential generation changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-managed-credentials-"));
  const bundles = [
    {
      version: 1 as const,
      credentialId: "credential-first",
      environment: { OPENAI_API_KEY: "first-key", OPENAI_BASE_URL: "http://model.local.dofe.ai/api/v1" },
      files: {},
    },
    {
      version: 1 as const,
      credentialId: "credential-second",
      environment: { OPENAI_API_KEY: "second-key", OPENAI_BASE_URL: "http://model.local.dofe.ai/api/v1" },
      files: {},
    },
  ];
  let fetches = 0;
  const resolver = createManagedCredentialResolver(root, async () => bundles[fetches++]!);

  try {
    const first = await resolver.resolve("runtime-1", "credential-first");
    const stableProfilePath = first?.profileDir;
    const stableLauncherPath = resolver.getExecutablePath("runtime-1", "codex");
    const second = await resolver.resolve("runtime-1", "credential-second");

    assert.equal(first?.environment.OPENAI_API_KEY, "first-key");
    assert.equal(second?.environment.OPENAI_API_KEY, "second-key");
    assert.equal(second?.profileDir, stableProfilePath);
    assert.equal(lstatSync(second!.profileDir).isSymbolicLink(), true);
    assert.equal(existsSync(stableLauncherPath), true);
    assert.match(readFileSync(stableLauncherPath, "utf8"), /managed-runtimes\/runtime-1\/current/);
    assert.equal(fetches, 2);
  } finally {
    resolver.cleanup("runtime-1");
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed credential launchers run the provider inside its dedicated image", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-managed-launcher-"));
  const resolver = createManagedCredentialResolver(root, async () => ({
    version: 1,
    credentialId: "credential-codex",
    environment: { OPENAI_API_KEY: "runtime-only-key", OPENAI_BASE_URL: "http://model.local.dofe.ai/api/v1" },
    files: {},
  }));

  try {
    await resolver.resolve("runtime-codex", "credential-codex");
    const launcherPath = resolver.getExecutablePath("runtime-codex", "codex");
    const launcher = readFileSync(launcherPath, "utf8");

    assert.match(launcher, /docker run --rm --init/);
    assert.match(launcher, /--name 'dofe-runtime-runtime-codex'/);
    assert.match(launcher, /dofe\/agent-runtime-codex:latest/);
    assert.doesNotMatch(launcher, /--env OPENAI_API_KEY/);
    assert.match(launcher, /runtime-key/);
    assert.match(launcher, /readonly/);
    assert.match(launcher, /dst=\/dofe-home/);
    assert.match(launcher, /--env HOME=\/dofe-home/);
    assert.match(launcher, /--env OPENAI_BASE_URL/);
    assert.match(launcher, /--entrypoint node/);
    assert.match(launcher, /--env DOFE_AGENT_RUNTIME_CREDENTIAL_ID/);
    assert.match(launcher, /--env DOFE_AGENT_ATTRIBUTION_EMPLOYEE_ID/);
    assert.match(launcher, /--read-only/);
    assert.match(launcher, /--security-opt no-new-privileges/);
    assert.match(launcher, /--cap-drop ALL/);
    assert.match(launcher, /--user "\$\(id -u\):\$\(id -g\)"/);
    assert.match(launcher, /attribution-proxy\.mjs/);
    const proxyPath = join(root, "managed-runtimes", "runtime-codex", "current", "attribution-proxy.mjs");
    const proxy = readFileSync(proxyPath, "utf8");
    assert.match(proxy, /x-dofe-attribution-signature/);
    assert.match(proxy, /startsWith\("x-dofe-"\)/);
    assert.match(proxy, /process\.env\[runtimeKeyName\] = runtimeKey/);
    assert.match(proxy, /model_provider=\\\"dofe-managed\\\"/);
    assert.match(proxy, /model_providers\.dofe-managed\.base_url/);
    assert.match(proxy, /DOFE_AGENT_GATEWAY_REQUEST_LOG/);
    assert.match(proxy, /x-request-id/);
    assert.match(proxy, /statusCode >= 200/);
    assert.match(proxy, /capturedUsage/);
    execFileSync(process.execPath, ["--check", proxyPath]);
    assert.doesNotMatch(launcher, /runtime-only-key/);
  } finally {
    resolver.cleanup("runtime-codex");
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed Codex proxy injects its runtime key when Codex sends no auth header", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-managed-codex-proxy-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  let receivedAuthorization: string | undefined;
  const upstream = createServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    request.resume();
    request.on("end", () => response.end("{}"));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");

  const resolver = createManagedCredentialResolver(root, async () => ({
    version: 1,
    credentialId: "credential-codex",
    environment: { OPENAI_API_KEY: "runtime-only-key", OPENAI_BASE_URL: "http://model.local.dofe.ai/api/v1" },
    files: {},
  }));

  try {
    const profile = await resolver.resolve("runtime-codex", "credential-codex");
    assert.ok(profile);
    const proxyPath = join(profile.profileDir, "attribution-proxy.mjs");
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, [
      "#!/usr/bin/env node",
      'const http = require("node:http");',
      'const base = new URL(process.env.OPENAI_BASE_URL);',
      'const target = new URL(base.pathname.replace(/\\/$/, "") + "/responses", base);',
      'const request = http.request(target, { method: "POST" }, (response) => {',
      '  response.resume();',
      '  response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));',
      '});',
      'request.on("error", () => process.exit(1));',
      'request.end("{}");',
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o700 });
    chmodSync(fakeCodexPath, 0o700);
    const port = (upstream.address() as AddressInfo).port;
    const child = spawn(process.execPath, [
      proxyPath,
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      join(profile.profileDir, "runtime-key"),
      "codex",
      "exec",
      "hi",
    ], {
      env: {
        ...process.env,
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdio: "ignore",
    });
    const [exitCode] = await once(child, "exit") as [number | null];

    assert.equal(exitCode, 0);
    assert.equal(receivedAuthorization, "Bearer runtime-only-key");
  } finally {
    upstream.close();
    resolver.cleanup("runtime-codex");
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed runtime attribution follows the models HMAC contract", () => {
  const headers = buildManagedRuntimeAttributionHeaders({
    runtimeKey: "runtime-key",
    runtimeCredentialId: "credential-1",
    runtimeId: "runtime-1",
    employeeId: "employee-1",
    conversationId: "conversation-1",
    timestampSeconds: 1_800_000_000,
  });
  assert.deepEqual(headers, {
    "x-dofe-employee-id": "employee-1",
    "x-dofe-conversation-id": "conversation-1",
    "x-dofe-attribution-timestamp": "1800000000",
    "x-dofe-attribution-signature": "c32f43facc0776838604d8bfbb3f95bf04c93c47af895a16e6ca9407bd3490db",
  });
  const localizedHeaders = buildManagedRuntimeAttributionHeaders({
    runtimeKey: "runtime-key",
    runtimeCredentialId: "credential-1",
    runtimeId: "runtime-1",
    employeeId: "研究 助手",
    conversationId: "conversation-1",
    timestampSeconds: 1_800_000_000,
  });
  assert.equal(localizedHeaders["x-dofe-employee-id"], "utf8.56CU56m2IOWKqeaJiw");
  assert.match(localizedHeaders["x-dofe-attribution-signature"]!, /^[a-f0-9]{64}$/);
});

test("managed gateway usage parser ignores auxiliary and failed responses and reads streaming usage", () => {
  assert.equal(extractManagedGatewayUsage({ data: [{ id: "model-1" }] }), undefined);
  assert.deepEqual(extractManagedGatewayUsage({
    type: "response.completed",
    response: { usage: { input_tokens: 120, output_tokens: 45, cached_tokens: 32 } },
  }), { inputTokens: 120, outputTokens: 45, cacheTokens: 32 });
  assert.deepEqual(extractManagedGatewayUsage({
    type: "message_delta",
    usage: { output_tokens: 18 },
  }), { inputTokens: 0, outputTokens: 18 });
  assert.deepEqual(extractManagedGatewayUsage({
    usage: {
      prompt_tokens: 200,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 75 },
    },
  }), { inputTokens: 200, outputTokens: 20, cacheTokens: 75 });
  assert.deepEqual(extractManagedGatewayUsage({
    usage: {
      input_tokens: 150,
      output_tokens: 30,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    },
  }), { inputTokens: 150, outputTokens: 30, cacheTokens: 50 });
});

test("managed runtime network configuration fails closed for permissive Docker networks", () => {
  assert.equal(resolveManagedRuntimeDockerNetwork({ MANAGED_RUNTIME_DOCKER_NETWORK: "models-egress" }), "models-egress");
  assert.throws(() => resolveManagedRuntimeDockerNetwork({}), /docker_network_required/);
  assert.throws(
    () => resolveManagedRuntimeDockerNetwork({ MANAGED_RUNTIME_DOCKER_NETWORK: "host" }),
    /docker_network_not_isolated/,
  );
});

test("managed runtime connectivity configuration injects only validated host and CA options", () => {
  assert.deepEqual(buildManagedRuntimeDockerConnectivityArgs({
    MANAGED_RUNTIME_DOCKER_EXTRA_HOSTS: "model.local.dofe.ai:host-gateway",
    MANAGED_RUNTIME_TLS_CA_PATH: "/Users/test/Library/Application Support/mkcert/rootCA.pem",
  }), [
    "--add-host", "model.local.dofe.ai:host-gateway",
    "--mount", "type=bind,src=/Users/test/Library/Application Support/mkcert/rootCA.pem,dst=/run/dofe-agent-runtime-ca.pem,readonly",
    "--env", "NODE_EXTRA_CA_CERTS=/run/dofe-agent-runtime-ca.pem",
  ]);
  assert.throws(
    () => buildManagedRuntimeDockerConnectivityArgs({ MANAGED_RUNTIME_DOCKER_EXTRA_HOSTS: "model.local.dofe.ai:host-gateway;touch" }),
    /docker_extra_hosts_invalid/,
  );
  assert.throws(
    () => buildManagedRuntimeDockerConnectivityArgs({ MANAGED_RUNTIME_TLS_CA_PATH: "relative/rootCA.pem" }),
    /tls_ca_path_invalid/,
  );
});

function writeJson(path: string, value: unknown): void {
  const directory = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}
