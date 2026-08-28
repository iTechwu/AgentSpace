# Workflow 编排中心与运行视图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态说明（2026-08-06）：复选框是可复现施工步骤，不是完成台账；实际完成度与环境门禁见 [../07-规格实施覆盖矩阵.md](../07-规格实施覆盖矩阵.md)。

**Goal:** 把现有 Automations 升级为计划/运行/模板编排中心，并让任务看板和日历进入同一个可访问的 Workflow 创建向导。

**Architecture:** Server Components/Workspace loader 提供首屏 projection，Server Actions 处理草稿、预检、发布和运行控制。客户端 `useReducer` 管理未保存草稿，`@xyflow/react` 仅负责画布交互，服务端 canonical graph 始终是事实来源。

**Tech Stack:** Next.js 16、React 19、TypeScript、`@xyflow/react`、现有 Workspace shell、Vitest、Testing Library、Playwright。

---

## 文件结构

```text
apps/web/features/workflows/workflow-types.ts
apps/web/features/workflows/workflow-data.ts
apps/web/features/workflows/workflow-actions.ts
apps/web/features/workflows/workflow-list-client.tsx
apps/web/features/workflows/workflow-builder-reducer.ts
apps/web/features/workflows/workflow-builder-client.tsx
apps/web/features/workflows/workflow-canvas.tsx
apps/web/features/workflows/workflow-node-config-panel.tsx
apps/web/features/workflows/workflow-preflight-panel.tsx
apps/web/features/workflows/workflow-run-client.tsx
apps/web/features/workflows/workflow-run-timeline.tsx
apps/web/app/w/[workspaceSlug]/automations/page.tsx
apps/web/app/w/[workspaceSlug]/automations/new/page.tsx
apps/web/app/w/[workspaceSlug]/automations/[workflowId]/page.tsx
apps/web/app/w/[workspaceSlug]/automations/runs/[runId]/page.tsx
```

### Task 1: 新增 Workflow Web 数据投影和 Workspace loader

**Files:**
- Create: `apps/web/features/workflows/workflow-types.ts`
- Create: `apps/web/features/workflows/workflow-data.ts`
- Create: `apps/web/features/workflows/workflow-data.test.ts`
- Modify: `apps/web/features/dashboard/workspace-module-loaders.ts:1-126,198-207`

- [ ] **Step 1: 写 workspace 隔离和摘要映射测试**

```ts
it("returns workflow list summaries without graph payloads", () => {
  seedWorkflow({ workspaceId: "default", name: "Daily brief", status: "published" });
  seedWorkflow({ workspaceId: "other", name: "Secret flow", status: "published" });
  const data = getWorkflowCenterPageData("default");
  expect(data.workflows.map((item) => item.name)).toEqual(["Daily brief"]);
  expect(data.workflows[0]).not.toHaveProperty("graphJson");
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-data.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现页面 DTO**

```ts
export interface WorkflowListItem {
  id: string;
  name: string;
  status: WorkflowDefinitionStatus;
  ownerLabel: string;
  triggerLabelCode: string;
  nextFireAt?: string;
  latestRun?: { id: string; status: WorkflowRunStatus; finishedAt?: string };
  topology: { employeeNodeCount: number; parallelGroupCount: number; hasApproval: boolean };
}

