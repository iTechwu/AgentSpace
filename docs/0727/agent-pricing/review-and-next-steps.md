# 深度审查：agent-pricing 实施状态与下一步计划

> **当前权威结论（2026-07-28 第六轮逐源码核实）：仓库内 Phase 0–6 的全部业务代码均已实施，并通过门禁 `npm run test:agent-pricing`（node + web 全绿）。**
> 本文早先版本曾以 ❌/⚠️/⏳ 标记大量“未实施”项，**经逐源码核实，这些标记全部过期、不再成立**。下文已就地订正为 ✅ 并附 `file:line` 证据。
>
> **唯一真正未完成的工作在仓库之外**：真实 `models.dofe.ai` 测试租户/网关/容器环境的 staging E2E、网络出口隔离验收、真实账单精确核对、节点中断与轮换宽限演练——均不能用仓库单测替代。在此完成前，生产环境继续保持 `DOFE_AGENT_RUNTIME_MODE=local`。
>
> 核实方法：代码知识图谱 + 逐行人工核对 + 运行 `test:agent-pricing:node` 与 `test:agent-pricing:web`（本日已复跑通过）。权威实施细节以 [implementation-plan.md](./implementation-plan.md) 与 [implementation-review-2026-07-28.md](./implementation-review-2026-07-28.md) 为准。

审查日期：2026-07-27（初版）/ 2026-07-28（第六轮逐源码订正）
审查范围：`docs/0727/agent-pricing` 三份文档 + AgentSpace 当前分支业务代码
结论：**仓库内 Phase 1–6 全链路已落地并通过门禁；剩余仅为 staging 门槛。**

---

## 1. 审查方法

1. 逐条对照 `00-产品需求与交付规格.md`、`README.md`、`models-contract.md`、`implementation-plan.md` 的验收项。
2. 使用代码知识图谱定位关键实现文件，并人工核对代码行为（非仅看导出名）。
3. 对每一项给出 ✅ 已实施 / ⚠️ 部分实施 / ❌ 未实施 / 不适用（models 侧）判定与 `file:line` 证据。
4. 第六轮额外运行仓库门禁作为客观佐证。

---

## 2. 分阶段实施状态

### Phase 0：契约与安全基线

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `DOFE_AGENT_RUNTIME_MODE` 启动时解析，默认 `local`，值域 `local\|remote` | ✅ 已实施 | `packages/services/src/config/deployment.ts:9` `resolveAgentRuntimeMode` |
| `local` 不进入受管流程 | ✅ 已实施 | `apps/cli/src/commands/daemon.ts` 仅在 `managedCredentialId` 存在时走受管路径；所有 managed action 先调 `assertRemoteRuntimeMode`（`runtime-provisioning.ts:119`） |
| 团队可见角色仅 Owner/Admin/Member | ✅ 已实施 | `apps/web/features/auth/workspace-permissions.ts`；`assertWorkspaceRoleForContext` 校验 |
| 平台超管不出现在成员关系 | ✅ 已实施 | 成员/计数用 `AND u.is_admin = 0` 过滤（`packages/db/src/user-auth.ts:357`）；转移目标用 `isPlatformAdminUserSync` 守卫拒绝超管（`packages/db/src/workspace-memberships.ts:139`）；SSO `isAdmin` 持久化（`apps/web/features/auth/server-auth.ts:209`） |

### Phase 1：models.dofe.ai RuntimeCredential（models 侧，不适用本仓库）

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| RuntimeCredential 模型与状态机 | ✅ 已实施（models 侧） | `models-contract.md` 指明实现位于 `models.dofe.ai` 仓库 |
| 创建 / 查询 / 轮换 / 撤销内部 API | ✅ 已实施（models 侧） | 同上 |
| 协议过滤模型目录 | ✅ 已实施（models 侧） | AgentSpace 通过 `runtimeCredentials.models` 与 `listProtocolFilteredRuntimeModelsAction` 消费（`apps/web/features/runtimes/actions.ts:184`） |

