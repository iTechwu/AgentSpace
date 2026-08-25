# 全站工作区间距优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过共享页面框架和 spacing tokens，将工作区主要页面统一为平衡密度，并为分栏、表格和日志保留明确的紧凑变体。

**Architecture:** 在现有 `page-shell` 和 `WorkbenchPageHeader` 基础上增加 `WorkbenchPageFrame`，显式声明 `balanced`、`compact` 或 `full-bleed` 密度。页面仍保留各自业务布局，统一框架只负责页面 gutter、区块 gap、窄屏收敛和密度变量，避免全局 CSS 末尾覆盖业务细节。

**Tech Stack:** React 19、Next.js 16、TypeScript、CSS custom properties、Vitest、Testing Library、Playwright。

**Delivery Rule:** 每个独立任务验证通过后立即使用中文提交，并执行 `git push` 推送当前跟踪分支；不得把多个已完成任务积压到一次提交或一次推送。

---

## File Structure

- Create: `apps/web/shared/ui/workbench-page-frame.tsx` — 页面密度与根容器的单一入口。
- Create: `apps/web/shared/ui/workbench-page-frame.test.tsx` — 根容器 class、属性透传和默认密度测试。
- Modify: `apps/web/app/globals.css` — spacing tokens、三种密度规则、响应式 gutter、紧凑区域规则。
- Modify: `apps/web/features/task-board/task-board-page-client.tsx` — balanced 页面。
- Modify: `apps/web/features/workflows/workflow-list-client.tsx` — balanced 页面。
- Modify: `apps/web/features/runtimes/runtimes-page-client.tsx` — balanced 页面。
- Modify: `apps/web/features/audit/audit-log-view.tsx` — balanced 页面、表格 compact。
- Modify: `apps/web/features/settings/settings-page-client.tsx` — balanced 页面。
- Modify: `apps/web/features/automations/automations-page-client.tsx` — balanced 页面。
- Modify: `apps/web/features/calendar/calendar-page-client.tsx` — balanced 页面。
- Modify: `apps/web/features/org-chart/org-chart-page-client.tsx` — balanced 页面。
- Modify: `apps/web/features/knowledge/knowledge-page-client.tsx` — full-bleed 分栏页面。
- Modify: `apps/web/features/approvals/approvals-page-client.tsx` — full-bleed 分栏页面。
- Modify: `apps/web/features/skills/skills-page-client.tsx` — full-bleed 工作台页面。
- Modify: `apps/web/features/tables/tables-page-client.tsx` — full-bleed 页面、表格 compact。
- Modify: `apps/web/features/templates/templates-page-client.tsx` — full-bleed 页面。
- Modify: `apps/web/features/performance/performance-page-client.tsx` — balanced 指标页面、表格 compact。
- Modify: `apps/web/features/costs/costs-page-client.tsx` — balanced 指标与表单页面。
- Modify: `apps/web/features/market/market-page-client.tsx` — balanced 市场页面。
- Modify: `apps/web/features/inbox/inbox-page-client.tsx` — full-bleed 通知分栏页面。
- Modify: `apps/web/features/agents/agents-page-client.tsx` — full-bleed Agent 工作台密度标记。
- Modify: `apps/web/app/w/[workspaceSlug]/runtimes/runtime/[runtimeId]/page.tsx` — balanced 详情页。
- Create: `apps/web/e2e/workspace-spacing.spec.ts` — 桌面/移动页面 gutter、换行和横向溢出验收。
- Modify: `docs/0825/im-uiux/05-全站间距与稳定流式反馈.md` — 记录实际迁移范围和验证证据。

### Task 1: 建立共享页面框架

**Files:**
- Create: `apps/web/shared/ui/workbench-page-frame.tsx`
- Create: `apps/web/shared/ui/workbench-page-frame.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkbenchPageFrame } from "@/shared/ui/workbench-page-frame";

describe("WorkbenchPageFrame", () => {
  it("uses balanced density by default and preserves section attributes", () => {
    render(<WorkbenchPageFrame aria-label="任务页面" data-hydrated="true">内容</WorkbenchPageFrame>);
    const frame = screen.getByRole("region", { name: "任务页面" });
    expect(frame).toHaveClass("page-shell", "workbench-page-frame", "workbench-page-frame--balanced");
    expect(frame).toHaveAttribute("data-page-density", "balanced");
    expect(frame).toHaveAttribute("data-hydrated", "true");
  });

  it("supports compact and full-bleed without dropping a feature class", () => {
    const { rerender } = render(<WorkbenchPageFrame className="audit-page" density="compact">日志</WorkbenchPageFrame>);
    expect(screen.getByText("日志").closest("section")).toHaveClass("audit-page", "workbench-page-frame--compact");
    rerender(<WorkbenchPageFrame className="knowledge-page" density="full-bleed">知识库</WorkbenchPageFrame>);
    expect(screen.getByText("知识库").closest("section")).toHaveClass("knowledge-page", "workbench-page-frame--full-bleed");
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run shared/ui/workbench-page-frame.test.tsx`

