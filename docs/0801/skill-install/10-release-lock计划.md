# 真实可重现 Release Lock 实现计划（P1-6）

## 背景（为什么做）

`docs/0801/skill-install/07-实施差距审查.md` P1-6：release lock 目前不可重现、未进生产路径、且无人消费。

现状（已核实）：
- `computeSkillReleaseLockSync`（`packages/services/src/skills/release.ts:37-62`）只填了 `dependencyLockDigest` + `serviceTemplateVersions`（仅从 manifest 推导），`serviceImageDigests`/`mcpToolFingerprints` 硬编码空、`providerCompatibilityRevision` 硬编码 0。**没有任何生产调用方**（仅 `release.test.ts` 使用）。
- `createSkillInstallationPlanSync`（`installations.ts:89`）用的是独立占位函数 `buildResolvedLockJson`（`installations.ts:156-167`，各字段空/0）；`createSkillUpgradePlanSync`（`release.ts:351`）直接写 `resolvedLockJson: "{}"`。
- `skill_installation.resolved_lock_json` 是**只写列**，任务/审批/回滚/审计均不读取。
- `SkillReleaseLock`（domain `skill-package.ts:144-153`）是死类型；services 用结构相同的 `ResolvedSkillReleaseLock`（`release.ts:26-35`）。
- 可用的真实数据：`skill_service_catalog`（`readSkillServiceCatalogSync(slug, templateVersion, workspaceId)` → `imageDigest`/`configSchemaVersion`，db `skill-services.ts:100`）、`mcp_catalog_item`（`readMcpCatalogItemBySlugSync(slug, workspaceId)` → `declaredToolsJson`，services `mcp-center/catalog.ts`）。
- 无 provider 兼容性模型（`providerCompatibilityRevision` 保留 0 并注释）。

## 目标

1. `computeSkillReleaseLockSync` 成为唯一 lock 来源，填满全部字段（依赖 lock、服务 template/image/config schema、MCP tool 指纹），并产出**可重现的 `lockDigest`**（sha256 of canonical lock JSON）。
2. 接入两条安装路径（prepare + upgrade），移除占位 `buildResolvedLockJson` 和 `"{}"`。
3. 提供 lock 读取入口，让任务/回滚/审计能引用同一个 lock；claim payload 暴露 `releaseLockDigest`。
4. 测试：lock 各字段真实填充、digest 可重现、provenance 无关、安装/升级落库为真实 lock。

## 本轮不做

- `agent_skill.rollout_pin` / canary 百分比灰度（需要 canary 模型 + 审批 UI，后续独立计划；任务快照已通过 assignment pin 固定 revision）。
- 持久化不可变审批记录（P1-3，另一个后续）。
- service catalog 准入 / managed node（Phase 3/6）。
- daemon 端 lock 校验（claim 先暴露 digest，供审计/未来校验）。

## 关键决策（已定）

- **lock 存储**：`resolved_lock_json` 存 `computeSkillReleaseLockSync` 返回的对象（含 `lockDigest`），canonical JSON。
- **lockDigest 定义**：`sha256(stableStringify({artifactDigest, packageSchemaVersion, dependencyLockDigest, serviceTemplateVersions, serviceImageDigests, serviceConfigSchemaVersions, mcpToolFingerprints, providerCompatibilityRevision}))`。复用 `stableStringify`（`package/package-digest.ts:71`）。
- **服务 image/schema**：manifest `services[].catalogSlug`+`templateVersion` → `readSkillServiceCatalogSync` 查库；查不到则留空（service 就绪是 Phase 3，不应因 catalog 缺失阻塞 lock 生成；未来由 service 组件 readiness 卡 `ready`）。
- **MCP 指纹**：manifest `capabilities[].kind==="mcp"` 的 `catalogSlug` → `readMcpCatalogItemBySlugSync` → `declaredToolsJson` 解析 → `sha256(stableStringify(declaredTools))`；查不到则跳过。
- **providerCompatibilityRevision**：保留 0（无模型），注释说明。

## 关键改动

