import assert from "node:assert/strict";
import test from "node:test";
import { assessRuntimeAppInstallability, buildRuntimeAppInstallPlan } from "./install-plan.ts";
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

test("corrects the broken Hacker Feeds Python harness to its working npm package", () => {
  const items = normalizeCliHubRegistryPayload(
    "clihub_harness",
    [{
      name: "hacker-feeds-cli",
      display_name: "Hacker Feeds CLI",
      install_cmd: "pip install git+https://github.com/collectivewinca/hacker-feeds-cli.git",
      entry_point: "cli-anything-hacker-feeds-cli",
    }],
    "2026-08-04T00:00:00.000Z",
  );

  assert.equal(items[0]?.installStrategy, "npm");
  assert.equal(items[0]?.installCmd, "npm install -g hacker-feeds-cli");
  assert.equal(items[0]?.entryPoint, "hf");
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

test("syncs harness registry from fallback URL when the primary URL is unavailable", async () => {
  const requestedUrls: string[] = [];
  const result = await syncCliHubCatalog({
    now: new Date("2026-05-08T00:00:00.000Z"),
    upsertItemsSync: (items) => items.length,
    readHealthSync: () => ({ itemCount: 1, lastSyncedAt: "2026-05-08T00:00:00.000Z", stale: false }),
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      requestedUrls.push(requestedUrl);
      if (requestedUrl === "https://hkuds.github.io/CLI-Anything/registry.json") {
        return new Response("unavailable", { status: 503, statusText: "Unavailable" });
      }
      if (requestedUrl.endsWith("/public_registry.json")) {
        return jsonResponse({ clis: [] });
      }
      return jsonResponse({ clis: [{ name: "mermaid", version: "1.0.0", install_cmd: "pip install mermaid-cli" }] });
    },
  });

  assert.equal(result.status, "fresh");
  assert.equal(result.errors.length, 0);
  assert.equal(requestedUrls.includes("https://raw.githubusercontent.com/HKUDS/CLI-Anything/main/registry.json"), true);
});

test("builds controlled cli-hub plans without executing registry shell strings", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
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
      installCmd: `pip install git+https://github.com/example/repo.git@${commit}#subdirectory=gimp`,
      skillMd: "skills/gimp/SKILL.md",
      requiresText: "Python 3.10+",
      registryJson: JSON.stringify({ name: "gimp", install_cmd: `pip install git+https://github.com/example/repo.git@${commit}#subdirectory=gimp` }),
      syncedAt: "2026-05-08T00:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "cli_hub");
  assert.deepEqual(plan.commands, [{
    executable: "cli-hub",
    args: ["install", "gimp"],
    env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
  }]);
  assert.deepEqual(plan.cliHubRegistrySnapshot, {
    source: "clihub_harness",
    registryJson: JSON.stringify({ name: "gimp", install_cmd: `pip install https://codeload.github.com/example/repo/zip/${commit}#subdirectory=gimp` }),
  });
  assert.equal(plan.verifyCommands.some((command) => command.executable === "cli-anything-gimp"), true);
  assert.equal(plan.risk, "low");
});

test("rewrites exact GitHub pip VCS installs to codeload archives for unstable container egress", () => {
  const commit = "fedcba9876543210fedcba9876543210fedcba98";
  const plan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: true,
    item: {
      source: "clihub_harness",
      name: "archive-backed-cli",
      displayName: "Archive-backed CLI",
      description: "Feeds",
      version: "1.0.0",
      category: "search",
      entryPoint: "archive-backed-cli",
      installStrategy: "cli_hub",
      installCmd: `pip install git+https://github.com/example/archive-backed-cli.git@${commit}`,
      registryJson: JSON.stringify({
        name: "archive-backed-cli",
        install_cmd: `pip install git+https://github.com/example/archive-backed-cli.git@${commit}`,
      }),
      syncedAt: "2026-08-04T00:00:00.000Z",
    },
  });

  assert.deepEqual(JSON.parse(plan.cliHubRegistrySnapshot?.registryJson ?? "{}"), {
    name: "archive-backed-cli",
    install_cmd: `pip install https://codeload.github.com/example/archive-backed-cli/zip/${commit}`,
  });
});

test("installs the known Hacker Feeds compatibility package with its real entry point", () => {
  const plan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: true,
    item: {
      source: "clihub_harness",
      name: "hacker-feeds-cli",
      displayName: "Hacker Feeds CLI",
      description: "Feeds",
      version: "1.0.0",
      category: "search",
      entryPoint: "cli-anything-hacker-feeds-cli",
      installStrategy: "pip",
      installCmd: "pip install git+https://github.com/collectivewinca/hacker-feeds-cli.git",
      registryJson: JSON.stringify({ name: "hacker-feeds-cli" }),
      syncedAt: "2026-08-04T00:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "npm");
  assert.equal(plan.app.entryPoint, "hf");
  assert.deepEqual(plan.commands, [{ executable: "npm", args: ["install", "--global", "hacker-feeds-cli"] }]);
  assert.deepEqual(plan.verifyCommands, [
    { executable: "npm", args: ["list", "--global", "--depth=0", "hacker-feeds-cli"] },
    { executable: "which", args: ["hf"] },
  ]);
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
    version: "2.3.4",
    category: "",
    entryPoint: "toolkit",
    installStrategy: "npm" as const,
    installCmd: "npm install -g @dofe/toolkit@2.3.4",
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
    { executable: "npm", args: ["install", "--global", "@dofe/toolkit@2.3.4"] },
  ]);
  assert.deepEqual(installPlan.verifyCommands, [
    { executable: "npm", args: ["list", "--global", "--depth=0", "@dofe/toolkit@2.3.4"] },
    { executable: "which", args: ["toolkit"] },
  ]);
  assert.deepEqual(updatePlan.commands, [
    { executable: "npm", args: ["install", "--global", "@dofe/toolkit@2.3.4"] },
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
      installCmd: "npm install --global chrome-devtools-mcp@1.6.0",
      registryJson: JSON.stringify({ npm_package_spec: "chrome-devtools-mcp@1.6.0" }),
      syncedAt: "2026-08-04T00:00:00.000Z",
    },
  });

  assert.deepEqual(plan.commands, [{ executable: "npm", args: ["install", "--global", "chrome-devtools-mcp@1.6.0"] }]);
});

