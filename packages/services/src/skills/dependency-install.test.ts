import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillDependencyInstallPlan } from "./dependency-install.ts";

test("buildSkillDependencyInstallPlan uses an argument-array npm plan with lifecycle scripts disabled", () => {
  const plan = buildSkillDependencyInstallPlan("skill-123", {
    manager: "npm",
    name: "@scope/tool",
    version: "1.2.3",
  });

  assert.equal(plan.app.source, "skill_dependency");
  assert.equal(plan.requiresApproval, true);
  assert.deepEqual(plan.commands, [{
    executable: "npm",
    args: ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "@scope/tool@1.2.3"],
    env: { NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  }]);
  assert.deepEqual(plan.verifyCommands, [{
    executable: "npm",
    args: ["list", "--global", "--depth=0", "@scope/tool"],
  }]);
});

test("buildSkillDependencyInstallPlan rejects Python source distributions", () => {
  const plan = buildSkillDependencyInstallPlan("skill-123", {
    manager: "pip",
    name: "requests",
    version: "2.32.3",
  });

  assert.deepEqual(plan.commands[0], {
    executable: "python",
    args: ["-m", "pip", "install", "--user", "--no-input", "--disable-pip-version-check", "--only-binary", ":all:", "requests==2.32.3"],
  });
});
