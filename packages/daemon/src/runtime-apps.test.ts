import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeDirectoryDigestSync, executeRuntimeAppPlan } from "./runtime-apps.ts";
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
    "--env", "HOME=/dofe-home",
    "--env", "PATH=/dofe-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env", "PIP_BREAK_SYSTEM_PACKAGES=1",
    "--entrypoint", "python3",
    "dofe/agent-runtime-codex:test",
    "-m", "pip", "install", "--user", "cli-anything-hub",
  ]);
  assert.equal(plan.verifyCommands[0]?.args.includes("--entrypoint"), true);
  assert.equal(plan.verifyCommands[0]?.args.includes("cli-anything-blender"), true);
});
