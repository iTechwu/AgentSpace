import assert from "node:assert/strict";
import test from "node:test";
import { assertSkillServiceCatalogAdmissionSync } from "./catalog.ts";

const sha = (fill: string) => fill.repeat(64);
const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFqpQUB2kqJXqZq9Y0Jq0N6nRqZb6
vY1Q6GZPZ5aB0nR4Lz1S8u4jT2qVwzKQm0xEb7jHkY9x0o0I9sM0w==
-----END PUBLIC KEY-----`;

function validInput() {
  return {
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: `ghcr.io/dofe-ai/document-renderer@sha256:${sha("a")}`,
    templateDigest: `sha256:${sha("b")}`,
    sbomDigest: `sha256:${sha("c")}`,
    rollbackClass: "stateless",
    networkJson: JSON.stringify({ egressAllowlist: ["https://example.com"] }),
    healthJson: JSON.stringify({ path: "/healthz", port: 8080 }),
    resourcesJson: JSON.stringify({ memory: "128Mi", cpu: "250m" }),
    secretFieldsJson: JSON.stringify(["RENDER_LICENSE"]),
    runAsNonRoot: true,
    readOnlyRootfs: true,
    capDrop: ["ALL"],
    signatureKeyPem: TEST_PUBLIC_KEY_PEM,
    signatureRequired: true,
    externalDependenciesJson: JSON.stringify(["postgres:central-render-db"]),
  };
}

test("catalog admission accepts a well-formed managed-service template", () => {
  const result = assertSkillServiceCatalogAdmissionSync(validInput());
  assert.equal(result.ok, true);
});

test("catalog admission rejects deployment types without an implemented binding model", () => {
  const external = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    deploymentType: "external_connection",
    imageDigest: "external-connection",
  });
  assert.equal(external.ok, false);
  if (!external.ok) assert.match(external.reason, /MCP Center connection reference/);

  const shared = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    deploymentType: "platform_shared",
  });
  assert.equal(shared.ok, false);
  if (!shared.ok) assert.match(shared.reason, /shared-service inventory/);
});

test("catalog admission accepts a full digest-pinned image ref from an allowed registry", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    imageDigest: `ghcr.io/dofe-ai/dofe-svc-e2e@sha256:${sha("a")}`,
  });
  assert.equal(result.ok, true);
});

test("catalog admission rejects a full ref whose digest is not locked", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    imageDigest: "localhost:5000/dofe-svc-e2e@sha256:not-a-digest",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /digest-locked/);
  }
});

test("catalog admission rejects an un-locked image digest", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    imageDigest: "renderer:latest",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /digest-locked/);
  }
});

test("catalog admission rejects a bare digest and an unapproved registry for image templates", () => {
  const bare = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    imageDigest: `sha256:${sha("a")}`,
  });
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.match(bare.reason, /pullable repo@sha256/);

  const registry = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    imageDigest: `registry.example.com/dofe/service@sha256:${sha("a")}`,
  });
  assert.equal(registry.ok, false);
  if (!registry.ok) assert.match(registry.reason, /not allowed/);
});

test("catalog admission rejects an unknown rollback class", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    rollbackClass: "blue_green",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /rollbackClass/);
  }
});

test("catalog admission rejects an unknown deployment type", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    deploymentType: "sidecar",
  });
  assert.equal(result.ok, false);
});

test("catalog admission accepts references to centrally-managed PostgreSQL/Redis/RabbitMQ", () => {
  // References to central stores are ALLOWED (CLAUDE.md: connect to externally
  // managed services); only creating them is forbidden, which no catalog field
  // expresses (templates carry no store images/volumes/init jobs).
  for (const dep of ["postgres:central-render-db", "redis:central-cache", "rabbitmq:central-queue"]) {
    const result = assertSkillServiceCatalogAdmissionSync({
      ...validInput(),
      externalDependenciesJson: JSON.stringify([dep]),
    });
    assert.equal(result.ok, true, `expected reference ${dep} to be accepted`);
  }
});

test("catalog admission rejects a malformed external dependency reference", () => {
  for (const dep of ["no-separator", "postgresql://user@host/db", "http://example.com"]) {
    const result = assertSkillServiceCatalogAdmissionSync({
      ...validInput(),
      externalDependenciesJson: JSON.stringify([dep]),
    });
    assert.equal(result.ok, false, `expected rejection for ${dep}`);
  }
});

test("catalog admission rejects malformed network policy", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    networkJson: "not-json",
  });
  assert.equal(result.ok, false);
  const noEgress = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    networkJson: JSON.stringify({ ingressPorts: [8080] }),
  });
  assert.equal(noEgress.ok, false);
  if (!noEgress.ok) {
    assert.match(noEgress.reason, /egressAllowlist/);
  }
});

test("catalog admission rejects a missing template digest", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    templateDigest: "",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /templateDigest/);
  }
});

test("catalog admission requires a digest-locked SBOM for image templates", () => {
  const missing = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    sbomDigest: "",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.reason, /sbomDigest/);
  }

  const unLocked = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    sbomDigest: "sbom.json",
  });
  assert.equal(unLocked.ok, false);

  const ok = assertSkillServiceCatalogAdmissionSync(validInput());
  assert.equal(ok.ok, true);
});

test("catalog admission does not misclassify external connections as image templates", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    deploymentType: "external_connection",
    imageDigest: `sha256:${sha("e")}`,
    sbomDigest: "",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.doesNotMatch(result.reason, /sbomDigest/);
});

test("catalog admission validates the container hardening profile", () => {
  const badBool = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    runAsNonRoot: "yes" as unknown as boolean,
  });
  assert.equal(badBool.ok, false);

  const badReadOnly = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    readOnlyRootfs: 1 as unknown as boolean,
  });
  assert.equal(badReadOnly.ok, false);

  const notArray = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    capDrop: "ALL" as unknown as string[],
  });
  assert.equal(notArray.ok, false);

  const badCap = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    capDrop: ["net-admin"],
  });
  assert.equal(badCap.ok, false);
  if (!badCap.ok) {
    assert.match(badCap.reason, /capDrop/);
  }

  const missingAll = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    capDrop: ["NET_ADMIN", "SYS_TIME"],
  });
  assert.equal(missingAll.ok, false);

  const emptyCaps = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    capDrop: [],
  });
  assert.equal(emptyCaps.ok, false);

  const okCaps = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    capDrop: ["ALL", "NET_ADMIN"],
  });
  assert.equal(okCaps.ok, true);
});

test("catalog admission validates health, resources and secret-field JSON shapes", () => {
  const noProbe = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    healthJson: JSON.stringify({ interval: "10s" }),
  });
  assert.equal(noProbe.ok, false);
  if (!noProbe.ok) {
    assert.match(noProbe.reason, /healthJson/);
  }

  const badPort = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    healthJson: JSON.stringify({ path: "/healthz", port: "8080" }),
  });
  assert.equal(badPort.ok, false);

  const badResource = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    resourcesJson: JSON.stringify({ memory: { value: 128 } }),
  });
  assert.equal(badResource.ok, false);

  const badSecret = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    secretFieldsJson: JSON.stringify(["license-key"]),
  });
  assert.equal(badSecret.ok, false);
  if (!badSecret.ok) {
    assert.match(badSecret.reason, /secretFieldsJson/);
  }

  const okSecret = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    secretFieldsJson: JSON.stringify(["RENDER_LICENSE", "API_KEY"]),
  });
  assert.equal(okSecret.ok, true);
});

test("catalog admission requires egressAllowlist for image templates (empty allowed)", () => {
  const missing = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    networkJson: JSON.stringify({ ingress: "private" }),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.reason, /egressAllowlist/);
  }

  const empty = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    networkJson: JSON.stringify({ egressAllowlist: [] }),
  });
  assert.equal(empty.ok, true, "an explicit empty allow-list (no egress) is valid");
});

test("catalog admission accepts only enforceable HTTP(S) egress origins", () => {
  for (const entry of [
    "ftp://example.com",
    "https://example.com/path",
    "https://user:pass@example.com",
    "https://example.com?q=1",
    "example.com:0",
  ]) {
    const result = assertSkillServiceCatalogAdmissionSync({
      ...validInput(),
      networkJson: JSON.stringify({ egressAllowlist: [entry] }),
    });
    assert.equal(result.ok, false, entry);
    if (!result.ok) assert.match(result.reason, /Invalid egressAllowlist/);
  }

  assert.equal(assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    networkJson: JSON.stringify({ egressAllowlist: ["https://example.com:8443", "api.example.com"] }),
  }).ok, true);
});

test("catalog admission validates egress allow-list entry format", () => {
  const bad = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    networkJson: JSON.stringify({ egressAllowlist: ["has space.example.com"] }),
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.reason, /egressAllowlist/);
  }

  const ok = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    networkJson: JSON.stringify({ egressAllowlist: ["fonts.example.com:443"] }),
  });
  assert.equal(ok.ok, true);
});

/* ------------------------------------------------------------------ */
/* Cosign image signature enforcement (schema v82)                     */
/* ------------------------------------------------------------------ */

test("catalog admission accepts a signature-required template with a PEM public key", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    signatureKeyPem: TEST_PUBLIC_KEY_PEM,
    signatureRequired: true,
  });
  assert.equal(result.ok, true);
});

test("catalog admission rejects a malformed cosign public key PEM", () => {
  const bad = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    signatureKeyPem: "not-a-pem-fragment",
    signatureRequired: true,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.reason, /signatureKeyPem must be a PEM/);
  }
});

test("catalog admission requires the trust key when signatureRequired is set", () => {
  const missing = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    signatureKeyPem: undefined,
    signatureRequired: true,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.reason, /must declare a signatureKeyPem/);
  }
});

test("catalog admission rejects advisory-only signatures for image templates", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    signatureKeyPem: TEST_PUBLIC_KEY_PEM,
    signatureRequired: false,
  });
  assert.equal(result.ok, false);
});
