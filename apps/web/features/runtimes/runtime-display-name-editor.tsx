"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateWorkspaceRuntimeDisplayNameAction } from "@/features/agents/actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { resolveLocalizedToast } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";

export function RuntimeDisplayNameEditor({
  runtimeId,
  runtimeName,
  displayName,
}: {
  runtimeId: string;
  runtimeName: string;
  displayName?: string;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const { pushToast } = useFeedbackToast();
  const incomingName = displayName?.trim() || runtimeName;
  const [committedName, setCommittedName] = useState(incomingName);
  const [name, setName] = useState(incomingName);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCommittedName(incomingName);
    setName(incomingName);
    setEditing(false);
    setError(null);
  }, [runtimeId, incomingName]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function cancel(): void {
    setName(committedName);
    setEditing(false);
    setError(null);
  }

  function submit(): void {
    const normalized = name.trim();
    if (!normalized) {
      setError(tx("请输入执行引擎名称。", "Enter a runtime name."));
      return;
    }
    if (normalized.length > 80) {
      setError(tx("名称最多 80 个字符。", "Runtime names must be 80 characters or fewer."));
      return;
    }
    if (normalized === committedName) {
      cancel();
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        const result = await updateWorkspaceRuntimeDisplayNameAction({ runtimeId, displayName: normalized });
        if (result.toast) pushToast(resolveLocalizedToast(result.toast, tx));
        setCommittedName(normalized);
        setName(normalized);
        setEditing(false);
        router.refresh();
      } catch (caught) {
        const message = caught instanceof Error
          ? caught.message
          : tx("名称保存失败，请稍后重试。", "Unable to save the runtime name. Try again.");
        setError(message);
        pushToast({ tone: "error", message });
      }
    });
  }

  return (
    <div className="runtime-display-name" aria-live="polite">
      {editing ? (
        <form
          className="runtime-display-name__form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
        >
          <label className="sr-only" htmlFor={`runtime-display-name-${runtimeId}`}>{tx("执行引擎名称", "Runtime name")}</label>
          <input
            ref={inputRef}
            id={`runtime-display-name-${runtimeId}`}
            aria-describedby={error ? `runtime-display-name-error-${runtimeId}` : undefined}
            aria-invalid={Boolean(error)}
            maxLength={80}
            onChange={(event) => setName(event.currentTarget.value)}
            value={name}
          />
          <div className="runtime-display-name__actions">
            <button className="primary-button" disabled={pending} type="submit">
              {pending ? tx("保存中", "Saving") : tx("保存名称", "Save name")}
            </button>
            <button className="modal-secondary-button" disabled={pending} onClick={cancel} type="button">
              <AppIcon name="close" />
              <span>{tx("取消", "Cancel")}</span>
            </button>
          </div>
          {error ? <p className="runtime-display-name__error" id={`runtime-display-name-error-${runtimeId}`} role="alert">{error}</p> : null}
        </form>
      ) : (
        <div className="runtime-display-name__readout">
          <h1>{committedName}</h1>
          <button
            aria-label={tx("编辑执行引擎名称", "Edit runtime name")}
            className="runtime-display-name__edit"
            onClick={() => setEditing(true)}
            title={tx("编辑执行引擎名称", "Edit runtime name")}
            type="button"
          >
            <AppIcon name="edit" />
          </button>
        </div>
      )}
    </div>
  );
}
