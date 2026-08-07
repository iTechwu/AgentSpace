# SSO Workspace Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让平台管理员只看到当前有效的 SSO workspace，并以可恢复的归档对账清理现有测试与历史漂移数据。

**Architecture:** SSO 继续生成确定性 workspace ID，本地 `workspace.archived_at` 表示 scope 是否有效，`workspace_sso_binding` 表示可信 SSO 映射。平台管理员登录时执行全量目录对账，普通用户登录只同步本人成员关系；管理员请求只读取未归档且已绑定的 workspace。维护脚本和 E2E 清理复用严格的测试 workspace 判定，不做业务 workspace 物理删除。

**Tech Stack:** TypeScript、Next.js 16、Vitest、Node test runner、PostgreSQL、Playwright、`@dofe/sso-node`

---

## File Map

- `packages/db/src/workspaces.ts`: workspace 归档恢复和“未归档且有 SSO binding”查询。
- `packages/db/src/workspace-sso-binding.ts`: 列出 binding，支持对账读取。
- `packages/db/src/postgres-schema.ts`: team/tenant 外部 binding 唯一索引。
- `packages/db/src/workspaces.test.ts`: 归档、恢复、可信列表回归测试。
- `packages/db/src/postgres.test.ts`: PostgreSQL schema 唯一约束断言。
- `packages/db/src/index.ts`: 导出新增数据库 API。
- `apps/web/features/auth/sso-workspaces.ts`: 普通用户同步与平台管理员全量对账。
- `apps/web/features/auth/sso-workspaces.test.ts`: 失效 scope 归档、重新启用恢复、普通用户不全局归档测试。
- `apps/web/features/auth/server-auth.ts`: 仅在平台管理员登录时开启权威目录对账。
- `apps/web/features/auth/server-workspace-resolver.ts`: 管理员仅从可信 SSO workspace 构造合成成员关系。
- `apps/web/features/auth/server-workspace.test.ts`: 未绑定测试 workspace 不可见测试。
- `apps/web/features/auth/sso-workspace-maintenance.ts`: dry-run/apply 分类和严格测试数据判定。
- `apps/web/features/auth/sso-workspace-maintenance.test.ts`: 维护计划幂等性与边界测试。
- `apps/web/scripts/reconcile-sso-workspaces.ts`: 读取 SSO 目录并执行一次性维护。
- `apps/web/package.json`: 增加维护命令。
- `apps/web/e2e/global-cleanup.ts`: 在测试库回收精确匹配的 E2E workspace。
- `apps/web/playwright.config.ts`: 注册 global setup/teardown。
- `apps/web/e2e/global-cleanup.test.ts`: 清理判定与执行回归测试。

### Task 1: 数据库归档恢复与可信 SSO Workspace 查询

**Files:**
- Modify: `packages/db/src/workspaces.ts`
- Modify: `packages/db/src/workspace-sso-binding.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/workspaces.test.ts`

- [ ] **Step 1: Write the failing database behavior tests**

在 `packages/db/src/workspaces.test.ts` 增加测试：

```ts
test("restoreWorkspaceSync makes an archived workspace active again", () => {
  const workspace = createWorkspaceSync({ id: "sso-team-restored", slug: "restored", name: "Restored", createdBy: "system" });
  archiveWorkspaceSync(workspace.id);
  assert.equal(listWorkspacesSync().some((item) => item.id === workspace.id), false);
  restoreWorkspaceSync(workspace.id);
  assert.equal(listWorkspacesSync().some((item) => item.id === workspace.id), true);
});

test("listActiveSsoWorkspacesSync excludes unbound and archived workspaces", () => {
  const active = createWorkspaceSync({ id: "sso-team-active", slug: "active", name: "Active", createdBy: "system" });
  const archived = createWorkspaceSync({ id: "sso-team-archived", slug: "archived", name: "Archived", createdBy: "system" });
  createWorkspaceSync({ id: "sso-team-e2e-unbound", slug: "unbound", name: "E2E Workspace unbound", createdBy: "system" });
  upsertWorkspaceSsoBindingSync(teamBinding(active.id, "team-active"));
  upsertWorkspaceSsoBindingSync(teamBinding(archived.id, "team-archived"));
  archiveWorkspaceSync(archived.id);
  assert.deepEqual(listActiveSsoWorkspacesSync().map((item) => item.id), [active.id]);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test packages/db/src/workspaces.test.ts
```

