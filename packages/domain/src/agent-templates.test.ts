import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_AGENT_TEMPLATE_PRESETS } from "./agent-templates.ts";

test("system AI employee templates provide Chinese defaults for created employees", () => {
  assert.equal(SYSTEM_AGENT_TEMPLATE_PRESETS.length, 3);

  for (const template of SYSTEM_AGENT_TEMPLATE_PRESETS) {
    assert.equal(template.version, 2);
    for (const value of [
      template.displayName,
      template.shortDescription,
      template.defaultAgentName,
      template.defaultRemarkName,
      template.defaultTitle,
      template.summary,
      template.fit,
      template.instructions,
      ...template.traits,
    ]) {
      assert.match(value, /[\u4e00-\u9fff]/, `${template.id} should use Chinese employee defaults`);
    }

    for (const recommendation of template.skillRecommendations) {
      assert.match(recommendation.label, /[\u4e00-\u9fff]/, `${template.id} skill label should be Chinese`);
      assert.match(recommendation.description, /[\u4e00-\u9fff]/, `${template.id} skill description should be Chinese`);
    }
  }
});
