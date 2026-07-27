import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EncryptedFileRuntimeCredentialVault } from "./credential-vault.ts";

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
