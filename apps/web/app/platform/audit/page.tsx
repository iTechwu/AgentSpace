import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/features/auth/server-auth";
import { DEFAULT_WORKSPACE_ID, listAuditLogsSync } from "@dofe-agent/db";

export const metadata: Metadata = {
  title: "平台审计",
};

export const dynamic = "force-dynamic";

export default async function PlatformAuditPage(): Promise<ReactNode> {
  const user = await getCurrentUser();
  if (!user?.isPlatformAdmin) {
    redirect("/");
  }

  const logs = listAuditLogsSync(DEFAULT_WORKSPACE_ID, {
    source: "platform_admin",
    limit: 500,
  });

  return (
    <main className="platform-audit-page">
      <header className="platform-audit-header">
        <h1>平台审计看板</h1>
        <p>仅平台运维可见的操作日志</p>
      </header>

      <section className="platform-audit-table-wrap">
        <table className="platform-audit-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>事件代码</th>
              <th>标题</th>
              <th>备注</th>
              <th>数据</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{new Date(log.createdAt).toLocaleString("zh-CN")}</td>
                <td>{log.code ?? "—"}</td>
                <td>{log.title}</td>
                <td>{log.note}</td>
                <td>
                  <pre className="platform-audit-data">
                    {formatAuditData(log.dataJson)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && <p className="platform-audit-empty">暂无平台运维审计记录。</p>}
      </section>
    </main>
  );
}

function formatAuditData(dataJson: string): string {
  try {
    const parsed = JSON.parse(dataJson) as Record<string, unknown>;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return dataJson;
  }
}
