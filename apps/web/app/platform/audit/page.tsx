import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/features/auth/server-auth";
import { listAuditLogsSync } from "@dofe-agent/db";
import { PLATFORM_AUDIT_WORKSPACE_ID } from "@dofe-agent/services";
import { AuditLogView, parseAuditLogFilters } from "@/features/audit/audit-log-view";

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
    <main className="platform-audit-page">
      <header className="platform-audit-header">
        <h1>平台审计看板</h1>
        <p>仅平台运维可见的操作日志</p>
      </header>

      <section className="platform-audit-table-wrap"><AuditLogView logs={logs} filters={filters} clearHref="/platform/audit" /></section>
    </main>
  );
}
