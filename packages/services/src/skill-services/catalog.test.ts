import assert from "node:assert/strict";
import test from "node:test";
import { assertSkillServiceCatalogAdmissionSync } from "./catalog.ts";

const sha = (fill: string) => fill.repeat(64);

function validInput() {
  return {
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${sha("a")}`,
    templateDigest: `sha256:${sha("b")}`,
    rollbackClass: "stateless",
    networkJson: JSON.stringify({ egressAllowlist: ["https://example.com"] }),
    externalDependenciesJson: JSON.stringify(["postgres:central-render-db"]),
  };
}

test("catalog admission accepts a well-formed managed-service template", () => {
  const result = assertSkillServiceCatalogAdmissionSync(validInput());
  assert.equal(result.ok, true);
});

test("catalog admission accepts an external_connection template without an image", () => {
  const result = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    deploymentType: "external_connection",
    imageDigest: "external-connection",
  });
  assert.equal(result.ok, false, "external_connection still requires a digest-form imageDigest");
  const relaxed = assertSkillServiceCatalogAdmissionSync({
    ...validInput(),
    deploymentType: "external_connection",
    imageDigest: `sha256:${sha("c")}`,
  });
  assert.equal(relaxed.ok, true);
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
