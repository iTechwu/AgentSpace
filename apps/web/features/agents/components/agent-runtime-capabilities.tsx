// AgentDetail 设置页的 Runtime 能力面板（从 agent-detail.tsx 拆出，3.4-2）：
// 展示绑定执行引擎实时继承的 CLI 应用与 MCP 连接。

import Link from "next/link";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import type { WorkspaceAgentRecord } from "@/features/dashboard/data";

export function AgentRuntimeCapabilities({
  capabilities,
  runtimeManagementHref,
  runtimeName,
}: {
  capabilities: WorkspaceAgentRecord["runtimeCapabilities"];
  runtimeManagementHref?: string;
  runtimeName: string;
}) {
  const { tx } = useLanguage();
  const cliApps = capabilities?.cliApps ?? [];
  const mcpServices = capabilities?.mcpServices ?? [];
  return (
    <section className="agent-runtime-capabilities" aria-label={tx("AI 员工 Runtime 能力", "AI employee runtime capabilities")}>
      <div className="agent-runtime-capabilities__heading">
        <div>
          <span>{tx("随执行引擎实时继承", "Inherited live from runtime")}</span>
          <h4>{tx("可用 CLI 与 MCP", "Available CLI and MCP")}</h4>
          <small>{runtimeName}</small>
        </div>
        <div className="agent-runtime-capabilities__heading-meta">
          <span>{tx(`${cliApps.length} 个 CLI · ${mcpServices.length} 个 MCP`, `${cliApps.length} CLI · ${mcpServices.length} MCP`)}</span>
          {runtimeManagementHref ? <Link href={runtimeManagementHref}>{tx("管理 Runtime 能力", "Manage runtime capabilities")}</Link> : null}
        </div>
      </div>
      <div className="agent-runtime-capabilities__columns">
        <section aria-labelledby="agent-runtime-cli-title">
          <div className="agent-runtime-capabilities__column-heading"><AppIcon name="terminal" /><strong id="agent-runtime-cli-title">CLI</strong><span>{cliApps.length}</span></div>
          {cliApps.length > 0 ? (
            <ul>{cliApps.map((app) => <li key={`${app.source}:${app.name}`}><span><strong>{app.displayName}</strong><small>{app.entryPoint || app.name} · {app.version || tx("版本未知", "unknown version")}</small></span><span className="status-chip status-chip--positive">{tx("已安装", "Installed")}</span></li>)}</ul>
          ) : <p>{tx("绑定的 Runtime 暂无 CLI 应用。", "The bound runtime has no CLI apps.")}</p>}
        </section>
        <section aria-labelledby="agent-runtime-mcp-title">
          <div className="agent-runtime-capabilities__column-heading"><AppIcon name="containers" /><strong id="agent-runtime-mcp-title">MCP</strong><span>{mcpServices.length}</span></div>
          {mcpServices.length > 0 ? (
            <ul>{mcpServices.map((service) => <li key={service.id}><span><strong>{service.catalogDisplayName}</strong><small>{service.transport} · {service.approvedToolCount} {tx("个已授权工具", "approved tools")}</small></span><span className="status-chip status-chip--positive">{tx("已连接", "Connected")}</span></li>)}</ul>
          ) : <p>{tx("绑定的 Runtime 暂无 MCP 连接。", "The bound runtime has no MCP connections.")}</p>}
        </section>
      </div>
      <p className="agent-runtime-capabilities__note">{tx("这里展示 Runtime 的实时能力，不会为 AI 员工复制安装。变更 Runtime 能力后，本列表会自动更新。", "This is a live view of runtime capabilities; capabilities are not copied to the employee.")}</p>
    </section>
  );
}
