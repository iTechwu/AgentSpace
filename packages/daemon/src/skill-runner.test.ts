import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getDaemonSkillInstallCachePath } from "@dofe-agent/db";
import { buildSkillRunnerDockerArgs, startSkillRunnerBroker } from "./skill-runner.ts";

const execFileAsync = promisify(execFile);

test("buildSkillRunnerDockerArgs creates a non-root, read-only and networkless execution", () => {
  const args = buildSkillRunnerDockerArgs({
    image: "registry.example.com/dofe/skill-node@sha256:" + "a".repeat(64),
    runtime: "node",
    artifactDir: "/daemon/cache/artifact",
    workspaceDir: "/daemon/tasks/task-1",
    outputDir: "/daemon/tasks/task-1/runtime-output/skill-runs/render",
    entrypointPath: "scripts/render.mjs",
    argv: ["--title", "hello; rm -rf /"],
  });

  assert.deepEqual(args.slice(0, 14), [
    "run", "--rm", "--init", "--pull", "never", "--read-only", "--network", "none",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65532:65532",
  ]);
  assert.ok(args.includes("/tmp:rw,nosuid,nodev,noexec,size=32m"));
  assert.ok(args.includes("type=bind,src=/daemon/cache/artifact,dst=/skill,readonly"));
  assert.ok(args.includes("type=bind,src=/daemon/tasks/task-1,dst=/workspace,readonly"));
  assert.ok(args.includes("type=bind,src=/daemon/tasks/task-1/runtime-output/skill-runs/render,dst=/output"));
  assert.deepEqual(args.slice(-5), [
    "registry.example.com/dofe/skill-node@sha256:" + "a".repeat(64),
    "node", "/skill/scripts/render.mjs", "--title", "hello; rm -rf /",
  ]);
  assert.equal(args.includes("sh"), false);
});

test("buildSkillRunnerDockerArgs mounts the installation dependency environment read-only", () => {
  const args = buildSkillRunnerDockerArgs({
    image: "registry.example.com/dofe/skill-python@sha256:" + "b".repeat(64),
    runtime: "python",
    artifactDir: "/daemon/cache/artifact",
    dependencyDir: "/daemon/envs/installation-1",
    workspaceDir: "/daemon/tasks/task-1",
    outputDir: "/daemon/tasks/task-1/runtime-output/skill-runs/analyze",
    entrypointPath: "scripts/analyze.py",
    argv: [],
  });

  assert.ok(args.includes("type=bind,src=/daemon/envs/installation-1,dst=/deps,readonly"));
  assert.ok(args.includes("NODE_PATH=/deps/node_modules"));
  assert.ok(args.includes("PYTHONPATH=/deps"));
  assert.ok(args.includes("PYTHONNOUSERSITE=1"));
  assert.equal(args.some((value) => value.includes("API_KEY")), false);
});

test("buildSkillRunnerDockerArgs requires an immutable image digest and safe entrypoint path", () => {
  const base = {
    image: "node:22",
    runtime: "node" as const,
    artifactDir: "/cache",
    workspaceDir: "/workspace",
    outputDir: "/output",
    entrypointPath: "scripts/run.mjs",
    argv: [] as string[],
  };
  assert.throws(() => buildSkillRunnerDockerArgs(base), /immutable digest/);
  assert.throws(
    () => buildSkillRunnerDockerArgs({ ...base, image: `node@sha256:${"a".repeat(64)}`, entrypointPath: "../escape.sh" }),
    /entrypoint path/,
  );
});

