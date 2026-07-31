import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSkillRequirementRuntimeContext,
  getSkillRequirementBlockers,
  normalizeSkillRequirementConfiguration,
  parseSkillRequirementDeclarations,
  serializeSkillRequirementConfiguration,
} from "./requirements.ts";

const skillMarkdown = `---
name: configured-skill
requires:
  - provider:codex
  - model:gpt-5
  - capability:tool_use
  - project:repository
  - config:API_BASE_URL
  - secret:OPENAI_API_KEY
---
# Configured skill
`;

test("parseSkillRequirementDeclarations accepts the bounded installation manifest", () => {
  assert.deepEqual(parseSkillRequirementDeclarations(skillMarkdown), [
    { kind: "provider", value: "codex" },
    { kind: "model", value: "gpt-5" },
    { kind: "capability", value: "tool_use" },
    { kind: "project", value: "repository" },
    { kind: "config", value: "API_BASE_URL" },
    { kind: "secret", value: "OPENAI_API_KEY" },
  ]);
});

test("parseSkillRequirementDeclarations treats APPKEY as a credential", () => {
  const appKeySkill = `---
requires:
  - config:IMAGE_APPKEY
  - config:IMAGE_BASE_URL
---`;
  assert.deepEqual(parseSkillRequirementDeclarations(appKeySkill), [
    { kind: "secret", value: "IMAGE_APPKEY" },
    { kind: "config", value: "IMAGE_BASE_URL" },
  ]);
});

test("parseSkillRequirementDeclarations rejects reserved config keys", () => {
  const reservedConfigSkill = `---
requires:
  - config:DOFE_AGENT_CONTEXT_TASK_ID
---`;

  assert.throws(
    () => parseSkillRequirementDeclarations(reservedConfigSkill),
    /DOFE_AGENT_CONTEXT_TASK_ID is reserved by the runtime/,
  );
});

test("parseSkillRequirementDeclarations rejects reserved secret keys", () => {
  const reservedSecretSkill = `---
requires:
  - secret:DOFE_AGENT_RUNTIME_TOKEN
---`;

  assert.throws(
    () => parseSkillRequirementDeclarations(reservedSecretSkill),
    /DOFE_AGENT_RUNTIME_TOKEN is reserved by the runtime/,
  );
});

test("normalizeSkillRequirementConfiguration rejects an unapproved provider and does not accept secret values", () => {
  const requirements = parseSkillRequirementDeclarations(skillMarkdown);
  assert.throws(
    () => normalizeSkillRequirementConfiguration({
      requirements,
      modelProvider: "claude",
      modelId: "gpt-5",
      capabilities: ["tool_use"],
      projectWorkDir: "/workspace/repository",
      values: { API_BASE_URL: "https://api.example.test" },
    }),
    /requires one of these providers/,
  );

  const configuration = normalizeSkillRequirementConfiguration({
    requirements,
    modelProvider: "codex",
    modelId: "gpt-5",
    capabilities: ["tool_use"],
    projectWorkDir: "/workspace/repository",
    values: { API_BASE_URL: "https://api.example.test", OPENAI_API_KEY: "not-stored" },
  });
  assert.deepEqual(configuration.values, { API_BASE_URL: "https://api.example.test" });
});

test("requirement context excludes secrets and reports Credential Center blockers", () => {
  const requirements = parseSkillRequirementDeclarations(skillMarkdown);
  const configJson = serializeSkillRequirementConfiguration({
    configJson: JSON.stringify({ requirements }),
    configuration: normalizeSkillRequirementConfiguration({
      requirements,
      modelProvider: "codex",
      modelId: "gpt-5",
      capabilities: ["tool_use"],
      projectWorkDir: "/workspace/repository",
      values: { API_BASE_URL: "https://api.example.test" },
    }),
  });
  const context = buildSkillRequirementRuntimeContext(configJson);
  assert.deepEqual(context?.credentialRequirements, [{ key: "OPENAI_API_KEY", status: "credential_center_required" }]);
  assert.equal(JSON.stringify(context).includes("not-stored"), false);
  assert.deepEqual(getSkillRequirementBlockers({ configJson, runtimeProvider: "codex" }), [
    "OPENAI_API_KEY must be configured in Credential Center.",
  ]);
});
