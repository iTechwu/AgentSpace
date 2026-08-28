import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveAgentRuntimeMode,
  resolveDofeAgentRuntimeConfig,
  resolveAttachmentRuntimeConfig,
  resolveModelsBaseUrl,
  resolveModelsGatewayBaseUrl,
  DEFAULT_MODELS_BASE_URL,
  DEFAULT_MODELS_GATEWAY_BASE_URL,
} from "./deployment.ts";

test("runtime mode defaults to local and only accepts remote explicitly", () => {
  assert.equal(resolveAgentRuntimeMode({}), "local");
  assert.equal(resolveAgentRuntimeMode({ DOFE_AGENT_RUNTIME_MODE: "remote" }), "remote");
  assert.equal(resolveAgentRuntimeMode({ DOFE_AGENT_RUNTIME_MODE: " LOCAL " }), "local");
});

test("runtime mode rejects unsupported deployment values", () => {
  assert.throws(
    () => resolveAgentRuntimeMode({ DOFE_AGENT_RUNTIME_MODE: "server" }),
    /DOFE_AGENT_RUNTIME_MODE must be either local or remote/,
  );
});

test("models base url falls back to the shared default and honors env overrides", () => {
  assert.equal(resolveModelsBaseUrl({}), DEFAULT_MODELS_BASE_URL);
  assert.equal(resolveModelsBaseUrl({ MODELS_BASE_URL: "  https://models.internal/api  " }), "https://models.internal/api");
  assert.equal(resolveModelsBaseUrl({ MODELS_BASE_URL: "   " }), DEFAULT_MODELS_BASE_URL);
});

test("models gateway base url falls back to the shared default and honors env overrides", () => {
  assert.equal(DEFAULT_MODELS_GATEWAY_BASE_URL, "https://model.local.dofe.ai/api");
  assert.equal(resolveModelsGatewayBaseUrl({}), DEFAULT_MODELS_GATEWAY_BASE_URL);
  assert.equal(resolveModelsGatewayBaseUrl({ MODELS_GATEWAY_BASE_URL: "https://gateway.example/api" }), "https://gateway.example/api");
  assert.equal(resolveModelsGatewayBaseUrl({ MODELS_GATEWAY_BASE_URL: "" }), DEFAULT_MODELS_GATEWAY_BASE_URL);
});

test("models gateway avoids redirecting streamed POST requests on the local public host", () => {
  assert.equal(
    resolveModelsGatewayBaseUrl({ MODELS_GATEWAY_BASE_URL: "http://model.local.dofe.ai/api" }),
    "https://model.local.dofe.ai/api",
  );
  assert.equal(
    resolveModelsGatewayBaseUrl({ MODELS_GATEWAY_BASE_URL: "http://models.internal/api" }),
    "http://models.internal/api",
  );
});

