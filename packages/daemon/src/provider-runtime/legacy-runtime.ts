// 3.5-4：自 provider-runtime.ts 拆出——不经 agent-router 的 gemini/nanobot
// 执行路径（sandbox/CLI 直跑 + stdout 事件流解析）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectSandbox } from "@dofe-agent/sandbox";
import { redactText } from "../agent-router/utils.ts";
import { clearTaskOutputArtifacts } from "../bundle.ts";
import { buildProviderEnv, buildProviderRedactions, execProviderCommand } from "./provider-env.ts";
import { truncateToolOutput } from "./router-diagnostics.ts";
import type { ProviderRuntimeRecord, ProviderTaskEvent, ProviderTaskOptions } from "./types.ts";

export async function runGeminiProviderTask(
  runtime: ProviderRuntimeRecord,
  prompt: string,
  workDir: string,
  taskTimeoutMs: number,
  options: ProviderTaskOptions,
): Promise<{ output: string; sessionId?: string }> {
  clearTaskOutputArtifacts(workDir);
  const outputFile = join(workDir, "last-message.txt");
  const model = (options.modelId ?? process.env.GEMINI_MODEL) || "gemini-2.0-flash-lite";
  const providerArgs = ["--model", model, "--sandbox", "-y", prompt];
  const sandbox = await connectSandbox({
    runtimeId: runtime.id,
    workDir,
  });
  let finalOutput = "";
  let stderr = "";
  let stdoutBuffer = "";
  const providerEnv = buildProviderEnv(runtime, options.contextEnv);
  const redactions = buildProviderRedactions(providerEnv, options.skillEnvKeys);
  const result = await sandbox.exec({
    command: runtime.metadata.executablePath,
    args: providerArgs,
    timeoutMs: taskTimeoutMs,
    env: providerEnv,
    onStdout: (chunk) => {
      const value = redactText(chunk, redactions);
      stdoutBuffer += value;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (trimmed.startsWith("{")) {
          try {
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            for (const mapped of mapGeminiEvent(event)) {
              options.onEvent?.(mapped);
            }
            continue;
          } catch {
            // Fall through and treat as output.
          }
        }

        finalOutput += (finalOutput ? "\n" : "") + trimmed;
      }
    },
    onStderr: (chunk) => {
      stderr += redactText(chunk, redactions);
    },
  });

  if (stdoutBuffer.trim()) {
    finalOutput += (finalOutput ? "\n" : "") + stdoutBuffer.trim();
  }
  if (result.timedOut) {
    throw new Error(`gemini timed out after ${taskTimeoutMs}ms.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(stderr.trim() || `gemini exited with code ${result.exitCode}.`);
  }

  if (finalOutput) {
    writeFileSync(outputFile, finalOutput, "utf8");
  }

  const output = finalOutput || (existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "");
  if (!output) {
    throw new Error("gemini returned an empty response.");
  }

  return { output };
}

export async function runNanoBotProviderTask(
  runtime: ProviderRuntimeRecord,
  prompt: string,
  workDir: string,
  taskTimeoutMs: number,
  options: ProviderTaskOptions,
): Promise<{ output: string; sessionId?: string }> {
  clearTaskOutputArtifacts(workDir);
  const outputFile = join(workDir, "last-message.txt");
  const configPath = process.env.NANOBOT_CONFIG_PATH?.trim() || process.env.NANOBOT_CONFIG?.trim();
  const providerArgs = ["agent", "-w", workDir, "-m", prompt, "--no-markdown"];
  if (configPath) {
    providerArgs.splice(1, 0, "-c", configPath);
  }

  let stderr = "";
  const result = await execProviderCommand(runtime, providerArgs, workDir, taskTimeoutMs, buildNanoBotEnv(runtime, options.contextEnv), options.skillEnvKeys, {
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });

  if (result.result.timedOut) {
    throw new Error(`nanobot timed out after ${taskTimeoutMs}ms.`);
  }
  if (result.result.exitCode !== 0) {
    throw new Error(stderr.trim() || `nanobot exited with code ${result.result.exitCode}.`);
  }

  const output = result.stdout.trim();
  if (output) {
    writeFileSync(outputFile, output, "utf8");
  }

  if (!output) {
    throw new Error("nanobot returned an empty response.");
  }

  return { output };
}

function mapGeminiEvent(event: Record<string, unknown>): ProviderTaskEvent[] {
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "tool_call" || type === "function_call") {
    return [{
      type: "tool_use",
      tool: typeof event.name === "string" ? event.name : "unknown",
      content: typeof event.name === "string" ? event.name : "tool call",
      inputJson: typeof event.input === "object" && event.input ? event.input as Record<string, unknown> : undefined,
      refId: readProviderRefId(event),
    }];
  }

  if (type === "tool_result" || type === "function_response") {
    return [{
      type: "tool_result",
      tool: typeof event.name === "string" ? event.name : undefined,
      content: typeof event.output === "string" ? truncateToolOutput(event.output) : "completed",
      output: typeof event.output === "string" ? truncateToolOutput(event.output) : undefined,
      refId: readProviderRefId(event),
    }];
  }

  return [];
}

function readProviderRefId(value: Record<string, unknown>): string | undefined {
  for (const key of ["id", "tool_use_id", "toolUseId", "call_id", "callId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function buildNanoBotEnv(runtime: ProviderRuntimeRecord, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildProviderEnv(runtime, extra);

  const model = process.env.NANOBOT_MODEL?.trim();
  if (model && !env.NANOBOT_AGENTS__DEFAULTS__MODEL) {
    env.NANOBOT_AGENTS__DEFAULTS__MODEL = model;
  }

  return env;
}