### 1. `packages/services/src/skills/release.ts`
- `ResolvedSkillReleaseLock` 增 `lockDigest: string`。
- `computeSkillReleaseLockSync(artifact, workspaceId = "default")` 扩展：
  - 现有 `dependencyLockDigest` + `serviceTemplateVersions` 保留。
  - 新增：遍历 `manifest.services`，`readSkillServiceCatalogSync(slug, templateVersion, workspaceId)` 填 `serviceImageDigests[slug] = catalog.imageDigest`、`serviceConfigSchemaVersions[slug] = catalog.configSchemaVersion`。
  - 新增：遍历 `manifest.capabilities`（kind==="mcp"），`readMcpCatalogItemBySlugSync(slug, workspaceId)` → 填 `mcpToolFingerprints[slug] = sha256(stableStringify(JSON.parse(declaredToolsJson)))`。
  - 计算 `lockDigest` 并附到返回对象。
- 新增 `readSkillInstallationLockSync(installationId, workspaceId?): ResolvedSkillReleaseLock | null`（`JSON.parse(resolved_lock_json)`，畸形返回 null）。
- `createSkillUpgradePlanSync`：`resolvedLockJson: "{}"` → `readSkillArtifactByDigestSync(input.artifactDigest, input.workspaceId)` 后 `JSON.stringify(computeSkillReleaseLockSync(artifact, input.workspaceId))`（artifact 缺失则 throw，与 plan 一致）。

### 2. `packages/services/src/skills/installations.ts`
- `createSkillInstallationPlanSync`：`buildResolvedLockJson(...)` → `JSON.stringify(computeSkillReleaseLockSync(artifact, input.workspaceId))`；删除 `buildResolvedLockJson`（唯一使用处）。
- `resolveClaimedSkillInstallationOperation`：claim payload 增 `releaseLockDigest`（解析 `installation.resolvedLockJson.lockDigest`，缺失则省略）。

### 3. `packages/domain/src/skill-package.ts`
- `SkillReleaseLock` 增 `lockDigest: string`（与 services 结构对齐）。
- `ClaimedSkillInstallationOperation` 增可选 `releaseLockDigest?: string`。

### 4. `packages/services/src/index.ts`
- 导出 `readSkillInstallationLockSync`（`computeSkillReleaseLockSync` 已导出）。

### 5. 测试
- `release.test.ts`：
  - seed `skill_service_catalog`（`upsertSkillServiceCatalogSync`，db `skill-services.ts:53`）+ `mcp_catalog_item`（`createMcpCatalogItemSync`，services `mcp-center/catalog.ts:49`），构建带 `services` + mcp `capabilities` 的 artifact，断言 `computeSkillReleaseLockSync` 的 `serviceImageDigests`/`serviceConfigSchemaVersions`/`mcpToolFingerprints` 真实填充。
  - 断言 `lockDigest` 可重现：同输入 → 同 digest；改依赖 → 不同 digest；provenance（manual vs github）→ 同 digest。
- `installations.test.ts`：
  - `createSkillInstallationPlanSync` 后断言 `resolvedLockJson` 解析出的 lock 有非空 `dependencyLockDigest` + `lockDigest`（不再是占位）。
  - upgrade 后断言 v2 安装的 `resolvedLockJson` 非 `"{}"` 且含 `lockDigest`。
  - claim 后断言 `resolved.releaseLockDigest` 存在。

## 验证步骤

1. `pnpm --filter @dofe-agent/domain run types`
2. `pnpm --filter @dofe-agent/services run types`
3. `pnpm --filter dofe-agent-daemon run types`（全链 domain→db→services→sandbox→daemon）
4. `cd apps/web && ../../apps/web/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit`
5. `node --env-file-if-exists=.env --experimental-strip-types --test packages/services/src/skills/release.test.ts`（单文件串行）
6. `node --env-file-if-exists=.env --experimental-strip-types --test packages/services/src/skills/installations.test.ts`（单文件串行；共享 PG 测试库脆弱性：先清孤儿行/重新 seed default 工作区，见 [[mcp-center-test-db-fragility]]）
7. `node --env-file-if-exists=.env --experimental-strip-types --test packages/daemon/src/task-context-skill-env.test.ts`（确认 snapshot 未回归）

## 已确认决策

1. `computeSkillReleaseLockSync` 是唯一 lock 来源；占位 `buildResolvedLockJson` 删除、upgrade `"{}"` 替换。
2. `lockDigest` = sha256(canonical 8 字段 JSON)，可重现 + provenance 无关。
3. 服务 image/schema 从 `skill_service_catalog` 查；MCP 指纹从 `mcp_catalog_item.declaredToolsJson` 计算；catalog 缺失留空（不阻塞 lock）。
4. claim 暴露 `releaseLockDigest`；`readSkillInstallationLockSync` 提供读取入口。
5. rollout_pin/canary 明确列为后续计划。
