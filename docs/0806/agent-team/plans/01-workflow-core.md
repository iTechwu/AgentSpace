# Workflow 核心模型与持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立版本化 Workflow 的领域契约、PostgreSQL 表、仓储、校验和发布服务。

**Architecture:** Domain 包定义稳定 DAG 和状态类型；DB 包只负责持久化与事务；Service 包负责图校验、权限预检、版本哈希和审计。该阶段不运行 AI 节点。

**Tech Stack:** TypeScript、Node Test、PostgreSQL、AJV、现有 `@dofe-agent/domain`、`@dofe-agent/db`、`@dofe-agent/services`。

---

## 文件结构

```text
packages/domain/src/workflows.ts
packages/domain/src/workflows.test.ts
packages/domain/src/index.ts
packages/db/src/postgres-schema.ts
packages/db/src/types.ts
packages/db/src/workflows/definitions.ts
packages/db/src/workflows/runs.ts
packages/db/src/workflows/events.ts
packages/db/src/workflows/workflows.test.ts
packages/db/src/index.ts
packages/services/src/workflows/validation.ts
packages/services/src/workflows/definitions.ts
packages/services/src/workflows/publishing.ts
packages/services/src/workflows/publishing.test.ts
packages/services/src/index.ts
```

### Task 1: 定义 Workflow 领域契约和 DAG 校验

**Files:**
- Create: `packages/domain/src/workflows.ts`
- Create: `packages/domain/src/workflows.test.ts`
- Modify: `packages/domain/src/index.ts:1-12`

- [ ] **Step 1: 写失败测试，固定无环、可达和 Join 规则**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowGraph } from "./workflows.ts";

