import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeAppInstallPlan } from "./install-plan.ts";
import { normalizeCliHubRegistryPayload, syncCliHubCatalog } from "./catalog.ts";

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
  assert.deepEqual(plan.commands, [{ executable: "cli-hub", args: ["install", "gimp"] }]);
  assert.equal(plan.verifyCommands.some((command) => command.executable === "cli-anything-gimp"), true);
  assert.equal(plan.risk, "medium");
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

  assert.deepEqual(plan.commands, [{ executable: "cli-hub", args: ["uninstall", "mermaid"] }]);
  assert.deepEqual(plan.verifyCommands, []);
});

test("bootstraps cli-hub before update and uninstall when readiness is missing", () => {
  const baseItem = {
    source: "clihub_public" as const,
    name: "toolkit",
    displayName: "Toolkit",
    description: "",
    version: "",
    category: "",
    entryPoint: "toolkit",
    installStrategy: "npm" as const,
    registryJson: "{}",
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

  assert.deepEqual(updatePlan.commands, [
    { executable: "python3", args: ["-m", "pip", "install", "--user", "cli-anything-hub"] },
    { executable: "cli-hub", args: ["update", "toolkit"] },
  ]);
  assert.deepEqual(uninstallPlan.commands, [
    { executable: "python3", args: ["-m", "pip", "install", "--user", "cli-anything-hub"] },
    { executable: "cli-hub", args: ["uninstall", "toolkit"] },
  ]);
  assert.deepEqual(uninstallPlan.verifyCommands, []);
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
  assert.deepEqual(plan.commands[0], { executable: "python3", args: ["-m", "pip", "install", "--user", "cli-anything-hub"] });
});