Expected: FAIL，提示无法解析 `@/shared/ui/workbench-page-frame`。

- [ ] **Step 3: 实现页面框架**

```tsx
import type { ComponentPropsWithoutRef } from "react";

export type WorkbenchPageDensity = "balanced" | "compact" | "full-bleed";

export interface WorkbenchPageFrameProps extends ComponentPropsWithoutRef<"section"> {
  readonly density?: WorkbenchPageDensity;
}

export function WorkbenchPageFrame({
  className,
  density = "balanced",
  ...props
}: WorkbenchPageFrameProps) {
  const classes = [
    "page-shell",
    "workbench-page-frame",
    `workbench-page-frame--${density}`,
    className,
  ].filter(Boolean).join(" ");
  return <section {...props} className={classes} data-page-density={density} />;
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `pnpm --filter @dofe-agent/web exec vitest run shared/ui/workbench-page-frame.test.tsx`

Expected: 2 tests PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "新增工作区页面密度框架"
git push
```

### Task 2: 建立 24/16/12/8 间距契约

**Files:**
- Modify: `apps/web/app/globals.css:1-33`
- Modify: `apps/web/app/globals.css:29552-29628`
- Modify: `apps/web/shared/ui/workbench-page-frame.test.tsx`

- [ ] **Step 1: 扩展测试以约束密度变量入口**

在现有测试中增加：

```tsx
it("exposes density through a stable data attribute", () => {
  render(<WorkbenchPageFrame density="compact">日志</WorkbenchPageFrame>);
  expect(screen.getByText("日志").closest("section")).toHaveAttribute("data-page-density", "compact");
});
```

- [ ] **Step 2: 运行测试并确认当前组件行为**

Run: `pnpm --filter @dofe-agent/web exec vitest run shared/ui/workbench-page-frame.test.tsx`

Expected: PASS；该测试先锁定 CSS 可依赖的属性契约。

- [ ] **Step 3: 在 `:root` 添加 tokens，并为三种密度建立规则**

```css
:root {
  --space-1: 4px;
  --space-1-5: 6px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --control-hit-size: 40px;
  --workbench-page-gutter: var(--space-6);
  --workbench-section-gap: var(--space-6);
  --workbench-component-gap: var(--space-4);
  --workbench-control-gap: var(--space-3);
  --workbench-inline-gap: var(--space-2);
}

.workbench-page-frame {
  min-width: 0;
  padding: var(--workbench-page-gutter);
  gap: var(--workbench-section-gap);
}

.workbench-page-frame--compact {
  --workbench-section-gap: var(--space-4);
  --workbench-component-gap: var(--space-3);
  --workbench-control-gap: var(--space-2);
}

.workbench-page-frame--full-bleed {
  --workbench-page-gutter: 0px;
  --workbench-section-gap: 0px;
  padding: 0;
  gap: 0;
}

@media (max-width: 860px) {
  .workbench-page-frame--balanced,
  .workbench-page-frame--compact {
    --workbench-page-gutter: var(--space-4);
  }
}
```

将 `.workbench-page-header` 的 `gap`、`padding-bottom`、aside gap 和移动端 gap 改为上述变量；保留标题字号和 40px 以上操作命中区。删除会覆盖新 frame 的桌面 `.page-shell { gap: 0; }`，并把确实需要无间距的页面交给 `full-bleed`。

- [ ] **Step 4: 运行共享组件测试和 CSS 静态检查**

Run: `pnpm --filter @dofe-agent/web exec vitest run shared/ui/workbench-page-frame.test.tsx && git diff --check`

Expected: tests PASS，`git diff --check` 无输出。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "统一工作区页面间距令牌"
git push
```

### Task 3: 迁移平衡密度页面

**Files:**
- Modify: `apps/web/features/task-board/task-board-page-client.tsx`
- Modify: `apps/web/features/workflows/workflow-list-client.tsx`
- Modify: `apps/web/features/runtimes/runtimes-page-client.tsx`
- Modify: `apps/web/features/audit/audit-log-view.tsx`
- Modify: `apps/web/features/settings/settings-page-client.tsx`
- Modify: `apps/web/features/automations/automations-page-client.tsx`
- Modify: `apps/web/features/calendar/calendar-page-client.tsx`
- Modify: `apps/web/features/org-chart/org-chart-page-client.tsx`
- Modify: `apps/web/app/w/[workspaceSlug]/runtimes/runtime/[runtimeId]/page.tsx`
- Modify: related existing `*.test.tsx` files for the pages above

- [ ] **Step 1: 在代表性页面测试中先断言 density**

在任务看板、设置、运行时和审计现有测试中各增加：

```tsx
expect(container.querySelector("[data-page-density='balanced']")).toBeInTheDocument();
```

- [ ] **Step 2: 运行四个测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/settings/settings-page-client.test.tsx features/runtimes/runtimes-page-client.test.tsx features/audit/audit-log-view.test.tsx features/task-board/task-board-page-client.test.tsx`