test("runtime config reads PostgreSQL and TOS configuration from repository .env", () => {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-deployment-config-"));
  try {
    mkdirSync(join(tempRoot, "apps", "web"), { recursive: true });
    writeFileSync(join(tempRoot, "Target.md"), "# test\n");
    writeFileSync(join(tempRoot, ".env"), [
      "SELF_HOSTED_DATABASE_URL=postgres://local:secret@127.0.0.1:5432/dofe_agent_test",
      "TOS_BUCKET=dofe-agent",
      "TOS_REGION=cn-beijing",
      "TOS_ENDPOINT=https://tos.example.com",
      "TOS_ACCESS_KEY=access-key",
      "TOS_SECRET_KEY=secret-key",
      "",
    ].join("\n"), "utf8");
    process.chdir(join(tempRoot, "apps", "web"));
    const runtime = resolveDofeAgentRuntimeConfig({});
    const attachments = resolveAttachmentRuntimeConfig({});
    assert.equal(runtime.databaseUrl, "postgres://local:secret@127.0.0.1:5432/dofe_agent_test");
    assert.equal(attachments.provider, "tos");
    assert.equal(attachments.tos?.bucket, "dofe-agent");
    assert.equal(attachments.tos?.endpoint, "https://tos.example.com");
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("TOS uses the public endpoint unless internal routing is explicitly enabled", () => {
  const attachments = resolveAttachmentRuntimeConfig({
    TOS_BUCKET: "dofe-agent",
    TOS_REGION: "cn-beijing",
    TOS_ENDPOINT: "https://tos.example.com",
    TOS_INTERNAL_ENDPOINT: "https://tos-internal.example.com",
    TOS_ACCESS_KEY: "access-key",
    TOS_SECRET_KEY: "secret-key",
  });
  assert.equal(attachments.provider, "tos");
  assert.equal(attachments.tos?.endpoint, "https://tos.example.com");
  assert.equal(attachments.tos?.publicEndpoint, "https://tos.example.com");
});

test("TOS can use a configured internal endpoint", () => {
  const attachments = resolveAttachmentRuntimeConfig({
    TOS_BUCKET: "dofe-agent",
    TOS_REGION: "cn-beijing",
    TOS_ENDPOINT: "https://tos.example.com",
    TOS_INTERNAL_ENDPOINT: "https://tos-internal.example.com",
    TOS_USE_INTERNAL_ENDPOINT: "true",
    TOS_BUCKET_DOMAIN: "https://assets.example.com",
    TOS_ACCESS_KEY: "access-key",
    TOS_SECRET_KEY: "secret-key",
  });
  assert.equal(attachments.tos?.endpoint, "https://tos-internal.example.com");
  assert.equal(attachments.tos?.bucketDomain, "https://assets.example.com");
});

test("legacy TOS S3 endpoint aliases are normalized for the TOS SDK", () => {
  const attachments = resolveAttachmentRuntimeConfig({
    TOS_BUCKET: "dofe-agent",
    TOS_REGION: "cn-beijing",
    TOS_S3_ENDPOINT: "https://tos-s3-cn-beijing.volces.com",
    TOS_ACCESS_KEY: "access-key",
    TOS_SECRET_KEY: "secret-key",
  });
  assert.equal(attachments.tos?.endpoint, "https://tos-cn-beijing.volces.com");
});

test("local attachment storage requires an explicit fallback opt-in", () => {
  assert.throws(
    () => resolveAttachmentRuntimeConfig({ ATTACHMENT_STORAGE_PROVIDER: "local" }),
    /ATTACHMENT_ENABLE_LOCAL_FALLBACK=true/,
  );
});

test("local attachment storage is available with an explicit fallback configuration", () => {
  const attachments = resolveAttachmentRuntimeConfig({
    ATTACHMENT_STORAGE_PROVIDER: "local",
    ATTACHMENT_ENABLE_LOCAL_FALLBACK: "true",
    SELF_HOSTED_ATTACHMENT_LOCAL_ROOT: "/srv/DofeAgent/data/attachments",
  });
  assert.equal(attachments.provider, "local");
});

test("incomplete TOS configuration is rejected instead of falling back to local storage", () => {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-incomplete-tos-"));
  try {
    mkdirSync(join(tempRoot, "apps", "web"), { recursive: true });
    writeFileSync(join(tempRoot, "Target.md"), "# test\n");
    writeFileSync(join(tempRoot, ".env"), "TOS_BUCKET=dofe-agent\n", "utf8");
    process.chdir(join(tempRoot, "apps", "web"));
    assert.throws(
      () => resolveAttachmentRuntimeConfig({}),
      /Missing required environment variable: TOS_ENDPOINT or TOS_S3_ENDPOINT/,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("invalid attachment storage provider is rejected", () => {
  assert.throws(
    () => resolveAttachmentRuntimeConfig({ ATTACHMENT_STORAGE_PROVIDER: "r2" }),
    /ATTACHMENT_STORAGE_PROVIDER must be tos/,
  );
});