### Phase 2：AgentSpace Runtime 数据与任务模型

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `agent_runtime` 受管字段 | ✅ 已实施 | `packages/db/src/postgres-schema.ts` 含 `managed_credential_id`、`credential_secret_ref`、`credential_config_ref`、`protocols_json`、`default_model`、`provisioning_state`、`allow_new_employee_sharing`（schema v46）等 |
| `RuntimeProvisioningTask` 及事件 | ✅ 已实施 | `packages/db/src/runtime-provisioning-tasks.ts`；`packages/services/src/runtime-provisioning/runtime-provisioning.ts` |
| 创建 / 取消 / 重试 / 停止 / 删除 Runtime | ✅ 已实施 | `packages/services/src/runtime-provisioning/runtime-provisioning.ts`（`assertCanManageManagedRuntimes`@`:108` 守卫各入口） |
| 凭据轮换与状态查询 | ✅ 已实施 | `rotateManagedRuntimeCredentialAsync`、`getManagedRuntimeCredentialStatusAsync` |
| 创建前检查 `remote` 模式与 SSO team 范围 | ✅ 已实施 | `assertRemoteRuntimeMode`@`runtime-provisioning.ts:119`、`resolveManagedRuntimeScopeSync` |
| Owner/Admin 统一校验 | ✅ 已实施 | `assertCanManageManagedRuntimes` 调用 `isWorkspaceAdminOrOwnerSync` |
| 选择已有 Runtime / 复用 | ✅ 已实施 | `bindEmployeeRuntimeSync`（`packages/services/src/employees/employees.ts:80`）+ Runtime 授权（`runtime-access`）；UI 复用入口：`ExecutionEngineSelect` 显式“可复用”徽标 + 协议/默认模型/已服务员工数，共享关闭项禁用；`agent_runtime.allow_new_employee_sharing`（schema v46）由 `bindEmployeeRuntimeSync` 据此拒绝新绑定，创建向导提供开关 |
| 任务离线恢复 | ✅ 已实施 | `resumePendingProvisioningTasksAsync`@`runtime-provisioning.ts:1423` |

### Phase 3：节点侧凭据解析与受管安装

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 节点侧 `ManagedCredentialResolver` | ✅ 已实施 | `packages/daemon/src/managed-provider-credentials.ts:169` `createManagedCredentialResolver`；经 `remote-daemon.ts:254` 装配，按 `runtimeId` 拉取凭据包端点解析为本地 profile |
| 固定网关 URL 与认证卷注入 | ✅ 已实施 | `packages/services/src/runtime-provisioning/provider-templates.ts:79` `resolveManagedRuntimeGatewayBaseUrl`（部署时由 `MODELS_GATEWAY_BASE_URL` 解析）+ `:192-198` `buildDockerTemplate`；Docker hardening（只读根、受限 `/tmp`、`no-new-privileges`、cap-drop、非默认网络）见 daemon 侧 |
| 受控 Docker 镜像 / CLI 安装 | ✅ 已实施 | `packages/daemon/src/managed-runtime-provisioning.ts:29-110` 真实驱动 `pull_image / install_cli / write_credential / health_check`，stage 超时齐备；`recordSkipped` 已删除（全仓零命中） |
| 健康检查后再标记就绪 | ✅ 已实施 | `managed-runtime-provisioning.ts:74` `health_check` 阶段；经本地归因代理访问非计费模型目录做协议级健康检查（HMAC 异常可在创建时漏检） |
| 停止 / 删除 / 失败时清理容器与卷 | ✅ 已实施 | `packages/db/src/managed-runtime-cleanup.ts`：原子领取、超时回收、最多 3 次、退避；取消保持 `cancelling` 至清理终态才删除 Runtime |

