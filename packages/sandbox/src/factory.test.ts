import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LEGACY_SANDBOX_PROVIDER_ENV, SANDBOX_PROVIDER_ENV, connectSandbox } from "./factory.ts";
import { LocalSandbox } from "./local/local-sandbox.ts";

test("connectSandbox defaults to the local provider", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "dofe-agent-sandbox-local-"));

  try {
    const sandbox = await connectSandbox({
      runtimeId: "runtime-local",
      workDir,
      env: {},
    });

    assert.ok(sandbox instanceof LocalSandbox);
    assert.equal(sandbox.status, "active");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("connectSandbox accepts an explicit local provider via env", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "dofe-agent-sandbox-explicit-"));

  try {
    for (const envName of [SANDBOX_PROVIDER_ENV, LEGACY_SANDBOX_PROVIDER_ENV]) {
      const sandbox = await connectSandbox({
        runtimeId: "runtime-explicit",
        workDir,
        env: { [envName]: "local" },
      });
      assert.ok(sandbox instanceof LocalSandbox);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// 3.5-5：cube 分支移除后 fail-closed——非 local provider 立即报错，
// 绝不落到半可用实现（旧版双开关打开会真实创建云沙箱后 exec 必抛）。
test("connectSandbox rejects non-local providers instead of falling back", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "dofe-agent-sandbox-reject-"));

  try {
    await assert.rejects(
      () => connectSandbox({ runtimeId: "runtime-cube", workDir, env: { [SANDBOX_PROVIDER_ENV]: "cube" } }),
      /Unsupported sandbox provider "cube". Only "local"/,
    );
    await assert.rejects(
      () => connectSandbox({ runtimeId: "runtime-e2b", workDir, provider: "e2b" as never }),
      /Unsupported sandbox provider "e2b"/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
