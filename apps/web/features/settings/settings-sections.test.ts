import { describe, expect, it } from "vitest";
import {
  SETTINGS_REVALIDATE_PATHS,
  canAccessSettingsSection,
  getAccessibleSettingsSections,
  getSettingsSectionPath,
  isSettingsDetailSectionId,
} from "./settings-sections";

describe("settings section helpers", () => {
  it("recognizes valid detail sections", () => {
    expect(isSettingsDetailSectionId("security")).toBe(true);
    expect(isSettingsDetailSectionId("overview")).toBe(false);
    expect(isSettingsDetailSectionId("unknown")).toBe(false);
  });

  it("returns role-aware accessible sections", () => {
    expect(getAccessibleSettingsSections("member")).toEqual([
      "preferences",
      "security",
      "permissions",
      "integrations",
    ]);
    expect(getAccessibleSettingsSections("admin")).toEqual([
      "preferences",
      "security",
      "permissions",
      "integrations",
    ]);
    expect(getAccessibleSettingsSections("owner")).toEqual([
      "preferences",
      "security",
      "permissions",
      "integrations",
    ]);
  });

  it("enforces the section permission model", () => {
    expect(canAccessSettingsSection("member", "integrations")).toBe(true);
    expect(canAccessSettingsSection("admin", "integrations")).toBe(true);
    expect(canAccessSettingsSection("member", "permissions")).toBe(true);
  });

  it("keeps paths and revalidate targets aligned", () => {
    expect(getSettingsSectionPath("preferences")).toBe("/settings/preferences");
    expect(getSettingsSectionPath("permissions")).toBe("/settings/permissions");
    expect(getSettingsSectionPath("integrations")).toBe("/settings/integrations");
    expect(SETTINGS_REVALIDATE_PATHS).toEqual([
      "/settings",
      "/settings/preferences",
      "/settings/security",
      "/settings/permissions",
      "/settings/integrations",
    ]);
  });
});
