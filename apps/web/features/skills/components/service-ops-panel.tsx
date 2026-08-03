"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import {
  listSkillServiceOpsViewAction,
  retireManagedSkillServiceAction,
  type SkillServiceOpsView,
} from "@/features/skills/service-ops-actions";

const SERVICE_STATUS_LABELS: Record<string, [string, string]> = {
  provisioning: ["部署中", "Provisioning"],
  ready: ["已就绪", "Ready"],
  degraded: ["已降级", "Degraded"],
  retired: ["已退役", "Retired"],
};

/**
 * 支撑服务运维面板（P1-3）：展示 Skill 受管服务的目录与实例
 * （状态/健康/绑定数/操作历史），可发起退役。
 */
export function ServiceOpsPanel() {
  const { tx } = useLanguage();
  const { pushToast } = useFeedbackToast();
  const [view, setView] = useState<SkillServiceOpsView>();
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    void listSkillServiceOpsViewAction()
      .then(setView)
      .catch(() => setView(undefined))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const services = view?.services ?? [];
  if (loading) {
    return <p className="form-field__hint">{tx("正在加载支撑服务…", "Loading support services…")}</p>;
  }
  if (services.length === 0) {
    return null;
  }

  const retire = (serviceId: string) => {
    if (!window.confirm(tx("退役该受管服务？依赖它的 Skill 安装将被阻断。", "Retire this managed service? Installations depending on it will be blocked."))) return;
    setPendingId(serviceId);
    void runToastAction({
      action: () => retireManagedSkillServiceAction({ serviceId }),
      pushToast,
      tx,
      fallbackError: { zh: "退役失败。", en: "Failed to retire." },
      onSuccess: reload,
    }).finally(() => setPendingId(""));
  };

  return (
    <section className="skill-service-ops">
      <header className="skill-service-ops__header">
        <AppIcon name="containers" />
        <h3>{tx(`支撑服务运维（${services.length}）`, `Support service operations (${services.length})`)}</h3>
        <button aria-label={tx("刷新", "Refresh")} className="action-button action-button--compact action-button--icon" onClick={reload} type="button"><AppIcon name="refresh" /></button>
      </header>
      <ul className="skill-service-ops__list">
        {services.map((service) => {
          const [statusZh, statusEn] = SERVICE_STATUS_LABELS[service.status] ?? [service.status, service.status];
          const retired = service.status === "retired";
          return (
            <li className="skill-service-ops__card" key={service.id}>
              <div className="skill-service-ops__summary">
                <strong>{service.catalogSlug}</strong>
                <code>{service.catalogVersion}</code>
                <span className={service.status === "degraded" ? "skill-service-ops__degraded" : service.status === "ready" ? "skill-service-ops__ready" : ""}>
                  {tx(statusZh, statusEn)}
                </span>
                <span className="skill-service-ops__runtime">{service.runtimeName}</span>
                <span className="skill-service-ops__meta">
                  {tx("健康", "health")}: {service.health ?? "—"} · {tx("绑定", "bindings")}: {service.bindingCount}
                </span>
              </div>
              {service.operations.length > 0 ? (
                <details className="skill-service-ops__ops">
                  <summary>{tx("操作历史", "Operation history")}</summary>
                  <ul>
                    {service.operations.map((operation) => (
                      <li key={operation.id}>
                        <code>{operation.operation}</code> · {operation.status} · {new Date(operation.createdAt).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {!retired ? (
                <div className="skill-service-ops__actions">
                  <button className="modal-secondary-button" disabled={pendingId === service.id} onClick={() => retire(service.id)} type="button">
                    <AppIcon name="trash" />{tx("退役", "Retire")}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
