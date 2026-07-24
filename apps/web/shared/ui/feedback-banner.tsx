import type { ReactNode } from "react";
import type { FeedbackState } from "@/shared/types/feedback";

interface FeedbackBannerProps {
  readonly feedback?: FeedbackState;
  readonly tone?: "success" | "error" | "info";
  readonly title?: ReactNode;
  readonly message?: ReactNode;
  readonly children?: ReactNode;
  readonly role?: "alert" | "status";
}

export function FeedbackBanner({
  feedback,
  tone,
  title,
  message,
  children,
  role,
}: FeedbackBannerProps) {
  if (feedback && feedback.tone === "idle") {
    return null;
  }

  const resolvedTone = feedback ? feedback.tone : tone;
  if (!resolvedTone) {
    return null;
  }

  const resolvedMessage = feedback ? feedback.message : message;
  const resolvedRole = role ?? (resolvedTone === "error" ? "alert" : "status");

  return (
    <div
      aria-atomic="true"
      className={`feedback-banner feedback-banner--${resolvedTone}`}
      role={resolvedRole}
    >
      {title ? <strong>{title}</strong> : null}
      {resolvedMessage ? <span>{resolvedMessage}</span> : null}
      {children}
    </div>
  );
}
