import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";

export type ToastTone = "success" | "error" | "info" | "warning";

export interface ResolvedToastInput {
  readonly tone: ToastTone;
  readonly message: string;
  readonly durationMs?: number;
}

export interface LocalizedToastDescriptor {
  readonly tone: ToastTone;
  readonly zh: string;
  readonly en: string;
  readonly durationMs?: number;
}

export interface ActionToastResult<T = void> {
  readonly data: T;
  readonly invalidation?: WorkspaceInvalidationEvent;
  readonly toast?: LocalizedToastDescriptor;
}

export function actionToastResult<T>(
  data: T,
  toast?: LocalizedToastDescriptor,
  invalidation?: WorkspaceInvalidationEvent,
): ActionToastResult<T> {
  return { data, invalidation, toast };
}

export function successToast(zh: string, en: string, durationMs?: number): LocalizedToastDescriptor {
  return { tone: "success", zh, en, durationMs };
}

export function errorToast(zh: string, en: string, durationMs?: number): LocalizedToastDescriptor {
  return { tone: "error", zh, en, durationMs };
}

export function infoToast(zh: string, en: string, durationMs?: number): LocalizedToastDescriptor {
  return { tone: "info", zh, en, durationMs };
}

export function warningToast(zh: string, en: string, durationMs?: number): LocalizedToastDescriptor {
  return { tone: "warning", zh, en, durationMs };
}

export function resolveLocalizedToast(
  toast: LocalizedToastDescriptor,
  tx: (zh: string, en: string) => string,
): ResolvedToastInput {
  return {
    tone: toast.tone,
    message: tx(toast.zh, toast.en),
    durationMs: toast.durationMs,
  };
}

export async function runToastAction<T>(input: {
  action: () => Promise<ActionToastResult<T>>;
  onSuccess?: (data: T, result: ActionToastResult<T>) => void | Promise<void>;
  pushToast: (toast: ResolvedToastInput) => string;
  tx: (zh: string, en: string) => string;
  fallbackError?: { zh: string; en: string };
}): Promise<void> {
  try {
    const result = await input.action();
    if (result.toast) {
      input.pushToast(resolveLocalizedToast(result.toast, input.tx));
    }
    await input.onSuccess?.(result.data, result);
  } catch (error) {
    const fallbackError = input.fallbackError ?? {
      zh: "操作失败，请稍后重试。",
      en: "Operation failed. Please try again.",
    };
    input.pushToast({
      tone: "error",
      message: error instanceof Error ? error.message : input.tx(fallbackError.zh, fallbackError.en),
    });
  }
}
