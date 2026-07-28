import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AuditLogView } from "@/features/audit/audit-log-view";
import { parseAuditLogFilters } from "@/features/audit/audit-log-filters";
import { LanguageProvider } from "@/features/i18n/language-provider";

it("renders the audit workbench in Chinese by default", () => {
  render(
    <LanguageProvider initialLanguage="zh">
      <AuditLogView clearHref="/w/acme/audit" filters={{}} logs={[]} />
    </LanguageProvider>,
  );

  expect(screen.getByRole("heading", { name: "审计日志" })).toBeInTheDocument();
  expect(screen.getByLabelText("事件类型")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "应用筛选" })).toBeInTheDocument();
  expect(screen.getByText("没有符合条件的审计事件")).toBeInTheDocument();
});

it("ignores invalid audit timestamps", () => {
  expect(parseAuditLogFilters({
    code: "runtime.started",
    createdFrom: "not-a-date",
    createdTo: "2026-07-28T08:00",
  })).toEqual({
    code: "runtime.started",
    actorId: undefined,
    employeeId: undefined,
    runtimeId: undefined,
    sessionId: undefined,
    taskId: undefined,
    modelId: undefined,
    createdFrom: undefined,
    createdTo: new Date("2026-07-28T08:00").toISOString(),
  });
});
