import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { AuditLogRecord } from "@dofe-agent/db";
import { AuditLogView, getAuditEventLabel } from "@/features/audit/audit-log-view";
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

it("renders a user-friendly event description instead of the internal event code", () => {
  const log: AuditLogRecord = {
    id: "audit-1",
    workspaceId: "workspace-1",
    title: "Model resolution fallback",
    note: "The selected model is unavailable.",
    code: "model.resolution_fallback",
    dataJson: "{}",
    source: "runtime_model",
    sourceIndex: 0,
    createdAt: "2026-07-31T08:00:00.000Z",
  };

  render(
    <LanguageProvider initialLanguage="zh">
      <AuditLogView clearHref="/w/acme/audit" filters={{}} logs={[log]} />
    </LanguageProvider>,
  );

  expect(screen.getByRole("cell", { name: "模型不可用，已自动切换" })).toBeInTheDocument();
  expect(screen.queryByText("model.resolution_fallback")).not.toBeInTheDocument();
});

it("falls back to the readable audit title for an unknown event code", () => {
  expect(getAuditEventLabel({
    code: "custom.policy_updated",
    source: "platform_admin",
    title: "Custom policy updated",
  }, "zh")).toBe("Custom policy updated");

  expect(getAuditEventLabel({
    code: "model.resolution_fallback",
    source: "runtime_model",
    title: "Model resolution fallback",
  }, "en")).toBe("Model unavailable; switched automatically");

  expect(getAuditEventLabel({
    source: "runtime_credential",
    title: "",
  }, "zh")).toBe("执行引擎凭据变更");
});
