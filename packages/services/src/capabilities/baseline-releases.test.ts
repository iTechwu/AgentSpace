import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  resolveBaselineRelease,
  setBaselineRegistryForTests,
  type BaselineRelease,
} from "./baseline-releases.ts";

const GOVERNED_UV: BaselineRelease = {
  tool: "uv",
  version: "0.4.10",
  artifactUrl: "https://github.com/astral-sh/uv/releases/download/0.4.10/uv-x86_64-unknown-linux-gnu.tar.gz",
  integrity: `sha256-${"a".repeat(64)}`,
  signatureRequired: true,
};

afterEach(() => {
  delete process.env.DOFE_AGENT_BASELINE_UV_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_UV_ARTIFACT_INTEGRITY;
  setBaselineRegistryForTests([]);
});

test("resolveBaselineRelease returns null for an ungoverned tool", () => {
  setBaselineRegistryForTests([]);
  assert.equal(resolveBaselineRelease("npm"), null);
  assert.equal(resolveBaselineRelease("python"), null);
});

test("resolveBaselineRelease reads the governed JSON registry", () => {
  setBaselineRegistryForTests([GOVERNED_UV]);
  const release = resolveBaselineRelease("uv");
  assert.ok(release);
  assert.equal(release.artifactUrl, GOVERNED_UV.artifactUrl);
  assert.equal(release.integrity, GOVERNED_UV.integrity);
  assert.equal(release.signatureRequired, true);
});

test("per-tool env override wins over the governed registry", () => {
  setBaselineRegistryForTests([GOVERNED_UV]);
  process.env.DOFE_AGENT_BASELINE_UV_ARTIFACT_URL = "https://mirror.example.com/uv-other.tar.gz";
  process.env.DOFE_AGENT_BASELINE_UV_ARTIFACT_INTEGRITY = `sha256-${"b".repeat(64)}`;
  const release = resolveBaselineRelease("uv");
  assert.ok(release);
  assert.equal(release.artifactUrl, "https://mirror.example.com/uv-other.tar.gz");
  assert.equal(release.integrity, `sha256-${"b".repeat(64)}`);
});

test("malformed registry entries (non-https / bad integrity) are rejected", () => {
  setBaselineRegistryForTests([
    { ...GOVERNED_UV, artifactUrl: "http://insecure.example.com/uv.tgz" },
    { ...GOVERNED_UV, integrity: "md5-abc" },
  ]);
  assert.equal(resolveBaselineRelease("uv"), null, "malformed pins must fail closed");
});
