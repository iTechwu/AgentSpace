import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDofeAgentChannelDeepLink,
  buildDofeAgentSettingsIntegrationsDeepLink,
  readDofeAgentAppUrl,
} from "../links.ts";

test("DofeAgent Feishu deep links use the public app URL and workspace path", () => {
  withDofeAgentAppUrl("https://dofe-agent.test", () => {
    assert.equal(readDofeAgentAppUrl(), "https://dofe-agent.test/");
    assert.equal(
      buildDofeAgentSettingsIntegrationsDeepLink({ workspaceId: "mars-labs" }),
      "https://dofe-agent.test/w/mars-labs/settings/integrations",
    );
    assert.equal(
      buildDofeAgentSettingsIntegrationsDeepLink({
        workspaceId: "mars-labs",
        target: "user-bindings",
      }),
      "https://dofe-agent.test/w/mars-labs/settings/integrations#feishu-user-bindings",
    );
    assert.equal(
      buildDofeAgentSettingsIntegrationsDeepLink({
        workspaceId: "mars-labs",
        target: "channel-bindings",
      }),
      "https://dofe-agent.test/w/mars-labs/settings/integrations#feishu-channel-bindings",
    );
    assert.equal(
      buildDofeAgentChannelDeepLink({
        workspaceId: "mars-labs",
        channelName: "tour visit",
      }),
      "https://dofe-agent.test/w/mars-labs/im?focus=channel%3Atour+visit",
    );
  });
});

test("DofeAgent Feishu deep links stay disabled when the public app URL is invalid", () => {
  withDofeAgentAppUrl("not a url", () => {
    assert.equal(readDofeAgentAppUrl(), undefined);
    assert.equal(
      buildDofeAgentSettingsIntegrationsDeepLink({ workspaceId: "workspace-1" }),
      undefined,
    );
  });
});

function withDofeAgentAppUrl<T>(appUrl: string | undefined, run: () => T): T {
  const previous = {
    DOFE_AGENT_APP_URL: process.env.DOFE_AGENT_APP_URL,
    NEXT_PUBLIC_DOFE_AGENT_APP_URL: process.env.NEXT_PUBLIC_DOFE_AGENT_APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  setOptionalEnv("DOFE_AGENT_APP_URL", appUrl);
  setOptionalEnv("NEXT_PUBLIC_DOFE_AGENT_APP_URL", undefined);
  setOptionalEnv("NEXT_PUBLIC_APP_URL", undefined);

  try {
    return run();
  } finally {
    setOptionalEnv("DOFE_AGENT_APP_URL", previous.DOFE_AGENT_APP_URL);
    setOptionalEnv("NEXT_PUBLIC_DOFE_AGENT_APP_URL", previous.NEXT_PUBLIC_DOFE_AGENT_APP_URL);
    setOptionalEnv("NEXT_PUBLIC_APP_URL", previous.NEXT_PUBLIC_APP_URL);
  }
}

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