Expected: FAIL，页面尚未输出 `data-page-density="balanced"`。任务看板断言位于 `features/task-board/task-board-page-client.test.tsx`。

- [ ] **Step 3: 将顶层 section 替换为 `WorkbenchPageFrame`**

每个文件导入：

```tsx
import { WorkbenchPageFrame } from "@/shared/ui/workbench-page-frame";
```

并将顶层：

```tsx
<section className="page-shell settings-page" data-hydrated={isHydrated ? "true" : undefined}>
```

替换为：

```tsx
<WorkbenchPageFrame className="settings-page" data-hydrated={isHydrated ? "true" : undefined}>
```

其他页面保留原 feature class，默认使用 balanced；结束标签同步改为 `</WorkbenchPageFrame>`。审计表格容器额外增加 `data-density-zone="compact"`。

- [ ] **Step 4: 收敛页面自身重复 gutter**

在 `globals.css` 中移除这些页面根节点重复的 `padding: 1rem 1.25rem 1.25rem`，内部布局继续使用 `--workbench-component-gap` 和 `--workbench-control-gap`。表单字段保持 12px，区块保持 16/24px，按钮 `min-height` 不低于 `var(--control-hit-size)`。

- [ ] **Step 5: 运行受影响页面测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/settings/settings-page-client.test.tsx features/runtimes/runtimes-page-client.test.tsx features/audit/audit-log-view.test.tsx features/task-board/task-board-page-client.test.tsx features/workflows/workflow-list-client.test.tsx`

Expected: 受影响测试全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "统一主要工作区页面间距"
git push
```

### Task 4: 迁移分栏与工作台页面

**Files:**
- Modify: `apps/web/features/knowledge/knowledge-page-client.tsx`
- Modify: `apps/web/features/approvals/approvals-page-client.tsx`
- Modify: `apps/web/features/skills/skills-page-client.tsx`
- Modify: `apps/web/features/tables/tables-page-client.tsx`
- Modify: `apps/web/features/templates/templates-page-client.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: related existing tests

- [ ] **Step 1: 写 full-bleed 与 compact zone 断言**

```tsx
expect(container.querySelector("[data-page-density='full-bleed']")).toBeInTheDocument();
expect(container.querySelector("[data-density-zone='compact']")).toBeInTheDocument();
```

知识库、审批、技能和模板只断言 full-bleed；表格页同时断言 compact zone。

- [ ] **Step 2: 运行相关测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/knowledge/knowledge-page-client.test.tsx features/approvals/approvals-page-client.test.tsx features/skills/skills-page-client.test.tsx features/tables/tables-page-client.test.tsx features/templates/templates-page-client.test.tsx`

Expected: density 断言 FAIL。

- [ ] **Step 3: 迁移为 full-bleed 页面框架**

```tsx
<WorkbenchPageFrame className="knowledge-page" density="full-bleed">
```

审批、技能、表格和模板使用相同模式。表格/日志滚动容器标记 `data-density-zone="compact"`，CSS 使用 `--space-1-5` 行间距和 `--space-2` 单元格纵向 padding，但交互控件仍保留 40px 命中区。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/knowledge/knowledge-page-client.test.tsx features/approvals/approvals-page-client.test.tsx features/skills/skills-page-client.test.tsx features/tables/tables-page-client.test.tsx features/templates/templates-page-client.test.tsx`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "优化分栏与表格页面密度"
git push
```

### Task 5: 收敛指标、市场与专业工作台密度

**Files:**
- Modify: `apps/web/features/performance/performance-page-client.tsx`
- Modify: `apps/web/features/performance/performance-page-client.test.tsx`
- Modify: `apps/web/features/costs/costs-page-client.tsx`
- Modify: `apps/web/features/costs/costs-page-client.test.tsx`
- Modify: `apps/web/features/market/market-page-client.tsx`
- Modify: `apps/web/features/market/market-page-client.test.tsx`
- Modify: `apps/web/features/inbox/inbox-page-client.tsx`
- Modify: `apps/web/features/inbox/inbox-page-client.test.tsx`
- Modify: `apps/web/features/agents/agents-page-client.tsx`
- Modify: `apps/web/features/agents/agents-page-client.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: 写各专业页面的密度断言**

```tsx
expect(container.querySelector("[data-page-density='balanced'].performance-page")).toBeInTheDocument();
expect(container.querySelector("[data-page-density='balanced'].costs-shell")).toBeInTheDocument();
expect(container.querySelector("[data-page-density='balanced'].market-page-shell")).toBeInTheDocument();
expect(container.querySelector("[data-page-density='full-bleed'].notification-feed-shell")).toBeInTheDocument();
expect(container.querySelector("[data-density-zone='compact'].agents-shell")).toBeInTheDocument();
```

每条断言放入对应现有测试文件；Agent 页使用已有默认 agent 模式 fixture。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/performance/performance-page-client.test.tsx features/costs/costs-page-client.test.tsx features/market/market-page-client.test.tsx features/inbox/inbox-page-client.test.tsx features/agents/agents-page-client.test.tsx`

