import type { WorkspaceRole } from "@dofe-agent/db";

const SETTINGS_DETAIL_SECTION_ORDER_INTERNAL = [
  "preferences",
  "security",
  "permissions",
  "integrations",
] as const;

export type SettingsDetailSectionId = typeof SETTINGS_DETAIL_SECTION_ORDER_INTERNAL[number];
export type SettingsSectionId = SettingsDetailSectionId;

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "preferences";
export const SETTINGS_HOME_PATH = "/settings";

export const SETTINGS_SECTION_ORDER = [
  ...SETTINGS_DETAIL_SECTION_ORDER_INTERNAL,
] as const satisfies readonly SettingsSectionId[];

const SETTINGS_SECTION_PATHS: Record<SettingsSectionId, string> = {
  preferences: "/settings/preferences",
  security: "/settings/security",
  permissions: "/settings/permissions",
  integrations: "/settings/integrations",
};

export const SETTINGS_REVALIDATE_PATHS = [
  SETTINGS_HOME_PATH,
  ...SETTINGS_SECTION_ORDER.map((section) => SETTINGS_SECTION_PATHS[section]),
];

export function isSettingsDetailSectionId(value: string): value is SettingsDetailSectionId {
  return SETTINGS_DETAIL_SECTION_ORDER_INTERNAL.includes(value as SettingsDetailSectionId);
}

export function canAccessSettingsSection(_role: WorkspaceRole, _section: SettingsSectionId): boolean {
  return true;
}

export function getAccessibleSettingsSections(role: WorkspaceRole): SettingsSectionId[] {
  return SETTINGS_SECTION_ORDER.filter((section) => canAccessSettingsSection(role, section));
}

export function getSettingsSectionPath(section: SettingsSectionId): string {
  return SETTINGS_SECTION_PATHS[section];
}