export interface WorkflowCenterPageData {
  workflows: WorkflowListItem[];
  totals: { all: number; published: number; paused: number; blocked: number };
}
```

`getWorkflowCenterPageData(workspaceId)` 只解析列表需要的 topology summary；不向列表传 graph、input、secret 引用或原始错误。

- [ ] **Step 4: 接入 automations loader 并验证**

把 `moduleId: "automations"` 的 data 类型从 `AutomationsPageData` 切换为 `WorkflowCenterPageData`，保留 legacy 统计字段在迁移 feature flag 内。

Run:

```bash
pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-data.test.ts features/dashboard/data.test.ts
pnpm --filter @dofe-agent/web run typecheck:test
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- apps/web/features/workflows apps/web/features/dashboard/workspace-module-loaders.ts
git commit -m "功能：新增编排中心数据投影"
```

### Task 2: 实现 Workflow Server Actions 与权限

**Files:**
- Create: `apps/web/features/workflows/workflow-actions.ts`
- Create: `apps/web/features/workflows/workflow-actions.test.ts`
- Modify: `apps/web/features/automations/actions.ts`

- [ ] **Step 1: 写 member/owner 权限和版本冲突测试**

```ts
it("requires admin to publish but lets members run published workflows", async () => {
  mockWorkspaceRole("member");
  await expect(publishWorkflowAction({ workflowId: "wf-1", expectedDraftVersion: 2 })).rejects.toThrow(/workspace role/i);
  await expect(runWorkflowAction({ workflowId: "wf-1", idempotencyKey: "manual:u1:1", input: {} })).resolves.toMatchObject({ ok: true });
});