Expected: FAIL because `restoreWorkspaceSync` and `listActiveSsoWorkspacesSync` are not exported.

- [ ] **Step 3: Implement minimal database APIs**

在 `packages/db/src/workspaces.ts` 增加：

```ts
export function restoreWorkspaceSync(id: string): void {
  const now = new Date().toISOString();
  getDatabase().prepare(`UPDATE workspace SET archived_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
}

export function listActiveSsoWorkspacesSync(): StoredWorkspaceRecord[] {
  const rows = getDatabase().prepare(`
    SELECT w.id, w.slug, w.name, w.created_by, w.created_at, w.updated_at, w.archived_at
    FROM workspace w
    INNER JOIN workspace_sso_binding b ON b.workspace_id = w.id
    WHERE w.archived_at IS NULL
    ORDER BY w.created_at DESC
  `).all();
  return rows.map(mapWorkspaceRecord);
}
```

把 workspace row 映射提取为本文件私有 helper，避免 `listWorkspacesSync` 与新查询重复；从 `packages/db/src/index.ts` 导出新增函数。同时从 `workspace-sso-binding.ts` 导出 `listWorkspaceSsoBindingsSync()`，返回所有 binding 供对账使用。

- [ ] **Step 4: Run the database tests and verify GREEN**

Run the Task 1 test command. Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add -A -- packages/db/src/workspaces.ts packages/db/src/workspace-sso-binding.ts packages/db/src/workspaces.test.ts packages/db/src/index.ts
git commit -m "实现：支持SSO工作区归档恢复与可信查询"
```

### Task 2: SSO Binding 唯一约束

**Files:**
- Modify: `packages/db/src/postgres-schema.ts`
- Modify: `packages/db/src/postgres.test.ts`

- [ ] **Step 1: Write the failing schema test**

在 `packages/db/src/postgres.test.ts` 增加：

```ts
test("postgres schema makes SSO team and tenant scopes unique", () => {
  const sql = getPostgresSchemaStatements().join("\n");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sso_binding_team_unique[\s\S]*ON workspace_sso_binding\(team_id\)[\s\S]*WHERE team_id IS NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sso_binding_tenant_unique[\s\S]*ON workspace_sso_binding\(tenant_id\)[\s\S]*WHERE source = 'tenant'/);
});
```

- [ ] **Step 2: Run the schema test and verify RED**

```bash
node --env-file-if-exists=.env --experimental-strip-types --test packages/db/src/postgres.test.ts
```

Expected: FAIL because both unique indexes are absent.

- [ ] **Step 3: Add the partial unique indexes**

在 `packages/db/src/postgres-schema.ts` 的 binding 索引区增加：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sso_binding_team_unique
  ON workspace_sso_binding(team_id)
  WHERE team_id IS NOT NULL
```

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sso_binding_tenant_unique
  ON workspace_sso_binding(tenant_id)
  WHERE source = 'tenant'
```

保留现有普通 team 索引只会重复索引，因此将其替换为唯一索引。迁移前通过维护脚本 dry-run 检测重复 binding；数据复核无重复后再让应用初始化 schema。

- [ ] **Step 4: Run schema tests and verify GREEN**

