import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import { getSystemAgentTemplatePreset } from "@dofe-agent/domain";
import { localizeLegacySystemTemplateEmployeesSync } from "./localize-legacy-employees.ts";

function createLegacyEmployee(): ActiveEmployee {
  return {
    name: "product-manager",
    remarkName: "Product Manager Agent",
    role: "Product Manager",
    origin: "agent-template:product-manager:v1",
    summary: "Turns product discussions into plans.",
    traits: ["product"],
    fit: "Product planning.",
    skillIds: ["skill-1"],
    channels: [],
    status: "active",
    instructions: "Role\nYou are a product manager.",
    channelMemberAccess: "enabled",
  };
}

test("localizes legacy system-template employee profile fields without changing its stable name", () => {
  const employee = createLegacyEmployee();
  const template = getSystemAgentTemplatePreset("product-manager");
  assert.ok(template);

  assert.equal(localizeLegacySystemTemplateEmployeesSync([employee]), 1);
  assert.equal(employee.name, "product-manager");
  assert.equal(employee.remarkName, template.defaultRemarkName);
  assert.equal(employee.role, template.defaultTitle);
  assert.equal(employee.summary, template.summary);
  assert.deepEqual(employee.traits, template.traits);
  assert.equal(employee.fit, template.fit);
  assert.equal(employee.instructions, template.instructions);
  assert.equal(employee.origin, "agent-template:product-manager:v2");
});

test("does not overwrite current templates or manually created employees", () => {
  const current = createLegacyEmployee();
  current.origin = "agent-template:product-manager:v2";
  const manual = createLegacyEmployee();
  manual.origin = "manual";

  assert.equal(localizeLegacySystemTemplateEmployeesSync([current, manual]), 0);
  assert.equal(current.instructions, "Role\nYou are a product manager.");
  assert.equal(manual.instructions, "Role\nYou are a product manager.");
});