it("returns a stable conflict code for stale drafts", async () => {
  mockWorkspaceRole("admin");
  const result = await updateWorkflowDraftAction({ workflowId: "wf-1", expectedDraftVersion: 1, patch: { name: "Changed" } });
  expect(result).toMatchObject({ ok: false, error: { code: "workflow_version_conflict" } });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-actions.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 Action 契约**

```ts
export type WorkflowActionResult<T> =
  | { ok: true; data: T; invalidation: WorkspaceInvalidationEvent }
  | { ok: false; error: { code: string; message: string; field?: string; nodeId?: string } };

export async function createWorkflowDraftAction(input: CreateWorkflowDraftInput): Promise<WorkflowActionResult<{ workflowId: string }>>;
export async function updateWorkflowDraftAction(input: UpdateWorkflowDraftInput): Promise<WorkflowActionResult<{ draftVersion: number }>>;
export async function validateWorkflowAction(input: ValidateWorkflowInput): Promise<WorkflowActionResult<WorkflowPreflightResult>>;
export async function publishWorkflowAction(input: PublishWorkflowInput): Promise<WorkflowActionResult<{ versionId: string }>>;
export async function runWorkflowAction(input: RunWorkflowInput): Promise<WorkflowActionResult<{ runId: string }>>;
export async function controlWorkflowRunAction(input: ControlWorkflowRunInput): Promise<WorkflowActionResult<{ runId: string; status: string }>>;
```

每个 Action 调用 `requireCurrentWorkspaceContext()`，publish/archive 需要 admin，run/control 需要成员和资源授权。返回错误前把内部路径/Provider message 映射为稳定 code。

- [ ] **Step 4: 运行测试并提交**

Run:

```bash
pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-actions.test.ts
pnpm --filter @dofe-agent/web run typecheck:test
```

Expected: PASS。

```bash
git add -A -- apps/web/features/workflows/workflow-actions.ts apps/web/features/workflows/workflow-actions.test.ts apps/web/features/automations/actions.ts
git commit -m "功能：实现工作流页面操作与权限校验"
```

### Task 3: 升级编排中心列表

**Files:**
- Create: `apps/web/features/workflows/workflow-list-client.tsx`
- Create: `apps/web/features/workflows/workflow-list-client.test.tsx`
- Modify: `apps/web/app/w/[workspaceSlug]/automations/page.tsx`
- Modify: `apps/web/features/dashboard/workspace-frame.tsx:912-923`

- [ ] **Step 1: 写 tabs、筛选和空状态测试**

```tsx
it("shows plan run template tabs and links to the shared builder", async () => {
  render(<WorkflowListClient data={fixture} workspaceSlug="default" />);
  expect(screen.getByRole("tab", { name: "计划" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "运行" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "模板" })).toBeVisible();
  expect(screen.getByRole("link", { name: "新建编排" })).toHaveAttribute("href", "/w/default/automations/new?entry=automations");
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-list-client.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现紧凑列表和状态**

使用 `WorkbenchPageHeader`、现有按钮/EmptyState；列表行显示名称、trigger、topology、nextFireAt、latestRun、owner、status。tabs 使用语义 `role=tablist/tab/tabpanel`，过滤不改变行高。

- [ ] **Step 4: 更新导航文案并运行测试**

把侧栏 `工作流规则 / Workflow Rules` 改为 `编排中心 / Orchestration`；路由仍为 `/automations`。

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-list-client.test.tsx features/dashboard/workspace-frame.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- apps/web/features/workflows apps/web/app/w apps/web/features/dashboard/workspace-frame.tsx
git commit -m "功能：升级自动化页面为编排中心"
```

### Task 4: 实现 Builder reducer 和客户端结构校验

**Files:**
- Create: `apps/web/features/workflows/workflow-builder-reducer.ts`
- Create: `apps/web/features/workflows/workflow-builder-reducer.test.ts`
- Create: `apps/web/features/workflows/workflow-client-validation.ts`

- [ ] **Step 1: 写 reducer/undo/连接校验测试**

```ts
test("creates a parallel group with an explicit join and supports undo", () => {
  let state = createEmptyWorkflowDraft();
  state = workflowDraftReducer(state, { type: "addEmployeeNode", nodeId: "a", employeeId: "emp-a" });
  state = workflowDraftReducer(state, { type: "addParallelGroup", sourceNodeId: "a", branches: [{ id: "b", employeeId: "emp-b" }, { id: "c", employeeId: "emp-c" }], joinId: "join" });
  expect(validateWorkflowDraft(state).errors).toEqual([]);
  state = workflowDraftReducer(state, { type: "undo" });
  expect(state.nodes.map((node) => node.id)).toEqual(["a"]);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-builder-reducer.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现纯 reducer**

```ts
export type WorkflowDraftEvent =
  | { type: "addEmployeeNode"; nodeId: string; employeeId: string }
  | { type: "addParallelGroup"; sourceNodeId: string; branches: Array<{ id: string; employeeId: string }>; joinId: string }
  | { type: "connect"; source: string; target: string }
  | { type: "updateNode"; nodeId: string; patch: Record<string, unknown> }
  | { type: "removeNode"; nodeId: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "markSaved"; canonical: WorkflowGraphDefinition; draftVersion: number };
```

History 只保存最近 50 次结构变化；`markSaved` 清除 dirty 但不清空 undo。客户端 validator 复用 domain 的结构规则并增加表单字段定位，不复制权限/Runtime 校验。

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-builder-reducer.test.ts`

Expected: PASS。

```bash
git add -A -- apps/web/features/workflows/workflow-builder-reducer.ts apps/web/features/workflows/workflow-builder-reducer.test.ts apps/web/features/workflows/workflow-client-validation.ts
git commit -m "功能：实现工作流草稿状态与客户端校验"
```

### Task 5: 实现可访问的 Workflow 画布与配置面板

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/features/workflows/workflow-canvas.tsx`
- Create: `apps/web/features/workflows/workflow-node-config-panel.tsx`
- Create: `apps/web/features/workflows/workflow-node-list-view.tsx`
- Create: `apps/web/features/workflows/workflow-canvas.test.tsx`

- [ ] **Step 1: 添加并固定画布依赖**

Run: `pnpm --filter @dofe-agent/web add @xyflow/react`

Expected: `apps/web/package.json` 和 `pnpm-lock.yaml` 更新；不要添加第二个状态管理库或自动布局库。

- [ ] **Step 2: 写键盘和列表替代视图测试**

```tsx
it("adds and connects nodes without drag and drop", async () => {
  const user = userEvent.setup();
  render(<WorkflowCanvasHarness />);
  await user.click(screen.getByRole("button", { name: "添加 AI 员工步骤" }));
  await user.selectOptions(screen.getByLabelText("AI 员工"), "emp-a");
  await user.click(screen.getByRole("button", { name: "连接到" }));
  await user.click(screen.getByRole("option", { name: "汇总步骤" }));
  expect(screen.getByRole("list", { name: "流程结构" })).toHaveTextContent("AI 员工步骤 → 汇总步骤");
});
```

- [ ] **Step 3: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-canvas.test.tsx`

Expected: FAIL。

- [ ] **Step 4: 实现画布适配层**

`@xyflow/react` node/edge 只在组件边界内使用；`toCanvasGraph`/`fromCanvasChange` 映射业务 DTO。节点固定最小/最大尺寸，长名称截断并有 tooltip。提供 `画布/列表` segmented control，所有 drag 行为有键盘命令替代。

Run:

```bash
pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-canvas.test.tsx
pnpm --filter @dofe-agent/web run typecheck:test
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- apps/web/package.json pnpm-lock.yaml apps/web/features/workflows
git commit -m "功能：实现可访问的工作流编排画布"
```

### Task 6: 实现统一创建向导、预检与发布

**Files:**
- Create: `apps/web/features/workflows/workflow-builder-client.tsx`
- Create: `apps/web/features/workflows/workflow-preflight-panel.tsx`
- Create: `apps/web/features/workflows/workflow-builder-client.test.tsx`
- Create: `apps/web/app/w/[workspaceSlug]/automations/new/page.tsx`
- Create: `apps/web/app/w/[workspaceSlug]/automations/[workflowId]/page.tsx`

- [ ] **Step 1: 写完整 happy path 和阻塞错误测试**

```tsx
it("creates, preflights and publishes a serial plus parallel workflow", async () => {
  renderBuilder({ entry: "calendar", employees: readyEmployees });
  await fillGoalAndDailyTrigger();
  await addParallelGraph();
  await userEvent.click(screen.getByRole("button", { name: "运行预检" }));
  expect(await screen.findByText("预检通过")) .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "发布" }));
  expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ expectedDraftVersion: 1 }));
});

it("keeps the builder open and focuses a blocked employee node", async () => {
  mockPreflightBlocker({ code: "workflow_employee_not_ready", nodeId: "audit" });
  renderBuilder();
  await userEvent.click(screen.getByRole("button", { name: "运行预检" }));
  expect(screen.getByTestId("node-audit")).toHaveAttribute("data-error", "true");
  expect(screen.getByRole("button", { name: "发布" })).toBeDisabled();
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-builder-client.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现五步向导和 entry 默认值**

`entry=task-board` 打开目标步骤；`entry=calendar` 打开 Trigger 步骤；`entry=automations` 从目标开始。步骤为目标、触发、流程、治理、预览。保存草稿返回 canonical graph；任何编辑清除旧 preflight。离开 dirty 页面使用浏览器确认。

- [ ] **Step 4: 运行测试和类型检查**

Run:

```bash
pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-builder-client.test.tsx
pnpm --filter @dofe-agent/web run typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- apps/web/features/workflows apps/web/app/w
git commit -m "功能：实现工作流创建预检与发布向导"
```

### Task 7: 实现 Run 详情、事件补偿和控制

**Files:**
- Create: `apps/web/features/workflows/workflow-run-client.tsx`
- Create: `apps/web/features/workflows/workflow-run-timeline.tsx`
- Create: `apps/web/features/workflows/workflow-run-client.test.tsx`
- Create: `apps/web/app/w/[workspaceSlug]/automations/runs/[runId]/page.tsx`
- Create: `apps/web/app/api/workspaces/[workspaceId]/workflow-runs/[runId]/events/route.ts`
- Create: `apps/web/app/api/workspaces/[workspaceId]/workflow-runs/[runId]/events/route.test.ts`

- [ ] **Step 1: 写刷新恢复、sequence 缺口和重试测试**

```tsx
it("reconciles an event sequence gap before rendering newer state", async () => {
  renderRun({ lastSequence: 4 });
  emitEvent({ sequence: 6, type: "workflow.node.succeeded" });
  expect(screen.getByText("正在同步缺失事件")) .toBeVisible();
  await waitFor(() => expect(mockFetchEvents).toHaveBeenCalledWith(expect.stringContaining("after=4")));
  expect(await screen.findByText("运行中")) .toBeVisible();
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-run-client.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现 projection 驱动的 Run UI**

Run 状态来自服务端 DTO；实时消息仅触发按 sequence 合并。节点显示员工、attempt、耗时、成本、Artifact 数和审批。操作只在允许状态显示，并调用 `controlWorkflowRunAction`；失败信息使用本地化稳定 code。

- [ ] **Step 4: 实现事件 route 的 workspace/auth/after 校验**

Route 使用当前用户 workspace context，拒绝 URL workspace 与 session workspace 不匹配；`after` 必须为非负整数；返回最多 200 条有序事件和 `hasMore`。

Run:

```bash
pnpm --filter @dofe-agent/web exec vitest run features/workflows/workflow-run-client.test.tsx 'app/api/workspaces/[workspaceId]/workflow-runs/[runId]/events/route.test.ts'
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- apps/web/features/workflows apps/web/app/w apps/web/app/api/workspaces
git commit -m "功能：实现工作流运行详情与事件补偿"
```

### Task 8: 接入任务看板、日历和移动端

**Files:**
- Modify: `apps/web/features/task-board/task-board-page-client.tsx:18-150`
- Modify: `apps/web/features/calendar/calendar-page-client.tsx:16-160`
- Modify: `apps/web/features/task-board/task-board-page-client.test.tsx`
- Modify: `apps/web/features/calendar/calendar-page-client.test.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/e2e/workflows-migration.spec.ts`

- [ ] **Step 1: 写两个入口都指向同一 builder 的测试**

```tsx
expect(within(taskBoardHeader).getByRole("link", { name: "编排任务" })).toHaveAttribute("href", "/w/default/automations/new?entry=task-board");
expect(within(calendarHeader).getByRole("link", { name: "新建定时" })).toHaveAttribute("href", "/w/default/automations/new?entry=calendar");
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/task-board/task-board-page-client.test.tsx features/calendar/calendar-page-client.test.tsx`

Expected: FAIL，仍使用旧 modal/入口。

- [ ] **Step 3: 替换入口并保留 legacy 查看**

任务看板新增“编排任务”命令；日历“新建定时”改为 Link。Legacy ScheduledTask 只读展示直到迁移阶段切流，不在新 UI 再创建旧记录。

- [ ] **Step 4: 完成响应式和 E2E**

≤860px 使用节点列表/画布/配置 segmented view；按钮、节点和时间线无重叠。Playwright 用测试管理员账号仅对本地/测试环境验证：创建 `A → (B ∥ C) → D`、发布、运行、刷新、查看终态。

Run:

```bash
pnpm --filter @dofe-agent/web exec vitest run features/workflows features/task-board/task-board-page-client.test.tsx features/calendar/calendar-page-client.test.tsx
pnpm --filter @dofe-agent/web run test:e2e -- workflows-migration.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- apps/web/features/task-board apps/web/features/calendar apps/web/features/workflows apps/web/app/globals.css apps/web/e2e/workflows-migration.spec.ts
git commit -m "功能：统一看板日历与工作流创建入口"
```

### Task 9: Web 阶段质量门禁

**Files:**
- Modify: `apps/web/features/i18n/presentation.ts`

- [ ] **Step 1: 补齐稳定错误码和状态本地化**

覆盖设计文档中的 graph、employee readiness、version conflict、trigger duplicate、budget、retry exhausted、sequence gap 和 cross-workspace code；不得直接显示服务端英文 message。

- [ ] **Step 2: 运行受限质量命令**

Run:

```bash
pnpm --filter @dofe-agent/web run typecheck
pnpm --filter @dofe-agent/web run typecheck:test
pnpm --filter @dofe-agent/web run lint
pnpm --filter @dofe-agent/web exec vitest run features/workflows features/task-board features/calendar
git diff --check
```

Expected: 全部 PASS。

- [ ] **Step 3: 提交**

```bash
git add -A -- apps/web
git commit -m "测试：完成工作流前端质量验证"
```
