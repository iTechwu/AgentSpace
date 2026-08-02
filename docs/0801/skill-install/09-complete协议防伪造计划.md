# P0-5：complete/fail 协议防伪造加固计划

## 背景（为什么做）

`docs/0801/skill-install/07-实施差距审查.md` P0-5：恶意或实现错误的 daemon 可以把任意组件直接报 `ready` 而无须可验证证据。现状（已核实）：

- complete/fail 路由 `as Partial<...>` 裸类型断言，无 runtime schema 校验（坏 body → Next.js 500）。
- `completeSkillInstallationOperationSync` **先**把 operation 标 `succeeded`，**再**逐条非事务 UPDATE 组件（部分状态风险）；`updateSkillInstallationComponentStatusSync` 接受任意 status 字符串，未知 `(kind,key)` 静默 0 行，缺失组件不 INSERT。
- `request_snapshot_json` 记录期望组件不一致（prepare 路径存 `components:[keys]`，upgrade 路径只存 `{artifactDigest, upgradeFrom}`），complete 时从不读取。
- claim payload 的 `components` 是 live 状态列表，不是冻结的期望集。
- `verified_at` 是服务器时间；`computedDigest` 进 opaque `safeResultJson` 且 best-effort（"Malformed safeResultJson must not fail completion"）。
- operation-worker 失败时 `fail` 后**再 best-effort partial complete**（被 DB guard 静默丢弃，partial 证据实际丢失）。

## 目标

1. complete/fail payload 共享 schema 校验（运行时，非仅类型断言）。
2. 期望组件 + artifact digest 在 operation 创建时冻结（canonical 进 `request_snapshot_json`），complete 必须**精确集合匹配**（无未知/重复/缺失组件；拒绝未知 status 值）。
3. 控制面验证证据 digest（`computedDigest === artifactDigest`）后重算 readiness —— **fail-closed**（替换现有 best-effort 语义，属有意的行为反转）。
4. complete 原子：op 标成功 + 全部组件更新 + readiness 在同一事务（`withTransaction`，单 worker 连接已确认原子）。
5. 拒绝跨 installation 数据（按该 op 的期望集匹配，结构性满足）。

## 本轮不做

- 每组件/每文件的独立 digest 证据（root digest 是聚合证据）。
- runner policy attestation；DB `status` TEXT 列的 CHECK 约束（应用层校验）。
- 数据迁移回填 `expectedComponents`（旧行运行时回退，见下）。

## 关键决策（已定）

- **期望集存储**：`request_snapshot_json` 统一为 `{artifactDigest, expectedComponents: [{kind, key}], ...}`（prepare + upgrade 两处创建路径都写）。无 schema 迁移。
- **旧行兼容**：`readSkillInstallationOperationExpectedComponentsSync` 在 `expectedComponents` 缺失或不可解析时，回退到 live `readSkillInstallationComponentsSync`（旧 prepare/upgrade 行组件在首次 complete 前仍为 pending，live 集即真实期望集）。claim 与 complete 共用同一 helper，保证一致。
- **证据校验**：`safeResultJson` 必须可解析且 `computedDigest === request_snapshot_json.artifactDigest`；缺失/畸形/不匹配 → `evidence_mismatch`（400）。当前只有 `prepare` op（必物化 artifact），fail-closed 安全；未来 `activate`/`deactivate` 等非物化 op 需按 kind 收窄。
- **返回类型**：`completeSkillInstallationOperationSync`/`failSkillInstallationOperationSync` 改为可区分联合 `{ok:true} | {ok:false; code: "invalid_payload"|"component_set_mismatch"|"evidence_mismatch"|"not_completable"|"operation_not_found"}`（route 区分 400/409）。
- **claim 状态字段**：期望集无 status，claim payload 合成 `status: "pending"`（daemon verifier 只读 kind/key，最小侵入）。

## 关键改动

### 1. 领域类型 — `packages/domain/src/skill-package.ts`
- 新增 `SkillInstallationOperationExpectedComponent {kind: SkillComponentKind; key: string}`（196 行附近）。
- `FailSkillInstallationOperationRequest`（220-223）增可选 `componentStatuses?: Array<{kind, key, status: SkillComponentStatus, errorCode?, errorMessage?}>`。
- `ClaimedSkillInstallationOperation.components` 保留 `status` 字段，注释说明期望集时 status 为 "pending"（信息性）。

### 2. 创建路径写期望集
- `packages/services/src/skills/installations.ts:100`：`components.map(c => c.key)` → `expectedComponents: components.map(c => ({kind: c.kind, key: c.key}))`。
- `packages/services/src/skills/release.ts:360`：upgrade snapshot 增 `expectedComponents`（`components` 在作用域内，`release.ts:340`）。

