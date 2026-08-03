import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillDependencyInstallPlan, resolveDependencyIntegrityLock } from "./dependency-install.ts";

test("buildSkillDependencyInstallPlan installs npm into an isolated deps dir with a pinned registry", () => {
  const plan = buildSkillDependencyInstallPlan("skill-123", {
    manager: "npm",
    name: "@scope/tool",
    version: "1.2.3",
  });

  assert.equal(plan.app.source, "skill_dependency");
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.depsDir, "deps/npm");
  assert.equal(plan.integrityLock, undefined, "no declared integrity → no lock");
  assert.deepEqual(plan.commands, [{
    executable: "npm",
    args: [
      "install", "--prefix", "deps/npm", "--ignore-scripts", "--no-audit", "--no-fund",
      "--registry", "https://registry.npmjs.org", "@scope/tool@1.2.3",
    ],
    env: { NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  }]);
  assert.deepEqual(plan.verifyCommands, [{
    executable: "npm",
    args: ["ls", "--prefix", "deps/npm", "@scope/tool@1.2.3"],
  }]);
  // The plan must never touch the Provider HOME / global package paths.
  assert.ok(!plan.commands[0]!.args.includes("--global"));
  assert.ok(plan.notes.some((note) => note.includes("isolated deps root")));
});

test("buildSkillDependencyInstallPlan carries the declared integrity lock", () => {
  const plan = buildSkillDependencyInstallPlan("skill-123", {
    manager: "pip",
    name: "requests",
    version: "2.32.3",
    integrity: "sha256:abc123",
  });
  assert.equal(plan.integrityLock, "sha256:abc123");
  assert.equal(plan.depsDir, "deps/pip");
});

test("resolveDependencyIntegrityLock resolves npm dist.integrity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ dist: { integrity: "sha512-deadbeef" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const lock = await resolveDependencyIntegrityLock({ manager: "npm", name: "left-pad", version: "1.3.0" });
    assert.equal(lock, "sha512-deadbeef");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveDependencyIntegrityLock resolves PyPI wheel sha256 with a sha256: prefix", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        urls: [
          { packagetype: "sdist", digests: { sha256: "sdist-hash" } },
          { packagetype: "bdist_wheel", digests: { sha256: "wheel-hash" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const lock = await resolveDependencyIntegrityLock({ manager: "pip", name: "requests", version: "2.32.3" });
    assert.equal(lock, "sha256:wheel-hash", "prefers the wheel artifact");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveDependencyIntegrityLock returns null on registry/network failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const lock = await resolveDependencyIntegrityLock({ manager: "npm", name: "left-pad", version: "1.3.0" });
    assert.equal(lock, null, "a lock is an enrichment, never a hard blocker");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildSkillDependencyInstallPlan isolates pip/uv installs and pins the pypi index", () => {
  const plan = buildSkillDependencyInstallPlan("skill-123", {
    manager: "pip",
    name: "requests",
    version: "2.32.3",
  });

  assert.deepEqual(plan.commands[0], {
    executable: "python",
    args: [
      "-m", "pip", "install", "--target", "deps/pip", "--no-deps", "--no-input",
      "--disable-pip-version-check", "--only-binary", ":all:",
      "--index-url", "https://pypi.org/simple", "requests==2.32.3",
    ],
  });
  assert.ok(!plan.commands[0]!.args.includes("--user"), "pip must never install --user");

  const uvPlan = buildSkillDependencyInstallPlan("skill-123", {
    manager: "uv",
    name: "requests",
    version: "2.32.3",
  });
  assert.deepEqual(uvPlan.commands[0]!.args.slice(0, 4), ["pip", "install", "--target", "deps/pip"]);
  assert.ok(uvPlan.commands[0]!.args.includes("--index-url"));
});