test("uses a validated exact PyPI package spec without starting the MCP server during verification", () => {
  const plan = buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: true,
    item: {
      source: "clihub_public",
      name: "minimax-coding-plan-mcp",
      displayName: "MiniMax Token Plan MCP",
      description: "",
      version: "0.0.4",
      category: "search",
      entryPoint: "minimax-coding-plan-mcp",
      installStrategy: "pip",
      installCmd: "python3 -m pip install --user minimax-coding-plan-mcp==0.0.4",
      registryJson: JSON.stringify({ pypi_package_spec: "minimax-coding-plan-mcp==0.0.4" }),
      syncedAt: "2026-08-04T00:00:00.000Z",
    },
  });

  assert.equal(plan.strategy, "pip");
  assert.deepEqual(plan.commands, [{
    executable: "python3",
    args: ["-m", "pip", "install", "--user", "minimax-coding-plan-mcp==0.0.4"],
    env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
  }]);
  assert.deepEqual(plan.verifyCommands, [
    {
      executable: "python3",
      args: ["-m", "pip", "show", "minimax-coding-plan-mcp"],
      env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
    },
    { executable: "which", args: ["minimax-coding-plan-mcp"] },
  ]);
});

test("rejects unsafe public npm package metadata when no pinned fallback exists", () => {
  assert.throws(() => buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: true,
    item: {
      source: "clihub_public",
      name: "toolkit",
      displayName: "Toolkit",
      description: "",
      version: "1.0.0",
      category: "",
      entryPoint: "toolkit",
      installStrategy: "npm",
      installCmd: "npm install -g toolkit",
      registryJson: JSON.stringify({ npm_package: "toolkit; touch /tmp/unsafe" }),
      syncedAt: "2026-05-08T00:00:00.000Z",
    },
  }), /runtime_app[.]install_artifact_unpinned/);
});

test("blocks shell metacharacter registry commands instead of allowing confirmation", () => {
  assert.throws(() => buildRuntimeAppInstallPlan({
    operation: "install",
    cliHubAvailable: false,
    item: {
      source: "clihub_public",
      name: "unsafe",
      displayName: "Unsafe",
      description: "",
      version: "1.0.0",
      category: "",
      entryPoint: "unsafe",
      installStrategy: "manual",
      installCmd: "curl https://example.invalid/install.sh | bash",
      registryJson: "{}",
      syncedAt: "2026-05-08T00:00:00.000Z",
    },
  }), /runtime_app[.]install_command_unsafe/);
});

test("reports stable preflight reasons for mutable and runtime-incompatible releases", () => {
  const baseItem = {
    source: "clihub_public" as const,
    name: "toolkit",
    displayName: "Toolkit",
    description: "",
    version: "latest",
    category: "developer_tools",
    entryPoint: "toolkit",
    installStrategy: "npm" as const,
    installCmd: "npm install -g toolkit",
    registryJson: JSON.stringify({ npm_package: "toolkit" }),
    syncedAt: "2026-08-05T00:00:00.000Z",
  };

  assert.deepEqual(assessRuntimeAppInstallability(baseItem), {
    status: "unsupported",
    code: "runtime_app.release_unpinned",
    requiredTools: [],
  });
  assert.equal(assessRuntimeAppInstallability({
    ...baseItem,
    version: "1.2.3",
    installCmd: "npm install -g toolkit@1.2.3",
    requiresText: "Desktop app installed locally",
  }).code, "runtime_app.runtime_dependency_unsupported");
  assert.deepEqual(assessRuntimeAppInstallability({
    ...baseItem,
    version: "1.2.3",
    installCmd: "npm install -g toolkit@1.2.3",
  }, {
    npm: { available: false },
    python: { available: true },
    pip: { available: true },
    cliHub: { available: true },
  }), {
    status: "needs_configuration",
    code: "runtime_app.runtime_npm_unavailable",
    requiredTools: ["npm"],
  });
  assert.equal(assessRuntimeAppInstallability({
    ...baseItem,
    version: "1.2.3",
    source: "clihub_harness",
    installStrategy: "cli_hub",
    installCmd: "python exploit.py toolkit@1.2.3",
  }).code, "runtime_app.install_artifact_unpinned");
});
