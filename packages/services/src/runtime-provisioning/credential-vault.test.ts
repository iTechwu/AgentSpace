import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createRuntimeCredentialVaultFromEnvironment,
  EncryptedFileRuntimeCredentialVault,
} from "./credential-vault.ts";

test("encrypted runtime credential vault survives a new process instance without persisting plaintext", () => {
  const directory = mkdtempSync(join(tmpdir(), "dofe-runtime-vault-"));
  const key = Buffer.alloc(32, 7);
  const scope = { tenantId: "tenant-1", teamId: "team-1", runtimeId: "runtime-1" };
  try {
    const secret = new EncryptedFileRuntimeCredentialVault(directory, key)
      .store("credential-1", "plaintext-runtime-key", scope);
    const files = readdirSync(directory);

    assert.equal(files.length, 1);
    assert.doesNotMatch(readFileSync(join(directory, files[0]!), "utf8"), /plaintext-runtime-key/);
    assert.match(secret.secretRef, /tenant-1\/team-1\/runtime-1/);
    assert.equal(new EncryptedFileRuntimeCredentialVault(directory, key).retrieve(secret.secretRef, scope), "plaintext-runtime-key");
    assert.equal(
      new EncryptedFileRuntimeCredentialVault(directory, key).retrieve(secret.secretRef, { ...scope, teamId: "team-2" }),
      undefined,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relative runtime credential vault paths are stable across workspace package directories", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "dofe-runtime-vault-root-"));
  const webDirectory = join(repositoryRoot, "apps", "web");
  const originalCwd = process.cwd();
  mkdirSync(webDirectory, { recursive: true });
  writeFileSync(join(repositoryRoot, "Target.md"), "test repository root\n", "utf8");

  try {
    process.chdir(webDirectory);
    const vault = createRuntimeCredentialVaultFromEnvironment({
      DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR: "./data/runtime-credential-vault",
    });
    vault.store("credential-2", "plaintext-runtime-key");

    assert.equal(readdirSync(join(repositoryRoot, "data", "runtime-credential-vault")).length, 1);
    assert.equal(readdirSync(webDirectory).includes("data"), false);
  } finally {
    process.chdir(originalCwd);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
