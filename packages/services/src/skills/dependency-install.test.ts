import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillDependencyInstallPlan } from "./dependency-install.ts";

test("buildSkillDependencyInstallPlan installs npm into an isolated deps dir with a pinned registry", () => {
  const plan = buildSkillDependencyInstallPlan("skill-123", {
    manager: "npm",
    name: "@scope/tool",
    version: "1.2.3",
  });

  assert.equal(plan.app.source, "skill_dependency");
  assert.equal(plan.requiresApproval, true);
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
