import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeDirectoryDigestSync,
  executeRuntimeAppPlan,
  readCliHubReadiness,
  resolveRuntimeAppCommandTimeoutMs,
  resolveRuntimeAppRegistryEnvironment,
} from "./runtime-apps.ts";
import * as runtimeApps from "./runtime-apps.ts";

function sha256(...parts: Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

test("computeDirectoryDigestSync hashes the tree deterministically (path + bytes, sorted)", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-sri-"));
  mkdirSync(join(root, "deps", "npm", "pkg"), { recursive: true });
  writeFileSync(join(root, "deps", "npm", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, "deps", "npm", "pkg", "package.json"), "{\"name\":\"pkg\"}\n");
  writeFileSync(join(root, "deps", "npm", ".lock"), "lockfile");

  const digest = computeDirectoryDigestSync(join(root, "deps", "npm"));
  // Deterministic: files are hashed in sorted order, path + \0 + bytes; directories contribute no separate hash.
  const expected = sha256(
    Buffer.from(".lock\0"),
    Buffer.from("lockfile"),
    Buffer.from("pkg/index.js\0"),
    Buffer.from("module.exports = 1;\n"),
    Buffer.from("pkg/package.json\0"),
    Buffer.from('{"name":"pkg"}\n'),
  );
  assert.equal(digest, expected);
});

test("computeDirectoryDigestSync returns undefined for a missing directory", () => {
  assert.equal(computeDirectoryDigestSync("/nonexistent/dofe-sri-path"), undefined);
});

test("executeRuntimeAppPlan records the download digest over the plan's depsDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-sri-"));
  mkdirSync(join(root, "deps", "pip"), { recursive: true });
  writeFileSync(join(root, "deps", "pip", "requests.py"), "print('requests')\n");

  const result = await executeRuntimeAppPlan(
    {
      app: { source: "skill_dependency", name: "dep-1", version: "1.0.0", entryPoint: "" },
      strategy: "pip",
      commands: [],
      verifyCommands: [],
      risk: "medium",
      requiresApproval: true,
      notes: [],
      depsDir: "deps/pip",
    },
    { cwd: root },
  );

  const expected = sha256(
    Buffer.from("requests.py\0"),
    Buffer.from("print('requests')\n"),
  );
  assert.equal(result.downloadedDigest, expected);
});

