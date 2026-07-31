import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { listManagedRuntimesForWorkspaceSync, resolveAgentRuntimeMode } from "@dofe-agent/services";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";
import { getWorkspacePageContext } from "../../../_lib/workspace-page-context";
import { ManagedRuntimeSharingToggle } from "@/features/runtimes/managed-runtime-sharing-toggle";
import { ManagedRuntimeModelSettings } from "@/features/runtimes/managed-runtime-model-settings";
import { AppIcon } from "@/shared/ui/app-icon";

export const dynamic = "force-dynamic";

export default async function ManagedRuntimeDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; runtimeId: string }>;
}) {
  const { workspaceSlug, runtimeId } = await params;
  if (resolveAgentRuntimeMode() !== "remote") notFound();

  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  if (!hasWorkspaceRole(workspaceContext.currentMembership.role, "admin")) notFound();
  const runtime = listManagedRuntimesForWorkspaceSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
  }).find((item) => item.id === runtimeId);
  if (!runtime) notFound();

  const presentation = presentRuntimeState(runtime.provisioningState, runtime.status);

  return (
    <section className="page-shell runtime-detail runtime-detail--stable">
      <header className="runtime-detail__header">
        <Link
          className="runtime-detail__back"
          href={buildWorkspacePath(workspaceContext.currentWorkspace.slug, "/runtimes")}
        >
          <AppIcon name="arrowLeft" />
          返回执行引擎列表
        </Link>
        <div className="runtime-detail__identity">
          <div className="runtime-detail__provider" aria-hidden="true">
            {formatDaemonProviderLabel(runtime.provider).slice(0, 1)}
          </div>
          <div className="runtime-detail__title">
            <div className="runtime-detail__eyebrow">托管执行引擎</div>
            <h1>{runtime.name}</h1>
            <p>{formatDaemonProviderLabel(runtime.provider)} 部署</p>
          </div>
          <div className="runtime-detail__status" aria-label={`Status: ${presentation.label}`}>
            <span className={`runtime-status runtime-status--${presentation.tone}`}>{presentation.label}</span>
            <span>{presentation.detail}</span>
          </div>
        </div>
      </header>

      <div className="runtime-detail__layout">
        <section className="runtime-detail__section runtime-detail__section--configuration" aria-labelledby="runtime-configuration-title">
          <div className="runtime-detail__section-heading">
            <div>
              <span>运行概览</span>
              <h2 id="runtime-configuration-title">连接信息</h2>
            </div>
            <p>查看当前连接状态，以及用于接收任务的执行身份。</p>
          </div>
          <dl className="runtime-detail__fields">
            <RuntimeField label="默认模型" value={runtime.defaultModel || "跟随系统默认"} />
            <RuntimeField label="支持协议" value={runtime.protocols.join(", ") || "暂未上报"} />
            <RuntimeField label="最近心跳" value={formatHeartbeat(runtime.lastHeartbeatAt)} />
            <RuntimeField label="运行凭据" value={formatCredential(runtime.managedCredentialId)} mono />
          </dl>
        </section>

        <section className="runtime-detail__section runtime-detail__section--usage" aria-labelledby="runtime-usage-title">
          <div className="runtime-detail__section-heading">
            <div>
              <span>容量与费用</span>
              <h2 id="runtime-usage-title">当前周期</h2>
            </div>
            <p>Token 用量为本地采集，费用以 models 对账结果为准。</p>
          </div>
          <dl className="runtime-detail__metrics">
            <RuntimeMetric label="AI 员工" value={String(runtime.assignedEmployeeCount)} />
            <RuntimeMetric label="任务" value={String(runtime.periodTaskCount ?? 0)} />
            <RuntimeMetric label="输入 Token" value={formatTokens(runtime.periodInputTokens ?? 0)} />
            <RuntimeMetric label="输出 Token" value={formatTokens(runtime.periodOutputTokens ?? 0)} />
            <RuntimeMetric
              label="当前估算"
              value={(runtime.unpricedUsageCount ?? 0) > 0 && (runtime.periodEstimatedCostUsd ?? 0) === 0
                ? "尚未计价"
                : formatMoney(runtime.periodEstimatedCostUsd ?? 0, runtime.periodCurrency)}
              warning={(runtime.unpricedUsageCount ?? 0) > 0}
            />
            <RuntimeMetric
              label="实际扣费"
              value={(runtime.pendingUsageCount ?? 0) > 0 && runtime.periodActualCostUsd === 0
                ? "待对账"
                : formatMoney(runtime.periodActualCostUsd, runtime.periodCurrency)}
            />
          </dl>
          {(runtime.unpricedUsageCount ?? 0) > 0 || (runtime.pendingUsageCount ?? 0) > 0 || (runtime.unallocatedUsageCount ?? 0) > 0 ? (
            <div className="runtime-detail__usage-status" role="status">
              {(runtime.unpricedUsageCount ?? 0) > 0 ? <span>{runtime.unpricedUsageCount} 条用量尚未取得 models 生效价</span> : null}
              {(runtime.pendingUsageCount ?? 0) > 0 ? <span>{runtime.pendingUsageCount} 条用量等待对账</span> : null}
              {(runtime.unallocatedUsageCount ?? 0) > 0 ? (
                <span className="runtime-detail__usage-status--warning">
                  {runtime.unallocatedUsageCount} 条用量未归属{runtime.unallocatedCostUsd > 0 ? `，涉及 ${formatMoney(runtime.unallocatedCostUsd, runtime.periodCurrency)}` : ""}
                </span>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      <div className="runtime-detail__settings" aria-label="执行引擎设置">
        <section className="runtime-detail__section runtime-detail__section--model" aria-labelledby="runtime-model-title">
          <div className="runtime-detail__section-heading">
            <div>
              <span>模型策略</span>
              <h2 id="runtime-model-title">默认模型</h2>
            </div>
            <p>当任务没有指定模型时，使用此处设置的语言模型。</p>
          </div>
          <ManagedRuntimeModelSettings runtimeId={runtime.id} defaultModel={runtime.defaultModel} />
        </section>

        <section className="runtime-detail__section runtime-detail__section--sharing" aria-labelledby="runtime-sharing-title">
          <div className="runtime-detail__section-heading">
            <div>
              <span>分配规则</span>
              <h2 id="runtime-sharing-title">允许分配给 AI 员工</h2>
            </div>
            <p>控制新创建的 AI 员工能否使用此执行引擎。</p>
          </div>
          <ManagedRuntimeSharingToggle
            runtimeId={runtime.id}
            allowNewEmployeeSharing={runtime.allowNewEmployeeSharing !== false}
          />
        </section>
      </div>
    </section>
  );
}

function RuntimeField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="runtime-detail__field">
      <dt>{label}</dt>
      <dd className={mono ? "runtime-detail__value--mono" : undefined}>{value}</dd>
    </div>
  );
}

function RuntimeMetric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className="runtime-detail__metric">
      <dt>{label}</dt>
      <dd className={warning ? "runtime-detail__metric--warning" : undefined}>{value}</dd>
    </div>
  );
}

function presentRuntimeState(
  state: "managed" | "credential_recovering" | "needs_attention" | "legacy",
  status: "online" | "offline",
): { label: string; detail: string; tone: "available" | "recovering" | "attention" | "stopped" } {
  if (state === "credential_recovering") return { label: "凭据恢复中", detail: "正在更新安全访问凭据", tone: "recovering" };
  if (state === "needs_attention") return { label: "需要处理", detail: "需要管理员介入", tone: "attention" };
  if (state === "legacy") return { label: "已停止", detail: "不再接收新任务", tone: "stopped" };
  return status === "online"
    ? { label: "可用", detail: "可以接收任务", tone: "available" }
    : { label: "离线", detail: "等待节点心跳", tone: "attention" };
}

function formatHeartbeat(value?: string): string {
  if (!value) return "从未上报";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCredential(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatCny(value: number): string {
  return `¥${value.toFixed(4)}`;
}

function formatMoney(value: number, currency?: string): string {
  const normalized = currency?.trim().toUpperCase();
  return !normalized || normalized === "CNY" ? formatCny(value) : `${value.toFixed(4)} ${normalized}`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}
