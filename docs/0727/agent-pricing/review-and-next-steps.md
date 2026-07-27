# 深度审查：agent-pricing 实施状态与下一步计划

审查日期：2026-07-27  
审查范围：`docs/0727/agent-pricing` 三份文档 + AgentSpace 当前分支业务代码  
结论：**尚未全面实施，但 Step 2 成本对账骨架与 Step 3 “Agent”→“AI员工”文案迁移已完成**。Phase 1（models.dofe.ai 侧 RuntimeCredential）已完成；Phase 2（AgentSpace 控制面）已落地主要路径；Phase 3（节点侧受管安装）基本未实施；Phase 4（模型配置与会话体验）核心路径已通；Phase 5（成本对账、文案迁移）已完成骨架与文案，余额/Key 用量、多维度视图、告警仍待实施。

---

## 1. 审查方法

1. 逐条对照 `00-产品需求与交付规格.md`、`README.md`、`models-contract.md`、`implementation-plan.md` 的验收项。
2. 使用代码知识图谱定位关键实现文件，并人工核对代码行为。
3. 标记每个需求为 **已实施 / 部分实施 / 未实施 / 不适用（models 侧）**。

---

## 2. 分阶段实施状态

### Phase 0：契约与安全基线

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `DOFE_AGENT_RUNTIME_MODE` 启动时解析，默认 `local`，值域 `local\|remote` | ✅ 已实施 | `packages/services/src/config/deployment.ts:9` `resolveAgentRuntimeMode` |
| `local` 不进入受管流程 | ✅ 已实施 | `apps/cli/src/commands/daemon.ts:1056-1077` 仅在 `managedCredentialId` 存在时走 `resolveEffectiveModelForTaskAsync`；所有 managed action 先调 `assertRemoteRuntimeMode` |
| 团队可见角色仅 Owner/Admin/Member | ✅ 已实施 | `apps/web/features/auth/workspace-permissions.ts`；`assertWorkspaceRoleForContext` 校验 |
| 平台超管不出现在成员关系 | ⚠️ 部分实施 | 团队侧校验仅看 `workspace_membership`（`implementation-plan.md:19`），但平台超管跨团队运维控制台尚未在本仓库可见 |

### Phase 1：models.dofe.ai RuntimeCredential（models 侧）

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| RuntimeCredential 模型与状态机 | ✅ 已实施（models 侧） | `models-contract.md` 指明实现位于 `models.dofe.ai` 仓库 |
| 创建 / 查询 / 轮换 / 撤销内部 API | ✅ 已实施（models 侧） | 同上 |
| 协议过滤模型目录 | ✅ 已实施（models 侧） | 同上；AgentSpace 通过 `runtimeCredentials.models` 消费 |

### Phase 2：AgentSpace Runtime 数据与任务模型

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `agent_runtime` 受管字段 | ✅ 已实施 | `packages/db/src/postgres-schema.ts` 含 `managed_credential_id`、`credential_secret_ref`、`credential_config_ref`、`protocols_json`、`default_model`、`provisioning_state` 等 |
| `RuntimeProvisioningTask` 及事件 | ✅ 已实施 | `packages/db/src/runtime-provisioning-tasks.ts`；`packages/services/src/runtime-provisioning/runtime-provisioning.ts` |
| 创建 / 取消 / 重试 / 停止 / 删除 Runtime | ✅ 已实施 | `packages/services/src/runtime-provisioning/runtime-provisioning.ts:106-437` |
| 凭据轮换与状态查询 | ✅ 已实施 | `rotateManagedRuntimeCredentialSync`、`getManagedRuntimeCredentialStatusSync` |
| 创建前检查 `remote` 模式与 SSO team 范围 | ✅ 已实施 | `assertRemoteRuntimeMode`、`resolveManagedRuntimeScopeSync` |
| Owner/Admin 统一校验 | ✅ 已实施 | `assertCanManageManagedRuntimes` 调用 `isWorkspaceAdminOrOwnerSync` |
| 选择已有 Runtime / 复用 | ⚠️ 部分实施 | 存在 `bindEmployeeRuntimeSync` 与 Runtime 授权（`runtime-access`），但 UI 缺少“从 AI员工表单浏览并选择已有 Runtime”的显式复用入口；创建向导未展示可复用 Runtime 列表 |
| 任务离线恢复 | ✅ 已实施 | `resumePendingProvisioningTasksSync` |

