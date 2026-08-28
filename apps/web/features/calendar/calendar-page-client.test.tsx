import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CalendarPageData } from "@/features/dashboard/data";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { CalendarPageClient } from "./calendar-page-client";

const legacySchedule: CalendarPageData = {
  scheduledTasks: [
    {
      id: "schedule-1",
      title: "汇总周报",
      description: "整理各团队本周进展",
      assignee: "Atlas",
      repeat: "weekly",
      scheduledAt: "2026-08-07T09:00:00.000Z",
      status: "active",
      createdBy: "user-1",
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
    },
  ],
  totalCount: 1,
  activeCount: 1,
  channels: [],
  agents: [{ id: "Atlas", name: "Atlas" }],
};

describe("CalendarPageClient", () => {
  it("opens the shared workflow builder from the calendar", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <CalendarPageClient data={legacySchedule} workspaceSlug="workspace-alpha" />
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: "+ 新建定时" })).toHaveAttribute(
      "href",
      "/w/workspace-alpha/automations/new?entry=calendar",
    );
  });

  it("shows legacy schedules without legacy mutation controls", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <CalendarPageClient data={legacySchedule} workspaceSlug="workspace-alpha" />
      </LanguageProvider>,
    );

    expect(screen.getByText("汇总周报")).toBeInTheDocument();
    expect(screen.getByText("旧版计划")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
  });

  it("uses the shared workflow builder for the empty state", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <CalendarPageClient
          data={{ ...legacySchedule, scheduledTasks: [], totalCount: 0, activeCount: 0 }}
          workspaceSlug="workspace-alpha"
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: "新建定时任务" })).toHaveAttribute(
      "href",
      "/w/workspace-alpha/automations/new?entry=calendar",
    );
  });
});
