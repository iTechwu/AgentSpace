"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";
import { FeedbackBanner } from "@/shared/ui/feedback-banner";

interface AddContainerModalProps {
  readonly command: string;
  readonly daemonId: string;
  readonly daemonTokenId: string;
  readonly mode?: "connect" | "update";
  readonly onClose: () => void;
  readonly onSuccess: (runtimeId?: string) => void;
}

export function AddContainerModal({
  command,
  daemonId,
  daemonTokenId,
  mode = "connect",
  onClose,
  onSuccess,
}: AddContainerModalProps) {
  const { tx } = useLanguage();
  const isUpdate = mode === "update";
  const { surfaceRef, handleBackdropMouseDown, labelId } = useDialogSurface<HTMLDivElement>(onClose);
  const [copied, setCopied] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [status, setStatus] = useState<"idle" | "waiting" | "success" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const pollTimerRef = useRef<number | null>(null);
  const currentStep = status === "waiting" || status === "success" || status === "error" ? 3 : hasCopied ? 2 : 1;
  const setupSteps = [
    {
      title: tx("复制命令", "Copy command"),
      body: tx("命令包含本次接入所需的专用令牌。", "The command contains the dedicated token for this connection."),
    },
    {
      title: tx("在服务器执行", "Run on server"),
      body: isUpdate
        ? tx("使用该服务器原来的登录用户执行，等待命令结束。", "Run it as the server's original OS user and wait for it to finish.")
        : tx("在目标 Linux 或 macOS 服务器的终端中执行。", "Run it in the terminal of the target Linux or macOS server."),
    },
    {
      title: tx("检测上线", "Verify connection"),
      body: tx("返回此处开始检测，在线后会自动进入执行引擎列表。", "Return here to verify; the engine appears automatically when online."),
    },
  ];

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopyError("");
      setCopied(true);
      setHasCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setCopyError(tx("复制失败，请检查浏览器剪贴板权限后重试。", "Copy failed. Check the browser clipboard permission and try again."));
    }
  }

  async function pollStatusOnce(): Promise<void> {
    const response = await fetch(`/api/daemon/onboarding-status?daemonKey=${encodeURIComponent(daemonId)}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Polling failed with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      status: "pending" | "online" | "offline";
      runtimeCount: number;
      runtimes: Array<{ id: string; status: string }>;
    };

    if (payload.status === "online" && payload.runtimeCount > 0) {
      setStatus("success");
      setStatusMessage(
        tx(
          `检测到服务器已上线，共 ${payload.runtimeCount} 个执行引擎。`,
          `Server is online with ${payload.runtimeCount} execution engine(s).`,
        ),
      );
      onSuccess(payload.runtimes[0]?.id);
      return;
    }

    if (payload.status === "online" && payload.runtimeCount === 0) {
      setStatus("error");
      setStatusMessage(
        tx(
          "检测到服务器已上线，但没有返回可用执行引擎。请检查 provider 安装与 daemon 日志。",
          "The server is online but did not report any runnable execution engines. Check the provider installation and daemon logs.",
        ),
      );
      return;
    }

    if (payload.status === "offline") {
      setStatus("error");
      setStatusMessage(
        tx("检测到服务器已注册但当前离线，请检查目标服务器上的服务日志。", "The server registered but is currently offline. Check the service logs on the target server."),
      );
    }
  }

  function startPolling(): void {
    setStatus("waiting");
    setStatusMessage(isUpdate ? tx("正在等待服务器更新后重新上线。", "Waiting for the server to come back online after updating.") : tx("正在等待服务器上线。", "Waiting for the new server to come online."));

    void pollStatusOnce().catch((error) => {
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });

    pollTimerRef.current = window.setInterval(() => {
      void pollStatusOnce().catch((error) => {
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : String(error));
      });
    }, 3000);
  }

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (status !== "success" && status !== "error") {
      return;
    }
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [status]);

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <div aria-labelledby={labelId} aria-modal="true" className="modal-card modal-card--compact" ref={surfaceRef} role="dialog" tabIndex={-1}>
        <div className="modal-card__header">
          <div>
            <div className="agents-pane__title-row">
              <h3 id={labelId}>{isUpdate ? tx("更新执行引擎", "Update execution engine") : tx("接入服务器", "Connect server")}</h3>
            </div>
            <p className="agent-command-modal__subtitle">
              {isUpdate
                ? tx("使用一条命令安全更新现有执行引擎。", "Safely update the existing execution engine with one command.")
                : tx("约 2 分钟完成接入，当前页面会检测服务器上线状态。", "Connect in about 2 minutes; this page verifies when the server comes online.")}
            </p>
          </div>
          <button aria-label={tx("关闭弹窗", "Close modal")} className="modal-close" onClick={onClose} type="button">
            <AppIcon name="close" />
          </button>
        </div>

        <div className="modal-card__body agent-command-modal__body">
          <div className="agent-command-modal__progress" role="list">
            {setupSteps.map((step, index) => {
              const stepNumber = index + 1;
              const state = stepNumber < currentStep ? "done" : stepNumber === currentStep ? "current" : "upcoming";
              return (
                <article
                  aria-current={state === "current" ? "step" : undefined}
                  className={`agent-command-modal__progress-step agent-command-modal__progress-step--${state}`}
                  key={step.title}
                  role="listitem"
                >
                  <span className="agent-command-modal__progress-index">
                    {state === "done" ? <AppIcon name="checkCircle" /> : stepNumber}
                  </span>
                  <span>
                    <strong>{step.title}</strong>
                    <small>{step.body}</small>
                  </span>
                </article>
              );
            })}
          </div>

          <div className="agent-command-modal__workspace">
            <section className="agent-command-modal__command-panel" aria-labelledby={`${labelId}-command`}>
              <div className="agent-command-modal__section-heading">
                <div>
                  <span>{tx("步骤 1", "Step 1")}</span>
                  <h4 id={`${labelId}-command`}>{isUpdate ? tx("更新命令", "Update command") : tx("安装命令", "Install command")}</h4>
                </div>
                <span className="agent-command-modal__environment">Linux / macOS</span>
              </div>
              <p>
                {isUpdate
                  ? tx("复制后，在这台服务器原来的登录用户下执行。", "Copy and run it as the original OS user on this server.")
                  : tx("复制后，在准备接入的服务器终端中执行。", "Copy and run it in the terminal of the server you want to connect.")}
              </p>
              <textarea
                aria-label={isUpdate ? tx("更新命令", "Update command") : tx("安装命令", "Install command")}
                autoFocus
                className="agent-command-modal__textarea"
                readOnly
                rows={5}
                value={command}
              />
            </section>

            <aside className="agent-command-modal__checklist" aria-label={tx("接入前检查", "Connection checklist")}>
              <div className="agent-command-modal__section-heading">
                <div>
                  <span>{tx("接入前检查", "Before you connect")}</span>
                  <h4>{tx("服务器准备", "Server readiness")}</h4>
                </div>
              </div>
              <ul>
                <li><AppIcon name="checkCircle" /><span>{tx("可访问互联网并已安装 curl", "Internet access and curl installed")}</span></li>
                <li><AppIcon name="checkCircle" /><span>{tx("拥有当前用户的软件安装权限", "Permission to install software for the current user")}</span></li>
                <li><AppIcon name="checkCircle" /><span>{tx("支持 Codex、Claude Code、OpenCode 等 Provider", "Supports Codex, Claude Code, OpenCode, and more")}</span></li>
              </ul>
              <dl className="agent-command-modal__identifiers">
                <div><dt>{tx("服务器 ID", "Server ID")}</dt><dd>{daemonId}</dd></div>
                <div><dt>{isUpdate ? tx("令牌来源", "Token source") : tx("令牌 ID", "Token ID")}</dt><dd>{daemonTokenId}</dd></div>
              </dl>
            </aside>
          </div>

          {statusMessage ? (
            <FeedbackBanner
              feedback={{
                tone: status === "error" ? "error" : status === "waiting" ? "info" : "success",
                message: statusMessage,
              }}
            />
          ) : null}
          {copyError ? <FeedbackBanner feedback={{ tone: "error", message: copyError }} /> : null}
          <div className="agent-command-modal__notes">
            <p className="panel-note" id={`${labelId}-security-note`}>
              {tx(
                isUpdate
                  ? "命令包含新令牌，并会覆盖目标机器 daemon.env 里的旧令牌。请只在对应服务器执行，并避免泄露。"
                  : "命令包含新令牌。请立即复制，只在目标机器执行，并避免泄露。",
                isUpdate
                  ? "This command contains a fresh token and replaces the old token in daemon.env on the target machine. Run it only on that server and avoid leaking it."
                  : "This command contains a fresh token. Copy it now, run it only on the target machine, and avoid leaking it.",
              )}
            </p>
          </div>
        </div>

        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onClose} type="button">
            {tx("关闭", "Close")}
          </button>
          <button
            aria-busy={status === "waiting"}
            className="modal-secondary-button"
            disabled={!hasCopied || status === "waiting" || status === "success"}
            onClick={() => startPolling()}
            title={!hasCopied ? tx("请先复制命令", "Copy the command first") : undefined}
            type="button"
          >
            {status === "waiting"
              ? tx("正在检测...", "Verifying...")
              : status === "error"
                ? tx("重新检测", "Verify again")
                : tx("开始检测", "Start verification")}
          </button>
          <button
            aria-describedby={`${labelId}-security-note`}
            aria-live="polite"
            className="primary-button"
            onClick={() => void handleCopy()}
            type="button"
          >
            <AppIcon name={copied ? "checkCircle" : "copy"} />
            {copied ? tx("已复制", "Copied") : tx("复制命令", "Copy command")}
          </button>
        </div>
      </div>
    </div>
  );
}