### Phase 3：节点侧凭据解析与受管安装

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 节点侧 `ProviderCredentialResolver` | ❌ 未实施 | `packages/daemon/src/provider-runtime.ts` 仍为本地 Provider Runtime；无按 `runtimeCredentialId` 解析 `secretRef/configRef` 的代码 |
| 固定网关 URL 与认证卷注入 | ❌ 未实施 | 未见 Docker 模板与卷写入逻辑 |
| 受控 Docker 镜像 / CLI 安装 | ❌ 未实施 | `runtime-provisioning.ts:574-575` 明确跳过 `pull_image` / `install_cli`，标记为 Phase 3 |
| 健康检查后再标记就绪 | ⚠️ 部分实施 | 当前仅校验 `managedCredentialId` 已绑定（`runtime-provisioning.ts:598-600`），无协议级 / 网关级健康检查 |
| 停止 / 删除 / 失败时清理容器与卷 | ❌ 未实施 | 目前仅撤销 credential 和删除 DB 行 |

### Phase 4：模型配置与会话体验

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `remote` 创建 Runtime 时从协议过滤目录选默认模型 | ✅ 已实施 | `apps/web/features/runtimes/runtime-model-picker.tsx`；`listProtocolFilteredRuntimeModelsAction` |
| AI员工默认模型 | ✅ 已实施 | `createEmployeeSync` / `updateEmployeeDefaultModelSync`；UI `create-agent-modal.tsx`、`agent-detail.tsx` |
| 五级模型优先级解析 | ✅ 已实施 | `packages/services/src/models/model-resolution.ts` `resolveEffectiveModelForTaskAsync` |
| 会话 `/model` 命令 | ✅ 已实施 | `apps/web/features/chat/model-command.ts`；`packages/services/src/chat/model-override.ts` |
| 聊天顶部模型选择器（直接私聊） | ✅ 已实施 | `apps/web/features/chat/chat-model-selector.tsx` |
| **不兼容 / 不可用 / 无权限模型的可操作错误状态** | ✅ **已实施** | `ChatModelOverrideValidationError` 归类错误码；`setChatModelOverrideAction` 返回 `{ok, code, message}`；`ChatModelSelector` 显示错误标签；`/model reset` 也支持清除覆盖 |

### Phase 5：用量、计费、对账与术语迁移

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `token_usage` 记录 `runtimeCredentialId`、`routerSessionId` | ✅ 已实施 schema + 写入 | `apps/cli/src/commands/daemon.ts:1275-1276`；schema 已加列 |
| 余额 / Key 用量 / 用量日志接入 | ⚠️ 部分实施 | `packages/services/src/models/usage-sync.ts` 已接入 `usage.tenantLogs` 并按 `runtimeCredentialId` 对账；余额 / Key 用量卡片尚未实施 |
| 成本状态：真实扣费 / 估算 / 待对账 / 已对账 | ✅ 已实施骨架 | `token_usage` 增加 `billing_status`、`actual_cost_usd`、`currency`、`reconciled_at`；`CostDashboardData`/`CostPageData` 暴露 `estimatedCostUsd`/`reconciledCostUsd`/`unallocatedCostUsd`/`totalActualCostUsd`；成本页展示三种状态并支持“与 models 对账” |
| AI员工 / Runtime / 会话维度成本视图 | ❌ 未实施 | 成本页仍为 `token_usage` 聚合，未按 Runtime / 会话拆分 |
| “Agent” 文案迁移为 “AI员工” | ✅ 已实施 | 已遍历 `apps/web/features` 面向用户的标签、Toast、空状态、选项和测试断言；内部标识、路由、类型名、第三方协议名保留 |
| 异常告警（余额不足、轮换失败、对账差异等） | ❌ 未实施 | 未见 |
| 平台超管审计隔离 | ❌ 未实施 | 平台侧审计未在本仓库落地 |

---

## 3. 关键缺口与风险

