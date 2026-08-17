import {
  listActivePagerAlertStatesSync,
  markPagerAlertClearedSync,
  upsertPagerAlertStateSync,
} from "@dofe-agent/db";
import type { DataProtectionAlert } from "../employees/data-protection-health.ts";

/**
 * Optional external paging / on-call webhook integration for data-protection alerts.
 *
 * When EXTERNAL_PAGER_WEBHOOK_URL is configured, error-level alerts are deduplicated
 * and posted as a compact JSON summary. Alert state is persisted so repeated
 * conditions ESCALATE (severity bumped after `escalateAfter` occurrences) and a
 * recovery notification is dispatched when a previously-paged alert clears.
 * The integration is intentionally simple: no retries, no queue — the caller
 * runs in a scheduled context and re-pages on the next evaluation cycle.
 */

export interface ExternalPagerConfig {
  webhookUrl?: string;
  token?: string;
  severityFilter: Set<DataProtectionAlert["severity"]>;
  /** Occurrences before an alert escalates (default 3). */
  escalateAfter?: number;
}

/**
 * Alert accepted by the pager. `alertKey` overrides the derived
 * code:employee:metric key so callers with rich metric payloads (e.g. the SLO
 * pager embeds a JSON detail blob) can keep a stable dedup/recovery key.
 */
export type PagerAlert = DataProtectionAlert & { alertKey?: string };

export interface PagerAlertPayload {
  source: "dofe-agent-data-protection";
  checkedAt: string;
  workspaceId?: string;
  alerts: Array<{
    code: string;
    severity: DataProtectionAlert["severity"] | "critical";
    message: string;
    employeeName?: string;
    metric?: string;
    value?: number;
    occurrences: number;
    escalated: boolean;
  }>;
  /** Alerts that cleared since the previous evaluation (recovery notification). */
  recovered: Array<{
    code: string;
    employeeName?: string;
    metric?: string;
    occurrences: number;
    clearedAt: string;
  }>;
}

export function readExternalPagerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ExternalPagerConfig {
  const rawFilter = env.EXTERNAL_PAGER_SEVERITY_FILTER?.trim().toLowerCase() ?? "error";
  const severities = rawFilter.split(",").map((s) => s.trim()).filter(Boolean);
  const severityFilter = new Set<DataProtectionAlert["severity"]>(
    severities.length === 0
      ? ["error"]
      : severities.filter((s): s is DataProtectionAlert["severity"] => s === "info" || s === "warning" || s === "error"),
  );
  const rawEscalate = Number.parseInt(env.EXTERNAL_PAGER_ESCALATE_AFTER?.trim() ?? "", 10);
  return {
    webhookUrl: env.EXTERNAL_PAGER_WEBHOOK_URL?.trim() || undefined,
    token: env.EXTERNAL_PAGER_TOKEN?.trim() || undefined,
    severityFilter,
    escalateAfter: Number.isFinite(rawEscalate) && rawEscalate > 1 ? rawEscalate : undefined,
  };
}

/**
 * Sends a deduplicated summary of alerts that match the configured severity filter.
 * Persists per-alert state so repeated conditions escalate and cleared conditions
 * produce a recovery notification. Returns the dispatch outcome plus escalation /
 * recovery counts. Never throws; errors are returned as a string reason.
 */
