import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManagedCredentialBundleDocument,
  buildManagedProvisioningStageCommands,
} from "./provider-templates.ts";

const originalModelsBaseUrl = process.env.MODELS_BASE_URL;
const originalGatewayBaseUrl = process.env.MODELS_GATEWAY_BASE_URL;

test("managed credential bundles use the gateway endpoint required by each protocol", () => {
  process.env.MODELS_BASE_URL = "http://models-control.test";
  process.env.MODELS_GATEWAY_BASE_URL = "http://model.local.dofe.ai";
  try {
    const claude = buildManagedCredentialBundleDocument(runtime("claude"), "claude-key");
    const codex = buildManagedCredentialBundleDocument(runtime("codex"), "codex-key");
    const gemini = buildManagedCredentialBundleDocument(runtime("gemini"), "gemini-key");

    assert.equal(claude.environment.ANTHROPIC_BASE_URL, "http://model.local.dofe.ai/anthropic");
    assert.equal(codex.environment.OPENAI_BASE_URL, "http://model.local.dofe.ai/v1");
    assert.equal(gemini.environment.GEMINI_BASE_URL, "https://model.local.dofe.ai/gemini");
  } finally {
    if (originalModelsBaseUrl === undefined) delete process.env.MODELS_BASE_URL;
    else process.env.MODELS_BASE_URL = originalModelsBaseUrl;
    if (originalGatewayBaseUrl === undefined) delete process.env.MODELS_GATEWAY_BASE_URL;
    else process.env.MODELS_GATEWAY_BASE_URL = originalGatewayBaseUrl;
  }
});

test("install stage verifies the provider CLI inside the pulled runtime image", () => {
  const commands = buildManagedProvisioningStageCommands("codex", "install_cli", {
    runtimeId: "runtime-codex",
    runtimeCredentialId: "credential-codex",
    gatewayBaseUrl: "http://model.local.dofe.ai",
    imageTag: "stable",
  });

  assert.deepEqual(commands, [{
    executable: "docker",
    args: [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      "dofe/agent-runtime-codex:stable",
      "-c",
      "command -v codex",
    ],
    env: undefined,
  }]);
});

function runtime(provider: "claude" | "codex" | "gemini") {
  return {
    id: `runtime-${provider}`,
    workspaceId: "workspace-1",
    provider,
    name: provider,
    status: "online" as const,
    metadataJson: "{}",
    connectedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedCredentialId: `credential-${provider}`,
  };
}
