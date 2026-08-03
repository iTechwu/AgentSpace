import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeAppInstallPlan } from "./install-plan.ts";
import { normalizeCliHubRegistryPayload, syncCliHubCatalog } from "./catalog.ts";
import { selectCliHubReadiness } from "./runtime-apps.ts";

test("normalizes CLI-Hub registry entries and infers install strategy", () => {
  const items = normalizeCliHubRegistryPayload(
    "clihub_harness",
    {
      clis: [
        {
          name: "mermaid",
          display_name: "Mermaid",
          description: "Render diagrams",
          version: "1.0.0",
          category: "diagram",
          install_cmd: "pip install mermaid-cli",
          entry_point: "mmdc",
          skill_md: "skills/mermaid/SKILL.md",
        },
      ],
    },
    "2026-05-08T00:00:00.000Z",
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, "clihub_harness");
  assert.equal(items[0]?.name, "mermaid");
  assert.equal(items[0]?.installStrategy, "pip");
  assert.equal(items[0]?.skillMd, "skills/mermaid/SKILL.md");
});

test("corrects the known MiniMax npm binary name from the public registry", () => {
  const items = normalizeCliHubRegistryPayload(
    "clihub_public",
    {
      clis: [{
        name: "minimax-cli",
        display_name: "MiniMax CLI",
        install_cmd: "npm install -g minimax-cli",
        entry_point: "minimax-cli",
      }],
    },
    "2026-08-03T00:00:00.000Z",
  );

  assert.equal(items[0]?.entryPoint, "minimax");
});

test("syncs public registry from fallback URL when the primary URL is unavailable", async () => {
  const requestedUrls: string[] = [];
  const result = await syncCliHubCatalog({
    now: new Date("2026-05-08T00:00:00.000Z"),
    upsertItemsSync: (items) => items.length,
    readHealthSync: () => ({
      itemCount: 1,
      lastSyncedAt: "2026-05-08T00:00:00.000Z",
      stale: false,
    }),
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith("/registry.json")) {
        return jsonResponse({ clis: [] });
      }
      if (String(url).includes("hkuds.github.io") && String(url).endsWith("/public_registry.json")) {
        return new Response("not found", { status: 404, statusText: "Not Found" });
      }
      return jsonResponse({
        clis: [
          {
            name: "feishu",
            display_name: "Feishu/Lark CLI",
            install_cmd: "npm install -g @larksuite/cli",
            entry_point: "lark-cli",
          },
        ],
      });
    },
  });

  assert.equal(result.status, "fresh");
  assert.equal(result.errors.length, 0);
  assert.equal(requestedUrls.some((url) => url.includes("raw.githubusercontent.com")), true);
});