Run the Task 2 test command. Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add -A -- packages/db/src/postgres-schema.ts packages/db/src/postgres.test.ts
git commit -m "约束：确保SSO工作区映射唯一"
```

### Task 3: 平台管理员权威目录对账

**Files:**
- Modify: `apps/web/features/auth/sso-workspaces.ts`
- Modify: `apps/web/features/auth/server-auth.ts`
- Test: `apps/web/features/auth/sso-workspaces.test.ts`

- [ ] **Step 1: Write failing reconciliation tests**

增加三个测试：

```ts
it("archives bound workspaces missing from an authoritative admin directory", () => {
  seedBoundWorkspace("sso-team-stale", "team-stale");
  syncSsoWorkspacesForUserSync({ displayName: "Admin", materializeMemberships: false, reconcileDirectory: true, scopes: [], userId: "user-1" });
  expect(readWorkspaceSync("sso-team-stale")?.archivedAt).toBeTruthy();
});

it("restores an archived workspace when its SSO scope becomes active again", () => {
  const scopes = buildSsoWorkspaceScopes(teamDirectory("team-active"));
  seedBoundWorkspace(scopes[0]!.id, "team-active");
  archiveWorkspaceSync(scopes[0]!.id);
  syncSsoWorkspacesForUserSync({ displayName: "Admin", materializeMemberships: false, reconcileDirectory: true, scopes, userId: "user-1" });
  expect(readWorkspaceSync(scopes[0]!.id)?.archivedAt).toBeUndefined();
});

