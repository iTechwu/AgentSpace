import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import {
  importWorkspaceSkillFromUrl,
  listWorkspaceGitCredentialsSync,
  resetWorkspaceStateSync,
  resolveWorkspaceGitCredentialSecretSync,
  revokeWorkspaceGitCredentialSync,
  setWorkspaceGitCredentialSync,
} from "../index.ts";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex").toString("base64");

before(() => {
  process.env.NODE_ENV = "test";
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = TEST_KEY;
});

beforeEach(() => {
  resetWorkspaceStateSync();
  getDatabase().exec("DELETE FROM workspace_git_credential");
  getDatabase().exec("DELETE FROM audit_log WHERE workspace_id = 'default'");
});

test("stores a private Git credential reference and resolves the secret back (never listing it)", () => {
  const stored = setWorkspaceGitCredentialSync({
    workspaceId: "default",
    host: "github.com",
    credentialType: "token",
    secret: "ghp_secret-token-123",
    referenceName: "Acme GitHub PAT",
  });
  assert.ok(stored.id.startsWith("wgc-"));
  assert.equal(stored.host, "github.com");

  // The list view must never expose the secret.
  const listed = listWorkspaceGitCredentialsSync("default");
  assert.equal(listed.length, 1);
  assert.equal("encryptedSecret" in listed[0]!, false);
  assert.ok(listed[0]!.fingerprint.length === 64);

  // Resolution decrypts and returns the exact secret for the host.
  assert.equal(
    resolveWorkspaceGitCredentialSecretSync({ workspaceId: "default", host: "github.com" }),
    "ghp_secret-token-123",
  );
  // Unknown host → null.
  assert.equal(
    resolveWorkspaceGitCredentialSecretSync({ workspaceId: "default", host: "gitlab.com" }),
    null,
  );
});

test("rotating a credential replaces the secret and fingerprint", () => {
  const original = setWorkspaceGitCredentialSync({
    workspaceId: "default",
    host: "gitlab.com",
    credentialType: "token",
    secret: "old-token",
  });
  const rotated = setWorkspaceGitCredentialSync({
    workspaceId: "default",
    host: "gitlab.com",
    credentialType: "token",
    secret: "new-token",
    rotate: true,
  });
  assert.ok(rotated.rotatedAt, "rotation stamps rotated_at");
  assert.notEqual(rotated.fingerprint, original.fingerprint, "a new secret yields a new fingerprint");
  assert.equal(
    resolveWorkspaceGitCredentialSecretSync({ workspaceId: "default", host: "gitlab.com" }),
    "new-token",
  );
});

test("revoking a credential makes resolution return null", () => {
  const stored = setWorkspaceGitCredentialSync({
    workspaceId: "default",
    host: "github.com",
    credentialType: "ssh_key",
    secret: "ssh-ed25519 AAAAC3Nz...",
  });
  const revoked = revokeWorkspaceGitCredentialSync({ workspaceId: "default", credentialId: stored.id });
  assert.equal(revoked, true);
  assert.equal(
    resolveWorkspaceGitCredentialSecretSync({ workspaceId: "default", host: "github.com" }),
    null,
  );
});

test("rejects unsupported hosts and empty secrets", () => {
  assert.throws(
    () =>
      setWorkspaceGitCredentialSync({
        workspaceId: "default",
        host: "bitbucket.org",
        credentialType: "token",
        secret: "x",
      }),
    /仅支持 github.com 或 gitlab.com/,
  );
  assert.throws(
    () =>
      setWorkspaceGitCredentialSync({
        workspaceId: "default",
        host: "github.com",
        credentialType: "token",
        secret: "",
      }),
    /不能为空/,
  );
});

test("private-repo skill import attaches the stored credential to GitHub fetches", async () => {
  setWorkspaceGitCredentialSync({
    workspaceId: "default",
    host: "github.com",
    credentialType: "token",
    secret: "ghp_private-token",
  });
  const captured: Array<string | undefined> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.github.com") || url.includes("raw.githubusercontent.com")) {
      captured.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    }
    if (url.includes("/commits/")) {
      return new Response(JSON.stringify({ sha: "abc123def456789012345678901234567890abcd" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("raw.githubusercontent.com")) {
      return new Response("---\nname: private-pack\ndescription: private\n---\n# Private\n", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const result = await importWorkspaceSkillFromUrl({
      workspaceId: "default",
      url: "https://github.com/octo-org/private-repo/blob/main/SKILL.md",
    });
    assert.ok(result.skillId);
    assert.ok(
      captured.some((header) => header === "Bearer ghp_private-token"),
      "GitHub API + raw fetches should carry the workspace credential",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
