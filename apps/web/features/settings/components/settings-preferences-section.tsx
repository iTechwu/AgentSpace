"use client";

import type { SidebarSectionId, SidebarVisibilityState } from "@/features/dashboard/sidebar-visibility-provider";
import { WORKSPACE_ONBOARDING_REPLAY_EVENT } from "@/features/dashboard/onboarding-guide";
import type { LanguageCode } from "@/features/i18n/language-provider";
import { SettingsSectionShell } from "@/features/settings/components/settings-chrome";
import type { SettingsSectionMeta } from "@/features/settings/settings-meta";
import type { SettingsTx } from "@/features/settings/settings-types";

export function SettingsPreferencesSection({
  language,
  meta,
  setLanguage,
  setSectionVisibility,
  tx,
  visibility,
}: {
  language: LanguageCode;
  meta: SettingsSectionMeta;
  setLanguage: (language: LanguageCode) => void;
  setSectionVisibility: (sectionId: SidebarSectionId, visible: boolean) => void;
  tx: SettingsTx;
  visibility: SidebarVisibilityState;
}) {
  const sidebarSectionOptions = buildSidebarSectionOptions(tx);

  return (
    <SettingsSectionShell meta={meta}>
      <section className="page-panel">
        <div className="panel-header">
          <div>
            <h3>{tx("界面显示语言", "Display Language")}</h3>
            <p className="settings-panel-note">
              {tx("决定设置页、工作台和系统文案优先使用的语言。", "Choose the preferred language for the workspace UI and settings copy.")}
            </p>
          </div>
        </div>

        <label className="form-field">
          <span>{tx("显示语言", "Display Language")}</span>
          <select
            aria-label={tx("显示语言", "Display Language")}
            onChange={(event) => setLanguage(event.currentTarget.value as LanguageCode)}
            value={language}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
      </section>

      <section className="page-panel">
        <div className="panel-header">
          <div>
            <h3>{tx("新手引导", "Onboarding")}</h3>
            <p className="settings-panel-note">
              {tx("重新运行 AI员工 搭建向导：绑定 Runtime、创建 AI员工、配置说明和能力来源，再完成第一条对话。", "Replay the AI employee setup guide: bind a Runtime, create an AI employee, configure instructions and capabilities, then complete the first conversation.")}
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => window.dispatchEvent(new Event(WORKSPACE_ONBOARDING_REPLAY_EVENT))}
            type="button"
          >
            {tx("重看新手引导", "Replay onboarding")}
          </button>
        </div>
      </section>

      <section className="page-panel">
        <div className="panel-header">
          <div>
            <h3>{tx("侧边栏显示", "Sidebar visibility")}</h3>
            <p className="settings-panel-note">
              {tx("把高频模块留在导航里，把暂时不用的入口先收起来。", "Keep frequent modules in the rail and hide the ones you do not need right now.")}
            </p>
          </div>
        </div>

        <div className="settings-options">
          {sidebarSectionOptions.map((section) => (
            <SidebarSectionOption
              enabled={visibility[section.id]}
              key={section.id}
              label={section.label}
              onChange={(enabled) => setSectionVisibility(section.id, enabled)}
            />
          ))}
        </div>
      </section>
    </SettingsSectionShell>
  );
}

function buildSidebarSectionOptions(tx: SettingsTx): Array<{
  id: SidebarSectionId;
  label: string;
}> {
  return [
    { id: "messages", label: tx("通知", "Feed") },
    { id: "approvals", label: tx("审批", "Approvals") },
    { id: "taskBoard", label: tx("项目看板", "Task Board") },
    { id: "channels", label: tx("消息", "Messages") },
    { id: "contacts", label: tx("联系人", "Contacts") },
    { id: "employeeManagement", label: tx("员工管理", "AI Employee Management") },
    { id: "skills", label: tx("技能库", "Skills") },
    { id: "market", label: tx("应用市场", "Runtime App Market") },
    { id: "containers", label: tx("执行引擎管理", "Execution Engine Management") },
    { id: "knowledge", label: tx("知识库", "Knowledge") },
    { id: "performance", label: tx("绩效", "Performance") },
    { id: "orgChart", label: tx("组织架构", "Org Chart") },
    { id: "costs", label: tx("成本与预算", "Costs & Budget") },
    { id: "tables", label: tx("数据表", "Tables") },
    { id: "automations", label: tx("自动化", "Automations") },
    { id: "calendar", label: tx("日历", "Calendar") },
    { id: "templates", label: tx("模板", "Templates") },
  ];
}

function SidebarSectionOption({
  enabled,
  label,
  onChange,
}: {
  enabled: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className={`settings-toggle${enabled ? " settings-toggle--active" : ""}`}>
      <div>
        <strong>{label}</strong>
      </div>
      <span className="settings-toggle__control">
        <input
          aria-label={label}
          checked={enabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
        <span className="settings-toggle__slider" />
      </span>
    </label>
  );
}
