import type { ReactNode } from "react";
import Link from "next/link";
import { AppIcon } from "@/shared/ui/app-icon";

type PlatformSection = "overview" | "audit";

interface PlatformConsoleShellProps {
  readonly activeSection: PlatformSection;
  readonly children: ReactNode;
  readonly operator: {
    readonly displayName: string;
  };
  readonly pageClassName?: string;
}

export function PlatformConsoleShell({
  activeSection,
  children,
  operator,
  pageClassName,
}: PlatformConsoleShellProps) {
  const pageClasses = pageClassName
    ? `platform-console-page ${pageClassName}`
    : "platform-console-page";

  return (
    <div className="platform-console-shell">
      <aside className="platform-console-sidebar">
        <div className="platform-console-brand">
          <span className="platform-console-brand__mark" aria-hidden="true">D</span>
          <div>
            <strong>DOFE OPS</strong>
            <span>平台运维中心</span>
          </div>
        </div>

        <nav className="platform-console-nav" aria-label="平台运维导航">
          <span className="platform-console-nav__label">工作台</span>
          <PlatformNavLink active={activeSection === "overview"} href="/platform" icon="performance">
            运行概览
          </PlatformNavLink>
          <PlatformNavLink active={activeSection === "audit"} href="/platform/audit" icon="approvals">
            平台审计
          </PlatformNavLink>
          <span className="platform-console-nav__label">快速入口</span>
          <PlatformNavLink href="/" icon="arrowLeft">
            返回团队空间
          </PlatformNavLink>
        </nav>

        <div className="platform-console-scope">
          <AppIcon name="info" />
          <div>
            <strong>只读跨团队视图</strong>
            <span>所有操作均记录真实操作者</span>
          </div>
        </div>

        <div className="platform-console-operator">
          <span className="platform-console-operator__avatar" aria-hidden="true">
            {operator.displayName.trim().slice(0, 1).toLocaleUpperCase("zh-CN") || "O"}
          </span>
          <div>
            <strong>{operator.displayName || "平台运维"}</strong>
            <span>平台管理员</span>
          </div>
        </div>
      </aside>

      <main className={pageClasses}>{children}</main>
    </div>
  );
}

function PlatformNavLink({
  active = false,
  children,
  href,
  icon,
}: {
  active?: boolean;
  children: ReactNode;
  href: string;
  icon: "approvals" | "arrowLeft" | "performance";
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={active
        ? "platform-console-nav__item platform-console-nav__item--active"
        : "platform-console-nav__item"}
      href={href}
    >
      <AppIcon name={icon} />
      <span>{children}</span>
    </Link>
  );
}