### 3. 共享 payload 解析器 — 新文件 `packages/services/src/skills/installations-protocol.ts`（从 `index.ts` 导出）
- `parseCompleteSkillInstallationOperationPayload(body: unknown)` / `parseFailSkillInstallationOperationPayload(body: unknown)` → `{ok:true, value} | {ok:false, reason}`。
- 共享 `parseComponentStatuses(value)`：数组元素 `{kind ∈ SkillComponentKind, key: 非空 string, status ∈ SkillComponentStatus, errorCode?/errorMessage?: string}`；拒绝**重复 (kind,key)**、未知 kind/status、非 string key/error。`safeResultJson`（complete）可选 string。

### 4. services 重写 — `packages/services/src/skills/installations.ts`
- 新 `readSkillInstallationOperationExpectedComponentsSync(operation): {kind,key}[]`（JSON.parse snapshot → expectedComponents，否则回退 live 行）。
- `resolveClaimedSkillInstallationOperation`（165-221）：改用该 helper 构建 `components`（status: "pending"），不再读 live 行。
- `completeSkillInstallationOperationSync`（233-298）重写：
  1. 读 op；缺失 → `operation_not_found`。
  2. 解析期望集 + artifactDigest（来自 snapshot）。
  3. 校验 `componentStatuses` 与期望集**精确多重集相等** → 否则 `component_set_mismatch`。
  4. 解析 safeResultJson，要求 `computedDigest === artifactDigest` → 否则 `evidence_mismatch`。
  5. `withTransaction(getDatabase(), () => { completeSkillOperationDbSync; 逐期望组件 updateSkillInstallationComponentStatusSync（changes===0 → throw → 回滚）; setSkillInstallationPreparedPathSync/PreparedDigestSync; evaluateSkillInstallationReadinessSync; })`。返回 `{ok:true}`。
- `failSkillInstallationOperationSync`（300-336）：接受可选 set 内 `componentStatuses`（partial 允许），同一事务内先应用、再阻塞剩余 pending/preparing 组件、`evaluateSkillInstallationReadinessSync`。

### 5. 路由 — `apps/web/app/api/daemon/skill-operations/[operationId]/{complete,fail}/route.ts`
- 用解析器替换 `as Partial<...>` 裸断言；`{ok:false}` → 400。
- 映射服务返回：`evidence_mismatch`/`component_set_mismatch`/`invalid_payload` → 400；`not_completable` → 409。
- fail 路由透传 `componentStatuses`。

### 6. Daemon — `packages/daemon/src/skill-install/operation-worker.ts`
- **删除** complete-after-fail 块（114-123）。
- `failSkillInstallationOperation`（107-112）增 `componentStatuses`（`componentStatuses.length > 0` 时）。

### 7. 测试
- `packages/services/src/skills/installations.test.ts`：
  - 两处缺证据调用补 `safeResultJson: JSON.stringify({computedDigest: ...})`（106-113 happy path、completeAllComponents 192-203）。
  - `assert.equal(done, true)` → `assert.equal(done.ok, true)`（114/148/202）。
  - 新增：重复 key 拒绝、未知组件拒绝、缺失组件拒绝、非法 status 拒绝、证据 digest 不匹配拒绝、safeResultJson 畸形/缺 digest 拒绝、原子性（删除一个 live 组件行 → 事务内 0 行 throw → op 保持 claimed）、set-match happy path、fail-with-componentStatuses、旧行回退。
- `packages/daemon/src/skill-install/operation-worker.test.ts`：断言验证失败 → fail 带 componentStatuses、无 complete-after-fail。

## 验证步骤

1. `pnpm --filter @dofe-agent/domain run types`
2. `pnpm --filter @dofe-agent/services run types`
3. `pnpm --filter dofe-agent-daemon run types`（全链 domain→db→services→sandbox→daemon）
4. `cd apps/web && tsc -p tsconfig.typecheck.json --noEmit`
5. `node --env-file-if-exists=.env --experimental-strip-types --test packages/services/src/skills/installations.test.ts`（串行单文件；共享 PG 测试库脆弱性：先清孤儿行/重新 seed default 工作区，见 [[mcp-center-test-db-fragility]]）
6. `node --env-file-if-exists=.env --experimental-strip-types --test packages/daemon/src/skill-install/operation-worker.test.ts`
7. `node --env-file-if-exists=.env --experimental-strip-types --test packages/daemon/src/task-context-skill-env.test.ts`（确认 snapshot 未回归）

## 已确认决策

1. 期望集存 `request_snapshot_json.expectedComponents`（无 schema 迁移）；旧行回退 live 组件集。
2. 证据校验 fail-closed（`computedDigest === artifactDigest`）；`safeResultJson` 畸形不再 best-effort 通过。
3. complete 必须精确集合匹配；partial complete 仅存在于 fail 的 componentStatuses。
4. complete/fail 原子（withTransaction）；0 行更新 → 事务内 throw 回滚。
5. 返回类型改可区分联合，route 区分 400/409。
