import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/features/auth/server-auth";
import { listAuditLogsSync } from "@dofe-agent/db";
import { PLATFORM_AUDIT_WORKSPACE_ID } from "@dofe-agent/services";
import { AuditLogView } from "@/features/audit/audit-log-view";
import { parseAuditLogFilters } from "@/features/audit/audit-log-filters";
import { PlatformConsoleShell } from "@/features/platform/platform-console-shell";

export const metadata: Metadata = {
  title: "平台审计",
};

export const dynamic = "force-dynamic";

export default async function PlatformAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  const user = await getCurrentUser();
  if (!user?.isPlatformAdmin) {
    redirect("/");
  }

  const filters = parseAuditLogFilters(await searchParams);
  const logs = listAuditLogsSync(PLATFORM_AUDIT_WORKSPACE_ID, {
    ...filters,
    source: "platform_admin",
    limit: 500,
  });

  return (
    <PlatformConsoleShell
      activeSection="audit"
      operator={{ displayName: user.displayName }}
      pageClassName="platform-console-page--audit"
    >
      <AuditLogView
        clearHref="/platform/audit"
        description="仅平台运维可见的操作日志。"
        eyebrow="平台治理"
        filters={filters}
        logs={logs}
        title="平台审计看板"
      />
    </PlatformConsoleShell>
  );
}
