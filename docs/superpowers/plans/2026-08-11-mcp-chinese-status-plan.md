# MCP Chinese Status Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw MCP transport, risk, connection, operation, and tool-call enum values with consistent Chinese UI labels across the market, Runtime capability, and connection detail pages.

**Architecture:** Add pure MCP presentation helpers beside the existing capability presentation helpers. Each client component will pass its existing `tx` translator to the helpers, preserving the raw values for filtering, actions, form inputs, API calls, and technical identifiers. No backend status or connection behavior changes.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Next.js client components.

---

## File Map

- Create: `apps/web/features/market/mcp-presentation.test.ts` — pure mapping tests for every supported MCP enum and unknown fallback.
- Modify: `apps/web/features/market/capability-presentation.ts` — shared MCP transport, risk, connection status, operation, and tool-call label helpers.
- Modify: `apps/web/features/market/mcp-market-panel.tsx` — use shared labels in filters, detail facts, tool risk chips, and connected Runtime rows.
- Modify: `apps/web/features/runtimes/runtime-capabilities-panel.tsx` — use shared labels for MCP transport, connection status, tool risk, and operation history status.
- Modify: `apps/web/features/market/mcp-connection-detail-client.tsx` — use shared labels for transport, connection status, risk, operation status, and tool-call outcomes.
- Modify: `apps/web/features/market/market-page-client.test.tsx` — assert the market renders Chinese MCP transport/risk/status labels instead of raw enum values.

### Task 1: Add failing presentation mapping tests

**Files:**
- Create: `apps/web/features/market/mcp-presentation.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  mcpConnectionStatusLabel,
  mcpOperationLabel,
  mcpOperationStatusLabel,
  mcpRiskLabel,
  mcpToolCallOutcomeLabel,
  mcpTransportLabel,
} from "@/features/market/capability-presentation";

const tx = (zh: string, _en: string) => zh;

describe("MCP presentation labels", () => {
  it("translates transport and risk values", () => {
    expect(mcpTransportLabel("streamable_http", tx)).toBe("流式 HTTP");
    expect(mcpTransportLabel("managed_stdio", tx)).toBe("受管 stdio");
    expect(mcpTransportLabel("managed_service", tx)).toBe("受管服务");
    expect(mcpTransportLabel("sse", tx)).toBe("SSE");
    expect(mcpRiskLabel("low", tx)).toBe("低风险");
    expect(mcpRiskLabel("medium", tx)).toBe("中风险");
    expect(mcpRiskLabel("high", tx)).toBe("高风险");
  });

  it("translates connection lifecycle values", () => {
    expect(mcpConnectionStatusLabel("pending_configuration", tx)).toBe("待配置");
    expect(mcpConnectionStatusLabel("queued_verification", tx)).toBe("等待验证");
    expect(mcpConnectionStatusLabel("verifying", tx)).toBe("验证中");
    expect(mcpConnectionStatusLabel("ready", tx)).toBe("已验证");
    expect(mcpConnectionStatusLabel("degraded", tx)).toBe("连接异常");
    expect(mcpConnectionStatusLabel("failed", tx)).toBe("验证失败");
    expect(mcpConnectionStatusLabel("disabled", tx)).toBe("已停用");
  });

  it("translates operation and tool-call values", () => {
    expect(mcpOperationLabel("verify", tx)).toBe("验证");
    expect(mcpOperationLabel("remove", tx)).toBe("移除");
    expect(mcpOperationStatusLabel("pending", tx)).toBe("等待中");
    expect(mcpOperationStatusLabel("running", tx)).toBe("进行中");
    expect(mcpOperationStatusLabel("succeeded", tx)).toBe("已成功");
    expect(mcpOperationStatusLabel("failed", tx)).toBe("失败");
    expect(mcpOperationStatusLabel("cancelled", tx)).toBe("已取消");
    expect(mcpToolCallOutcomeLabel("succeeded", tx)).toBe("成功");
    expect(mcpToolCallOutcomeLabel("failed", tx)).toBe("失败");
  });

  it("uses a safe Chinese fallback for unknown values", () => {
    expect(mcpTransportLabel("future_transport", tx)).toBe("未知传输");
    expect(mcpConnectionStatusLabel("future_status", tx)).toBe("状态未知");
    expect(mcpOperationStatusLabel("future_operation_status", tx)).toBe("状态未知");
    expect(mcpToolCallOutcomeLabel("future_outcome", tx)).toBe("结果未知");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails for missing exports**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/market/mcp-presentation.test.ts`

Expected: FAIL because the MCP presentation helper exports do not exist yet.

### Task 2: Implement shared mappings and update MCP pages

**Files:**
- Modify: `apps/web/features/market/capability-presentation.ts`
- Modify: `apps/web/features/market/mcp-market-panel.tsx`
- Modify: `apps/web/features/runtimes/runtime-capabilities-panel.tsx`
- Modify: `apps/web/features/market/mcp-connection-detail-client.tsx`

- [ ] **Step 1: Add the pure helper implementations**

Add to `capability-presentation.ts`:

