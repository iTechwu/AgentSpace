import assert from "node:assert/strict";
import test from "node:test";
import { validateDspManifest } from "./manifest-schema.ts";

const VALID_MANIFEST = {
  schemaVersion: 1,
  artifact: { name: "my-skill", version: "1.2.0" },
  files: [
    { path: "SKILL.md", sha256: "a".repeat(64), size: 10, mediaType: "text/markdown" },
    {
      path: "scripts/render.py",
      sha256: "b".repeat(64),
      size: 2143,
      mediaType: "text/x-python",
      mode: "0755",
    },
  ],
  dependencies: [{ kind: "npm", name: "example", version: "1.4.2", integrity: "sha512-abc" }],
  capabilities: [{ kind: "mcp", catalogSlug: "github", requiredTools: ["search_issues"] }],
  services: [{ catalogSlug: "document-renderer", templateVersion: "2.1.0", required: true }],
  entrypoints: [
    { id: "render", kind: "script", path: "scripts/render.py", runtime: "python" },
  ],
};

test("validateDspManifest accepts a complete manifest", () => {
  const result = validateDspManifest(VALID_MANIFEST);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateDspManifest rejects an unknown schemaVersion", () => {
  const result = validateDspManifest({ ...VALID_MANIFEST, schemaVersion: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("schemaVersion")));
});

test("validateDspManifest rejects a malformed file sha256", () => {
  const broken = {
    ...VALID_MANIFEST,
    files: [{ path: "SKILL.md", sha256: "not-a-hash", size: 10, mediaType: "text/markdown" }],
  };
  const result = validateDspManifest(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("sha256")));
});

test("validateDspManifest rejects an invalid capability kind", () => {
  const result = validateDspManifest({
    ...VALID_MANIFEST,
    capabilities: [{ kind: "shell", catalogSlug: "x" }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("kind")));
});

test("validateDspManifest rejects additional properties", () => {
  const result = validateDspManifest({ ...VALID_MANIFEST, surprise: true });
  assert.equal(result.ok, false);
});

test("validateDspManifest rejects entrypoint ids that normalize to the same command segment", () => {
  const result = validateDspManifest({
    ...VALID_MANIFEST,
    entrypoints: [
      { id: "render docs", kind: "script", path: "scripts/render.py", runtime: "python" },
      { id: "render-docs", kind: "script", path: "scripts/other.py", runtime: "python" },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("duplicate normalized id")));
});

test("validateDspManifest accepts bounded config keys and rejects unsafe names", () => {
  const accepted = validateDspManifest({
    ...VALID_MANIFEST,
    entrypoints: [{
      id: "render",
      kind: "script",
      path: "scripts/render.py",
      runtime: "python",
      configKeys: ["RENDER_API_TOKEN"],
    }],
  });
  assert.equal(accepted.ok, true);

  const rejected = validateDspManifest({
    ...VALID_MANIFEST,
    entrypoints: [{
      id: "render",
      kind: "script",
      path: "scripts/render.py",
      runtime: "python",
      configKeys: ["../../TOKEN"],
    }],
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.includes("configKeys")));
});
