# 05 SkillRolloutPlan 具体落点文件与测试矩阵

本文把 [02-依赖模型与接口契约.md](./02-依赖模型与接口契约.md) 的 `planSkillRollout` 深模块和 [04-实施计划与验收.md](./04-实施计划与验收.md) 的阶段拆成**逐文件改动点**与**可执行的测试矩阵**。所有函数名、文件路径、导出位置均对照当前代码逐一核对。

## 1. 落点分层总览

| 层 | 包 | 改动 |
| --- | --- | --- |
| 领域类型 | `packages/domain/src/skill-package.ts` | 新增 `SkillSkillDependency` 类型 |
| 解析 | `packages/services/src/skills/dependencies.ts` | 新增 `skillDependencies` frontmatter 解析 |
| 包构建 | `packages/services/src/skills/skill-artifacts.ts` | manifest 增加 `skillDependencies` 字段 |
| 锁 | `packages/services/src/skills/release-lock.ts` | lock 纳入 skill 依赖声明 |
| 深模块 | `packages/services/src/skills/rollout.ts`（新） | `planSkillRollout` 及辅助函数 |
| 审批接入 | `packages/services/src/skills/installations.ts` | 子安装引用 `rolloutPlanId` |
| 导入 | `packages/services/src/skills/import.ts` | 写 coordinate、按 coordinate 关联 |
| Schema | `packages/db/src/postgres-schema.ts` | 新表 + 两列 + 索引 |
| 记录类型 | `packages/db/src/types.ts` | `SkillRolloutPlanRecord` |
| DB 访问 | `packages/db/src/skill-rollout-plans.ts`（新） | plan 的 CRUD/审批 |
| 原子写 | `packages/db/src/skill-installations.ts` | ON CONFLICT upsert |
| preflight | `packages/services/src/workflows/validation.ts` | 依赖闭包就绪门禁 |
| 导出 | `packages/services/src/index.ts`、`packages/db/src/index.ts` | 对外暴露 |

## 2. 逐文件改动点

### 2.1 领域类型 `packages/domain/src/skill-package.ts`

在现有 `SkillDependencyKind`（`:66`）旁新增：

```ts
export type SkillSkillPlacement = "same_runtime" | "workflow";

export interface SkillSkillDependency {
  coordinate: string;      // 稳定依赖身份，必须带 scheme 前缀，如 github:owner/repo/skills/novel-outline
  version: string;         // 作者声明的版本范围（如 "^1.1.0"）
  placement: SkillSkillPlacement;
  required: boolean;
}
```

并给 manifest 接口增加 `skillDependencies?: SkillSkillDependency[]` 字段。

### 2.2 解析 `packages/services/src/skills/dependencies.ts`

新增 `parseSkillSkillDependencies(skillMarkdown): SkillSkillDependency[]`，与现有 `parseSkillDependencyDeclarations` 并列，识别 `skillDependencies:` YAML list。校验规则：

- coordinate 必须有 scheme 前缀（`^[a-z][a-z0-9+.-]*:`），拒绝裸显示名称。
- placement 只能取 `same_runtime` / `workflow`。
- required 缺省为 `true`。

### 2.3 包构建 `packages/services/src/skills/skill-artifacts.ts`

- `SkillArtifactManifest` 增加 `skillDependencies?: SkillSkillDependency[]`。
- manifest 的 canonical 序列化纳入该字段，使 digest 覆盖 skill 依赖声明。

### 2.4 锁 `packages/services/src/skills/release-lock.ts`

- `ManifestLike` 增加 `skillDependencies`。
- `ResolvedSkillReleaseLock` 增加 `skillDependencyLockDigest`（由排序后的 `coordinate@version` 声明哈希得到），与运行时 `dependencyLockDigest` 分离。
- 说明：声明的**版本范围**进 lock；**解析后的确切 digest 闭包**不进 per-artifact lock，而进 `skill_rollout_plan`（因为 digest 解析依赖工作区已导入的 artifact，随时间变化）。

### 2.5 深模块 `packages/services/src/skills/rollout.ts`（新）

```ts
export interface SkillRolloutTargetScope =
  | { kind: "workflow"; workflowId: string }
  | { kind: "employees"; employeeIds: string[] }
  | { kind: "runtimes"; runtimeIds: string[] }
  | { kind: "all-compatible" };

export interface SkillRolloutPlan {
  planId: string;
  planDigest: string;
  root: { artifactDigest: string; coordinate?: string };
  closure: Array<{
    coordinate: string;
    artifactDigest: string;      // 已锁定确切 digest
    requestedVersion: string;
    placement: "same_runtime" | "workflow";
    required: boolean;
  }>;
  items: Array<{
    runtimeId: string;
    artifactDigest: string;
    revision: string;
    state: "ready" | "installing" | "pending";
  }>;
  risks: SkillRolloutRiskSummary;
  requiredCount: number;
  readyCount: number;
  pendingCount: number;
}

export function planSkillRollout(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  targetScope: SkillRolloutTargetScope;
  dependencyMode?: "required-only" | "include-optional";
}): SkillRolloutPlan;
```