export async function sendExternalPagerAlert(options: {
  alerts: PagerAlert[];
  workspaceId?: string;
  checkedAt: string;
  config?: ExternalPagerConfig;
  /**
   * recovery 检测的告警域（state.code 集合）。必填：不同调用方共享同一张
   * pager_alert_state 表，不限定域时 SLO pager 的“无告警即恢复”会把数据保护、
   * 维护任务等其他域的活跃告警一并误清（复审 P0）。
   */
  recoveryCodes: readonly string[];
}): Promise<{ sent: boolean; reason?: string; escalatedCount?: number; recoveredCount?: number }> {
  const config = options.config ?? readExternalPagerConfigFromEnv();
  const workspaceId = options.workspaceId ?? "default";
  const escalateAfter = config.escalateAfter ?? 3;
  const webhookUrl = config.webhookUrl;
  if (!webhookUrl) {
    return { sent: false, reason: "EXTERNAL_PAGER_WEBHOOK_URL not configured." };
  }
  const filtered = dedupeAlerts(options.alerts.filter((alert) => config.severityFilter.has(alert.severity)));
  // Pager state tracks only alerts accepted by the severity filter. When an
  // error drops to warning under the default error-only filter, the prior
  // error must recover instead of remaining active indefinitely.
  const currentKeys = new Set(filtered.map(alertKey));

  // Recovery: any previously-active state in this caller's alert domain that is
  // not present in the current alert set has cleared → include it as a recovery
  // notification. States are only marked cleared AFTER the webhook delivery
  // succeeds; on failure they stay active and the recovery is re-sent on the
  // next cycle (复审 P1：发送前清除会在 webhook 失败时永久丢失 recovery)。
  // State tracking is best-effort: paging must never fail because the state
  // store is unavailable.
  const recoveryScope = new Set(options.recoveryCodes);
  const recovered: PagerAlertPayload["recovered"] = [];
  const pendingClearKeys: string[] = [];
  try {
    for (const state of listActivePagerAlertStatesSync(workspaceId)) {
      if (!recoveryScope.has(state.code) || currentKeys.has(state.alertKey)) {
        continue;
      }
      pendingClearKeys.push(state.alertKey);
      recovered.push({
        code: state.code,
        employeeName: state.employeeName,
        metric: state.metric,
        occurrences: state.occurrences,
        clearedAt: new Date().toISOString(),
      });
    }
  } catch {
    // State store unavailable — recovery detection is skipped this cycle.
  }
  if (filtered.length === 0 && recovered.length === 0) {
    // Nothing to page or recover this cycle. Recovery is only consumed when a
    // payload is actually dispatched, so an empty cycle never loses a notice.
    return { sent: false, reason: "No alerts match the configured severity filter." };
  }

  const payloadAlerts: PagerAlertPayload["alerts"] = [];
  for (const alert of filtered) {
    let occurrences = 1;
    try {
      const state = upsertPagerAlertStateSync({
        workspaceId,
        alertKey: alertKey(alert),
        code: alert.code,
        employeeName: alert.employeeName,
        metric: alert.metric,
        severity: alert.severity,
        now: options.checkedAt,
      });
      occurrences = state.occurrences;
    } catch {
      // State store unavailable — escalate from occurrences = 1.
    }
    const escalated = occurrences >= escalateAfter;
    // Escalation bumps the reported severity to critical so the on-call sees it.
    const severity = escalated ? "critical" : alert.severity;
    payloadAlerts.push({
      code: alert.code,
      severity,
      message: escalated
        ? `[ESCALATED ×${occurrences}] ${alert.message}`
        : alert.message,
      employeeName: alert.employeeName,
      metric: alert.metric,
      value: alert.value,
      occurrences,
      escalated,
    });
  }

  const payload: PagerAlertPayload = {
    source: "dofe-agent-data-protection",
    checkedAt: options.checkedAt,
    workspaceId: options.workspaceId,
    alerts: payloadAlerts,
    recovered,
  };

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (config.token) {
      headers.authorization = `Bearer ${config.token}`;
    }
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return { sent: false, reason: `Pager webhook returned ${response.status} ${response.statusText}.`, recoveredCount: recovered.length };
    }
    // Delivery succeeded — the recovery notices are now consumed, so the
    // cleared states can be retired. Best-effort: a state-store failure here
    // only means a duplicate recovery notice on the next cycle.
    try {
      for (const key of pendingClearKeys) {
        markPagerAlertClearedSync({ workspaceId, alertKey: key });
      }
    } catch {
      // State store unavailable — recovery may be re-sent next cycle.
    }
    return {
      sent: true,
      escalatedCount: payloadAlerts.filter((alert) => alert.escalated).length,
      recoveredCount: recovered.length,
    };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error), recoveredCount: recovered.length };
  }
}

function alertKey(alert: PagerAlert): string {
  return alert.alertKey ?? `${alert.code}:${alert.employeeName ?? "_"}:${alert.metric ?? "_"}`;
}

function dedupeAlerts(alerts: PagerAlert[]): PagerAlert[] {
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    const key = `${alert.code}:${alert.employeeName ?? "_"}:${alert.metric ?? "_"}:${alert.value ?? "_"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
