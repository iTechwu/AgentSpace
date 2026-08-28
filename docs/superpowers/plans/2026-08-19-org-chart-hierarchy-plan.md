# 组织架构层级视图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将组织架构的平铺成员列表改造成根组织、组织单元和成员三层相连的组织树。

**Architecture:** 保持现有服务端数据结构，在客户端将 `humans` 和 `agents` 投影为两个组织分支。结构语义和视图切换由 React 组件负责，连接关系和响应式布局由局部 CSS 负责，按群组视图沿用现有数据与成员卡。

**Tech Stack:** Next.js 16、React 19、TypeScript、CSS、Vitest、Testing Library

---

### Task 1: 组织树行为测试

**Files:**
- Create: `apps/web/features/org-chart/org-chart-page-client.test.tsx`

- [ ] **Step 1: Write the failing test**

  渲染包含一名人类和两名 AI 员工的数据，断言组织树面板包含“工作区全体”根节点、两个组织单元、正确数量的 `treeitem`，并断言切换“按群组”后 tab 选中状态和群组内容正确。

- [ ] **Step 2: Run test to verify it fails**

  Run: `pnpm --filter @dofe-agent/web exec vitest run features/org-chart/org-chart-page-client.test.tsx`

  Expected: FAIL，因为现有组件没有树语义、根节点和组织单元。

### Task 2: 三层组织树组件

**Files:**
- Modify: `apps/web/features/org-chart/org-chart-page-client.tsx`

- [ ] **Step 1: Implement the minimal hierarchy**

  增加根节点、组织单元节点、成员列表与紧凑空节点；为视图切换增加 `tablist` / `tab` / `tabpanel` 属性；成员卡支持树视图和群组视图复用。

- [ ] **Step 2: Run test to verify it passes**

  Run: `pnpm --filter @dofe-agent/web exec vitest run features/org-chart/org-chart-page-client.test.tsx`

  Expected: PASS。

### Task 3: 组织图视觉与响应式布局

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Implement hierarchy styling**

  为画布、根节点、组织单元、成员分支和连接线添加稳定尺寸与响应式规则；保留现有设计变量，补充键盘焦点和减少动态效果样式。

- [ ] **Step 2: Verify behavior and types**

  Run: `pnpm --filter @dofe-agent/web exec vitest run features/org-chart/org-chart-page-client.test.tsx`

  Run: `pnpm --filter @dofe-agent/web exec tsc -p tsconfig.test.json --noEmit`

  Expected: 两条命令均退出码 0。

### Task 4: 浏览器验证与提交

**Files:**
- Verify: `apps/web/features/org-chart/org-chart-page-client.tsx`
- Verify: `apps/web/app/globals.css`

- [ ] **Step 1: Run the local app and inspect desktop/mobile**

  使用本地开发服务器和 Playwright 检查桌面、移动视口，确认组织树非空、连接线连续、文本不重叠、切换可用。

- [ ] **Step 2: Review the diff**

  Run: `git diff --check`

  Expected: 无空白错误。

- [ ] **Step 3: Commit the verified change**

  Run: `git add -A && git commit -m "优化组织架构层级视图"`

  Expected: 提交成功，不执行 push。

