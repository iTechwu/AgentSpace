// 任务队列 helper：延迟阈值 + 排队任务 inputJson 的标题安全解析。

export const TASK_QUEUE_DELAY_THRESHOLD_MS = 10_000;

export function safeReadTaskTitle(inputJson: string): string | undefined {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    return typeof parsed.title === "string" ? parsed.title : undefined;
  } catch {
    return undefined;
  }
}
