import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  detectAgentRouterHarnesses,
  listAgentRouterHarnesses,
  runAgentRouter,
  type AgentRouterEvent,
} from "./agent-router/index.ts";

test("listAgentRouterHarnesses exposes the MVP native harnesses", () => {
  assert.deepEqual(listAgentRouterHarnesses(), [
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex CLI" },
    { id: "antigravity", label: "Antigravity CLI" },
    { id: "opencode", label: "OpenCode" },
    { id: "openclaw", label: "OpenClaw" },
    { id: "hermes", label: "Hermes Agent" },
    { id: "deepseek-harness", label: "DeepSeek Harness" },
  ]);
});

test("detectAgentRouterHarnesses reports available and missing CLIs", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "agent-router-detect-"));
  const originalPath = process.env.PATH;

  try {
    writeExecutable(join(binDir, "claude"), "#!/bin/sh\necho claude 1.2.3\n");
    writeExecutable(join(binDir, "codex"), "#!/bin/sh\necho codex 4.5.6\n");
    writeExecutable(join(binDir, "agy"), "#!/bin/sh\necho agy 0.9.0\n");
    writeExecutable(join(binDir, "opencode"), "#!/bin/sh\necho opencode 0.3.0\n");
    writeExecutable(
      join(binDir, "hermes-agent"),
      "#!/bin/sh\nif [ \"$1\" = 'version' ]; then echo hermes 0.2.0; else echo unknown option >&2; exit 2; fi\n",
    );
    writeExecutable(join(binDir, "dsh"), "#!/bin/sh\necho dsh 0.1.1-rc.2\n");
    process.env.PATH = binDir;

    const detected = await detectAgentRouterHarnesses();
    assert.deepEqual(
      detected.harnesses.map((harness) => ({ id: harness.id, status: harness.status, version: harness.version })),
      [
        { id: "claude", status: "available", version: "claude 1.2.3" },
        { id: "codex", status: "available", version: "codex 4.5.6" },
        { id: "antigravity", status: "available", version: "agy 0.9.0" },
        { id: "opencode", status: "available", version: "opencode 0.3.0" },
        { id: "openclaw", status: "missing", version: undefined },
        { id: "hermes", status: "available", version: "hermes 0.2.0" },
        { id: "deepseek-harness", status: "available", version: "dsh 0.1.1-rc.2" },
      ],
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("detectAgentRouterHarnesses recognizes a standalone DeepSeek JSON-RPC runtime", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "agent-router-detect-deepseek-jsonrpc-"));
  const originalPath = process.env.PATH;

  try {
    writeExecutable(join(binDir, "dsh-jsonrpc-agent"), "#!/bin/sh\necho deepseek-jsonrpc 0.0.1\n");
    process.env.PATH = binDir;

    const detected = await detectAgentRouterHarnesses();
    const deepSeek = detected.harnesses.find((harness) => harness.id === "deepseek-harness");

    assert.equal(deepSeek?.status, "available");
    assert.equal(deepSeek?.version, "deepseek-jsonrpc 0.0.1");
    assert.equal(deepSeek?.path, join(binDir, "dsh-jsonrpc-agent"));
  } finally {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("runAgentRouter launches DeepSeek Harness headless with an isolated profile and model patch", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-harness-"));
  const binDir = join(workDir, "bin");
  const dshPath = join(binDir, "dsh");
  const argsPath = join(workDir, "dsh-args.txt");
  const homePath = join(workDir, "dsh-home.txt");
  const policyPath = join(workDir, "dsh-policy.txt");
  const patchCopyPath = join(workDir, "dsh-patch-copy.yml");

  try {
    writeExecutable(
      dshPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$DSH_ARGS_PATH\"",
        "printf '%s' \"$DSH_HOME\" > \"$DSH_HOME_PATH\"",
        "printf '%s\\n%s' \"$DSH_PERMISSION_MODE\" \"$DSH_TELEMETRY_DISABLED\" > \"$DSH_POLICY_PATH\"",
        "cat \"$4\" > \"$DSH_PATCH_COPY_PATH\"",
        "printf '%s\\n' 'deepseek harness output'",
      ].join("\n"),
    );

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "hello deepseek",
      cwd: workDir,
      executablePath: dshPath,
      model: "deepseek-v4-pro",
      env: {
        DSH_ARGS_PATH: argsPath,
        DSH_HOME_PATH: homePath,
        DSH_POLICY_PATH: policyPath,
        DSH_PATCH_COPY_PATH: patchCopyPath,
      },
      timeoutMs: 5_000,
    });
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    const patchIndex = args.indexOf("--patch");
    const modelPatchPath = args[patchIndex + 1];

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "deepseek harness output");
    assert.deepEqual(args.slice(0, 2), ["--profile", "headless"]);
    assert.equal(patchIndex, 2);
    assert.equal(args.at(-1), "hello deepseek");
    const runtimeHomePath = readFileSync(homePath, "utf8");
    assert.match(runtimeHomePath, new RegExp(`^${workDir.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}/\\.dofe-deepseek-harness-`));
    assert.equal(existsSync(runtimeHomePath), false);
    assert.equal(readFileSync(policyPath, "utf8"), "workspace-write\n1");
    assert.match(readFileSync(patchCopyPath, "utf8"), /provider: deepseek-official/);
    assert.match(readFileSync(patchCopyPath, "utf8"), /model: deepseek-v4-pro/);
    assert.match(readFileSync(patchCopyPath, "utf8"), /id: tool-web\n  disabled: true/);
    assert.match(readFileSync(patchCopyPath, "utf8"), /id: tool-subagent\n  disabled: true/);
    assert.match(readFileSync(patchCopyPath, "utf8"), /id: tool-workflow\n  disabled: true/);
    assert.match(readFileSync(patchCopyPath, "utf8"), /id: tool-ralph\n  disabled: true/);
    assert.equal(existsSync(modelPatchPath), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter executes a DeepSeek Harness JSON-RPC turn and streams owned session events", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");
  const requestsPath = join(workDir, "requests.jsonl");
  const runtimeEnvPath = join(workDir, "runtime-env.json");

  try {
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
    writeExecutable(
      runtimePath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const readline = require('node:readline');",
        "const requests = process.env.REQUESTS_PATH;",
        "fs.writeFileSync(process.env.RUNTIME_ENV_PATH, JSON.stringify({ home: process.env.DSH_HOME, sessionRoot: process.env.DSH_SESSION_ROOT, cwd: process.env.DSH_CWD, config: process.env.DSH_CORDIS_CONFIG }));",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);",
        "rl.on('line', (line) => {",
        "  fs.appendFileSync(requests, `${line}\\n`);",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });",
        "    return;",
        "  }",
        "  if (message.method === 'session/prompt') {",
        "    const sessionId = message.params.sessionId;",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'other-session', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ignore me' }] } } } } });",
        "    send({ jsonrpc: '2.0', id: message.id, result: { messageId: 'message-1' } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'message-1' }] } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{\"command\":\"pwd\"}' } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/result', seq: 4, time: 5, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '/workspace' }] }] } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 5, time: 6, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 6, time: 7, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 7, time: 8, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private reasoning' } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 8, time: 9, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'text' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 9, time: 10, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'hello from ' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 10, time: 11, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'jsonrpc' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 11, time: 12, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'hello from jsonrpc' } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 12, time: 13, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 13, time: 14, data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'bash', argumentsDelta: '{}' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 14, time: 15, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 15, time: 16, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 2 } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 16, time: 17, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 17, time: 18, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'hello from jsonrpc' }] }, usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 2 } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/end', seq: 18, time: 19, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 19, time: 20, data: { turn: 1, reason: { kind: 'completed' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });",
        "    return;",
        "  }",
        "  if (message.method === 'shutdown') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: {} });",
        "    rl.close();",
        "  }",
        "});",
      ].join("\n"),
    );

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "inspect the workspace",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-pro",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: {
        DSH_CORDIS_CONFIG: configPath,
        DEEPSEEK_BASE_URL: "https://api.deepseek.example",
        REQUESTS_PATH: requestsPath,
        RUNTIME_ENV_PATH: runtimeEnvPath,
      },
      timeoutMs: 5_000,
    });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.outputText, "hello from jsonrpc");
    assert.equal(result.sessionId, undefined, "one-shot JSON-RPC must not advertise resumable sessions");
    assert.ok(result.events.some((event) => event.type === "tool_started" && event.toolUseId === "call-1"));
    assert.ok(result.events.some((event) => event.type === "tool_output" && event.output === "/workspace"));
    assert.ok(result.events.some((event) => event.type === "tool_finished" && event.status === "completed"));
    assert.deepEqual(
      result.events.filter((event) => event.type === "text_delta").map((event) => event.text),
      ["hello from ", "jsonrpc"],
    );
    assert.equal(JSON.stringify(result.events).includes("private reasoning"), false);
    assert.ok(result.events.some((event) =>
      event.type === "tool_output"
      && event.tool === "usage"
      && (event.metadata as { input_tokens?: number }).input_tokens === 12
      && (event.metadata as { cache_read_tokens?: number }).cache_read_tokens === 3
      && (event.metadata as { cache_write_tokens?: number }).cache_write_tokens === 1
      && (event.metadata as { reasoning_tokens?: number }).reasoning_tokens === 2
    ));
    assert.equal(result.events.filter((event) => event.type === "tool_output" && event.tool === "usage").length, 1);
    assert.equal(result.events.some((event) => event.type === "session_updated"), false);
    assert.equal(result.events.some((event) => event.type === "narration_delta" && event.text === "ignore me"), false);

    const requests = readFileSync(requestsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(requests.map((request) => request.method), ["initialize", "session/prompt", "shutdown"]);
    assert.deepEqual(requests[0]?.params, {
      cwd: realpathSync(workDir),
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    assert.deepEqual((requests[1]?.params as { contentBlocks?: unknown }).contentBlocks, [
      { type: "text", text: "inspect the workspace" },
    ]);
    assert.deepEqual((requests[1]?.params as { environment?: unknown }).environment, {
      DEEPSEEK_BASE_URL: "https://api.deepseek.example",
    });
    const runtimeEnv = JSON.parse(readFileSync(runtimeEnvPath, "utf8")) as Record<string, string>;
    assert.equal(runtimeEnv.cwd, realpathSync(workDir));
    assert.equal(runtimeEnv.config, realpathSync(configPath));
    assert.match(runtimeEnv.home, /\.dofe-deepseek-harness-jsonrpc-/);
    assert.equal(runtimeEnv.sessionRoot, join(runtimeEnv.home, "sessions"));
    assert.equal(existsSync(runtimeEnv.home), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter verifies pinned DeepSeek JSON-RPC carrier and Cordis config digests before spawn", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-release-gate-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");
  const startedPath = join(workDir, "started.txt");

  try {
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
    writeExecutable(
      runtimePath,
      [
        "#!/bin/sh",
        "printf '%s' started > \"$STARTED_PATH\"",
      ].join("\n"),
    );
    const executableSha256 = sha256File(runtimePath);
    let cordisConfigSha256 = sha256File(configPath);
    const sidecarPins = writeDeepSeekRuntimeSidecars(runtimePath);

    for (const releasePolicy of [
      { executableSha256: "0".repeat(64), cordisConfigSha256, ...sidecarPins },
      { executableSha256, cordisConfigSha256: "f".repeat(64), ...sidecarPins },
    ]) {
      rmSync(startedPath, { force: true });
      const result = await runAgentRouter({
        version: 1,
        harness: "deepseek-harness",
        prompt: "must not start",
        cwd: workDir,
        executablePath: runtimePath,
        model: "deepseek-v4-flash",
        mode: "jsonrpc",
        deepSeekJsonRpcEnabled: true,
        deepSeekJsonRpcReleasePolicy: releasePolicy,
        env: { DSH_CORDIS_CONFIG: configPath, STARTED_PATH: startedPath },
        timeoutMs: 1_000,
      });

      assert.equal(result.status, "failed");
      assert.equal(existsSync(startedPath), false);
      assert.match(result.diagnostics[0]?.message ?? "", /SHA-256 digest mismatch/);
    }

    rmSync(startedPath, { force: true });
    const unapprovedComposition = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "must not start an unapproved composition",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      deepSeekJsonRpcReleasePolicy: {
        executableSha256,
        cordisConfigSha256,
        ...sidecarPins,
      },
      env: { DSH_CORDIS_CONFIG: configPath, STARTED_PATH: startedPath },
      timeoutMs: 1_000,
    });
    assert.equal(unapprovedComposition.status, "failed");
    assert.equal(existsSync(startedPath), false);
    assert.match(unapprovedComposition.diagnostics[0]?.message ?? "", /not the approved .* composition/);

    writeApprovedDeepSeekCordisConfig(configPath);
    cordisConfigSha256 = sha256File(configPath);

    writeExecutable(
      runtimePath,
      [
        "#!/usr/bin/env node",
        "require('node:fs').writeFileSync(process.env.STARTED_PATH, 'started');",
      ].join("\n"),
    );
    rmSync(startedPath, { force: true });
    const indirectInterpreter = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "must not start through env",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      deepSeekJsonRpcReleasePolicy: {
        executableSha256: sha256File(runtimePath),
        cordisConfigSha256,
        ...sidecarPins,
      },
      env: { DSH_CORDIS_CONFIG: configPath, STARTED_PATH: startedPath },
      timeoutMs: 1_000,
    });
    assert.equal(indirectInterpreter.status, "failed");
    assert.equal(existsSync(startedPath), false);
    assert.match(indirectInterpreter.diagnostics[0]?.message ?? "", /fixed absolute interpreter/);

    writeExecutable(runtimePath, "#!/bin/sh\nprintf '%s' started > \"$STARTED_PATH\"\n");
    rmSync(`${runtimePath}-rg`, { force: true });
    rmSync(startedPath, { force: true });
    const missingSidecar = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "must not start without its pinned bundle",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      deepSeekJsonRpcReleasePolicy: {
        executableSha256: sha256File(runtimePath),
        cordisConfigSha256,
        ...sidecarPins,
      },
      env: { DSH_CORDIS_CONFIG: configPath, STARTED_PATH: startedPath },
      timeoutMs: 1_000,
    });
    assert.equal(missingSidecar.status, "failed");
    assert.equal(existsSync(startedPath), false);
    assert.match(missingSidecar.diagnostics[0]?.message ?? "", /ripgrep sidecar/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter resets attempt state when DeepSeek JSON-RPC retries the same step", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-retry-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");

  try {
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
    writeExecutable(
      runtimePath,
      [
        "#!/usr/bin/env node",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);",
        "rl.on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });",
        "    return;",
        "  }",
        "  if (message.method === 'session/prompt') {",
        "    const sessionId = message.params.sessionId;",
        "    const failure = { message: 'retry me', code: 'UPSTREAM' };",
        "    send({ jsonrpc: '2.0', id: message.id, result: { messageId: 'message-1' } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { inserted: [{ id: 'message-1' }] } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 4, time: 5, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'discarded attempt' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 5, time: 6, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'discarded attempt' } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 6, time: 7, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'llm/retry', seq: 7, time: 8, data: { retryId: 'retry-1', turn: 1, step: 1, provider: 'deepseek-official', mode: 'normal', policyKey: 'default', retry: 1, maxRetries: 2, delayMs: 0, failure } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'llm/retry-started', seq: 8, time: 9, data: { retryId: 'retry-1', turn: 1, step: 1, retry: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 9, time: 10, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 10, time: 11, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'after retry' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 11, time: 12, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'after retry' } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 12, time: 13, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 13, time: 14, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'after retry' }] } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/end', seq: 14, time: 15, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 15, time: 16, data: { turn: 1, reason: { kind: 'completed' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });",
        "    return;",
        "  }",
        "  if (message.method === 'shutdown') { send({ jsonrpc: '2.0', id: message.id, result: {} }); rl.close(); }",
        "});",
      ].join("\n"),
    );

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "retry once",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: configPath },
      timeoutMs: 5_000,
    });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.outputText, "after retry");
    assert.deepEqual(
      result.events.filter((event) => event.type === "text_delta").map((event) => event.text),
      ["after retry"],
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter fail-closes an incompatible DeepSeek Harness JSON-RPC server", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-identity-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");

  try {
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
    writeExecutable(
      runtimePath,
      [
        "#!/usr/bin/env node",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'not-deepseek', version: '1' } } })}\\n`);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "must fail closed",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: configPath },
      timeoutMs: 5_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.outputText, undefined);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "harness.protocol_parse_failed"
      && diagnostic.severity === "error"
      && diagnostic.message.includes("incompatible server identity")
    ));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter classifies invalid DeepSeek Harness JSON-RPC launch contracts", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-contract-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configDirectory = join(workDir, "cordis-directory");

  try {
    writeExecutable(runtimePath, "#!/bin/sh\nprintf '%s\\n' unexpected\n");
    mkdirSync(configDirectory);
    const disabled = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "disabled",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
    });
    const missingConfig = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "missing config",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
    });
    const invalidModel = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "invalid model",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-chat",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: join(workDir, "missing.yml") },
    });
    const unsupportedSession = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "resume",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      sessionId: "existing-session",
    });
    const invalidConfig = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "config must be a file",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: configDirectory },
    });

    assert.equal(disabled.diagnostics[0]?.code, "harness.profile_missing");
    assert.equal(missingConfig.diagnostics[0]?.code, "harness.profile_missing");
    assert.equal(invalidModel.diagnostics[0]?.code, "harness.model_unavailable");
    assert.equal(unsupportedSession.diagnostics[0]?.code, "harness.session_missing");
    assert.equal(invalidConfig.diagnostics[0]?.code, "harness.profile_missing");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter disposes a DeepSeek JSON-RPC launch rejected by capability diagnostics", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-dispose-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");
  const startedPath = join(workDir, "started");

  try {
    writeExecutable(runtimePath, `#!/bin/sh\ntouch "${startedPath}"\n`);
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "must not start",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: configPath },
      runtimeToolCapabilities: [{
        id: "denied-tool",
        command: "denied-tool",
        allowedShellPatterns: ["denied-tool *"],
        diagnosticCommands: [],
        source: "workspace",
        status: "denied",
      }],
    });

    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics[0]?.code, "harness.tool_unauthorized");
    assert.equal(existsSync(startedPath), false);
    assert.deepEqual(
      readdirSync(workDir).filter((name) => name.startsWith(".dofe-deepseek-harness-jsonrpc-")),
      [],
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter fail-closes malformed known events and root subagent notifications", async () => {
  for (const scenario of [
    "malformed-message",
    "malformed-chunk",
    "malformed-tool-call",
    "orphan-tool-result",
    "negative-usage",
    "fractional-usage",
    "usage-conflict",
    "post-finish",
    "turn-mismatch",
    "unknown-required",
    "malformed-turn-end",
    "subagent",
    "oversized-frame",
  ] as const) {
    const workDir = mkdtempSync(join(tmpdir(), `agent-router-deepseek-jsonrpc-${scenario}-`));
    const runtimePath = join(workDir, "dsh-jsonrpc-agent");
    const configPath = join(workDir, "cordis.yml");

    try {
      writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
      writeExecutable(
        runtimePath,
        [
          "#!/usr/bin/env node",
          "const readline = require('node:readline');",
          "const rl = readline.createInterface({ input: process.stdin });",
          "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
          "rl.on('line', (line) => {",
          "  const message = JSON.parse(line);",
          "  if (message.method === 'initialize') {",
          "    send({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });",
          "    return;",
          "  }",
          "  if (message.method !== 'session/prompt') return;",
          "  const sessionId = message.params.sessionId;",
          "  send({ jsonrpc: '2.0', id: message.id, result: { messageId: 'message-1' } });",
          "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { inserted: [{ id: 'message-1' }] } } } });",
          "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } } });",
          "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } } } });",
          scenario === "oversized-frame"
            ? "  process.stdout.write('x'.repeat(1024 * 1024 + 1));"
            : scenario === "malformed-message"
            ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { content: 'not-an-array' } } } } });"
            : scenario === "malformed-chunk"
              ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } } } }); send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 4, time: 5, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private failure reasoning' } } } } }); send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 5, time: 6, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: -1, text: 'bad' } } } } }); send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 6, time: 7, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'should-not-emit' } } } } });"
              : scenario === "malformed-tool-call"
                ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: '', name: 'bash', arguments: '{}' } } } });"
                : scenario === "orphan-tool-result"
                  ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'missing-call' }, content: [] } } } } });"
                  : scenario === "negative-usage"
                    ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'bad usage' }] }, usage: { inputTokens: -1, outputTokens: 1 } } } } });"
                    : scenario === "fractional-usage"
                      ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1.5, outputTokens: 1 } } } } } });"
                      : scenario === "usage-conflict"
                        ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } } } } }); send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 4, time: 5, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } } } }); send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 5, time: 6, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'bad usage' }] }, usage: { inputTokens: 2, outputTokens: 1 } } } } });"
                        : scenario === "post-finish"
                          ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } } } }); send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/chunk', seq: 4, time: 5, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'late' } } } } });"
                          : scenario === "turn-mismatch"
                            ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 3, time: 4, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'wrong turn' }] } } } } });"
                            : scenario === "unknown-required"
                              ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'future/required', seq: 3, time: 4, data: {} } } });"
                              : scenario === "malformed-turn-end"
                                ? "  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 3, time: 4, data: { turn: 0, reason: { kind: 'completed' } } } } }); send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });"
                                : "  send({ jsonrpc: '2.0', method: 'subagent.started', params: { parentSessionId: sessionId, sessionId: 'child-1' } });",
          "});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const result = await runAgentRouter({
        version: 1,
        harness: "deepseek-harness",
        prompt: scenario,
        cwd: workDir,
        executablePath: runtimePath,
        model: "deepseek-v4-flash",
        mode: "jsonrpc",
        deepSeekJsonRpcEnabled: true,
        env: { DSH_CORDIS_CONFIG: configPath },
        timeoutMs: 5_000,
      });

      assert.equal(result.status, "failed");
      assert.equal(result.signal, "SIGTERM", `${scenario}: ${JSON.stringify(result)}`);
      assert.equal(JSON.stringify(result.diagnostics).includes("private failure reasoning"), false);
      assert.equal(result.events.some((event) => event.type === "text_delta" && event.text === "should-not-emit"), false);
      assert.ok(result.diagnostics.some((diagnostic) =>
        diagnostic.code === "harness.protocol_parse_failed"
        && diagnostic.message.includes(
          scenario === "oversized-frame"
            ? "size limit"
            : scenario === "malformed-message"
            ? "assistant/message"
            : scenario === "malformed-chunk"
              ? "assistant/chunk"
              : scenario === "malformed-tool-call"
                ? "tool/call"
                : scenario === "orphan-tool-result"
                  ? "tool/result"
                  : scenario === "negative-usage" || scenario === "fractional-usage" || scenario === "usage-conflict"
                    ? "usage"
                    : scenario === "post-finish"
                      ? "finish"
                      : scenario === "turn-mismatch"
                        ? "turn"
                        : scenario === "unknown-required"
                          ? "unsupported"
                          : scenario === "malformed-turn-end"
                            ? "turn/end"
                            : "subagent",
        )
      ), `${scenario}: ${JSON.stringify(result.diagnostics)}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test("runAgentRouter cancels the whole DeepSeek Harness JSON-RPC process", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-cancel-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");
  const cancelAtPath = join(workDir, "cancel-at.txt");
  const controller = new AbortController();

  try {
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
    writeExecutable(
      runtimePath,
      [
        "#!/usr/bin/env node",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') {",
        "    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } })}\\n`);",
        "    return;",
        "  }",
        "  if (message.method === 'session/prompt') {",
        "    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { messageId: 'message-1' } })}\\n`);",
        "    return;",
        "  }",
        "  if (message.method === 'session/cancel') {",
        "    require('node:fs').writeFileSync(process.env.CANCEL_AT_PATH, String(message.params.reason));",
        "  }",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    setTimeout(() => controller.abort(), 1_000);

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "wait",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: configPath, CANCEL_AT_PATH: cancelAtPath },
      signal: controller.signal,
      timeoutMs: 5_000,
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.sessionId, undefined);
    assert.equal(readFileSync(cancelAtPath, "utf8"), "operator");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter terminates a DeepSeek JSON-RPC runtime that acknowledges shutdown but ignores EOF", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-shutdown-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");
  const shutdownAtPath = join(workDir, "shutdown-at.txt");

  try {
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
    writeExecutable(
      runtimePath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
        "process.on('SIGTERM', () => {});",
        "rl.on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });",
        "    return;",
        "  }",
        "  if (message.method === 'session/prompt') {",
        "    const sessionId = message.params.sessionId;",
        "    send({ jsonrpc: '2.0', id: message.id, result: { messageId: 'message-1' } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { inserted: [{ id: 'message-1' }] } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });",
        "    return;",
        "  }",
        "  if (message.method === 'shutdown') {",
        "    fs.writeFileSync(process.env.SHUTDOWN_AT_PATH, String(Date.now()));",
        "    send({ jsonrpc: '2.0', id: message.id, result: {} });",
        "  }",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "finish",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: configPath, SHUTDOWN_AT_PATH: shutdownAtPath },
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "done");
    assert.equal(result.signal, "SIGKILL");
    const shutdownElapsedMs = Date.now() - Number(readFileSync(shutdownAtPath, "utf8"));
    assert.ok(shutdownElapsedMs >= 5_900);
    assert.ok(shutdownElapsedMs < 8_000);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter bounds shutdown when a DeepSeek JSON-RPC runtime never acknowledges it", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-jsonrpc-shutdown-timeout-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");
  const shutdownAtPath = join(workDir, "shutdown-at.txt");

  try {
    writeFileSync(configPath, "- id: sdk-jsonrpc-server\n", "utf8");
    writeExecutable(
      runtimePath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
        "rl.on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });",
        "    return;",
        "  }",
        "  if (message.method === 'session/prompt') {",
        "    const sessionId = message.params.sessionId;",
        "    send({ jsonrpc: '2.0', id: message.id, result: { messageId: 'message-1' } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { inserted: [{ id: 'message-1' }] } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } } } });",
        "    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });",
        "    return;",
        "  }",
        "  if (message.method === 'shutdown') fs.writeFileSync(process.env.SHUTDOWN_AT_PATH, String(Date.now()));",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "finish",
      cwd: workDir,
      executablePath: runtimePath,
      model: "deepseek-v4-flash",
      mode: "jsonrpc",
      deepSeekJsonRpcEnabled: true,
      env: { DSH_CORDIS_CONFIG: configPath, SHUTDOWN_AT_PATH: shutdownAtPath },
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.signal, "SIGTERM");
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "harness.protocol_parse_failed"
      && diagnostic.message.includes("shutdown response timed out")
    ));
    const shutdownElapsedMs = Date.now() - Number(readFileSync(shutdownAtPath, "utf8"));
    assert.ok(shutdownElapsedMs >= 1_900);
    assert.ok(shutdownElapsedMs < 4_000);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter isolates concurrent DeepSeek Harness overlays in one workdir", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-concurrent-"));
  const dshPath = join(workDir, "dsh");
  const firstCopyPath = join(workDir, "first-patch.yml");
  const secondCopyPath = join(workDir, "second-patch.yml");
  const firstArgsPath = join(workDir, "first-args.txt");
  const secondArgsPath = join(workDir, "second-args.txt");
  const firstHomePath = join(workDir, "first-home.txt");
  const secondHomePath = join(workDir, "second-home.txt");

  try {
    writeExecutable(
      dshPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$DSH_ARGS_PATH\"",
        "printf '%s' \"$DSH_HOME\" > \"$DSH_HOME_PATH\"",
        "cat \"$4\" > \"$DSH_PATCH_COPY_PATH\"",
        "sleep 0.1",
        "printf '%s\\n' \"$DSH_OUTPUT\"",
      ].join("\n"),
    );

    const [first, second] = await Promise.all([
      runAgentRouter({
        version: 1,
        harness: "deepseek-harness",
        prompt: "first",
        cwd: workDir,
        executablePath: dshPath,
        model: "deepseek-v4-flash",
        env: {
          DSH_ARGS_PATH: firstArgsPath,
          DSH_HOME_PATH: firstHomePath,
          DSH_PATCH_COPY_PATH: firstCopyPath,
          DSH_OUTPUT: "first output",
        },
        timeoutMs: 5_000,
      }),
      runAgentRouter({
        version: 1,
        harness: "deepseek-harness",
        prompt: "second",
        cwd: workDir,
        executablePath: dshPath,
        model: "deepseek-v4-pro",
        env: {
          DSH_ARGS_PATH: secondArgsPath,
          DSH_HOME_PATH: secondHomePath,
          DSH_PATCH_COPY_PATH: secondCopyPath,
          DSH_OUTPUT: "second output",
        },
        timeoutMs: 5_000,
      }),
    ]);

    assert.equal(first.status, "completed", JSON.stringify(first));
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.match(readFileSync(firstCopyPath, "utf8"), /model: deepseek-v4-flash/);
    assert.match(readFileSync(secondCopyPath, "utf8"), /model: deepseek-v4-pro/);
    const firstArgs = readFileSync(firstArgsPath, "utf8").trim().split(/\r?\n/);
    const secondArgs = readFileSync(secondArgsPath, "utf8").trim().split(/\r?\n/);
    const firstPatchPath = firstArgs[firstArgs.indexOf("--patch") + 1];
    const secondPatchPath = secondArgs[secondArgs.indexOf("--patch") + 1];
    assert.ok(firstPatchPath);
    assert.ok(secondPatchPath);
    assert.notEqual(firstPatchPath, secondPatchPath);
    assert.equal(existsSync(firstPatchPath), false);
    assert.equal(existsSync(secondPatchPath), false);
    const firstHome = readFileSync(firstHomePath, "utf8");
    const secondHome = readFileSync(secondHomePath, "utf8");
    assert.notEqual(firstHome, secondHome);
    assert.equal(existsSync(firstHome), false);
    assert.equal(existsSync(secondHome), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter removes stale DeepSeek Harness overlays without touching recent files", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-stale-"));
  const dshPath = join(workDir, "dsh");
  const stalePath = join(workDir, ".dofe-deepseek-harness.patch-00000000-0000-4000-8000-000000000001.yml");
  const recentPath = join(workDir, ".dofe-deepseek-harness.patch-00000000-0000-4000-8000-000000000002.yml");
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1_000);

  try {
    writeFileSync(stalePath, "stale", "utf8");
    utimesSync(stalePath, oldTime, oldTime);
    writeFileSync(recentPath, "recent", "utf8");
    writeExecutable(dshPath, "#!/bin/sh\nprintf '%s\\n' 'deepseek output'\n");

    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "cleanup stale overlays",
      cwd: workDir,
      executablePath: dshPath,
      model: "deepseek-v4-flash",
      timeoutMs: 5_000,
    });

    assert.equal(result.status, "completed");
    assert.equal(existsSync(stalePath), false);
    assert.equal(existsSync(recentPath), true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter rejects DeepSeek Harness session resume in headless mode", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-session-"));
  const dshPath = join(workDir, "dsh");

  try {
    writeExecutable(dshPath, "#!/bin/sh\nprintf '%s\\n' unexpected\n");
    const result = await runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "resume",
      cwd: workDir,
      executablePath: dshPath,
      sessionId: "existing-session",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "harness.session_missing"), true);
    assert.equal(result.outputText, undefined);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter classifies DeepSeek Harness auth failures, empty output, and timeout", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-failures-"));
  const dshPath = join(workDir, "dsh");
  const request = {
    version: 1 as const,
    harness: "deepseek-harness" as const,
    prompt: "test failure",
    cwd: workDir,
    executablePath: dshPath,
    model: "deepseek-v4-flash",
  };

  try {
    writeExecutable(dshPath, "#!/bin/sh\nprintf '%s\\n' 'DEEPSEEK_API_KEY is required' >&2\nexit 1\n");
    const authFailure = await runAgentRouter(request);
    assert.equal(authFailure.status, "failed");
    assert.equal(authFailure.diagnostics.some((diagnostic) => diagnostic.code === "harness.auth_required"), true);

    writeExecutable(dshPath, "#!/bin/sh\nexit 0\n");
    const empty = await runAgentRouter(request);
    assert.equal(empty.status, "failed");
    assert.equal(empty.diagnostics.some((diagnostic) => diagnostic.code === "harness.empty_response"), true);

    writeExecutable(dshPath, "#!/bin/sh\nsleep 1\n");
    const timeout = await runAgentRouter({ ...request, timeoutMs: 50 });
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.diagnostics.some((diagnostic) => diagnostic.code === "harness.timeout"), true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter cancels DeepSeek Harness by terminating the child process", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-cancel-"));
  const dshPath = join(workDir, "dsh");
  const controller = new AbortController();

  try {
    writeExecutable(dshPath, "#!/bin/sh\ntrap 'exit 143' TERM\nwhile true; do sleep 1; done\n");
    const pending = runAgentRouter({
      version: 1,
      harness: "deepseek-harness",
      prompt: "cancel me",
      cwd: workDir,
      executablePath: dshPath,
      model: "deepseek-v4-flash",
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.signal, "SIGTERM");
  } finally {
    controller.abort();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter launches Hermes in headless text mode with model and runtime tool PATH", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-hermes-"));
  const providerBinDir = join(workDir, "provider-bin");
  const toolBinDir = join(workDir, "tool-bin");
  const hermesPath = join(providerBinDir, "hermes");
  const fakeCliPath = join(toolBinDir, "fake-cli");
  const argsPath = join(workDir, "hermes-args.txt");
  const seenPathFile = join(workDir, "seen-path.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      hermesPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$HERMES_ARGS_PATH\"",
        "printf '%s' \"$PATH\" > \"$SEEN_PATH_FILE\"",
        "if command -v fake-cli >/dev/null 2>&1; then",
        "  printf '%s\\n' 'hermes text output'",
        "else",
        "  printf '%s\\n' 'tool missing'",
        "fi",
      ].join("\n"),
    );
    writeExecutable(fakeCliPath, "#!/bin/sh\necho fake-cli-ok\n");
    process.env.PATH = providerBinDir;

    const result = await runAgentRouter({
      version: 1,
      harness: "hermes",
      prompt: "hello hermes",
      cwd: workDir,
      executablePath: hermesPath,
      model: "nous-hermes",
      env: {
        HERMES_ARGS_PATH: argsPath,
        SEEN_PATH_FILE: seenPathFile,
      },
      runtimeToolCapabilities: [{
        id: "fake-cli",
        command: "fake-cli",
        displayName: "Fake CLI",
        binDir: toolBinDir,
        allowedShellPatterns: ["fake-cli *"],
        source: "runtime",
      }],
      timeoutMs: 1_000,
    });
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    const seenPath = readFileSync(seenPathFile, "utf8").split(delimiter);

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "hermes text output");
    assert.deepEqual(args, ["-z", "hello hermes", "--model", "nous-hermes"]);
    assert.equal(seenPath.includes(toolBinDir), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter launches Antigravity in prompt mode with cwd, model, conversation, and runtime tool PATH", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-antigravity-"));
  const providerBinDir = join(workDir, "provider-bin");
  const toolBinDir = join(workDir, "tool-bin");
  const agyPath = join(providerBinDir, "agy");
  const fakeCliPath = join(toolBinDir, "fake-cli");
  const argsPath = join(workDir, "antigravity-args.txt");
  const seenPathFile = join(workDir, "seen-path.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      agyPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$ANTIGRAVITY_ARGS_PATH\"",
        "printf '%s' \"$PATH\" > \"$SEEN_PATH_FILE\"",
        "if command -v fake-cli >/dev/null 2>&1; then",
        "  printf '%s\\n' 'antigravity text output'",
        "else",
        "  printf '%s\\n' 'tool missing'",
        "fi",
      ].join("\n"),
    );
    writeExecutable(fakeCliPath, "#!/bin/sh\necho fake-cli-ok\n");
    process.env.PATH = providerBinDir;

    const result = await runAgentRouter({
      version: 1,
      harness: "antigravity",
      prompt: "hello antigravity",
      cwd: workDir,
      executablePath: agyPath,
      model: "Gemini 3.5 Flash",
      sessionId: "conversation-123",
      env: {
        ANTIGRAVITY_ARGS_PATH: argsPath,
        SEEN_PATH_FILE: seenPathFile,
      },
      runtimeToolCapabilities: [{
        id: "fake-cli",
        command: "fake-cli",
        displayName: "Fake CLI",
        binDir: toolBinDir,
        allowedShellPatterns: ["fake-cli *"],
        source: "runtime",
      }],
      timeoutMs: 1_000,
    });
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    const seenPath = readFileSync(seenPathFile, "utf8").split(delimiter);

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "antigravity text output");
    assert.equal(result.sessionId, "conversation-123");
    assert.deepEqual(args, [
      "--conversation",
      "conversation-123",
      "-p",
      "hello antigravity",
      "--cwd",
      workDir,
      "--model",
      "Gemini 3.5 Flash",
    ]);
    assert.equal(seenPath.includes(toolBinDir), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter returns structured Hermes diagnostics for nonzero and empty responses", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-hermes-diagnostics-"));
  const binDir = join(workDir, "bin");
  const hermesPath = join(binDir, "hermes");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      hermesPath,
      [
        "#!/bin/sh",
        "if [ \"$HERMES_SLEEP\" = '1' ]; then",
        "  sleep 2",
        "fi",
        "if [ \"$HERMES_EMPTY\" = '1' ]; then",
        "  exit 0",
        "fi",
        "printf '%s\\n' 'auth failed: login required' >&2",
        "exit 42",
      ].join("\n"),
    );
    process.env.PATH = binDir;

    const failed = await runAgentRouter({
      version: 1,
      harness: "hermes",
      prompt: "fail",
      cwd: workDir,
      executablePath: hermesPath,
      timeoutMs: 1_000,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.diagnostics.some((diagnostic) => diagnostic.code === "harness.exited_nonzero"), true);
    assert.match(failed.diagnostics.find((diagnostic) => diagnostic.code === "harness.exited_nonzero")?.rawProviderMessage ?? "", /login required/);

    const empty = await runAgentRouter({
      version: 1,
      harness: "hermes",
      prompt: "empty",
      cwd: workDir,
      executablePath: hermesPath,
      env: { HERMES_EMPTY: "1" },
      timeoutMs: 1_000,
    });
    assert.equal(empty.status, "failed");
    assert.equal(empty.diagnostics.some((diagnostic) => diagnostic.code === "harness.empty_response"), true);

    const timeout = await runAgentRouter({
      version: 1,
      harness: "hermes",
      prompt: "slow",
      cwd: workDir,
      executablePath: hermesPath,
      env: { HERMES_SLEEP: "1" },
      timeoutMs: 50,
    });
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.diagnostics.some((diagnostic) => diagnostic.code === "harness.timeout"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter invokes Claude with a text prompt and parses stream-json output", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-claude-"));
  const binDir = join(workDir, "bin");
  const claudePath = join(binDir, "claude");
  const stdinPath = join(workDir, "stdin.jsonl");
  const argsPath = join(workDir, "args.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      claudePath,
      [
        "#!/bin/sh",
        "mkdir -p \"$(dirname \"$CLAUDE_STDIN_PATH\")\"",
        "cat > \"$CLAUDE_STDIN_PATH\"",
        "printf '%s\\n' \"$@\" > \"$CLAUDE_ARGS_PATH\"",
        "printf '%s\\n' '{\"type\":\"assistant\",\"session_id\":\"claude-session\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"thinking\"}]}}'",
        "printf '%s\\n' '{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"pwd\"}}'",
        "printf '%s\\n' '{\"type\":\"tool_result\",\"name\":\"Bash\",\"output\":\"ok\"}'",
        "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"claude-session\",\"result\":\"final claude text\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}'",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const events: AgentRouterEvent[] = [];
    const result = await runAgentRouter({
      version: 1,
      harness: "claude",
      prompt: "hello claude",
      cwd: workDir,
      model: "sonnet",
      mode: "plan",
      env: {
        CLAUDE_STDIN_PATH: stdinPath,
        CLAUDE_ARGS_PATH: argsPath,
      },
      timeoutMs: 1_000,
    }, {
      emit: (event) => events.push(event),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "final claude text");
    assert.equal(result.sessionId, "claude-session");
    assert.equal(events.some((event) => event.type === "tool_started" && event.tool === "Bash"), true);
    assert.equal(events.some((event) => event.type === "tool_finished" && event.tool === "Bash"), true);
    assert.equal(events.some((event) => event.type === "session_updated" && event.sessionId === "claude-session"), true);
    assert.equal(readFileSync(stdinPath, "utf8"), "");
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    assert.deepEqual(args.slice(0, 7), [
      "-p",
      "hello claude",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
    ]);
    assert.equal(args.includes("--input-format"), false);
    assert.equal(args.includes("hello claude"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter normalizes Codex JSON events, output file, and resume launch", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-codex-"));
  const binDir = join(workDir, "bin");
  const codexPath = join(binDir, "codex");
  const argsPath = join(workDir, "args.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      codexPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$CODEX_ARGS_PATH\"",
        "prev=''",
        "for arg in \"$@\"; do",
        "  if [ \"$prev\" = '-o' ]; then",
        "    printf '%s' 'codex file output' > \"$arg\"",
        "  fi",
        "  prev=\"$arg\"",
        "done",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"codex-session\"}'",
        "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"type\":\"commandExecution\",\"command\":\"pwd\"}}'",
        "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"commandExecution\",\"aggregatedOutput\":\"/tmp\"}}'",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const events: AgentRouterEvent[] = [];
    const result = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "continue codex",
      cwd: workDir,
      sessionId: "codex-prev",
      mode: "workspace-write",
      env: { CODEX_ARGS_PATH: argsPath },
      timeoutMs: 1_000,
    }, {
      emit: (event) => events.push(event),
    });

    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "codex file output");
    assert.equal(result.sessionId, "codex-session");
    assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
    assert.equal(args.includes("codex-prev"), true);
    assert.equal(args.includes("--cd"), false);
    assert.equal(args.includes("--sandbox"), false);
    assert.equal(events.some((event) => event.type === "tool_started" && event.tool === "exec_command"), true);
    assert.equal(events.some((event) => event.type === "tool_output" && event.tool === "exec_command"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter launches Codex in its process cwd without passing a host --cd path", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-codex-cwd-"));
  const binDir = join(workDir, "bin");
  const codexPath = join(binDir, "codex");
  const argsPath = join(workDir, "args.txt");
  const cwdPath = join(workDir, "cwd.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      codexPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$CODEX_ARGS_PATH\"",
        "pwd > \"$CODEX_CWD_PATH\"",
        "prev=''",
        "for arg in \"$@\"; do",
        "  if [ \"$prev\" = '-o' ]; then",
        "    printf '%s' 'codex cwd output' > \"$arg\"",
        "  fi",
        "  prev=\"$arg\"",
        "done",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "hello codex",
      cwd: workDir,
      env: {
        CODEX_ARGS_PATH: argsPath,
        CODEX_CWD_PATH: cwdPath,
      },
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "completed", JSON.stringify(result.diagnostics));
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    assert.equal(result.outputText, "codex cwd output");
    assert.equal(readFileSync(cwdPath, "utf8").trim(), realpathSync(workDir));
    assert.equal(args.includes("--cd"), false);
    assert.equal(args.at(-1), "hello codex");
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter handles Codex snake_case events without treating successful tool output as auth failure", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-codex-snake-"));
  const binDir = join(workDir, "bin");
  const codexPath = join(binDir, "codex");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      codexPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"codex-snake-session\"}'",
        "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\",\"command\":\"acme-tool read\"}}'",
        "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"docs mention unauthorized 401 api key text, but command succeeded\",\"exit_code\":0,\"status\":\"completed\"}}'",
        "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"snake final text\"}}'",
        "printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":5}}'",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const events: AgentRouterEvent[] = [];
    const result = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "snake codex",
      cwd: workDir,
      timeoutMs: 1_000,
    }, {
      emit: (event) => events.push(event),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "snake final text");
    assert.equal(result.sessionId, "codex-snake-session");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "harness.auth_invalid"), false);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "harness.auth_required"), false);
    assert.equal(events.some((event) => event.type === "tool_started" && event.tool === "exec_command"), true);
    assert.equal(events.some((event) => event.type === "tool_output" && event.tool === "exec_command"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter classifies explicit Runtime credential failures as authentication failures", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-codex-auth-"));
  const binDir = join(workDir, "bin");
  const codexPath = join(binDir, "codex");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      codexPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"codex-auth-session\"}'",
        "printf '%s\\n' '{\"type\":\"turn.started\"}'",
        "printf '%s\\n' '{\"type\":\"error\",\"message\":\"Runtime credential rejected by gateway\"}'",
        "printf '%s\\n' '{\"type\":\"turn.failed\",\"error\":{\"message\":\"Runtime credential rejected by gateway\"}}'",
        "exit 1",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "auth failure",
      cwd: workDir,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    const authDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.code === "harness.auth_invalid");
    assert.ok(authDiagnostic, JSON.stringify(result.diagnostics));
    assert.match(authDiagnostic.rawProviderMessage ?? "", /Runtime credential rejected/);
    assert.equal(result.sessionId, "codex-auth-session");
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter does not rotate Runtime credentials for upstream provider 401s", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-codex-upstream-auth-"));
  const binDir = join(workDir, "bin");
  const codexPath = join(binDir, "codex");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      codexPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"codex-upstream-auth-session\"}'",
        "printf '%s\\n' '{\"type\":\"turn.failed\",\"error\":{\"message\":\"unexpected status 401 Unauthorized: 该令牌状态不可用\"}}'",
        "exit 1",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "upstream auth failure",
      cwd: workDir,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    const modelDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.code === "harness.model_unavailable");
    assert.ok(modelDiagnostic, JSON.stringify(result.diagnostics));
    assert.match(modelDiagnostic.rawProviderMessage ?? "", /令牌状态不可用/);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "harness.auth_invalid"), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter normalizes OpenCode JSON text, session, usage, and launch args", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-opencode-"));
  const providerBinDir = join(workDir, "provider-bin");
  const toolBinDir = join(workDir, "tool-bin");
  const opencodePath = join(providerBinDir, "opencode");
  const fakeCliPath = join(toolBinDir, "fake-cli");
  const argsPath = join(workDir, "opencode-args.txt");
  const seenPathFile = join(workDir, "seen-path.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      opencodePath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$OPENCODE_ARGS_PATH\"",
        "printf '%s' \"$PATH\" > \"$SEEN_PATH_FILE\"",
        "if ! command -v fake-cli >/dev/null 2>&1; then",
        "  printf '%s\\n' 'missing fake cli' >&2",
        "  exit 3",
        "fi",
        "printf '%s\\n' '{\"type\":\"step_start\",\"sessionID\":\"ses_1\",\"part\":{\"text\":\"thinking\"}}'",
        "printf '%s\\n' '{\"type\":\"text\",\"sessionID\":\"ses_1\",\"part\":{\"text\":\"final answer\"}}'",
        "printf '%s\\n' '{\"type\":\"step_finish\",\"sessionID\":\"ses_1\",\"part\":{\"tokens\":{\"input\":5,\"output\":7}}}'",
      ].join("\n"),
    );
    writeExecutable(fakeCliPath, "#!/bin/sh\necho fake-cli-ok\n");
    process.env.PATH = providerBinDir;

    const events: AgentRouterEvent[] = [];
    const result = await runAgentRouter({
      version: 1,
      harness: "opencode",
      prompt: "hello opencode",
      cwd: workDir,
      executablePath: opencodePath,
      model: "openrouter/openai/gpt-4.1",
      sessionId: "ses_prev",
      env: {
        OPENCODE_ARGS_PATH: argsPath,
        SEEN_PATH_FILE: seenPathFile,
      },
      runtimeToolCapabilities: [{
        id: "fake-cli",
        command: "fake-cli",
        displayName: "Fake CLI",
        binDir: toolBinDir,
        allowedShellPatterns: ["fake-cli *"],
        source: "runtime",
      }],
      timeoutMs: 1_000,
    }, {
      emit: (event) => events.push(event),
    });
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    const seenPath = readFileSync(seenPathFile, "utf8").split(delimiter);

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "final answer");
    assert.equal(result.sessionId, "ses_1");
    assert.deepEqual(args, [
      "run",
      "--format",
      "json",
      "--session",
      "ses_prev",
      "--model",
      "openrouter/openai/gpt-4.1",
      "hello opencode",
    ]);
    assert.equal(seenPath.includes(toolBinDir), true);
    assert.equal(events.some((event) => event.type === "session_updated" && event.sessionId === "ses_1"), true);
    assert.equal(events.some((event) => event.type === "thought_delta" && event.text === "thinking"), true);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "final answer"), true);
    assert.equal(events.some((event) => event.type === "tool_output" && event.tool === "usage"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter returns structured OpenCode diagnostics for nonzero, empty, and timeout", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-opencode-diagnostics-"));
  const binDir = join(workDir, "bin");
  const opencodePath = join(binDir, "opencode");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      opencodePath,
      [
        "#!/bin/sh",
        "if [ \"$OPENCODE_SLEEP\" = '1' ]; then",
        "  sleep 2",
        "fi",
        "if [ \"$OPENCODE_EMPTY\" = '1' ]; then",
        "  exit 0",
        "fi",
        "if [ \"$OPENCODE_INVALID_JSON\" = '1' ]; then",
        "  printf '%s\\n' '{\"type\":\"text\",\"sessionID\":\"ses_partial\",\"part\":{\"text\":\"partial output\"}}'",
        "  printf '%s\\n' '{not-json'",
        "  exit 0",
        "fi",
        "printf '%s\\n' 'OpenCode auth failed' >&2",
        "exit 42",
      ].join("\n"),
    );
    process.env.PATH = binDir;

    const failed = await runAgentRouter({
      version: 1,
      harness: "opencode",
      prompt: "fail",
      cwd: workDir,
      executablePath: opencodePath,
      timeoutMs: 1_000,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.diagnostics.some((diagnostic) => diagnostic.code === "harness.exited_nonzero"), true);
    assert.match(failed.diagnostics.find((diagnostic) => diagnostic.code === "harness.exited_nonzero")?.rawProviderMessage ?? "", /OpenCode auth failed/);

    const empty = await runAgentRouter({
      version: 1,
      harness: "opencode",
      prompt: "empty",
      cwd: workDir,
      executablePath: opencodePath,
      env: { OPENCODE_EMPTY: "1" },
      timeoutMs: 1_000,
    });
    assert.equal(empty.status, "failed");
    assert.equal(empty.diagnostics.some((diagnostic) => diagnostic.code === "harness.empty_response"), true);

    const partialInvalid = await runAgentRouter({
      version: 1,
      harness: "opencode",
      prompt: "partial-invalid",
      cwd: workDir,
      executablePath: opencodePath,
      env: { OPENCODE_INVALID_JSON: "1" },
      timeoutMs: 1_000,
    });
    assert.equal(partialInvalid.status, "completed");
    assert.equal(partialInvalid.outputText, "partial output");
    assert.equal(partialInvalid.diagnostics.some((diagnostic) => diagnostic.code === "harness.protocol_parse_failed"), true);

    const timeout = await runAgentRouter({
      version: 1,
      harness: "opencode",
      prompt: "slow",
      cwd: workDir,
      executablePath: opencodePath,
      env: { OPENCODE_SLEEP: "1" },
      timeoutMs: 50,
    });
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.diagnostics.some((diagnostic) => diagnostic.code === "harness.timeout"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter translates fake runtime tool capabilities into PATH, Claude allowedTools, and diagnostics", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-tool-capability-"));
  const providerBinDir = join(workDir, "provider-bin");
  const toolBinDir = join(workDir, "tool-bin");
  const claudePath = join(providerBinDir, "claude");
  const fakeCliPath = join(toolBinDir, "fake-cli");
  const argsPath = join(workDir, "claude-args.txt");
  const seenPathFile = join(workDir, "seen-path.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      claudePath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$CLAUDE_ARGS_PATH\"",
        "printf '%s' \"$PATH\" > \"$SEEN_PATH_FILE\"",
        "if command -v fake-cli >/dev/null 2>&1; then",
        "  fake-cli smoke >/dev/null",
        "fi",
        "cat >/dev/null",
        "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"cap-session\",\"result\":\"cap ok\"}'",
      ].join("\n"),
    );
    writeExecutable(fakeCliPath, "#!/bin/sh\nprintf '%s\\n' fake-cli-ok\n");
    process.env.PATH = providerBinDir;

    const result = await runAgentRouter({
      version: 1,
      harness: "claude",
      prompt: "use fake cli",
      cwd: workDir,
      executablePath: claudePath,
      env: {
        CLAUDE_ARGS_PATH: argsPath,
        SEEN_PATH_FILE: seenPathFile,
      },
      allowedTools: ["Read"],
      runtimeToolCapabilities: [{
        id: "fake-cli",
        command: "fake-cli",
        displayName: "Fake CLI",
        binDir: toolBinDir,
        allowedShellPatterns: ["fake-cli *", "fake-cli status"],
        diagnosticCommands: ["command -v fake-cli", "fake-cli smoke"],
        source: "runtime",
      }],
      timeoutMs: 1_000,
    });
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);
    const seenPath = readFileSync(seenPathFile, "utf8").split(delimiter);

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "cap ok");
    assert.equal(seenPath.includes(toolBinDir), true);
    assert.equal(args.includes("--allowedTools"), true);
    assert.equal(args.includes("Bash(fake-cli *)"), true);
    assert.equal(args.includes("Bash(fake-cli status)"), true);
    assert.equal(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "harness.tool_available" &&
      diagnostic.message.includes("fake-cli smoke")
    ), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter distinguishes denied and missing runtime tool capabilities before provider launch", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-tool-denied-"));
  const binDir = join(workDir, "bin");
  const codexPath = join(binDir, "codex");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(codexPath, "#!/bin/sh\nexit 0\n");
    process.env.PATH = binDir;

    const denied = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "try tool",
      cwd: workDir,
      executablePath: codexPath,
      runtimeToolCapabilities: [{
        id: "denied-tool",
        command: "denied-tool",
        allowedShellPatterns: ["denied-tool *"],
        diagnosticCommands: ["command -v denied-tool"],
        source: "workspace",
        status: "denied",
        denialReason: "Agent lacks workspace grant.",
      }],
      timeoutMs: 1_000,
    });
    assert.equal(denied.status, "failed");
    assert.equal(denied.diagnostics[0]?.code, "harness.tool_unauthorized");
    assert.match(denied.diagnostics[0]?.rawProviderMessage ?? "", /workspace grant/);

    const missing = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "try missing",
      cwd: workDir,
      executablePath: codexPath,
      runtimeToolCapabilities: [{
        id: "missing-tool",
        command: "missing-tool",
        allowedShellPatterns: ["missing-tool *"],
        diagnosticCommands: ["command -v missing-tool"],
        source: "runtime",
      }],
      timeoutMs: 1_000,
    });
    assert.equal(missing.status, "failed");
    assert.equal(missing.diagnostics[0]?.code, "harness.tool_missing");
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter reports Claude provider permission denials as tool_permission_denied diagnostics", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-claude-tool-denial-"));
  const binDir = join(workDir, "bin");
  const claudePath = join(binDir, "claude");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      claudePath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"denied-session\",\"result\":\"need permission\",\"permission_denials\":[{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"fake-cli status\"}}]}'",
      ].join("\n"),
    );
    process.env.PATH = binDir;

    const result = await runAgentRouter({
      version: 1,
      harness: "claude",
      prompt: "try fake cli",
      cwd: workDir,
      executablePath: claudePath,
      allowedTools: ["Read"],
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "harness.tool_permission_denied" &&
      diagnostic.message.includes("fake-cli status")
    ), true);
    assert.equal(result.events.some((event) =>
      event.type === "approval_requested" &&
      event.contentPreview.includes("fake-cli status")
    ), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter normalizes OpenClaw JSON output and nonzero diagnostics", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-openclaw-"));
  const binDir = join(workDir, "bin");
  const openClawPath = join(binDir, "openclaw");
  const argsPath = join(workDir, "args.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      openClawPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$OPENCLAW_ARGS_PATH\"",
        "if [ \"$OPENCLAW_FAIL_AUTH\" = '1' ]; then",
        "  printf '%s\\n' '401 unauthorized: login required' >&2",
        "  exit 1",
        "fi",
        "printf '%s\\n' '{\"sessionId\":\"openclaw-session\",\"message\":{\"content\":\"openclaw text\"},\"usage\":{\"inputTokens\":5,\"outputTokens\":8}}'",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const ok = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hello claw",
      cwd: workDir,
      model: "openclaw-model",
      mode: "medium",
      env: { OPENCLAW_ARGS_PATH: argsPath, OPENCLAW_PROFILE: "test-profile" },
      timeoutMs: 1_000,
    });
    const args = readFileSync(argsPath, "utf8").trim().split(/\r?\n/);

    assert.equal(ok.status, "completed");
    assert.equal(ok.outputText, "openclaw text");
    assert.equal(ok.sessionId, "openclaw-session");
    assert.deepEqual(args.slice(0, 2), ["--profile", "test-profile"]);
    assert.equal(args.includes("--thinking"), true);

    const failed = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hello claw",
      cwd: workDir,
      env: { OPENCLAW_ARGS_PATH: argsPath, OPENCLAW_FAIL_AUTH: "1" },
      timeoutMs: 1_000,
    });

    assert.equal(failed.status, "failed");
    assert.equal(failed.diagnostics.some((diagnostic) => diagnostic.code === "harness.auth_invalid"), true);
    assert.equal(failed.diagnostics.some((diagnostic) => diagnostic.code === "harness.exited_nonzero"), true);
    assert.match(failed.diagnostics.find((diagnostic) => diagnostic.code === "harness.auth_invalid")?.rawProviderMessage ?? "", /unauthorized/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter performs OpenClaw daemon preflight before CLI launch", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-openclaw-preflight-"));
  const binDir = join(workDir, "bin");
  const openClawPath = join(binDir, "openclaw");
  const countPath = join(workDir, "count.txt");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      openClawPath,
      [
        "#!/bin/sh",
        "count=0",
        "if [ -f \"$OPENCLAW_COUNT_PATH\" ]; then count=$(cat \"$OPENCLAW_COUNT_PATH\"); fi",
        "count=$((count + 1))",
        "printf '%s' \"$count\" > \"$OPENCLAW_COUNT_PATH\"",
        "printf '%s\\n' '{\"sessionId\":\"should-not-run\",\"message\":{\"content\":\"ran\"}}'",
      ].join("\n"),
    );
    writeFileSync(join(workDir, "task.json"), "{}", "utf8");
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hello claw",
      cwd: workDir,
      executablePath: openClawPath,
      openClawEphemeralAgent: true,
      env: {
        OPENCLAW_COUNT_PATH: countPath,
        DOFE_AGENT_CONTEXT_TASK_ID: "task-openclaw",
      },
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics[0]?.code, "harness.profile_missing");
    assert.equal(existsSync(countPath), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter maps OpenClaw model, session, tool, and protocol diagnostics", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-openclaw-diagnostics-"));
  const binDir = join(workDir, "bin");
  const openClawPath = join(binDir, "openclaw");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      openClawPath,
      [
        "#!/bin/sh",
        "case \"$OPENCLAW_SCENARIO\" in",
        "  model) printf '%s\\n' 'model missing-model not found' >&2; exit 1 ;;",
        "  session) printf '%s\\n' 'session stale-session not found' >&2; exit 1 ;;",
        "  tool) printf '%s\\n' 'tool fake-cli not found in PATH' >&2; exit 1 ;;",
        "  invalid) printf '%s\\n' '{ invalid json'; exit 0 ;;",
        "esac",
        "printf '%s\\n' '{\"sessionId\":\"ok\",\"message\":{\"content\":\"ok\"}}'",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const model = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hi",
      cwd: workDir,
      executablePath: openClawPath,
      env: { OPENCLAW_SCENARIO: "model" },
      timeoutMs: 1_000,
    });
    assert.equal(model.diagnostics.some((diagnostic) => diagnostic.code === "harness.model_unavailable"), true);

    const session = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hi",
      cwd: workDir,
      executablePath: openClawPath,
      sessionId: "stale-session",
      env: { OPENCLAW_SCENARIO: "session" },
      timeoutMs: 1_000,
    });
    assert.equal(session.diagnostics.some((diagnostic) => diagnostic.code === "harness.session_missing"), true);

    const tool = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hi",
      cwd: workDir,
      executablePath: openClawPath,
      env: { OPENCLAW_SCENARIO: "tool" },
      timeoutMs: 1_000,
    });
    assert.equal(tool.diagnostics.some((diagnostic) => diagnostic.code === "harness.tool_missing"), true);

    const invalid = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hi",
      cwd: workDir,
      executablePath: openClawPath,
      env: { OPENCLAW_SCENARIO: "invalid" },
      timeoutMs: 1_000,
    });
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.diagnostics.some((diagnostic) => diagnostic.code === "harness.protocol_parse_failed"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter redacts OpenClaw secrets from diagnostics", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-openclaw-redaction-"));
  const binDir = join(workDir, "bin");
  const openClawPath = join(binDir, "openclaw");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      openClawPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' '401 unauthorized OPENCLAW_API_KEY=supersecret-token Authorization: Bearer anothersecret' >&2",
        "exit 1",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = await runAgentRouter({
      version: 1,
      harness: "openclaw",
      prompt: "hi",
      cwd: workDir,
      executablePath: openClawPath,
      env: { OPENCLAW_API_KEY: "supersecret-token" },
      timeoutMs: 1_000,
    });
    const raw = result.diagnostics.map((diagnostic) => `${diagnostic.rawProviderMessage ?? ""}\n${diagnostic.stderrTail ?? ""}`).join("\n");

    assert.equal(raw.includes("supersecret-token"), false);
    assert.equal(raw.includes("anothersecret"), false);
    assert.match(raw, /redacted/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runAgentRouter returns timeout and empty-response diagnostics", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-diagnostics-"));
  const binDir = join(workDir, "bin");
  const claudePath = join(binDir, "claude");
  const codexPath = join(binDir, "codex");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(claudePath, "#!/bin/sh\nsleep 2\n");
    writeExecutable(codexPath, "#!/bin/sh\nexit 0\n");
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const timeout = await runAgentRouter({
      version: 1,
      harness: "claude",
      prompt: "slow",
      cwd: workDir,
      timeoutMs: 50,
    });
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.diagnostics[0]?.code, "harness.timeout");

    const empty = await runAgentRouter({
      version: 1,
      harness: "codex",
      prompt: "empty",
      cwd: workDir,
      timeoutMs: 1_000,
    });
    assert.equal(empty.status, "failed");
    assert.equal(empty.diagnostics.some((diagnostic) => diagnostic.code === "harness.empty_response"), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("agent-router CLI emits JSONL events and result in --json-events mode", () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-cli-"));
  const binDir = join(workDir, "bin");
  const codexPath = join(binDir, "codex");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      codexPath,
      [
        "#!/bin/sh",
        "prev=''",
        "for arg in \"$@\"; do",
        "  if [ \"$prev\" = '-o' ]; then",
        "    printf '%s' 'cli codex output' > \"$arg\"",
        "  fi",
        "  prev=\"$arg\"",
        "done",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"cli-session\"}'",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(process.cwd(), "packages/daemon/src/agent-router/cli.ts"),
        "run",
        "--harness",
        "codex",
        "--cwd",
        workDir,
        "--json-events",
        "ping",
      ],
      { encoding: "utf8", env: process.env },
    );
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(lines.some((line) => line.type === "harness_started"), true);
    assert.equal(lines.at(-1)?.type, "result");
    assert.equal(lines.at(-1)?.status, "completed");
    assert.equal(lines.at(-1)?.outputText, "cli codex output");
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("agent-router CLI emits Hermes result JSONL in --json-events mode", () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-cli-hermes-"));
  const binDir = join(workDir, "bin");
  const hermesPath = join(binDir, "hermes");
  const originalPath = process.env.PATH;

  try {
    writeExecutable(
      hermesPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' 'cli hermes output'",
      ].join("\n"),
    );
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(process.cwd(), "packages/daemon/src/agent-router/cli.ts"),
        "run",
        "--harness",
        "hermes",
        "--cwd",
        workDir,
        "--json-events",
        "ping",
      ],
      { encoding: "utf8", env: process.env },
    );
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(lines.some((line) => line.type === "harness_started"), true);
    assert.equal(lines.at(-1)?.type, "result");
    assert.equal(lines.at(-1)?.status, "completed");
    assert.equal(lines.at(-1)?.outputText, "cli hermes output");
  } finally {
    process.env.PATH = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("daemon CLI emits portable evidence for an attested DeepSeek release", () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-router-deepseek-release-evidence-"));
  const runtimePath = join(workDir, "dsh-jsonrpc-agent");
  const configPath = join(workDir, "cordis.yml");
  const provenancePath = join(workDir, "provenance.json");
  const wheelSha256 = "1".repeat(64);

  try {
    writeExecutable(
      runtimePath,
      [
        `#!${process.execPath}`,
        "if (process.env.DEEPSEEK_API_KEY) process.exit(41);",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const request = JSON.parse(line);",
        "  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } }) + '\\n');",
        "  if (request.method === 'shutdown') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n'); rl.close(); }",
        "});",
      ].join("\n"),
    );
    writeApprovedDeepSeekCordisConfig(configPath);
    const sidecars = writeDeepSeekRuntimeSidecars(runtimePath);
    writeDeepSeekRuntimeProvenance(provenancePath, runtimePath, sidecars.ripgrepSha256, wheelSha256);

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(process.cwd(), "packages/daemon/src/cli.ts"),
        "verify-deepseek-release",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "must-not-appear-in-evidence",
          DOFE_AGENT_DEEPSEEK_JSONRPC_ENABLED: "1",
          DOFE_AGENT_DEEPSEEK_JSONRPC_MANAGED_BUNDLE: "1",
          DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE: runtimePath,
          DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE_SHA256: sha256File(runtimePath),
          DOFE_AGENT_DEEPSEEK_JSONRPC_CORDIS_CONFIG: configPath,
          DOFE_AGENT_DEEPSEEK_JSONRPC_CORDIS_CONFIG_SHA256: sha256File(configPath),
          DOFE_AGENT_DEEPSEEK_JSONRPC_RIPGREP_SHA256: sidecars.ripgrepSha256,
          DOFE_AGENT_DEEPSEEK_JSONRPC_SPAWN_HELPER_SHA256: sidecars.spawnHelperSha256 ?? "",
          DOFE_AGENT_DEEPSEEK_JSONRPC_PROVENANCE: provenancePath,
          DOFE_AGENT_DEEPSEEK_JSONRPC_SOURCE_COMMIT: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
          DOFE_AGENT_DEEPSEEK_JSONRPC_WHEEL_SHA256: wheelSha256,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes("must-not-appear-in-evidence"), false);
    assert.equal(result.stdout.includes(workDir), false);
    const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(evidence, {
      schemaVersion: 1,
      kind: "deepseek-jsonrpc-release-evidence",
      source: {
        repository: "https://github.com/iTechwu/deepseek-harness",
        ref: "dsh-v0.1.1-rc.2",
        commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
      },
      wheel: {
        filename: "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl",
        sha256: wheelSha256,
        distribution: "deepseek-harness-runtime-bin",
        version: "0.1.1rc2",
        tag: "py3-none-manylinux_2_28_x86_64",
      },
      artifacts: {
        "dsh-jsonrpc-agent": sha256File(runtimePath),
        "dsh-jsonrpc-agent-rg": sidecars.ripgrepSha256,
        ...(sidecars.spawnHelperSha256
          ? { "dsh-jsonrpc-agent-spawn-helper": sidecars.spawnHelperSha256 }
          : {}),
      },
      composition: {
        id: "dsh-v0.1.1-rc.2-default",
        sha256: sha256File(configPath),
      },
      wire: {
        protocol: "jsonrpc-2.0-ndjson",
        serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
        initialize: true,
        shutdown: true,
        stdoutPurity: true,
      },
    });

    const tampered = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      source: { commit: string };
    };
    tampered.source.commit = "0".repeat(40);
    writeFileSync(provenancePath, JSON.stringify(tampered), "utf8");
    const rejected = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(process.cwd(), "packages/daemon/src/cli.ts"),
        "verify-deepseek-release",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "must-not-appear-in-evidence",
          DOFE_AGENT_DEEPSEEK_JSONRPC_ENABLED: "1",
          DOFE_AGENT_DEEPSEEK_JSONRPC_MANAGED_BUNDLE: "1",
          DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE: runtimePath,
          DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE_SHA256: sha256File(runtimePath),
          DOFE_AGENT_DEEPSEEK_JSONRPC_CORDIS_CONFIG: configPath,
          DOFE_AGENT_DEEPSEEK_JSONRPC_CORDIS_CONFIG_SHA256: sha256File(configPath),
          DOFE_AGENT_DEEPSEEK_JSONRPC_RIPGREP_SHA256: sidecars.ripgrepSha256,
          DOFE_AGENT_DEEPSEEK_JSONRPC_SPAWN_HELPER_SHA256: sidecars.spawnHelperSha256 ?? "",
          DOFE_AGENT_DEEPSEEK_JSONRPC_PROVENANCE: provenancePath,
          DOFE_AGENT_DEEPSEEK_JSONRPC_SOURCE_COMMIT: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
          DOFE_AGENT_DEEPSEEK_JSONRPC_WHEEL_SHA256: wheelSha256,
        },
      },
    );
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr.includes("must-not-appear-in-evidence"), false);
    assert.equal(rejected.stderr.includes(workDir), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeApprovedDeepSeekCordisConfig(path: string): void {
  writeFileSync(
    path,
    readFileSync(new URL("../../../deploy/daemon/runtimes/deepseek-jsonrpc/cordis.yml", import.meta.url)),
  );
}

function writeDeepSeekRuntimeSidecars(runtimePath: string): {
  ripgrepSha256: string;
  spawnHelperSha256?: string;
} {
  const ripgrepPath = `${runtimePath}-rg`;
  writeExecutable(ripgrepPath, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "darwin") {
    return { ripgrepSha256: sha256File(ripgrepPath) };
  }
  const spawnHelperPath = `${runtimePath}-spawn-helper`;
  writeExecutable(spawnHelperPath, "#!/bin/sh\nexit 0\n");
  return {
    ripgrepSha256: sha256File(ripgrepPath),
    spawnHelperSha256: sha256File(spawnHelperPath),
  };
}

function writeDeepSeekRuntimeProvenance(
  path: string,
  runtimePath: string,
  ripgrepSha256: string,
  wheelSha256: string,
): void {
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    source: {
      repository: "https://github.com/iTechwu/deepseek-harness",
      ref: "dsh-v0.1.1-rc.2",
      commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    },
    wheel: {
      filename: "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl",
      sha256: wheelSha256,
      distribution: "deepseek-harness-runtime-bin",
      version: "0.1.1rc2",
      tag: "py3-none-manylinux_2_28_x86_64",
    },
    artifacts: {
      "dsh-jsonrpc-agent": {
        source: "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64",
        sha256: sha256File(runtimePath),
      },
      "dsh-jsonrpc-agent-rg": {
        source: "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64-rg",
        sha256: ripgrepSha256,
      },
    },
  }), "utf8");
}