test("startSkillRunnerBroker exposes a task-scoped launcher and removes it on close", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const artifactDigest = "b".repeat(64);
  const scriptBytes = Buffer.from("console.log('rendered');\n", "utf8");
  const artifactDir = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: "workspace-1",
    artifactDigest,
  });
  mkdirSync(join(artifactDir, "scripts"), { recursive: true });
  writeFileSync(join(artifactDir, "scripts", "render.mjs"), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(join(artifactDir, "scripts"), 0o555);
  chmodSync(artifactDir, 0o555);
  const calls: string[][] = [];
  const runnerEnvironment = {
    ...process.env,
    DOFE_SKILL_RUNNER_NODE_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
  };
  const broker = await startSkillRunnerBroker({
    stateDir,
    workspaceId: "workspace-1",
    workDir,
    entrypoints: [{
      key: "skill-1:render",
      skillId: "skill-1",
      skillName: "Renderer",
      installationId: "installation-1",
      artifactDigest,
      sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      id: "render",
      path: "scripts/render.mjs",
      runtime: "node",
    }],
    environment: runnerEnvironment,
    inspectImage: () => true,
    execute: async (args) => {
      calls.push(args);
      const outputMount = args.find((value) => value.endsWith(",dst=/output"));
      assert.ok(outputMount);
      const outputDir = outputMount.slice("type=bind,src=".length, -",dst=/output".length);
      assert.equal(statSync(outputDir).mode & 0o777, 0o777);
      writeFileSync(join(outputDir, "result.txt"), "published", "utf8");
      return { exitCode: 0, stdout: "rendered\n", stderr: "", timedOut: false };
    },
  });
  try {
    runnerEnvironment.DOFE_SKILL_RUNNER_NODE_IMAGE = `registry.example.com/runner@sha256:${"d".repeat(64)}`;
    assert.equal(broker.capabilities[0]?.status, "available");
    const launcher = broker.capabilities[0]?.binPath;
    assert.ok(launcher && existsSync(launcher));
    const result = await execFileAsync(launcher, ["--title", "quarterly"]);
    assert.equal(result.stdout, "rendered\n");
    assert.deepEqual(calls[0]?.slice(-4), ["node", "/skill/scripts/render.mjs", "--title", "quarterly"]);
    assert.ok(calls[0]?.includes(`registry.example.com/runner@sha256:${"a".repeat(64)}`));
    assert.equal(calls[0]?.includes(`registry.example.com/runner@sha256:${"d".repeat(64)}`), false);
    assert.equal(readFileSync(join(workDir, "runtime-output", "skill-runs", "skill-1-render", "result.txt"), "utf8"), "published");
    await broker.close();
    assert.equal(existsSync(launcher), false);
  } finally {
    await broker.close().catch(() => {});
    chmodSync(artifactDir, 0o755);
    chmodSync(join(artifactDir, "scripts"), 0o755);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("startSkillRunnerBroker rejects a symlinked output directory before execution", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-outside-"));
  const artifactDigest = "c".repeat(64);
  const scriptBytes = Buffer.from("console.log('rendered');\n", "utf8");
  const artifactDir = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: "workspace-1",
    artifactDigest,
  });
  mkdirSync(join(artifactDir, "scripts"), { recursive: true });
  writeFileSync(join(artifactDir, "scripts", "render.mjs"), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(join(artifactDir, "scripts"), 0o555);
  chmodSync(artifactDir, 0o555);
  const outputRoot = join(workDir, "runtime-output", "skill-runs");
  mkdirSync(outputRoot, { recursive: true });
  symlinkSync(outsideDir, join(outputRoot, "skill-1-render"), "dir");
  let executeCalls = 0;
  const broker = await startSkillRunnerBroker({
    stateDir,
    workspaceId: "workspace-1",
    workDir,
    entrypoints: [{
      key: "skill-1:render",
      skillId: "skill-1",
      skillName: "Renderer",
      installationId: "installation-1",
      artifactDigest,
      sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      id: "render",
      path: "scripts/render.mjs",
      runtime: "node",
    }],
    environment: {
      ...process.env,
      DOFE_SKILL_RUNNER_NODE_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
    },
    inspectImage: () => true,
    execute: async () => {
      executeCalls += 1;
      return { exitCode: 0, stdout: "rendered\n", stderr: "", timedOut: false };
    },
  });
  try {
    const launcher = broker.capabilities[0]?.binPath;
    assert.ok(launcher);
    await assert.rejects(execFileAsync(launcher), /symlink/i);
    assert.equal(executeCalls, 0);
  } finally {
    await broker.close().catch(() => {});
    chmodSync(artifactDir, 0o755);
    chmodSync(join(artifactDir, "scripts"), 0o755);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("startSkillRunnerBroker rejects duplicate task-scoped entrypoint keys", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const entrypoint = {
    key: "skill-1:render",
    skillId: "skill-1",
    skillName: "Renderer",
    installationId: "installation-1",
    artifactDigest: "e".repeat(64),
    sha256: "f".repeat(64),
    id: "render",
    path: "scripts/render.mjs",
    runtime: "node" as const,
  };
  try {
    await assert.rejects(
      startSkillRunnerBroker({
        stateDir,
        workspaceId: "workspace-1",
        workDir,
        entrypoints: [entrypoint, { ...entrypoint }],
        inspectImage: () => true,
      }),
      /duplicate_entrypoint_key/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