内部辅助函数（全部导出以便单测）：

- `resolveSkillDependencyClosureSync(rootDigest, mode): ClosureEntry[]` —— 传递展开，`same_runtime` 与 `workflow` 都入闭包，但标记 placement。
- `detectSkillDependencyCycleSync(closure): string[] | null` —— 返回环上 coordinate，无环返回 null。
- `lockSkillDependencyDigestSync(coordinate, versionRange): { artifactDigest }` —— 按 coordinate 查到已导入 artifact，取版本范围内最大版本，无满足项 fail-closed。
- `computeSkillRolloutTargetRuntimesSync(scope): string[]` —— 三种 scope 映射到 Runtime 集合。
- `dedupeSkillRolloutItemsSync(items): SkillRolloutItem[]` —— 去除已 ready/installing 的 `Runtime × Artifact`。
- `computeSkillRolloutPlanDigestSync(closure, runtimes, risks): string` —— canonical 稳定哈希，顺序无关。

### 2.6 审批接入 `packages/services/src/skills/installations.ts`

- `createSkillInstallationPlanSync` 增加 `rolloutPlanId?: string` 参数。
- 当提供 `rolloutPlanId` 时：校验 plan 存在、`decision=approved`、`planDigest` 匹配、且该 installation 的 `artifactDigest` 属于 plan 闭包、`runtimeId` 属于目标集合；**不再**走单 installation 的 `consumeSkillInstallApprovalSync` 分支。
- 未提供 `rolloutPlanId` 时保持现有单装路径不变（向后兼容）。

### 2.7 导入 `packages/services/src/skills/import.ts`

- 导入时把来源的稳定 coordinate 写入 `skill_artifact.coordinate`（新列）。
- 依赖关联改为按 coordinate 解析（`readSkillArtifactsByCoordinateSync`），不再按可重命名的显示名称。

### 2.8 Schema `packages/db/src/postgres-schema.ts`

在 `skill_install_approval`（`:3406`）之后新增：

```sql
CREATE TABLE IF NOT EXISTS skill_rollout_plan (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  root_artifact_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'v1',
  closure_json JSONB NOT NULL,
  target_runtimes_json JSONB NOT NULL,
  risk_summary_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision TEXT NOT NULL DEFAULT 'pending',
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  UNIQUE(workspace_id, plan_digest)
);

ALTER TABLE skill_installation ADD COLUMN rollout_plan_id TEXT
  REFERENCES skill_rollout_plan(id) ON DELETE SET NULL;
CREATE INDEX idx_skill_installation_rollout_plan ON skill_installation(rollout_plan_id);

ALTER TABLE skill_artifact ADD COLUMN coordinate TEXT;
CREATE INDEX idx_skill_artifact_coordinate ON skill_artifact(workspace_id, coordinate);
```

### 2.9 记录类型 `packages/db/src/types.ts`

镜像现有 `SkillInstallApprovalRecord`（`:1643`）新增：

```ts
export interface SkillRolloutPlanRecord {
  id: string;
  workspaceId: string;
  rootArtifactDigest: string;
  planDigest: string;
  policyVersion: string;
  closureJson: string;
  targetRuntimesJson: string;
  riskSummaryJson: string;
  decision: "pending" | "approved" | "rejected";
  actorUserId?: string;
  createdAt: string;
  consumedAt?: string;
}
```

### 2.10 DB 访问 `packages/db/src/skill-rollout-plans.ts`（新）

镜像 `skill-install-approvals.ts` 的实现模式：

- `createSkillRolloutPlanSync(input)`
- `readSkillRolloutPlanSync(id, workspaceId)`
- `readSkillRolloutPlanByDigestSync({ workspaceId, planDigest })`
- `approveSkillRolloutPlanSync(id, workspaceId, decision)`
- `consumeSkillRolloutPlanSync(id, workspaceId)` —— 原子置 `consumed_at`，返回是否成功（一次性使用）

### 2.11 原子写 `packages/db/src/skill-installations.ts`

`createSkillInstallationSync`（`:78`）当前“先 `readSkillInstallationByLockSync` 再 INSERT”。改为：