test("accepts serial plus parallel join", () => {
  const result = validateWorkflowGraph({
    schemaVersion: 1,
    nodes: [
      { id: "a", type: "employee_task", employeeId: "emp-a", config: {} },
      { id: "b", type: "employee_task", employeeId: "emp-b", config: {} },
      { id: "c", type: "employee_task", employeeId: "emp-c", config: {} },
      { id: "join", type: "join", config: { policy: "all_success" } },
      { id: "d", type: "employee_task", employeeId: "emp-d", config: {} },
    ],
    edges: [
      { source: "a", target: "b" }, { source: "a", target: "c" },
      { source: "b", target: "join" }, { source: "c", target: "join" },
      { source: "join", target: "d" },
    ],
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.topologicalOrder, ["a", "b", "c", "join", "d"]);
});

test("rejects cycles and join nodes with fewer than two inputs", () => {
  const result = validateWorkflowGraph({
    schemaVersion: 1,
    nodes: [
      { id: "a", type: "employee_task", employeeId: "emp-a", config: {} },
      { id: "join", type: "join", config: { policy: "all_success" } },
    ],
    edges: [{ source: "a", target: "join" }, { source: "join", target: "a" }],
  });
  assert.ok(result.errors.some((error) => error.code === "workflow_graph_cycle"));
  assert.ok(result.errors.some((error) => error.code === "workflow_join_requires_multiple_inputs"));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test --test-concurrency=1 packages/domain/src/workflows.test.ts`

Expected: FAIL，提示 `Cannot find module './workflows.ts'` 或 `validateWorkflowGraph` 未定义。

- [ ] **Step 3: 实现稳定类型和 Kahn 拓扑排序校验**

```ts
export type WorkflowNodeType = "employee_task" | "join" | "approval";
export type WorkflowJoinPolicy = "all_success" | "allow_partial";
export type WorkflowDefinitionStatus = "draft" | "published" | "paused" | "archived";
export type WorkflowRunStatus = "created" | "queued" | "running" | "waiting_approval" | "paused" | "succeeded" | "partially_succeeded" | "failed" | "cancelled";
export type WorkflowNodeRunStatus = "pending" | "ready" | "queued" | "running" | "waiting_approval" | "retry_wait" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface WorkflowNodeDefinition {
  id: string;
  type: WorkflowNodeType;
  employeeId?: string;
  config: Record<string, unknown>;
}

export interface WorkflowEdgeDefinition { source: string; target: string }
export interface WorkflowGraphDefinition {
  schemaVersion: 1;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

export interface WorkflowGraphError { code: string; nodeIds: string[] }
export interface WorkflowGraphValidationResult {
  errors: WorkflowGraphError[];
  topologicalOrder: string[];
}

export function validateWorkflowGraph(graph: WorkflowGraphDefinition): WorkflowGraphValidationResult {
  // Normalize IDs, reject duplicates/missing endpoints, build in/out degree maps,
  // run deterministic Kahn sorting, then validate reachability and Join indegree >= 2.
  // Return every structural error; never throw for user-authored graph mistakes.
}
```

实现必须按 `nodes` 原顺序稳定排序，错误至少覆盖：duplicate node、missing endpoint、cycle、unreachable node、employee missing、Join 输入不足和 Join 无下游。

- [ ] **Step 4: 导出模块并运行测试/类型检查**

Run:

```bash
node --experimental-strip-types --test --test-concurrency=1 packages/domain/src/workflows.test.ts
pnpm --filter @dofe-agent/domain run types
```

Expected: PASS；类型检查退出码 0。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/domain/src/workflows.ts packages/domain/src/workflows.test.ts packages/domain/src/index.ts
git commit -m "功能：定义工作流领域模型与图校验"
```

### Task 2: 新增 PostgreSQL Workflow Schema

**Files:**
- Modify: `packages/db/src/postgres-schema.ts:1231-1257,1513-1590,2490-2575`
- Modify: `packages/db/src/types.ts:430-495`
- Create: `packages/db/src/workflows/schema.test.ts`

- [ ] **Step 1: 写失败的 schema 契约测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getPostgresSchemaStatements } from "../postgres-schema.ts";

test("workflow schema contains tenant-safe relations and idempotency constraints", () => {
  const sql = getPostgresSchemaStatements().join("\n");
  for (const table of ["workflow_definition", "workflow_version", "workflow_trigger", "workflow_run", "workflow_node_run", "workflow_run_event", "workflow_outbox"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /UNIQUE\s*\(workspace_id, trigger_key\)/i);
  assert.match(sql, /UNIQUE\s*\(run_id, node_id\)/i);
  assert.match(sql, /UNIQUE\s*\(run_id, sequence\)/i);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/schema.test.ts`

Expected: FAIL，缺少 `workflow_definition`。

- [ ] **Step 3: 增加表、约束和索引**

在 `getPostgresSchemaStatements()` 返回的语句列表中按依赖顺序加入设计文档 §05 的七张表。必须包含：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_run_trigger_key
  ON workflow_run(workspace_id, trigger_key);
CREATE INDEX IF NOT EXISTS idx_workflow_trigger_due
  ON workflow_trigger(status, next_fire_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_workflow_node_run_ready
  ON workflow_node_run(status, available_at)
  WHERE status IN ('ready', 'retry_wait');
CREATE INDEX IF NOT EXISTS idx_workflow_outbox_due
  ON workflow_outbox(status, available_at)
  WHERE status = 'pending';
```

所有表必须 `workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE`；历史 Run/Node/Event 不因 Definition 归档而删除。

- [ ] **Step 4: 添加 record 类型并验证**

在 `types.ts` 添加与列一一对应的 `WorkflowDefinitionRecord`、`WorkflowVersionRecord`、`WorkflowTriggerRecord`、`WorkflowRunRecord`、`WorkflowNodeRunRecord`、`WorkflowRunEventRecord`、`WorkflowOutboxRecord`，JSON 列仍以 string 暴露，与现有 DB 层一致。

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/schema.test.ts
pnpm --filter @dofe-agent/db run types
```

Expected: PASS；类型检查退出码 0。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/db/src/postgres-schema.ts packages/db/src/types.ts packages/db/src/workflows/schema.test.ts
git commit -m "功能：新增工作流持久化表结构"
```

### Task 3: 实现 Definition、Version 和 Trigger 仓储

**Files:**
- Create: `packages/db/src/workflows/definitions.ts`
- Create: `packages/db/src/workflows/definitions.test.ts`
- Modify: `packages/db/src/index.ts:1-260`

- [ ] **Step 1: 写 workspace 隔离和不可变版本测试**

```ts
test("published versions are immutable and scoped to workspace", () => {
  const draft = createWorkflowDefinitionSync({ workspaceId: "default", name: "Daily brief", ownerUserId: "u1", createdBy: "u1" });
  const version = publishWorkflowVersionSync({ workspaceId: "default", workflowId: draft.id, graphJson: VALID_GRAPH, contentHash: "sha256:a", publishedBy: "u1" });
  assert.equal(readWorkflowVersionSync(version.id, "other-workspace"), null);
  assert.throws(() => publishWorkflowVersionSync({ workspaceId: "default", workflowId: draft.id, graphJson: VALID_GRAPH, contentHash: "sha256:b", publishedBy: "u1", versionNumber: version.versionNumber }), /workflow_version_conflict/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/definitions.test.ts`

Expected: FAIL，仓储函数未定义。

- [ ] **Step 3: 实现事务仓储 API**

```ts
export function createWorkflowDefinitionSync(input: CreateWorkflowDefinitionInput): WorkflowDefinitionRecord;
export function updateWorkflowDraftSync(input: UpdateWorkflowDraftInput): WorkflowDefinitionRecord;
export function readWorkflowDefinitionSync(id: string, workspaceId: string): WorkflowDefinitionRecord | null;
export function listWorkflowDefinitionsSync(workspaceId: string): WorkflowDefinitionRecord[];
export function publishWorkflowVersionSync(input: PublishWorkflowVersionInput): WorkflowVersionRecord;
export function readWorkflowVersionSync(id: string, workspaceId: string): WorkflowVersionRecord | null;
export function listWorkflowVersionsSync(workflowId: string, workspaceId: string): WorkflowVersionRecord[];
export function upsertWorkflowTriggerSync(input: UpsertWorkflowTriggerInput): WorkflowTriggerRecord;
```

所有更新使用 `WHERE id = ? AND workspace_id = ?`；发布在事务内插入 version、更新 `active_version_id/status`、写 audit/outbox。`content_hash` 由 service 传入，DB 不自行序列化 graph。

- [ ] **Step 4: 导出并运行测试**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/definitions.test.ts
pnpm --filter @dofe-agent/db run types
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/db/src/workflows/definitions.ts packages/db/src/workflows/definitions.test.ts packages/db/src/index.ts
git commit -m "功能：实现工作流定义与版本仓储"
```

### Task 4: 实现发布校验与不可变版本服务

**Files:**
- Create: `packages/services/src/workflows/validation.ts`
- Create: `packages/services/src/workflows/publishing.ts`
- Create: `packages/services/src/workflows/publishing.test.ts`
- Modify: `packages/services/src/index.ts:1135-1163`

- [ ] **Step 1: 写发布预检失败测试**

```ts
test("publish rejects unavailable employees before writing a version", () => {
  const result = validateWorkflowForPublishSync({
    workspaceId: "default",
    graph: graphWithEmployee("missing-employee"),
    actor: { userId: "owner", displayName: "Owner", role: "owner" },
  });
  assert.deepEqual(result.blockers, [{ code: "workflow_employee_not_ready", nodeId: "research", employeeId: "missing-employee" }]);
  assert.throws(() => publishWorkflowSync({ ...VALID_INPUT, graph: graphWithEmployee("missing-employee") }), /workflow_employee_not_ready/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/publishing.test.ts`

Expected: FAIL，校验/发布函数未定义。

- [ ] **Step 3: 实现 canonical JSON、SHA-256 和预检**

```ts
export interface WorkflowPublishBlocker { code: string; nodeId?: string; employeeId?: string; detail?: string }
export interface WorkflowPublishValidation { blockers: WorkflowPublishBlocker[]; warnings: WorkflowPublishBlocker[] }

export function canonicalizeWorkflowGraph(graph: WorkflowGraphDefinition): string;
export function hashWorkflowGraph(graph: WorkflowGraphDefinition): string;
export function validateWorkflowForPublishSync(input: ValidateWorkflowForPublishInput): WorkflowPublishValidation;
export function publishWorkflowSync(input: PublishWorkflowInput): WorkflowVersionRecord;
```

预检依次执行 graph validator、员工存在/active、channel access、runtime binding、Skill readiness、预算与 actor role。先返回全部 blocker，再由 `publishWorkflowSync` 在 blocker 非空时抛稳定代码；成功时把 graph/input/output/governance canonical JSON 与 hash 交给 DB 事务。

- [ ] **Step 4: 运行 service/类型测试**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/publishing.test.ts
pnpm --filter @dofe-agent/services run types
```

Expected: PASS；重复发布相同 hash 不产生内容不同的版本。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/services/src/workflows packages/services/src/index.ts
git commit -m "功能：实现工作流发布预检与版本发布"
```

### Task 5: 核心阶段回归与覆盖清单

**Files:**
- Modify: `packages/db/package.json:21-28`
- Modify: `packages/services/package.json:7-9`
- Create: `packages/services/src/workflows/test-inventory.ts`

- [ ] **Step 1: 把 workflow 测试纳入包级受限测试清单**

```json
{
  "scripts": {
    "test": "sh -c 'for file in src/workflows/*.test.ts; do node --env-file-if-exists=../../.env --experimental-strip-types --test --test-concurrency=1 \"$file\" || exit 1; done' --"
  }
}
```

不要删除现有 skill/MCP/OpenMontage 测试；把 workflow glob 加入现有循环或 inventory，而不是替换脚本。

`packages/services/src/workflows/test-inventory.ts` 导出显式文件列表，供 `scripts/verify-test-coverage.mjs` 检查：

```ts
export const WORKFLOW_TEST_FILES = [
  "src/workflows/publishing.test.ts",
  "src/workflows/validation.test.ts",
] as const;
```

- [ ] **Step 2: 运行最小完整阶段测试**

Run:

```bash
pnpm --filter @dofe-agent/domain run test
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/*.test.ts
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/*.test.ts
pnpm run typecheck:deps
```

Expected: 全部 PASS；不得出现 workspace 泄漏、未稳定排序或 schema 缺索引。

- [ ] **Step 3: 检查变更和提交**

Run: `git diff --check`

Expected: 无输出。

```bash
git add -A -- packages/db/package.json packages/services/package.json packages/services/src/workflows/test-inventory.ts
git commit -m "测试：补齐工作流核心阶段回归清单"
```
