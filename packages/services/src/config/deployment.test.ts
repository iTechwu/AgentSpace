import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAgentSpaceRuntimeConfig, resolveAttachmentRuntimeConfig } from "./deployment.ts";

test("runtime config reads PostgreSQL and TOS configuration from repository .env", () => {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-deployment-config-"));
  try {
    mkdirSync(join(tempRoot, "apps", "web"), { recursive: true });
    writeFileSync(join(tempRoot, "Target.md"), "# test\n");
    writeFileSync(join(tempRoot, ".env"), [
      "SELF_HOSTED_DATABASE_URL=postgres://local:secret@127.0.0.1:5432/agent_space_test",
      "TOS_BUCKET=agentspace",
      "TOS_REGION=cn-beijing",
      "TOS_ENDPOINT=https://tos.example.com",
      "TOS_ACCESS_KEY=access-key",
      "TOS_SECRET_KEY=secret-key",
      "",
    ].join("\n"), "utf8");
    process.chdir(join(tempRoot, "apps", "web"));
    const runtime = resolveAgentSpaceRuntimeConfig({});
    const attachments = resolveAttachmentRuntimeConfig({});
    assert.equal(runtime.databaseUrl, "postgres://local:secret@127.0.0.1:5432/agent_space_test");
    assert.equal(attachments.provider, "tos");
    assert.equal(attachments.tos?.bucket, "agentspace");
    assert.equal(attachments.tos?.endpoint, "https://tos.example.com");
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("TOS uses the public endpoint unless internal routing is explicitly enabled", () => {
  const attachments = resolveAttachmentRuntimeConfig({
    TOS_BUCKET: "agentspace",
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
    TOS_BUCKET: "agentspace",
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
    TOS_BUCKET: "agentspace",
    TOS_REGION: "cn-beijing",
    TOS_S3_ENDPOINT: "https://tos-s3-cn-beijing.volces.com",
    TOS_ACCESS_KEY: "access-key",
    TOS_SECRET_KEY: "secret-key",
  });
  assert.equal(attachments.tos?.endpoint, "https://tos-cn-beijing.volces.com");
});

test("local storage can be explicitly selected for isolated environments", () => {
  const attachments = resolveAttachmentRuntimeConfig({
    ATTACHMENT_STORAGE_PROVIDER: "local",
    SELF_HOSTED_ATTACHMENT_LOCAL_ROOT: "/tmp/agent-space-local-attachments",
  });
  assert.equal(attachments.provider, "local");
  assert.equal(attachments.localRoot, "/tmp/agent-space-local-attachments");
});

test("invalid attachment storage provider is rejected", () => {
  assert.throws(
    () => resolveAttachmentRuntimeConfig({ ATTACHMENT_STORAGE_PROVIDER: "r2" }),
    /ATTACHMENT_STORAGE_PROVIDER must be either local or tos/,
  );
});
