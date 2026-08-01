import assert from "node:assert/strict";
import test from "node:test";
import { decryptMcpSecret, encryptMcpSecret, redactMcpText, redactToolInputSchema, validateMcpConnectionConfiguration, validateMcpEndpoint, validateMcpRequestHeaders, validateMcpResolvedAddresses } from "./security.ts";

test("validateMcpEndpoint accepts an https host on the allow-list", () => {
  const result = validateMcpEndpoint("https://github-mcp.example.com/mcp", ["github-mcp.example.com"]);
  assert.equal(result.ok, true);
  assert.equal(result.host, "github-mcp.example.com");
});

test("validateMcpEndpoint accepts wildcard and suffix host rules", () => {
  assert.equal(validateMcpEndpoint("https://api.example.com/mcp", ["*.example.com"]).ok, true);
  assert.equal(validateMcpEndpoint("https://api.example.com/mcp", [".example.com"]).ok, true);
  assert.equal(validateMcpEndpoint("https://evilexample.com/mcp", [".example.com"]).ok, false);
});

test("validateMcpEndpoint rejects non-allow-listed hosts", () => {
  const result = validateMcpEndpoint("https://evil.example.org/mcp", ["github-mcp.example.com"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "mcp.policy_denied");
});

test("validateMcpEndpoint rejects http", () => {
  assert.equal(validateMcpEndpoint("http://github-mcp.example.com/mcp", ["github-mcp.example.com"]).ok, false);
});

test("validateMcpEndpoint rejects loopback, private, link-local and metadata addresses", () => {
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "[::1]"]) {
    const result = validateMcpEndpoint(`https://${host}/mcp`, [host]);
    assert.equal(result.ok, false, `expected ${host} to be rejected`);
    assert.equal(result.code, "mcp.policy_denied");
  }
});

test("validateMcpResolvedAddresses rejects a mixed public and private DNS answer", () => {
  assert.equal(validateMcpResolvedAddresses(["203.0.113.8"]).ok, true);
  assert.equal(validateMcpResolvedAddresses(["203.0.113.8", "169.254.169.254"]).ok, false);
  assert.equal(validateMcpResolvedAddresses(["::ffff:127.0.0.1"]).ok, false);
});

test("validateMcpEndpoint rejects credentials embedded in the URL", () => {
  const result = validateMcpEndpoint("https://user:pass@github-mcp.example.com/mcp", ["github-mcp.example.com"]);
  assert.equal(result.ok, false);
});

test("validateMcpEndpoint rejects query and fragment data", () => {
  assert.equal(validateMcpEndpoint("https://github-mcp.example.com/mcp?token=secret", ["github-mcp.example.com"]).ok, false);
  assert.equal(validateMcpEndpoint("https://github-mcp.example.com/mcp#secret", ["github-mcp.example.com"]).ok, false);
});

test("validateMcpEndpoint rejects non-standard HTTPS ports", () => {
  assert.equal(validateMcpEndpoint("https://github-mcp.example.com:8443/mcp", ["github-mcp.example.com"]).ok, false);
  assert.equal(validateMcpEndpoint("https://github-mcp.example.com:443/mcp", ["github-mcp.example.com"]).ok, true);
});

test("validateMcpRequestHeaders accepts scalar headers and rejects protocol overrides", () => {
  assert.equal(validateMcpRequestHeaders({ "X-Tenant": "workspace-1", Accept: "application/json" }).ok, true);
  assert.equal(validateMcpRequestHeaders({ Host: "internal.service" }).ok, false);
  assert.equal(validateMcpRequestHeaders({ "X-Test": "ok\r\nHost: internal.service" }).ok, false);
  assert.equal(validateMcpRequestHeaders({ "bad header": "value" }).ok, false);
});

test("validateMcpConnectionConfiguration rejects fields outside the reviewed schema", () => {
  const schema = {
    type: "object",
    properties: { "X-Tenant": { type: "string", maxLength: 64 } },
    required: ["X-Tenant"],
    additionalProperties: false,
  };
  assert.equal(validateMcpConnectionConfiguration(schema, { "X-Tenant": "workspace-1" }).ok, true);
  assert.equal(validateMcpConnectionConfiguration(schema, { "X-Tenant": "workspace-1", "X-Unsafe": "value" }).ok, false);
  assert.equal(validateMcpConnectionConfiguration(schema, {}).ok, false);
});

test("encrypt/decrypt round-trips a secret and never exposes plaintext in the ciphertext", () => {
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const plaintext = "sk-super-secret-token-12345";
  const encrypted = encryptMcpSecret(plaintext);
  assert.equal(encrypted.includes(plaintext), false);
  assert.equal(encrypted.startsWith("mcp1:"), true);
  assert.equal(decryptMcpSecret(encrypted), plaintext);
});

test("decrypt rejects a tampered or wrong-version ciphertext", () => {
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  assert.throws(() => decryptMcpSecret("other:1:2:3"));
  assert.throws(() => decryptMcpSecret("mcp1:only:two"));
});

test("redactMcpText strips authorization, bearer and secret-like values", () => {
  const redacted = redactMcpText('Authorization: Bearer abc.def.ghi and api_key=sk-live-XYZ');
  assert.equal(redacted.includes("abc.def.ghi"), false);
  assert.equal(redacted.includes("sk-live-XYZ"), false);
  assert.ok(redacted.includes("[REDACTED]"));
});

test("redactToolInputSchema removes sensitive defaults and examples recursively", () => {
  const redacted = redactToolInputSchema({
    type: "object",
    properties: {
      token: { type: "string", default: "secret-default", examples: ["secret-example"], const: "secret-const", enum: ["secret-enum"] },
      request: { type: "object", properties: { Authorization: { default: "Bearer secret" } } },
      safe: { type: "string", default: "visible-default" },
    },
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("secret-default"), false);
  assert.equal(serialized.includes("secret-example"), false);
  assert.equal(serialized.includes("secret-const"), false);
  assert.equal(serialized.includes("secret-enum"), false);
  assert.equal(serialized.includes("Bearer secret"), false);
  assert.equal(serialized.includes("visible-default"), true);
});
