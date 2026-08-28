"use client";

import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import type { ToastTone } from "@/shared/lib/toast-action";

interface FeedbackToastProps {
  readonly tone: ToastTone;
  readonly message: string;
  readonly isClosing?: boolean;
  readonly onDismiss?: () => void;
}

export function FeedbackToast({ tone, message, isClosing, onDismiss }: FeedbackToastProps) {
  const { tx } = useLanguage();

  return (
    <div
      aria-atomic="true"
      className={`feedback-toast feedback-toast--${tone}${isClosing ? " feedback-toast--closing" : ""}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <div className="feedback-toast__icon" aria-hidden="true">
        <AppIcon
          name={
            tone === "success"
              ? "checkCircle"
              : tone === "info"
                ? "info"
                : "alertCircle"
          }
        />
      </div>
      <div className="feedback-toast__body">
        <span>{message}</span>
      </div>
      {onDismiss ? (
        <button
          aria-label={tx("关闭通知", "Dismiss notification")}
          className="feedback-toast__close"
          onClick={onDismiss}
          type="button"
        >
          <AppIcon name="close" />
        </button>
      ) : null}
    </div>
  );
}