```sql
INSERT INTO skill_installation (id, workspace_id, runtime_id, artifact_digest, ...)
VALUES (...)
ON CONFLICT (workspace_id, runtime_id, artifact_digest, revision)
DO NOTHING
RETURNING id;
```

未返回行时再读现有记录返回（幂等）；消除并发撞唯一键。`CreateSkillInstallationInput` 增加 `rolloutPlanId?: string`。

### 2.12 preflight `packages/services/src/workflows/validation.ts`

`validateWorkflowNodeDependencies`（`:228`，现校验 `requiredSkillIds` 是否分配）升级为：

1. 对每个 `requiredSkillIds` 解析依赖闭包并锁定 digest。
2. 映射到节点员工 → Runtime。
3. 复用 `assertSkillInstallationReadyForTaskSync` 语义校验每个 `Runtime × Artifact` 是否 ready。
4. 缺项产出新 blocker 码 `workflow_skill_closure_not_ready`（保留原 `workflow_skill_not_ready` 给未分配场景）。

### 2.13 导出

- `packages/services/src/index.ts`：在 skills 导出块（`:613` 附近）新增 `rollout.ts` 导出。
- `packages/db/src/index.ts`：在 `:1140` / `:1178` 附近新增 `skill-rollout-plans.ts` 与 `SkillRolloutPlanRecord` 导出。

## 3. 测试矩阵

| # | 模块 / 测试文件 | 用例 | 断言 |
| --- | --- | --- | --- |
| T01 | `packages/domain/src/skill-package.test.ts` | 合法 skillDependencies | 解析 coordinate/version/placement/required 无误 |
| T02 | 同上 | 非法 coordinate（裸名称/无 scheme） | 抛错 |
| T03 | 同上 | 非法 placement | 抛错 |
| T04 | `packages/services/src/skills/dependencies.test.ts` | `parseSkillSkillDependencies` 解析 YAML list | 返回正确数组 |
| T05 | 同上 | 非 list / 缺 coordinate / 缺 version | 抛错 |
| T06 | `packages/services/src/skills/rollout.test.ts`（新） | 闭包传递展开 | `same_runtime` 与 `workflow` 依赖都在闭包、placement 正确 |
| T07 | 同上 | 循环依赖 | 返回 `skill_dependency_cycle` 及环上坐标 |
| T08 | 同上 | 版本范围→digest | 取范围内最大版本；无满足项 fail-closed |
| T09 | 同上 | 目标 Runtime 三种 scope | workflow/employees/runtimes 映射正确；all-compatible 过滤能力不匹配 |
| T10 | 同上 | 去重 | 已 ready/installing 的 `Runtime × Artifact` 不重复生成安装项 |
| T11 | 同上 | planDigest 稳定 | 闭包/runtimes 顺序无关，digest 一致 |
| T12 | 同上 | required-only / include-optional | 可选依赖按模式纳入或跳过 |
| T13 | `packages/db/src/skill-rollout-plans.test.ts`（新） | create/read/approve/consume | 全生命周期状态正确 |
| T14 | 同上 | `UNIQUE(workspace_id, plan_digest)` | 重复创建幂等返回已有 |
| T15 | 同上 | consume 一次性 | 第二次 consume 返回 false |
| T16 | `packages/db/src/skill-installations.test.ts` | 并发 `createSkillInstallationSync` | 恰一行、无唯一键错误、幂等返回同一记录 |
| T17 | `packages/services/src/skills/installations.test.ts` | `rolloutPlanId` 有效 | installation 引用 plan、不再消费单 installation 审批 |
| T18 | 同上 | `rolloutPlanId` digest/runtime 越界 | 拒绝（`rollout_scope_mismatch`） |
| T19 | 同上 | plan 已 consume / decision 非 approved | 拒绝 |
| T20 | `packages/services/src/skills/import.test.ts` | import 写 coordinate、重复坐标同 artifact | 关联正确 |
| T21 | `packages/services/src/workflows/validation.test.ts` | 缺闭包 / runtime 未 ready | 产出 `workflow_skill_closure_not_ready` |
| T22 | 同上 | 闭包全部 ready | 无 blocker |

## 4. 与既有测试的关系

- 现有 `install-approval.test.ts`、`installations.test.ts`、`dependencies.test.ts`、`import.test.ts`、`validation.test.ts` 全部保留；新用例是**增量**，不得弱化既有失败即抛的语义。
- 深模块 `rollout.ts` 只依赖 DB 层 + 纯辅助（避免与 `release.ts` 形成模块环，参考 `release-lock.ts` 的注释）。
- 遵循仓库测试约束：API 包单文件用 `jest --runInBand`，全量用 `--maxWorkers=2`。