### Phase 4：模型配置与会话体验

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `remote` 创建 Runtime 时从协议过滤目录选默认模型 | ✅ 已实施 | `apps/web/features/runtimes/runtime-model-picker.tsx`；`listProtocolFilteredRuntimeModelsAction`@`apps/web/features/runtimes/actions.ts:184` |
| AI员工默认模型 | ✅ 已实施 | `createEmployeeSync` / `updateEmployeeDefaultModelSync`；UI `create-agent-modal.tsx`、`agent-detail.tsx` |
| 五级模型优先级解析 | ✅ 已实施 | `packages/services/src/models/model-resolution.ts:54` `resolveEffectiveModelForTaskAsync`（会话>AI员工>Runtime>团队>协议兜底） |
| 会话 `/model` 命令 | ✅ 已实施 | `apps/web/features/chat/model-command.ts`；`packages/services/src/chat/model-override.ts` |
| 聊天顶部模型选择器（直接私聊） | ✅ 已实施 | `apps/web/features/chat/chat-model-selector.tsx` |
| **不兼容 / 不可用 / 无权限模型的可操作错误状态** | ✅ 已实施 | `ChatModelOverrideValidationError`@`model-override.ts:207`，错误码 `model_required / model_unavailable / no_bound_runtime / not_a_managed_runtime / remote_mode_required`；`setChatModelOverrideAction` 返回 `{ok, code, message}`；`ChatModelSelector` 显示错误标签；`/model reset` 与 `/model clear` 均清除覆盖 |

### Phase 5：用量、计费、对账与术语迁移

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `token_usage` 记录 `runtimeCredentialId`、`routerSessionId` 等归因 | ✅ 已实施 | schema + 写入：`apps/cli/src/commands/daemon.ts`；`packages/db/src/postgres-schema.ts:1198-1213` |
| 余额 / Key 用量 / 用量日志接入 | ✅ 已实施 | `packages/services/src/models/usage-sync.ts` 接入 `usage.tenantLogs` 按 `runtimeCredentialId` 对账；余额卡片调 `billing.balanceByTeam`（`apps/web/features/costs/actions.ts:32`，remote 显示数值、local 显示“暂不可用”） |
| 成本状态：真实扣费 / 估算 / 待对账 / 已对账 | ✅ 已实施 | `token_usage.billing_status` = `estimated \| reconciled \| unallocated \| pending_reconciliation`；`CostDashboardData` 暴露 `estimatedCostUsd`/`reconciledCostUsd`/`unallocatedCostUsd`/`totalActualCostUsd`；成本页展示并对账 |
| AI员工 / Runtime / 会话维度成本视图 | ✅ 已实施 | `getRuntimeCostSummarySync`@`token-usage.ts:385`、`getRuntimeCredentialCostSummarySync`@`:480`、`getSessionCostSummarySync`@`:573`；service 封装 `packages/services/src/costs/costs.ts`；UI 三张明细表始终渲染 + 说明性空状态（`costs-page-client.tsx:271`） |
| “Agent” 文案迁移为 “AI员工” | ✅ 已实施 | 已遍历 `apps/web/features` 面向用户文案；保留内部标识、路由、类型名、第三方协议名 |
| 异常告警（余额不足、轮换失败、对账差异、预算超支） | ✅ 已实施 | `billing.insufficient_balance`@`runtime-provisioning.ts:1237`、`runtime.credential_rotation_failed`@`:461`、`usage.reconciliation_discrepancy`@`usage-sync.ts:305`、`budget.exceeded`@`budgets.ts:35`；`/inbox` + 侧栏未读徽标展示 |
| 平台超管审计隔离 | ✅ 已实施 | `platform-audit` 合成账本（`PLATFORM_AUDIT_WORKSPACE_ID`）+ `source='platform_admin'` 切片保留真实操作者；团队侧审计匿名化为“平台运维”（`packages/services/src/shared/audit.ts:6,116`）；`/platform` 与 `/platform/audit` 路由 + 仅超管可见侧栏入口 |

---

## 3. 历史缺口闭环情况

初版审查列出的 5 项关键缺口，现已全部在仓库内闭环：

1. ~~**Phase 3 缺失导致受管 Runtime 只是 DB 行 + Credential**~~ → ✅ 已闭环。节点侧真实驱动 `pull_image / install_cli / write_credential / health_check`，容器/卷/凭据清理与归因代理健康检查齐备（见 Phase 3 表）。
2. ~~**Phase 4 错误状态缺失**~~ → ✅ 已闭环。`ChatModelOverrideValidationError` 结构化错误码 + 选择器错误标签（见 Phase 4 表）。
3. ~~**Phase 5 成本对账缺失**~~ → ✅ 已闭环。`billing_status` 四值 + per-credential 游标对账 + 24h 回看 + 重试 outbox + 未分配用量标记（`usage-sync.ts`）。
4. ~~**文案未迁移**~~ → ✅ 已闭环。用户可见文案统一为“AI员工 / AI employee”。
5. ~~**平台超管隐身**~~ → ✅ 已闭环。超管不写入成员关系、转移/分配/计数排除超管、团队侧审计匿名化、`/platform` 运维看板 + `/platform/audit` 独立权限。

