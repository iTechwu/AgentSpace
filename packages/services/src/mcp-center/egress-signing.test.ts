import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { McpEgressLeaseClaims } from "@dofe-agent/domain";
import {
  readMcpEgressLeaseSigningKey,
  readMcpEgressLeaseVerificationKey,
  signMcpEgressLease,
  verifyMcpEgressLease,
} from "./egress.ts";

const SECRET = "a".repeat(32);
const ED25519_KEYS = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function claims(): McpEgressLeaseClaims {
  return {
    iss: "agentspace-control-plane",
    aud: "mcp-egress-proxy",
    jti: "jti-eddsa",
    workspaceId: "ws-1",
    runtimeId: "rt-1",
    connectionId: "conn-1",
    releaseId: "rel-1",
    releaseManifestDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    policyRevisionId: "pol-1",
    policyDigest: `sha256:${"a".repeat(64)}`,
    purpose: "task_call",
    taskId: "task-1",
    toolName: "some_tool",
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

test("Ed25519 lease can be verified with only the public key", () => {
  const token = signMcpEgressLease(claims(), { algorithm: "EdDSA", privateKey: ED25519_KEYS.privateKey });
  assert.equal(verifyMcpEgressLease(token, { algorithm: "EdDSA", publicKey: ED25519_KEYS.publicKey }).ok, true);
});

test("lease verification rejects algorithm downgrade and a different public key", () => {
  const token = signMcpEgressLease(claims(), { algorithm: "EdDSA", privateKey: ED25519_KEYS.privateKey });
  assert.equal(verifyMcpEgressLease(token, SECRET).ok, false);
  const otherKeys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  assert.equal(verifyMcpEgressLease(token, { algorithm: "EdDSA", publicKey: otherKeys.publicKey }).ok, false);
});

test("lease key configuration prefers asymmetric files and gates legacy HMAC", () => {
  assert.deepEqual(
    readMcpEgressLeaseSigningKey({
      MCP_EGRESS_PROXY_LEASE_SIGNING_PRIVATE_KEY_FILE: "/run/secrets/private.pem",
      MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET: SECRET,
    }, () => ED25519_KEYS.privateKey),
    { algorithm: "EdDSA", privateKey: ED25519_KEYS.privateKey.trim() },
  );
  assert.deepEqual(
    readMcpEgressLeaseVerificationKey(
      { MCP_EGRESS_PROXY_LEASE_VERIFY_PUBLIC_KEY_FILE: "/run/secrets/public.pem" },
      () => ED25519_KEYS.publicKey,
    ),
    { algorithm: "EdDSA", publicKey: ED25519_KEYS.publicKey.trim() },
  );
  assert.equal(readMcpEgressLeaseVerificationKey({ MCP_EGRESS_PROXY_LEASE_SECRET: SECRET }), undefined);
  assert.deepEqual(readMcpEgressLeaseVerificationKey({
    MCP_EGRESS_PROXY_LEASE_SECRET: SECRET,
    MCP_EGRESS_PROXY_ALLOW_LEGACY_HMAC: "true",
  }), { algorithm: "HS256", secret: SECRET });
  assert.throws(
    () => readMcpEgressLeaseVerificationKey(
      { MCP_EGRESS_PROXY_LEASE_VERIFY_PUBLIC_KEY_FILE: "relative.pem" },
      () => ED25519_KEYS.publicKey,
    ),
    /must be absolute/,
  );
});