it("does not archive unrelated bound workspaces during a regular user login", () => {
  seedBoundWorkspace("sso-team-other", "team-other");
  syncSsoWorkspacesForUserSync({ displayName: "Mina", scopes: [], userId: "user-1" });
  expect(readWorkspaceSync("sso-team-other")?.archivedAt).toBeUndefined();
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @dofe-agent/web exec vitest run features/auth/sso-workspaces.test.ts
```

Expected: FAIL because `reconcileDirectory` is not implemented and archived workspaces are not restored.

- [ ] **Step 3: Implement transactional authoritative reconciliation**

扩展输入：

```ts
export function syncSsoWorkspacesForUserSync(input: {
  displayName: string;
  materializeMemberships?: boolean;
  reconcileDirectory?: boolean;
  scopes: readonly SsoWorkspaceScope[];
  userId: string;
}): SsoWorkspaceScope[]
```

用 `withTransaction(getDatabase(), () => { ... })` 包裹当前同步。处理每个有效 scope 时调用 `restoreWorkspaceSync(scope.id)`；仅当 `reconcileDirectory === true` 时遍历 `listWorkspaceSsoBindingsSync()`，对不在 `activeScopeIds` 中的 workspace 调用 `archiveWorkspaceSync()`。

在 `server-auth.ts` 中传入：

```ts
reconcileDirectory: updatedUser.isAdmin === true,
```

SSO 请求失败发生在此函数之前，因此失败时不会触发归档。

- [ ] **Step 4: Run tests and verify GREEN**

Run the Task 3 command. Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add -A -- apps/web/features/auth/sso-workspaces.ts apps/web/features/auth/sso-workspaces.test.ts apps/web/features/auth/server-auth.ts
git commit -m "修复：按SSO权威目录归档和恢复工作区"
```

### Task 4: 平台管理员只读取可信 SSO Workspace

**Files:**
- Modify: `apps/web/features/auth/server-workspace-resolver.ts`
- Test: `apps/web/features/auth/server-workspace.test.ts`

- [ ] **Step 1: Write the failing access test**

更新原平台管理员测试：创建一个有 binding 的真实 workspace、一个无 binding 的 `sso-team-e2e-*` workspace、一个已归档且有 binding 的 workspace，并断言只有真实 workspace 可访问和出现在列表中。

```ts
expect(resolveWorkspaceAccessForIdentifierSync(user, "platform-target").status).toBe("ok");
expect(resolveWorkspaceAccessForIdentifierSync(user, "sso-team-e2e-unbound").status).toBe("forbidden");
expect(resolveWorkspaceAccessForIdentifierSync(user, "archived-target").status).toBe("forbidden");
expect(resolveCurrentWorkspaceContextForUserSync(user).workspaces.map((item) => item.id)).toEqual(["sso-team-platform-target"]);
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --filter @dofe-agent/web exec vitest run features/auth/server-workspace.test.ts
```

Expected: FAIL because the resolver currently grants every unarchived `sso-*` workspace.

- [ ] **Step 3: Replace prefix filtering with trusted query**

在 `ensureWorkspaceMembershipsSync` 管理员分支中使用 `listActiveSsoWorkspacesSync()`，删除 `listWorkspacesSync().filter(id.startsWith("sso-"))`。普通用户成员仍保留 `sso-` 限制。

- [ ] **Step 4: Run the test and verify GREEN**

Run the Task 4 command. Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add -A -- apps/web/features/auth/server-workspace-resolver.ts apps/web/features/auth/server-workspace.test.ts
git commit -m "修复：管理员仅访问有效SSO工作区"
```

### Task 5: Dry-run/Apply 维护命令与 E2E 回收

**Files:**
- Create: `apps/web/features/auth/sso-workspace-maintenance.ts`
- Create: `apps/web/features/auth/sso-workspace-maintenance.test.ts`
- Create: `apps/web/scripts/reconcile-sso-workspaces.ts`
- Create: `apps/web/e2e/global-cleanup.ts`
- Create: `apps/web/e2e/global-cleanup.test.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Write failing maintenance classification tests**

维护模块暴露纯判定和执行 API：

```ts
export function isDisposableTestWorkspace(workspace: StoredWorkspaceRecord, hasBinding: boolean): boolean;
export function planSsoWorkspaceMaintenanceSync(activeWorkspaceIds: ReadonlySet<string>): SsoWorkspaceMaintenancePlan;
export function applySsoWorkspaceMaintenanceSync(plan: SsoWorkspaceMaintenancePlan): SsoWorkspaceMaintenanceResult;
```

测试要求：

```ts
expect(isDisposableTestWorkspace({ id: "sso-team-e2e-abc-def", name: "E2E Workspace abc-def", ...record }, false)).toBe(true);
expect(isDisposableTestWorkspace({ id: "sso-team-real", name: "E2E Workspace customer", ...record }, true)).toBe(false);
expect(isDisposableTestWorkspace({ id: "sso-team-e2e-abc-def", name: "Customer", ...record }, false)).toBe(false);
```

再用临时数据库验证 dry-run 不写数据、apply 只归档计划目标、第二次 apply 变更数为零。

- [ ] **Step 2: Run maintenance tests and verify RED**

```bash
pnpm --filter @dofe-agent/web exec vitest run features/auth/sso-workspace-maintenance.test.ts e2e/global-cleanup.test.ts
```

Expected: FAIL because maintenance and cleanup modules do not exist.

- [ ] **Step 3: Implement strict maintenance planning**

测试 workspace 仅在以下任一完整条件成立时进入计划：

```ts
const isE2e = /^sso-team-e2e-[a-z0-9]+-[a-z0-9]+$/.test(workspace.id)
  && /^E2E Workspace [a-z0-9]+-[a-z0-9]+$/.test(workspace.name);
const isVisual = /^Loading Visual Check$/.test(workspace.name)
  && workspace.id.startsWith("sso-");
return !hasBinding && (isE2e || isVisual);
```

计划器还检测同一 `teamId` 或 tenant-only `tenantId` 的重复 binding；发现重复时抛错且不执行写入。apply 使用事务归档测试目标和失效 binding、恢复有效 binding，并返回 `archivedIds`/`restoredIds`。

- [ ] **Step 4: Implement operational script**

脚本读取 `--apply`，默认 dry-run；通过 `@dofe/sso-node` 分页读取 ACTIVE tenant/team，调用 `buildSsoAdminWorkspaceScopes` 生成权威 scope，并输出 JSON：

```ts
const apply = process.argv.includes("--apply");
const plan = planSsoWorkspaceMaintenanceSync(new Set(scopes.map((scope) => scope.id)));
const result = apply ? applySsoWorkspaceMaintenanceSync(plan) : undefined;
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", plan, result }, null, 2));
```

在 `apps/web/package.json` 增加：

```json
"reconcile:sso-workspaces": "node --env-file-if-exists=../../.env --experimental-strip-types scripts/reconcile-sso-workspaces.ts"
```

- [ ] **Step 5: Implement E2E global cleanup**

`global-cleanup.ts` 只在 `DOFE_AGENT_E2E === "1"` 时运行，查询严格匹配的未绑定 E2E workspace 并调用 `hardDeleteWorkspaceSync`。同一函数同时作为 Playwright `globalSetup` 和 `globalTeardown`，从而清理上次异常残留及本轮产物；在 `playwright.config.ts` 注册两个生命周期钩子。

- [ ] **Step 6: Run tests and verify GREEN**

Run the Task 5 test command. Expected: PASS.

- [ ] **Step 7: Run type checks**

```bash
pnpm --filter @dofe-agent/web run typecheck:test
pnpm run typecheck:deps
pnpm run typecheck:web:only
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 5**

```bash
git add -A -- apps/web/features/auth/sso-workspace-maintenance.ts apps/web/features/auth/sso-workspace-maintenance.test.ts apps/web/scripts/reconcile-sso-workspaces.ts apps/web/e2e/global-cleanup.ts apps/web/e2e/global-cleanup.test.ts apps/web/playwright.config.ts apps/web/package.json
git commit -m "实现：增加SSO工作区维护与测试回收"
```

### Task 6: 当前应用库归档与最终验证

**Files:**
- No repository source changes.
- Runtime evidence: local command output retained in this task transcript; do not commit secrets or database dumps.

- [ ] **Step 1: Verify duplicate bindings before applying schema indexes**

使用只读查询统计 `team_id` 和 tenant-only `tenant_id` 重复项。Expected: zero duplicate groups；否则停止并人工处理冲突。

- [ ] **Step 2: Run maintenance dry-run**

```bash
pnpm --dir apps/web run reconcile:sso-workspaces
```

Expected plan: 3 active scopes, 7 stale bound workspaces to archive, 87 unbound test workspaces to archive, no unexpected category.

- [ ] **Step 3: Apply logical archival**

```bash
pnpm --dir apps/web run reconcile:sso-workspaces -- --apply
```

Expected: only IDs printed by dry-run are archived; no physical deletes.

- [ ] **Step 4: Verify idempotency**

Run apply again. Expected: `archivedIds` and `restoredIds` are empty.

- [ ] **Step 5: Verify authoritative data counts read-only**

Read SSO ACTIVE directory and application DB. Expected:

- 3 valid authoritative scopes.
- 3 unarchived bound SSO workspaces.
- 0 unarchived unbound `sso-*` test workspaces.
- Platform administrator resolver produces exactly those 3 workspace IDs.

- [ ] **Step 6: Run final relevant verification**

```bash
pnpm --filter @dofe-agent/web exec vitest run features/auth/sso-workspaces.test.ts features/auth/server-workspace.test.ts features/auth/sso-workspace-maintenance.test.ts e2e/global-cleanup.test.ts
node --env-file-if-exists=.env --experimental-strip-types --test packages/db/src/workspaces.test.ts packages/db/src/postgres.test.ts
pnpm run typecheck:deps
pnpm run typecheck:web:only
pnpm --filter @dofe-agent/web run typecheck:test
git diff --check
```

Expected: every command exits 0 with no failed tests or type errors.

## 跨仓后续

SSO 的孤儿 team 查询与状态修复属于独立子项目。完成本计划后进入 SSO 仓库，读取其 `AGENTS.md` 和数据迁移约束，另建规格与实施计划；该修复不得与 AgentSpace 提交混合，也不得从本工作站触发 Jenkins。