1. **Phase 3 缺失导致“受管 Runtime”只是 DB 行 + Credential，无法真正运行。** 当前 pipeline 不会拉取镜像、安装 CLI 或注入凭据，服务器 Runtime 不会实际可用。
2. **Phase 4 错误状态缺失。** 用户选择不兼容模型或团队余额不足时，前端缺乏可操作的反馈，容易把失败当成通用错误。
3. **Phase 5 成本对账缺失。** `token_usage` 只有估算，无法与 models 网关真实账单对账，无法满足“团队账单可核对”的验收标准。
4. **文案未迁移。** 产品验收清单要求用户界面统一为 “AI员工”，当前仍大量显示 “Agent”。
5. **平台超管隐身。** 虽然成员关系未写入超管，但平台运维控制台和审计在本仓库不可见。

---

## 4. 推荐下一步计划（按优先级）

### Step 1 — Phase 4 聊天模型错误状态（已实施）

目标：让不兼容 / 不可用 / 无权限模型在聊天顶部选择器与 `/model` 命令中有明确、可操作的提示。

- ✅ `packages/services/src/chat/model-override.ts`：新增 `ChatModelOverrideValidationError`，把校验异常归类为可读错误码。
- ✅ `apps/web/features/channels/actions.ts`：`setChatModelOverrideAction` 返回结构化结果 `{ok}` / `{ok:false; code; message}`。
- ✅ `apps/web/features/chat/chat-model-selector.tsx`：展示错误提示，保持当前模型不变。
- ✅ `apps/web/features/chat/model-command.ts`：支持 `/model reset` 清除覆盖。
- ⏳ 创建 Runtime 向导中的余额预检与模型可用性前置校验仍待实施（需在前端提交前调用 `billing.preflight`）。

### Step 2 — Phase 5 成本对账骨架（已实施骨架）

目标：让成本页能区分“估算 / 已对账 / 未分配”。

- ✅ 扩展 `token_usage`：增加 `billing_status`、`gateway_request_id`、`actual_cost_usd`、`currency`、`reconciled_at`。
- ✅ 新增 `packages/services/src/models/usage-sync.ts`：按 `runtimeCredentialId` 拉取 models 用量日志，匹配本地记录并标记 `reconciled`，未匹配插入 `unallocated`。
- ✅ 在 `CostPageData` / 成本中心展示三种状态金额与“与 models 对账”按钮。
- ✅ 更新 `implementation-plan.md` Phase 5 为部分完成。
- ⏳ 仍待细化：按 Runtime / AI员工 / 会话维度拆分视图；接入 models `billing.balanceByTeam` 展示团队余额。

### Step 3 — “Agent” → “AI员工” 文案迁移（已实施）

目标：通过用户可见文案验收。

- ✅ 搜索 `apps/web/features` 中面向用户的 “Agent” 文案（标签、占位符、Toast、空状态、选项、测试断言）。
- ✅ 替换为 “AI员工” / “AI employee”，保留内部标识、路由、类型名、第三方协议名。
- ✅ 更新 `implementation-plan.md` Phase 5 文案迁移项。

### Step 4 — Phase 3 节点侧受管安装（高耦合，需与 daemon/ops 协同）

目标：让服务器 Runtime 能真正拉取镜像、安装 CLI、注入凭据、运行健康检查。

- 设计 `ProviderCredentialResolver` 与 Docker 模板。
- 实现节点执行器对 `pull_image / install_cli / write_credential / health_check` 的驱动。
- 与 `runtime-provisioning.ts` pipeline 对接，移除 `recordSkipped`。
- 更新 `implementation-plan.md` Phase 3 为已完成。

---

## 5. 本次立即实施项

选择 **Step 3 — “Agent” → “AI员工” 文案迁移** 作为立即实施项：

- 改动面小，不依赖 models 侧新接口。
- 直接对应 `implementation-plan.md` Phase 5 文案迁移验收项。

实施范围：
1. ✅ 遍历 `apps/web/features` 中面向用户的 “Agent” 文案（agents、costs、chat、inbox、auth、settings、permissions、dashboard、org-chart、knowledge、task-board、skills、automations、approvals、performance、i18n 等）。
2. ✅ 统一替换为 “AI员工 / AI employee”，保留内部标识、路由、类型名、第三方协议名（如 `DofeAgent`、`agentId`、`mention_agent` 值）。
3. ✅ 同步更新相关测试断言中的文案期望。
4. ✅ 更新 `docs/0727/agent-pricing/implementation-plan.md` 与 `review-and-next-steps.md` 对应状态。

下一步推荐：**Step 4 — Phase 3 节点侧受管安装**（需与 daemon/ops 协同）。