```ts
export function mcpTransportLabel(transport: string, tx: CapabilityTranslator): string {
  switch (transport) {
    case "streamable_http": return tx("流式 HTTP", "Streamable HTTP");
    case "managed_stdio": return tx("受管 stdio", "Managed stdio");
    case "managed_service": return tx("受管服务", "Managed service");
    case "sse": return tx("SSE", "SSE");
    default: return tx("未知传输", "Unknown transport");
  }
}

export function mcpRiskLabel(risk: string, tx: CapabilityTranslator): string {
  switch (risk) {
    case "low": return tx("低风险", "Low risk");
    case "medium": return tx("中风险", "Medium risk");
    case "high": return tx("高风险", "High risk");
    default: return tx("风险未知", "Unknown risk");
  }
}

export function mcpConnectionStatusLabel(status: string, tx: CapabilityTranslator): string {
  switch (status) {
    case "pending_configuration": return tx("待配置", "Needs config");
    case "queued_verification": return tx("等待验证", "Queued");
    case "verifying": return tx("验证中", "Verifying");
    case "ready": return tx("已验证", "Verified");
    case "degraded": return tx("连接异常", "Degraded");
    case "failed": return tx("验证失败", "Verification failed");
    case "disabled": return tx("已停用", "Disabled");
    default: return tx("状态未知", "Unknown status");
  }
}

export function mcpOperationLabel(operation: string, tx: CapabilityTranslator): string {
  const labels: Record<string, [string, string]> = {
    verify: ["验证", "Verify"], enable: ["启用", "Enable"], disable: ["停用", "Disable"], remove: ["移除", "Remove"],
  };
  const label = labels[operation];
  return label ? tx(label[0], label[1]) : tx("未知操作", "Unknown operation");
}

export function mcpOperationStatusLabel(status: string, tx: CapabilityTranslator): string {
  const labels: Record<string, [string, string]> = {
    pending: ["等待中", "Pending"], claimed: ["已领取", "Claimed"], running: ["进行中", "Running"], succeeded: ["已成功", "Succeeded"], failed: ["失败", "Failed"], cancelled: ["已取消", "Cancelled"],
  };
  const label = labels[status];
  return label ? tx(label[0], label[1]) : tx("状态未知", "Unknown status");
}

export function mcpToolCallOutcomeLabel(outcome: string, tx: CapabilityTranslator): string {
  if (outcome === "succeeded") return tx("成功", "Succeeded");
  if (outcome === "failed") return tx("失败", "Failed");
  return tx("结果未知", "Unknown result");
}
```

- [ ] **Step 2: Replace raw market labels**

Import `mcpConnectionStatusLabel`, `mcpRiskLabel`, and `mcpTransportLabel` in `mcp-market-panel.tsx`. Use them for transport filter options, detail transport facts, tool risk chips, connection row transport text, and connection status labels. Keep `transport` and `risk` raw values for filtering and CSS tone decisions.

- [ ] **Step 3: Replace raw Runtime capability labels**

Import `mcpConnectionStatusLabel`, `mcpOperationStatusLabel`, `mcpRiskLabel`, and `mcpTransportLabel` in `runtime-capabilities-panel.tsx`. Use them for MCP row transport, connection status, tool risk, and operation history fallback status. Leave CLI operation labels unchanged except where the shared MCP history path is used.

- [ ] **Step 4: Replace raw connection-detail labels**

Import the shared MCP helpers in `mcp-connection-detail-client.tsx`. Use them for the connection transport, connection status, tool risk chips, operation labels/statuses, and tool-call outcomes. Keep error codes, endpoint, runtime IDs, actor IDs, and tool names unchanged.

### Task 3: Add page-level regression assertions

**Files:**
- Modify: `apps/web/features/market/market-page-client.test.tsx`

- [ ] **Step 1: Add a market rendering assertion**

Extend the MCP fixture with a `managed_stdio` entry containing `medium` and `high` tools, render the MCP tab, and assert that the page contains `受管 stdio`, `中风险`, and `高风险` while not containing `managed_stdio` as visible text in the catalog/detail presentation.

- [ ] **Step 2: Add connection status assertions**

Render fixture connections with `queued_verification`, `ready`, `degraded`, `failed`, and `disabled` statuses in separate test cases and assert the visible labels are `等待验证`, `已验证`, `连接异常`, `验证失败`, and `已停用`.

- [ ] **Step 3: Run the focused market and helper tests**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/market/mcp-presentation.test.ts features/market/market-page-client.test.tsx --maxWorkers=2`

Expected: PASS with no raw MCP transport/status labels in the tested presentation paths.

### Task 4: Verify type safety and commit the implementation

- [ ] **Step 1: Run the Runtime capability and connection detail tests**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/runtimes/runtime-capabilities-panel.test.tsx features/market/mcp-connection-detail-client.test.tsx --maxWorkers=2`

Expected: PASS. If the connection detail test file does not exist, run the available Runtime test and rely on the shared helper test for detail mappings.

- [ ] **Step 2: Run web type checking**

Run: `pnpm --filter @dofe-agent/web run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Review the diff and commit only implementation files**

Run: `git diff --check && git status --short`.

Stage only the helper, component, and test files from this plan; preserve unrelated pre-existing workspace changes. Commit with:

```bash
git add apps/web/features/market/capability-presentation.ts apps/web/features/market/mcp-presentation.test.ts apps/web/features/market/mcp-market-panel.tsx apps/web/features/runtimes/runtime-capabilities-panel.tsx apps/web/features/market/mcp-connection-detail-client.tsx apps/web/features/market/market-page-client.test.tsx
git commit -m "完成MCP页面中文状态展示"
```

Expected: a clean commit containing only the MCP localization implementation and its tests.
