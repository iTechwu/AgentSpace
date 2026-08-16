import type { Sandbox } from "./interface.ts";
import type { SandboxConnectOptions } from "./types.ts";
import { LocalSandbox } from "./local/local-sandbox.ts";

export const SANDBOX_PROVIDER_ENV = "DOFE_AGENT_SANDBOX_PROVIDER";
export const LEGACY_SANDBOX_PROVIDER_ENV = "SANDBOX_PROVIDER";

// 3.5-5：Cube provider 已整体移除——生命周期 scaffold 可用但 exec() 数据面
// 自落地起未实现（TODO 46 无进展，双开关打开只会真实创建云沙箱后必抛
// NOT_READY）。恢复远端沙箱时从 git 历史取回 cube/ 并补齐 envd/E2B exec。
// 此处 fail-closed：显式选择 local 之外的 provider 立即报错，绝不落到
// 半可用的实现。
export async function connectSandbox(options: SandboxConnectOptions): Promise<Sandbox> {
  const env = options.env ?? process.env;
  const rawValue = options.provider ?? env[SANDBOX_PROVIDER_ENV] ?? env[LEGACY_SANDBOX_PROVIDER_ENV] ?? "local";
  const provider = rawValue.trim().toLowerCase();

  if (provider !== "local") {
    throw new Error(
      `Unsupported sandbox provider "${rawValue}". Only "local" is available; remote sandbox providers were removed until their exec transport is implemented.`,
    );
  }

  return new LocalSandbox(options.workDir, options.runtimeId);
}
