import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekJsonRpcWorker, isDeepSeekBoundedWorkerEnabled, mintDeepSeekSessionId } from "./deepseek-jsonrpc-worker.ts";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

const FAKE_RUNTIME = [
  "#!/usr/bin/env node",
  "const readline = require('node:readline');",
  "const rl = readline.createInterface({ input: process.stdin });",
  "rl.on('line', (line) => {",
  "  const req = JSON.parse(line);",
  "  if (req.method === 'initialize') {",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }, protocolVersion: '2.0' } }));",
  "  } else if (req.method === 'session/prompt') {",
  "    const sid = req.params.sessionId;",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { messageId: 'msg-' + sid } }));",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: sid, status: 'running' } }));",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: sid, event: { type: 'assistant/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: 'reply-' + sid }] } } } } }));",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: sid, status: 'idle' } }));",
  "  } else if (req.method === 'session/resume') {",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: req.params.sessionId, resumed: true } }));",
  "  } else if (req.method === 'session/close') {",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: req.params.sessionId, closed: true } }));",
  "  } else if (req.method === 'shutdown') {",
  "    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }));",
  "    process.exit(0);",
  "  }",
  "});",
].join("\n");

test("DeepSeekJsonRpcWorker reuses one runtime process across sessions and recovers fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dofe-jsonrpc-worker-"));
  const executable = join(dir, "dsh-jsonrpc-agent");
  writeExecutable(executable, FAKE_RUNTIME);
  const worker = new DeepSeekJsonRpcWorker({
    executablePath: executable,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", DEEPSEEK_API_KEY: "task-key" },
    model: "deepseek-v4-flash",
    maxSessions: 2,
  });

  try {
    await worker.start();
    const first = await worker.runSession(mintDeepSeekSessionId(), "hello", { DEEPSEEK_API_KEY: "key-a", MY_SKILL: "skill-a" });
    const second = await worker.runSession(mintDeepSeekSessionId(), "world", { DEEPSEEK_API_KEY: "key-b", MY_SKILL: "skill-b" });
    assert.match(first, /^reply-dofe-task-/);
    assert.match(second, /^reply-dofe-task-/);
    assert.notEqual(first, second);

    await worker.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DeepSeekJsonRpcWorker rejects a third session at its bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dofe-jsonrpc-worker-bound-"));
  const executable = join(dir, "dsh-jsonrpc-agent");
  writeExecutable(executable, FAKE_RUNTIME);
  const worker = new DeepSeekJsonRpcWorker({
    executablePath: executable,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    model: "deepseek-v4-pro",
    maxSessions: 2,
  });

  try {
    await worker.start();
    const p1 = worker.runSession(mintDeepSeekSessionId(), "a");
    const p2 = worker.runSession(mintDeepSeekSessionId(), "b");
    await assert.rejects(
      worker.runSession(mintDeepSeekSessionId(), "c"),
      /at its session bound/,
    );
    await Promise.all([p1, p2]);
    await worker.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DeepSeekJsonRpcWorker resumes a persisted session (provider session mapping)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dofe-jsonrpc-worker-resume-"));
  const executable = join(dir, "dsh-jsonrpc-agent");
  writeExecutable(executable, FAKE_RUNTIME);
  const worker = new DeepSeekJsonRpcWorker({
    executablePath: executable,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    model: "deepseek-v4-flash",
    maxSessions: 2,
  });

  try {
    await worker.start();
    const sessionId = "dofe-provider-session-1";
    await worker.resumeSession(sessionId);
    const output = await worker.runSession(sessionId, "continue");
    assert.equal(output, "reply-dofe-provider-session-1");
    await worker.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isDeepSeekBoundedWorkerEnabled defaults off and requires strict 1", () => {
  assert.equal(isDeepSeekBoundedWorkerEnabled({}), false);
  assert.equal(isDeepSeekBoundedWorkerEnabled({ DOFE_AGENT_DEEPSEEK_BOUNDED_WORKER_ENABLED: "0" }), false);
  assert.equal(isDeepSeekBoundedWorkerEnabled({ DOFE_AGENT_DEEPSEEK_BOUNDED_WORKER_ENABLED: "true" }), false);
  assert.equal(isDeepSeekBoundedWorkerEnabled({ DOFE_AGENT_DEEPSEEK_BOUNDED_WORKER_ENABLED: "1" }), true);
});
