"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  cancelProvisioningAction,
  deleteManagedRuntimeAction,
  retryProvisioningAction,
  rotateManagedRuntimeCredentialAction,
  stopManagedRuntimeAction,
} from "@/features/runtimes/actions";
import { ManagedRuntimeList } from "@/features/runtimes/managed-runtime-list";
import { ManagedRuntimeCreationWizard } from "@/features/runtimes/managed-runtime-creation-wizard";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { useLanguage } from "@/features/i18n/language-provider";
import { WorkbenchPageHeader } from "@/shared/ui/workbench-page-header";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { ManagedRuntimeListItem, PublicRuntimeProvisioningTaskRecord } from "@dofe-agent/services";

export function RuntimesPageClient({
  workspaceSlug,
  isAdmin,
  initialTasks,
  initialRuntimes,
  targetServers,
}: {
  workspaceSlug: string;
  isAdmin: boolean;
  initialTasks: PublicRuntimeProvisioningTaskRecord[];
  initialRuntimes: ManagedRuntimeListItem[];
  targetServers: Array<{ deviceName: string; status: "online" | "offline" }>;
}) {
  const router = useRouter();
  const { tx } = useLanguage();
  const [pending, startTransition] = useTransition();

  if (!isAdmin) {
    return (
      <section className="page-shell runtimes-page">
        <WorkbenchPageHeader
          description={tx("只有工作区所有者和管理员可以管理执行引擎。", "Only workspace owners and admins can manage runtimes.")}
          eyebrow={tx("数字员工", "AI employees")}
          title={tx("执行引擎管理", "Runtime management")}
        />
      </section>
    );
  }

  function refresh() {
    startTransition(() => router.refresh());
  }

  return (
    <section className="page-shell runtimes-page">
      <WorkbenchPageHeader
        description={tx(
          "系统优先复用兼容的共享执行能力，缺失时自动在托管节点通过 Docker 部署。",
          "Compatible shared capacity is reused first; otherwise it is deployed with Docker on a managed node.",
        )}
        eyebrow={tx("数字员工", "AI employees")}
        meta={(
          <>
            <span>{tx(`${targetServers.filter((node) => node.status === "online").length} 个在线节点`, `${targetServers.filter((node) => node.status === "online").length} online nodes`)}</span>
            <span>{tx(`${initialTasks.length} 个部署任务`, `${initialTasks.length} provisioning tasks`)}</span>
          </>
        )}
        title={tx("执行能力管理", "Execution capacity")}
      />

      <div className="runtimes-page__content">
        <ManagedRuntimeCreationWizard
          targetServers={targetServers}
          onResolved={(result) => {
            if (result.kind === "reused") {
              refresh();
              return;
            }
            router.push(buildWorkspacePath(workspaceSlug, `/runtimes/${result.taskId}`));
          }}
        />

        <details className="runtime-operations">
          <summary>
            <span>{tx("运维详情", "Operations")}</span>
            <small>{tx(
              `${initialRuntimes.length} 个运行环境 · ${initialTasks.length} 个部署任务`,
              `${initialRuntimes.length} environments · ${initialTasks.length} provisioning tasks`,
            )}</small>
          </summary>
          <div className="runtime-operations__content">
          <section className="runtimes-panel" aria-labelledby="runtime-list-title">
          <div className="runtimes-panel__header">
            <div>
              <span>{tx("资源", "Resources")}</span>
              <h2 id="runtime-list-title">{tx("运行环境", "Runtime environments")}</h2>
            </div>
          </div>
          <ManagedRuntimeList
            runtimes={initialRuntimes}
            workspaceSlug={workspaceSlug}
            pending={pending}
            onRotate={(runtimeId) =>
              startTransition(async () => {
                await rotateManagedRuntimeCredentialAction(runtimeId, "manual");
                refresh();
              })
            }
          />
        </section>

        <section className="runtimes-panel" aria-labelledby="provisioning-task-title">
          <div className="runtimes-panel__header">
            <div>
              <span>{tx("部署", "Provisioning")}</span>
              <h2 id="provisioning-task-title">{tx("部署任务", "Provisioning tasks")}</h2>
            </div>
          </div>
          {initialTasks.length === 0 ? (
            <div className="runtimes-empty">
              <strong>{tx("暂无部署任务", "No provisioning tasks")}</strong>
              <p>{tx("创建托管执行引擎后，部署进度会显示在这里。", "Provisioning progress will appear here after you create a managed runtime.")}</p>
            </div>
          ) : (
          <ul className="runtime-task-list">
            {initialTasks.map((task) => (
              <li key={task.id} className="runtime-task-list__item">
                <Link
                  href={buildWorkspacePath(workspaceSlug, `/runtimes/${task.id}`)}
                  className="runtime-task-list__link"
                >
                  {formatDaemonProviderLabel(task.runtimeType)}
                </Link>
                <StatusBadge status={task.status} />
                <span className="runtime-task-list__progress">
                  {task.stage} · {task.progressPercent}%
                </span>
                {task.runtimeCredentialId ? (
                  <span className="runtime-task-list__credential">
                    {task.runtimeCredentialId.slice(0, 12)}
                  </span>
                ) : null}
                <div className="runtime-task-list__actions">
                  {task.status === "failed" || task.status === "retrying" ? (
                    <ActionButton
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await retryProvisioningAction(task.id);
                          refresh();
                        })
                      }
                    >
                      {tx("重试", "Retry")}
                    </ActionButton>
                  ) : null}
                  {task.status === "running" || task.status === "queued" || task.status === "retrying" || task.status === "failed" ? (
                    <ActionButton
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await cancelProvisioningAction(task.id, "ui_cancel");
                          refresh();
                        })
                      }
                    >
                      {tx("取消", "Cancel")}
                    </ActionButton>
                  ) : null}
                  {task.status === "succeeded" && task.runtimeId ? (
                    <>
                      <ActionButton
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await rotateManagedRuntimeCredentialAction(task.runtimeId!, "manual");
                            refresh();
                          })
                        }
                      >
                        {tx("轮换凭证", "Rotate credential")}
                      </ActionButton>
                      <ActionButton
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await stopManagedRuntimeAction(task.runtimeId!, "ui_stop");
                            refresh();
                          })
                        }
                      >
                        {tx("停止", "Stop")}
                      </ActionButton>
                      <ActionButton
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await deleteManagedRuntimeAction(task.runtimeId!, "ui_delete");
                            refresh();
                          })
                        }
                      >
                        {tx("删除", "Delete")}
                      </ActionButton>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          )}
        </section>
          </div>
        </details>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: PublicRuntimeProvisioningTaskRecord["status"] }) {
  const { tx } = useLanguage();
  const label: Record<PublicRuntimeProvisioningTaskRecord["status"], string> = {
    queued: tx("排队中", "Queued"),
    running: tx("部署中", "Running"),
    retrying: tx("重试中", "Retrying"),
    cancelling: tx("取消中", "Cancelling"),
    succeeded: tx("已完成", "Succeeded"),
    failed: tx("失败", "Failed"),
    cancelled: tx("已取消", "Cancelled"),
  };
  return (
    <span className={`runtime-status runtime-status--${status}`}>{label[status]}</span>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="action-button runtime-action-button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