> 仓库内不再有未闭环的业务代码缺口。

---

## 4. 实施步骤状态

### Step 1 — Phase 4 聊天模型错误状态 ✅ 已实施

- ✅ `packages/services/src/chat/model-override.ts`：`ChatModelOverrideValidationError` 归类可读错误码。
- ✅ `apps/web/features/channels/actions.ts`：`setChatModelOverrideAction` 返回结构化结果。
- ✅ `apps/web/features/chat/chat-model-selector.tsx`：展示错误提示，保持当前模型不变。
- ✅ `apps/web/features/chat/model-command.ts`：支持 `/model reset` / `/model clear` 清除覆盖。
- ✅ **创建 Runtime 向导余额预检与模型可用性前置校验**：`managed-runtime-creation-wizard.tsx:40` 提交前调 `preflightManagedRuntimeAction` → `preflightManagedRuntimeCreationAsync`@`runtime-provisioning.ts:1140` → `billing.preflight`（`:1165`），未通过禁用创建按钮并展示原因。

### Step 2 — Phase 5 成本对账 ✅ 已实施

- ✅ 扩展 `token_usage`：`billing_status`、`gateway_request_id`、`actual_cost_usd`、`currency`、`reconciled_at`。
- ✅ `packages/services/src/models/usage-sync.ts`：按 `runtimeCredentialId` 拉 `usage.tenantLogs`，匹配标记 `reconciled`，未匹配插入 `unallocated`。
- ✅ `CostPageData` / 成本中心展示三种状态金额与“与 models 对账”按钮（`reconcileWorkspaceUsageAction`）。
- ✅ **按 Runtime / AI员工 / 会话维度拆分视图**：三维度汇总查询 + service 封装 + UI 三张明细表（见 Phase 5 表）。
- ✅ **接入 `billing.balanceByTeam` 展示团队余额**：`getTeamBillingBalanceAction`@`costs/actions.ts:24`。

### Step 3 — “Agent” → “AI员工” 文案迁移 ✅ 已实施

- ✅ 遍历 `apps/web/features` 面向用户文案，统一替换为“AI员工 / AI employee”，保留内部标识、路由、类型名、第三方协议名。
- ✅ 同步更新测试断言。

### Step 4 — Phase 3 节点侧受管安装 ✅ 已实施

- ✅ `ManagedCredentialResolver` + 凭据包端点。
- ✅ `provider-templates.ts` 固定网关 URL + Docker 模板 + hardening。
- ✅ 节点执行器真实驱动四 stage；`recordSkipped` 死代码已删除。
- ✅ 与 `runtime-provisioning.ts` pipeline 对接；清理与归因代理健康检查齐备。

---

## 5. 剩余工作（仅 staging 门槛，仓库外）

仓库内业务代码已全部实施并通过 `test:agent-pricing`。以下为无法用单测替代、必须在目标基础设施执行的验收，完成前生产保持 `local`：

1. **staging E2E**：真实 `models.dofe.ai` 测试租户、Runtime Key、网关与批准的容器镜像，跑通新建 Runtime → 创建 AI员工 → 会话 `/model` → 真实用量回传 → 对账修正。
2. **网络出口隔离**：在目标基础设施验证 Runtime 只能访问 models 网关，不能经 DNS、直连 IP、代理环境变量或其他出口访问上游 Provider（门禁脚本 `npm run verify:managed-runtime-egress`）。
3. **真实账单核对**：核对真实账单中的 Runtime Key / AI员工 / 会话 / 模型 / 请求 ID，演练未分配用量修复（`npm run verify:managed-runtime-billing`）。
4. **故障演练**：节点中断、清理最终失败、Key 撤销失败、轮换宽限期与回滚流程，保留审计证据。

> 上述四项不属于 AgentSpace 业务代码缺失，不应在本文标记为 ❌。`implementation-plan.md` 的“仍属 staging 门槛”一节与此一致。