test("builds controlled cli-hub plans without executing registry shell strings", () => {
  const plan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: true,
    item: {
      source: "clihub_harness",
      name: "gimp",
      displayName: "GIMP",
      description: "Image editing harness",
      version: "0.1.0",
      category: "image",
      entryPoint: "cli-anything-gimp",
      installStrategy: "pip",
      installCmd: "pip install git+https://example.invalid/repo.git#subdirectory=gimp",
      skillMd: "skills/gimp/SKILL.md",
      requiresText: "GIMP installed locally",
      registryJson: "{}",
      syncedAt: "2026-05-08T00:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "cli_hub");
  assert.deepEqual(plan.commands, [{
    executable: "cli-hub",
    args: ["install", "gimp"],
    env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
  }]);
  assert.equal(plan.verifyCommands.some((command) => command.executable === "cli-anything-gimp"), true);
  assert.equal(plan.risk, "medium");
});

test("target Runtime CLI readiness takes precedence over daemon host readiness", () => {
  const selected = selectCliHubReadiness(
    JSON.stringify({ cliHubReadiness: {
      checkedAt: "2026-08-03T00:00:00.000Z",
      cliHub: { available: false, error: "not installed in Runtime HOME" },
    } }),
    JSON.stringify({ cliHubReadiness: {
      checkedAt: "2026-08-03T00:00:00.000Z",
      cliHub: { available: true, version: "host cli-hub" },
    } }),
  );

  assert.equal(selected.cliHub.available, false);
  assert.equal(selected.cliHub.error, "not installed in Runtime HOME");
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("builds uninstall plans without post-uninstall availability checks", () => {
  const plan = buildRuntimeAppInstallPlan({
    operation: "uninstall",
    cliHubAvailable: true,
    item: {
      source: "clihub_harness",
      name: "mermaid",
      displayName: "Mermaid",
      description: "Render diagrams",
      version: "1.0.0",
      category: "diagram",
      entryPoint: "mmdc",
      installStrategy: "cli_hub",
      registryJson: "{}",
      syncedAt: "2026-05-08T00:00:00.000Z",
    },
  });

  assert.deepEqual(plan.commands, [{
    executable: "cli-hub",
    args: ["uninstall", "mermaid"],
    env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
  }]);
  assert.deepEqual(plan.verifyCommands, []);
});

test("installs, updates, and uninstalls public npm apps without fetching the CLI-Hub registry", () => {
  const baseItem = {
    source: "clihub_public" as const,
    name: "toolkit",
    displayName: "Toolkit",
    description: "",
    version: "",
    category: "",
    entryPoint: "toolkit",
    installStrategy: "npm" as const,
    registryJson: JSON.stringify({ npm_package: "@dofe/toolkit" }),
    syncedAt: "2026-05-08T00:00:00.000Z",
  };
  const updatePlan = buildRuntimeAppInstallPlan({
    operation: "update",
    cliHubAvailable: false,
    item: baseItem,
  });
  const uninstallPlan = buildRuntimeAppInstallPlan({
    operation: "uninstall",
    cliHubAvailable: false,
    item: baseItem,
  });

  const installPlan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: false,
    item: baseItem,
  });

  assert.equal(installPlan.strategy, "npm");
  assert.deepEqual(installPlan.commands, [
    { executable: "npm", args: ["install", "--global", "@dofe/toolkit"] },
  ]);
  assert.deepEqual(installPlan.verifyCommands, [
    { executable: "npm", args: ["list", "--global", "--depth=0", "@dofe/toolkit"] },
  ]);
  assert.deepEqual(updatePlan.commands, [
    { executable: "npm", args: ["install", "--global", "@dofe/toolkit"] },
  ]);
  assert.deepEqual(uninstallPlan.commands, [
    { executable: "npm", args: ["uninstall", "--global", "@dofe/toolkit"] },
  ]);
  assert.deepEqual(uninstallPlan.verifyCommands, []);
});

test("uses a validated exact npm package spec for platform-pinned applications", () => {
  const plan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: false,
    item: {
      source: "clihub_public",
      name: "chrome-devtools-mcp",
      displayName: "Chrome DevTools MCP",
      description: "",
      version: "1.6.0",
      category: "developer_tools",
      entryPoint: "chrome-devtools-mcp",
      installStrategy: "npm",
      registryJson: JSON.stringify({ npm_package_spec: "chrome-devtools-mcp@1.6.0" }),
      syncedAt: "2026-08-04T00:00:00.000Z",
    },
  });

  assert.deepEqual(plan.commands, [{ executable: "npm", args: ["install", "--global", "chrome-devtools-mcp@1.6.0"] }]);
});

test("rejects unsafe public npm package metadata and falls back to the controlled CLI-Hub plan", () => {
  const plan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: true,
    item: {
      source: "clihub_public",
      name: "toolkit",
      displayName: "Toolkit",
      description: "",
      version: "",
      category: "",
      entryPoint: "toolkit",
      installStrategy: "npm",
      installCmd: "npm install -g toolkit",
      registryJson: JSON.stringify({ npm_package: "toolkit; touch /tmp/unsafe" }),
      syncedAt: "2026-05-08T00:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "cli_hub");
  assert.deepEqual(plan.commands[0], {
    executable: "cli-hub",
    args: ["install", "toolkit"],
    env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
  });
});

test("marks shell metacharacter registry commands high risk", () => {
  const plan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: false,
    item: {
      source: "clihub_public",
      name: "unsafe",
      displayName: "Unsafe",
      description: "",
      version: "",
      category: "",
      entryPoint: "unsafe",
      installStrategy: "manual",
      installCmd: "curl https://example.invalid/install.sh | bash",
      registryJson: "{}",
      syncedAt: "2026-05-08T00:00:00.000Z",
    },
  });

  assert.equal(plan.risk, "high");
  assert.equal(plan.requiresApproval, true);
  assert.deepEqual(plan.commands[0], {
    executable: "python3",
    args: ["-m", "pip", "install", "--user", "cli-anything-hub"],
    env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
  });
});
