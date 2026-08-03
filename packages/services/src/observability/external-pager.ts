import type { DataProtectionAlert } from "../employees/data-protection-health.ts";

/**
 * Optional external paging / on-call webhook integration for data-protection alerts.
 *
 * When EXTERNAL_PAGER_WEBHOOK_URL is configured, error-level alerts are deduplicated
 * and posted as a compact JSON summary. The integration is intentionally simple:
 * no retries, no queue, no persistence — the caller already runs in a Cron/scheduled
 * context and can rely on the next evaluation cycle to re-page if the condition
 * persists. Set EXTERNAL_PAGER_SEVERITY_FILTER to control which severities are sent.
 */

export interface ExternalPagerConfig {
  webhookUrl?: string;
  token?: string;
  severityFilter: Set<DataProtectionAlert["severity"]>;
}

export interface PagerAlertPayload {
  source: "dofe-agent-data-protection";
  checkedAt: string;
  workspaceId?: string;
  alerts: Array<{
    code: string;
    severity: DataProtectionAlert["severity"];
    message: string;
    employeeName?: string;
    metric?: string;
    value?: number;
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
  return {
    webhookUrl: env.EXTERNAL_PAGER_WEBHOOK_URL?.trim() || undefined,
    token: env.EXTERNAL_PAGER_TOKEN?.trim() || undefined,
    severityFilter,
  };
}

/**
 * Sends a deduplicated summary of alerts that match the configured severity filter.
 * Returns true if a payload was dispatched, false if no webhook is configured or no
 * alerts matched the filter. Never throws; errors are returned as a string reason.
 */
export async function sendExternalPagerAlert(options: {
  alerts: DataProtectionAlert[];
  workspaceId?: string;
  checkedAt: string;
  config?: ExternalPagerConfig;
}): Promise<{ sent: boolean; reason?: string }> {
  const config = options.config ?? readExternalPagerConfigFromEnv();
  if (!config.webhookUrl) {
    return { sent: false, reason: "EXTERNAL_PAGER_WEBHOOK_URL not configured." };
  }
  const filtered = dedupeAlerts(options.alerts.filter((alert) => config.severityFilter.has(alert.severity)));
  if (filtered.length === 0) {
    return { sent: false, reason: "No alerts match the configured severity filter." };
  }

  const payload: PagerAlertPayload = {
    source: "dofe-agent-data-protection",
    checkedAt: options.checkedAt,
    workspaceId: options.workspaceId,
    alerts: filtered.map((alert) => ({
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      employeeName: alert.employeeName,
      metric: alert.metric,
      value: alert.value,
    })),
  };

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (config.token) {
      headers.authorization = `Bearer ${config.token}`;
    }
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return { sent: false, reason: `Pager webhook returned ${response.status} ${response.statusText}.` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function dedupeAlerts(alerts: DataProtectionAlert[]): DataProtectionAlert[] {
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    const key = `${alert.code}:${alert.employeeName ?? "_"}:${alert.metric ?? "_"}:${alert.value ?? "_"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
