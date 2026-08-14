import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSkillEgressOrigin,
  normalizeSkillEgressAllowlist,
  parseSkillEgressOrigin,
} from "./skill-egress.ts";

test("parseSkillEgressOrigin accepts bare hostnames and HTTPS origins", () => {
  for (const [entry, hostname] of [
    ["api.example.com", "api.example.com"],
    ["https://api.example.com", "api.example.com"],
    ["  API.Example.COM  ", "api.example.com"],
    ["api.example.com.", "api.example.com"],
    // Default ports normalize away — the approved object equals the enforced one.
    ["https://api.example.com:443", "api.example.com"],
    ["api.example.com:443", "api.example.com"],
    // IDN input normalizes to its punycode form.
    ["https://bücher.de", "xn--bcher-kva.de"],
  ] as const) {
    const parsed = parseSkillEgressOrigin(entry);
    assert.ok(parsed.ok, entry);
    assert.equal(parsed.origin.hostname, hostname, entry);
    assert.equal(parsed.origin.port, undefined, entry);
  }
});

test("parseSkillEgressOrigin rejects cleartext http origins", () => {
  for (const entry of [
    "http://api.example.com",
    "http://api.example.com/",
    "http://api.example.com:80",
  ]) {
    const parsed = parseSkillEgressOrigin(entry);
    assert.ok(!parsed.ok, entry);
    if (!parsed.ok) assert.match(parsed.reason, /https/i, entry);
  }
});

test("parseSkillEgressOrigin rejects raw IPs, localhost and private-suffix names", () => {
  for (const entry of [
    "203.0.113.10",
    "https://203.0.113.10",
    // WHATWG URL canonicalizes integer / hex / partial IPv4 forms.
    "0xcb00710a",
    "203.1602634",
    "[2001:db8::10]",
    "https://[2001:db8::1]:443",
    "localhost",
    "foo.localhost",
    "mdns.local",
    "db.internal",
    "nas.lan",
    "ad.corp",
    // Single-label names may resolve via search domains to private addresses.
    "intranet",
  ]) {
    const parsed = parseSkillEgressOrigin(entry);
    assert.ok(!parsed.ok, entry);
  }
});

test("parseSkillEgressOrigin rejects unenforceable shapes", () => {
  for (const entry of [
    "ftp://example.com",
    "https://example.com/path",
    "https://example.com?q=1",
    "https://example.com#frag",
    "https://user:pass@example.com",
    "*.example.com",
    "has space.example.com",
    "",
    "   ",
    "exa_mple.com",
    "example..com",
    "-bad.example.com",
    "example.com:0",
    "example.com:65536",
    "example.com:abc",
  ]) {
    assert.ok(!parseSkillEgressOrigin(entry).ok, entry);
  }
});

test("parseSkillEgressOrigin gates explicit non-default ports on allowExplicitPort", () => {
  const rejected = parseSkillEgressOrigin("example.com:8443");
  assert.ok(!rejected.ok);
  if (!rejected.ok) assert.match(rejected.reason, /port/i);

  const allowed = parseSkillEgressOrigin("example.com:8443", { allowExplicitPort: true });
  assert.ok(allowed.ok);
  assert.deepEqual(allowed.origin, { hostname: "example.com", port: 8443 });
});

test("normalizeSkillEgressAllowlist dedupes, sorts and separates invalid entries", () => {
  const result = normalizeSkillEgressAllowlist([
    "Registry.Example.com",
    "https://api.example.com:443",
    "api.example.com",
    "not a host",
  ]);
  assert.deepEqual(result.formatted, ["api.example.com", "registry.example.com"]);
  assert.deepEqual(result.hostnames, ["api.example.com", "registry.example.com"]);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0]!.entry, "not a host");
});

test("formatSkillEgressOrigin renders hostname and hostname:port", () => {
  assert.equal(formatSkillEgressOrigin({ hostname: "api.example.com" }), "api.example.com");
  assert.equal(formatSkillEgressOrigin({ hostname: "api.example.com", port: 8443 }), "api.example.com:8443");
});
