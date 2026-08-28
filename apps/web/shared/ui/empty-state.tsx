import type { ReactNode } from "react";

interface EmptyStateProps {
  readonly title: string;
  readonly body?: ReactNode;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly actionHref?: string;
  readonly eyebrow?: string;
  readonly variant?: "default" | "warm" | "cool";
}

export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
  actionHref,
  eyebrow,
  variant = "default",
}: EmptyStateProps) {
  return (
    <div className={`workspace-empty workspace-empty--${variant}`}>
      {eyebrow ? <span className="workspace-empty__eyebrow">{eyebrow}</span> : null}
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {actionLabel && actionHref ? (
        <a className="action-button" href={actionHref}>
          {actionLabel}
        </a>
      ) : actionLabel && onAction ? (
        <button className="action-button" onClick={onAction} type="button">
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