Expected: 新 density 断言 FAIL。

- [ ] **Step 3: 迁移简单页面并标记专业工作台**

Performance、Costs 和 Market 根节点使用 balanced `WorkbenchPageFrame` 并保留原 class；Inbox 使用 full-bleed。Agents 的三个 `agents-shell` 模式根节点保留当前结构，增加 `data-density-zone="compact"`，由 CSS 继承共享 tokens，不为复杂条件渲染再套一层容器。

Performance 表格 wrapper 增加：

```tsx
<div className="performance-table-wrapper" data-density-zone="compact">
```

- [ ] **Step 4: 使用共享变量替换根级重复间距**

Costs、Performance、Market 的根级 padding/gap 使用 `--workbench-page-gutter`、`--workbench-section-gap`；Inbox 和 Agents 的 list/header/toolbar 使用 `--workbench-component-gap`、`--workbench-control-gap`，不改变已有分栏宽度、resize handle 或移动 drill-down 状态。

- [ ] **Step 5: 运行五个页面测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/performance/performance-page-client.test.tsx features/costs/costs-page-client.test.tsx features/market/market-page-client.test.tsx features/inbox/inbox-page-client.test.tsx features/agents/agents-page-client.test.tsx`

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "统一指标与专业工作台页面密度"
git push
```

### Task 6: 添加跨页面浏览器验收

**Files:**
- Create: `apps/web/e2e/workspace-spacing.spec.ts`

- [ ] **Step 1: 写跨视口失败测试**

```ts
import { expect, test } from "@playwright/test";
import { openSeededWorkspacePage } from "./helpers";

const routes = [
  "/task/board", "/knowledge", "/approvals", "/runtimes", "/audit", "/settings",
  "/performance", "/costs", "/market", "/inbox", "/agents",
];

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`keeps workspace spacing stable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const session = await openSeededWorkspacePage(page, routes[0]);
    for (const route of routes) {
      await page.goto(`/w/${session.workspaceSlug}${route}`);
      const frame = page.locator("[data-page-density], [data-density-zone]").first();
      await expect(frame).toBeVisible();
      const metrics = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overlapping: Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"))
          .filter((element) => element.offsetParent !== null)
          .some((element) => element.getBoundingClientRect().width <= 0),
      }));
      expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
      expect(metrics.overlapping).toBe(false);
    }
  });
}
```

- [ ] **Step 2: 在 E2E 数据库可用时运行并确认测试结果**

Run: `pnpm --filter @dofe-agent/web exec playwright test e2e/workspace-spacing.spec.ts --workers=1`

Expected: 2 tests PASS。若本机缺少 `DOFE_AGENT_TEST_DATABASE_URL`，记录为环境限制，并使用真实浏览器回归补充证据。

- [ ] **Step 3: 运行类型与相关回归**

Run: `pnpm --filter @dofe-agent/web run typecheck:test && pnpm --filter @dofe-agent/web run lint`

Expected: 两条命令均退出 0。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "增加工作区间距浏览器回归"
git push
```

### Task 7: 真实页面验收与记录

**Files:**
- Modify: `docs/0825/im-uiux/05-全站间距与稳定流式反馈.md`

- [ ] **Step 1: 使用 `browser-testing-with-devtools` 登录本地优惠豚账户**

打开本地 AgentSpace，使用仓库提供的测试管理员账户登录。依次检查任务、知识库、审批、运行时、审计、设置、IM；在 390px 与 1440px 视口检查 gutter、工具栏换行、表格内部滚动、按钮命中区和页面横向溢出。

- [ ] **Step 2: 检查浏览器诊断**

记录控制台 error/warning、HTTP 4xx/5xx、失败资源、布局溢出和交互遮挡。发现问题时回到对应任务增加失败测试，再完成修复和回归。

- [ ] **Step 3: 更新实施证据**

在设计文档末尾追加实际迁移页面、执行命令、测试数量、桌面/移动截图路径以及未执行项的原因，不写“全部通过”而缺少命令或截图证据。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "记录全站间距优化验收结果"
git push
```
