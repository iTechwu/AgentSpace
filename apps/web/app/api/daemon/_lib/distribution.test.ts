import { describe, expect, it } from "vitest";

import { buildHostedInstallScript, resolveRequestOrigin } from "./distribution";

describe("daemon distribution helpers", () => {
  it("uses forwarded e2e origin for hosted daemon install defaults", () => {
    const request = new Request("http://127.0.0.1:1456/api/daemon/install-script", {
      headers: {
        "x-forwarded-host": "feishu-e2e.hire-an-agent.online",
        "x-forwarded-proto": "https",
      },
    });
    const origin = resolveRequestOrigin(request);
    const script = buildHostedInstallScript(origin);

    expect(origin).toBe("https://feishu-e2e.hire-an-agent.online");
    expect(script).toContain("DEFAULT_SERVER_URL='https://feishu-e2e.hire-an-agent.online'");
    expect(script).toContain("DEFAULT_PACKAGE_URL='https://feishu-e2e.hire-an-agent.online/api/daemon/package'");
    expect(script).not.toContain("DEFAULT_SERVER_URL='https://hire-an-agent.online'");
  });
});
