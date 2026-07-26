import type { SettingsSectionId } from "@/features/settings/settings-sections";
import type { SettingsTx } from "@/features/settings/settings-types";

export type SettingsSectionTone = "personal" | "security" | "integration";

export interface SettingsSectionMeta {
  cardDescription: string;
  description: string;
  groupLabel: string;
  navLabel: string;
  scopeLabel: string;
  pageTitle: string;
  title: string;
  tone: SettingsSectionTone;
}

export function getSettingsSectionMeta(
  section: SettingsSectionId,
  tx: SettingsTx,
): SettingsSectionMeta {
  switch (section) {
    case "preferences":
      return {
        cardDescription: tx("把语言和界面偏好集中起来，避免与安全和集成配置混在一起。", "Keep language and interface preferences together instead of mixing them with security and integration settings."),
        description: tx("控制你的语言、界面和个人使用习惯。", "Control your language, interface, and personal usage preferences."),
        groupLabel: tx("偏好设置", "Preferences"),
        navLabel: tx("偏好设置", "Preferences"),
        pageTitle: tx("设置", "Settings"),
        scopeLabel: tx("仅自己", "Just you"),
        title: tx("偏好设置", "Preferences"),
        tone: "personal",
      };
    case "security":
      return {
        cardDescription: tx("把设备、会话和退出动作收进同一条安全流程。", "Gather devices, sessions, and sign-out actions into one security workflow."),
        description: tx("处理当前账号的会话、安全动作和设备审计。", "Handle session safety, sign-out actions, and device audit for the current account."),
        groupLabel: tx("安全与会话", "Security & sessions"),
        navLabel: tx("安全与会话", "Security"),
        pageTitle: tx("设置", "Settings"),
        scopeLabel: tx("仅自己", "Just you"),
        title: tx("安全与会话", "Security & sessions"),
        tone: "security",
      };
    case "permissions":
      return {
        cardDescription: tx("用资源树和 Actor 视角统一检查工作区授权、继承和外部委托。", "Use resource and actor views to inspect workspace grants, inheritance, and external delegations together."),
        description: tx("统一查看成员、频道、Agent、Runtime、文档和外部授权的权限来源。", "Review permission sources across members, channels, agents, runtimes, documents, and external authorization."),
        groupLabel: tx("权限中心", "Permissions center"),
        navLabel: tx("权限中心", "Permissions"),
        pageTitle: tx("设置", "Settings"),
        scopeLabel: tx("按角色过滤", "Role filtered"),
        title: tx("统一权限管理", "Unified permissions"),
        tone: "security",
      };
    case "integrations":
      return {
        cardDescription: tx("绑定自己的飞书身份；管理员可配置外部协作入口。", "Bind your Feishu identity; admins can configure external collaboration entry points."),
        description: tx("成员管理自己的外部身份绑定，管理员创建和检查外部 IM 与文档数据面的工作区级集成。", "Members manage their own external identity binding; admins create and inspect workspace-level IM and document data-plane integrations."),
        groupLabel: tx("外部集成", "External integrations"),
        navLabel: tx("外部集成", "Integrations"),
        pageTitle: tx("设置", "Settings"),
        scopeLabel: tx("个人绑定 / Admin", "Personal binding / Admin"),
        title: tx("外部集成", "External integrations"),
        tone: "integration",
      };
  }
}
