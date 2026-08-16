// 3.5-4：自 remote-daemon.ts 拆出——跨模块共享的小工具（不进公共 barrel 面）。
import { tailAndRedact } from "../runtime-apps.ts";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readErrorTail(error: unknown, key: "stdout" | "stderr"): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? tailAndRedact(value) : undefined;
}
