// 3.5-4：自 provider-runtime.ts 拆出——任务失败元数据读取与错误 category
// 归一化，供 task-execution 等调用方把结构化错误映射回 API 字段。
import type { ProviderErrorCategory } from "@dofe-agent/domain";
import { ProviderTaskExecutionError, type ProviderTaskStructuredError } from "./types.ts";

export function readProviderTaskFailureMetadata(error: unknown): {
  sessionId?: string;
  workDir?: string;
  providerError?: ProviderTaskStructuredError;
} | undefined {
  if (!(error instanceof ProviderTaskExecutionError)) {
    return undefined;
  }

  return {
    sessionId: error.sessionId,
    workDir: error.workDir,
    providerError: error.providerError,
  };
}

export function normalizeProviderTaskErrorCategory(
  category: ProviderTaskStructuredError["category"] | undefined,
): ProviderErrorCategory | undefined {
  return (
    category === "provider" ||
    category === "runtime" ||
    category === "configuration" ||
    category === "auth" ||
    category === "profile" ||
    category === "model" ||
    category === "tool" ||
    category === "protocol" ||
    category === "unknown"
  )
    ? category
    : undefined;
}