test("executeRuntimeAppPlan seeds synchronized CLI-Hub registry snapshots into Runtime HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-cli-hub-cache-"));
  const runtimeHomeDir = join(root, "runtime-home");
  const runtimeBinDir = join(runtimeHomeDir, ".local", "bin");
  mkdirSync(runtimeBinDir, { recursive: true });
  const cliHubPath = join(runtimeBinDir, "cli-hub");
  writeFileSync(cliHubPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(cliHubPath, 0o755);

  try {
    await executeRuntimeAppPlan({
      app: { source: "clihub_harness", name: "hacker-feeds-cli", version: "1.0.0", entryPoint: "cli-anything-hacker-feeds-cli" },
      strategy: "cli_hub",
      commands: [{ executable: "cli-hub", args: ["install", "hacker-feeds-cli"] }],
      verifyCommands: [],
      risk: "low",
      requiresApproval: true,
      notes: [],
      cliHubRegistrySnapshot: {
        source: "clihub_harness",
        registryJson: JSON.stringify({ name: "hacker-feeds-cli", install_cmd: "pip install hacker-feeds-cli" }),
      },
    }, { runtimeHomeDir });

    const harnessCache = JSON.parse(readFileSync(join(runtimeHomeDir, ".cli-hub", "registry_cache.json"), "utf8"));
    const publicCache = JSON.parse(readFileSync(join(runtimeHomeDir, ".cli-hub", "public_registry_cache.json"), "utf8"));
    assert.equal(harnessCache.data.clis[0]?.name, "hacker-feeds-cli");
    assert.deepEqual(publicCache.data.clis, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed runtime app plans execute inside the target provider image", () => {
  const buildManagedRuntimeAppPlan = Reflect.get(runtimeApps, "buildManagedRuntimeAppPlan");
  assert.equal(typeof buildManagedRuntimeAppPlan, "function");
  if (typeof buildManagedRuntimeAppPlan !== "function") return;

  const plan = buildManagedRuntimeAppPlan(
    {
      app: { source: "clihub_harness", name: "blender", version: "1.0.0", entryPoint: "cli-anything-blender" },
      strategy: "pip",
      commands: [{
        executable: "python3",
        args: ["-m", "pip", "install", "--user", "cli-anything-hub"],
        env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
      }],
      verifyCommands: [{ executable: "cli-anything-blender", args: ["--help"] }],
      risk: "low",
      requiresApproval: true,
      notes: [],
    },
    {
      image: "dofe/agent-runtime-codex:test",
      runtimeHomeDir: "/state/managed-runtimes/runtime-codex/home",
      depsRoot: "/state/workspaces/ws/runtime-app-deps",
      dockerNetwork: "dofe-models-egress",
      dockerConnectivityArgs: ["--add-host", "model.local:host-gateway"],
      registryEnvironment: {
        NPM_CONFIG_REGISTRY: "https://npm.example.com/",
        PIP_INDEX_URL: "https://pypi.example.com/simple",
      },
      user: "10001:10001",
    },
  );

  assert.equal(plan.commands[0]?.executable, "docker");
  assert.deepEqual(plan.commands[0]?.args, [
    "run", "--rm", "--init", "--pull", "never", "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--add-host", "model.local:host-gateway",
    "--network", "dofe-models-egress", "--user", "10001:10001",
    "--mount", "type=bind,src=/state/managed-runtimes/runtime-codex/home,dst=/dofe-home",
    "--mount", "type=bind,src=/state/workspaces/ws/runtime-app-deps,dst=/runtime-app-deps",
    "--workdir", "/runtime-app-deps",
    "--env", "PIP_BREAK_SYSTEM_PACKAGES=1",
    "--env", "NPM_CONFIG_REGISTRY=https://npm.example.com/",
    "--env", "PIP_INDEX_URL=https://pypi.example.com/simple",
    "--env", "HOME=/dofe-home",
    "--env", "PYTHONUSERBASE=/dofe-home/.local",
    "--env", "NPM_CONFIG_PREFIX=/dofe-home/.local",
    "--env", "PATH=/dofe-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--entrypoint", "python3",
    "dofe/agent-runtime-codex:test",
    "-m", "pip", "install", "--user", "cli-anything-hub",
  ]);
  assert.equal(plan.verifyCommands[0]?.args.includes("--entrypoint"), true);
  assert.equal(plan.verifyCommands[0]?.args.includes("cli-anything-blender"), true);
});

test("runtime app registries are validated and required for enforced egress", () => {
  assert.deepEqual(resolveRuntimeAppRegistryEnvironment({
    DOFE_AGENT_NPM_REGISTRY: "https://npm.example.com",
    DOFE_AGENT_PYPI_INDEX_URL: "https://pypi.example.com/simple",
  }), {
    NPM_CONFIG_REGISTRY: "https://npm.example.com/",
    PIP_INDEX_URL: "https://pypi.example.com/simple",
    UV_DEFAULT_INDEX: "https://pypi.example.com/simple",
  });
  assert.throws(() => resolveRuntimeAppRegistryEnvironment({
    MCP_EGRESS_ENFORCE: "true",
  }), /controlled_registries_required/);
  assert.throws(() => resolveRuntimeAppRegistryEnvironment({
    DOFE_AGENT_NPM_REGISTRY: "http://npm.example.com",
  }), /npm_registry_invalid/);
});

test("runtime app command timeout has an operational default and bounded override", () => {
  assert.equal(resolveRuntimeAppCommandTimeoutMs({}), 10 * 60 * 1000);
  assert.equal(resolveRuntimeAppCommandTimeoutMs({ DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS: "" }), 10 * 60 * 1000);
  assert.equal(resolveRuntimeAppCommandTimeoutMs({ DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS: "invalid" }), 10 * 60 * 1000);
  assert.equal(resolveRuntimeAppCommandTimeoutMs({ DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(resolveRuntimeAppCommandTimeoutMs({ DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS: "1" }), 30_000);
  assert.equal(resolveRuntimeAppCommandTimeoutMs({ DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS: "99999999" }), 30 * 60 * 1000);
});

test("runtime app command failures do not expose the full command or host paths", async () => {
  await assert.rejects(
    executeRuntimeAppPlan({
      app: { source: "clihub_public", name: "broken", version: "1.0.0", entryPoint: "broken" },
      strategy: "pip",
      commands: [{ executable: "/bin/sh", args: ["-c", "echo safe-detail >&2; exit 7", "/private/host/runtime-home"] }],
      verifyCommands: [],
      risk: "low",
      requiresApproval: true,
      notes: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Runtime application command failed \(sh, exit code 7\)\. safe-detail/);
      assert.doesNotMatch(error.message, /private\/host|echo safe-detail|exit 7/);
      return true;
    },
  );
});

test("runtime app execution installs into the selected runtime private home", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-runtime-app-home-"));
  const runtimeHomeDir = join(root, "runtime-home");
  mkdirSync(runtimeHomeDir, { recursive: true });

  try {
    const result = await executeRuntimeAppPlan({
      app: { source: "clihub_public", name: "portable", version: "1.0.0", entryPoint: "portable" },
      strategy: "npm",
      commands: [{
        executable: "/bin/sh",
        args: ["-c", "printf '%s\\n%s\\n%s\\n%s\\n' \"$HOME\" \"$PYTHONUSERBASE\" \"$NPM_CONFIG_PREFIX\" \"$PATH\""],
        env: { HOME: "/untrusted", NPM_CONFIG_PREFIX: "/untrusted" },
      }],
      verifyCommands: [],
      risk: "low",
      requiresApproval: true,
      notes: [],
    }, { runtimeHomeDir });

    const runtimePrefix = join(runtimeHomeDir, ".local");
    assert.match(result.safeStdoutTail, new RegExp(runtimeHomeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.safeStdoutTail, new RegExp(runtimePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.safeStdoutTail, new RegExp(join(runtimePrefix, "bin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.safeStdoutTail, /untrusted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime app execution supports python fallback and platform-specific user scripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-runtime-app-platform-"));
  const binDir = join(root, "bin");
  const pythonUserBase = join(root, "Library", "Python", "3.12");
  const pythonUserBin = join(pythonUserBase, "bin");
  const originalPath = process.env.PATH;
  const originalPythonUserBase = process.env.FAKE_PYTHON_USER_BASE;
  mkdirSync(binDir, { recursive: true });
  mkdirSync(pythonUserBin, { recursive: true });
  writeFileSync(join(binDir, "python"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'Python 3.12.0'; exit 0; fi",
    "if [ \"$1\" = \"-c\" ]; then printf '%s\\n' \"$FAKE_PYTHON_USER_BASE\"; exit 0; fi",
    "exit 1",
    "",
  ].join("\n"));
  writeFileSync(join(pythonUserBin, "cli-hub"), "#!/bin/sh\necho 'cli-hub 1.0.0'\n");
  chmodSync(join(binDir, "python"), 0o755);
  chmodSync(join(pythonUserBin, "cli-hub"), 0o755);

  try {
    const stages: string[] = [];
    process.env.PATH = binDir;
    process.env.FAKE_PYTHON_USER_BASE = pythonUserBase;
    const result = await executeRuntimeAppPlan({
      app: { source: "clihub_harness", name: "portable", version: "1.0.0", entryPoint: "cli-hub" },
      strategy: "pip",
      commands: [{ executable: "python3", args: ["--version"] }],
      verifyCommands: [{ executable: "cli-hub", args: ["--version"] }],
      risk: "low",
      requiresApproval: true,
      notes: [],
    }, { onStage: (stage) => { stages.push(stage); } });
    const readiness = readCliHubReadiness();

    assert.match(result.safeStdoutTail, /Python 3\.12\.0/);
    assert.match(result.safeStdoutTail, /cli-hub 1\.0\.0/);
    assert.equal(readiness.python.available, true);
    assert.equal(readiness.cliHub.available, true);
    assert.deepEqual(stages, ["installing", "verifying"]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPythonUserBase === undefined) delete process.env.FAKE_PYTHON_USER_BASE;
    else process.env.FAKE_PYTHON_USER_BASE = originalPythonUserBase;
    rmSync(root, { recursive: true, force: true });
  }
});
