# 受管 Runtime 与 AI员工计费实施计划

状态：分阶段实施提案。该计划以可验证的契约和安全边界为先，避免在 Runtime 安装流程中引入不可逆的凭据与计费债务。`DOFE_AGENT_RUNTIME_MODE` 是部署级开关：未设置或为 `local` 时保持既有路径不变，只有 `remote`（服务器模式）才进入 `models.dofe.ai` 受管流程。

## 阶段 0：确认契约与安全基线

目标：在开发前冻结跨项目责任边界。

1. 确认 `models.dofe.ai` 是模型目录、Key、路由、用量和余额的唯一事实来源。
2. 确认上述 models 事实来源仅适用于 `DOFE_AGENT_RUNTIME_MODE=remote`；未设置或为 `local` 时，既有本地模型、凭据、用量和错误处理不变。
3. 在服务启动时解析 `DOFE_AGENT_RUNTIME_MODE`，值域为 `local | remote`，默认 `local`；`remote` 是服务器模式的正式值。不得把它保存为 Runtime 字段、暴露为创建表单选项，或因错误自动切换。
4. 确认 AgentSpace 是 Runtime 生命周期、AI员工归因、会话配置与产品审计的事实来源。
5. 定义仅供服务器模式使用的 `RuntimeCredential` 请求 / 响应 schema、幂等语义、错误码、事件与版本策略。
6. 定义可信调用链，明确谁可以提供 `employeeId`、`conversationId`、`requestId` 等归因字段。
7. 对齐术语：产品界面统一使用“AI员工”；内部实体可逐步保留 `agent` 兼容名。
8. 冻结简化权限模型：团队可见角色仅为 `Owner`、`Admin`、`Member`；Owner/Admin
   具有相同的日常团队管理、财务/运营和 AI员工操作能力，Member 不可操作 AI员工，
   且仅 Owner 可转移 team/tenant 所有权。
9. 定义平台超管授权为成员关系之外的权限覆盖；成员、转移、分配与负责人查询
   必须排除超管，平台侧与团队侧审计采用不同身份展示策略。

产出：模式状态机与迁移规则、API 契约、三角色权限矩阵、超管隐身规则、威胁模型、数据保留规则、验收测试清单。

## 阶段 1：models.dofe.ai 的 Runtime 凭据能力

状态：**已完成**。

目标：让模型服务能够为服务器模式受管 Runtime 签发可隔离、可轮换、可审计的凭据。本地模式无此阶段的运行时调用。

1. ✅ 新增 `RuntimeCredential` 数据模型及其状态机。
2. ✅ 新增创建、查询、轮换、撤销凭据的内部 API。
3. ✅ 增加按 Runtime 凭据与协议过滤模型目录的内部 API。
4. ✅ 将 Runtime 凭据映射到现有 API Key、团队、租户、允许模型与网关策略。
5. ✅ 向用量记录写入 Runtime、AI员工、会话和请求关联字段。
6. ✅ 扩展 `models-sdk`，为 AgentSpace 提供稳定的类型化调用方式。

实现文件：

- Prisma schema：`apps/api/prisma/schema.prisma`（`RuntimeCredential`、`RuntimeCredentialStatus`、`GatewayUsageLog` 归因字段、`GatewayUserApiKey` 反向关系）
- 领域服务：`apps/api/libs/domain/runtime-credential/`
- 内部 API：`apps/api/src/modules/internal-api/internal-api.controller.ts`、`internal-api.service.ts`
- 代理校验：`apps/api/libs/domain/proxy-core/proxy-core.service.ts`、`runtime-attribution.helper.ts`
- 契约/SDK：`packages/contracts/src/schemas/runtime-credential.schema.ts`、`packages/contracts/src/api/internal.contract.ts`、`packages/models-sdk/src/internal-types.ts`、`packages/models-sdk/src/internal.ts`
- 测试：`apps/api/libs/domain/runtime-credential/runtime-credential.service.spec.ts`、`apps/api/libs/domain/proxy-core/proxy-core.runtime-attribution.spec.ts`、`apps/api/src/modules/internal-api/internal-api.controller.http.spec.ts`

验收：重复创建请求只产生一个有效凭据；轮换不泄露明文 Key；撤销后网关拒绝旧 Key；模型目录与实际调用权限一致。

## 阶段 2：AgentSpace 的 Runtime 数据与任务模型

目标：将 Runtime 安装变成可恢复的异步工作流。

1. 仅为受管 Runtime 增加类型、协议能力、默认模型、团队归属和凭据引用字段；`runtimeCredentialId`、`secretRef`、`configRef` 只由 `remote` 部署写入。
2. 在受管创建和复用入口先检查部署模式：`local` 继续调用既有本地路径，不进入任何新增分支；`remote` 才校验 SSO 团队范围与 models 内部配置。两条路径均不得相互回退。
3. 引入仅用于服务器模式的 `RuntimeProvisioningTask`，记录阶段、进度、可读日志、错误、重试次数、幂等键与资源清理结果。
4. 为服务器 Runtime、任务、凭据状态、模型配置建立审计事件模型；不要求修改既有本地审计事件。
5. 在 API 中区分“创建新 Runtime”“选择已有 Runtime”“重试安装”“停止 / 删除 Runtime”。
6. 设计任务状态迁移、超时、取消、补偿和节点离线恢复策略。
7. 在服务端对 Runtime、模型、成本、审计和 AI员工操作统一校验 Owner/Admin；
   Member 不返回可操作入口，且服务端必须拒绝绕过前端的请求。

验收：未设置模式或 `local` 时既有本地流程回归通过、不生成新增 models 管理请求；`remote` 时在 models 配置或团队范围缺失时创建前失败；用户关闭页面后服务器任务继续运行；每次失败都可定位阶段；重试不会重复创建容器或 Runtime Key；Member 无法绕过前端操作 AI员工或 Runtime。

## 阶段 3：节点侧凭据解析与受管安装

目标：确保服务器模式凭据仅在正确的 Runtime 中短暂可用；本地模式不进入本阶段。

1. 实现服务器节点侧 `ProviderCredentialResolver`，按 `runtimeCredentialId` 解析 `secretRef`、`configRef`。
2. 为每种服务器 Runtime 适配器建立固定网关 URL、环境变量映射和认证卷写入规则。
3. 使用受控 Docker 模板安装镜像和 CLI，禁止用户提供任意 shell 命令或宿主机 Provider 配置。
4. 以原子方式写入认证卷，并在轮换后重载服务器 Runtime；失败时保留可恢复状态。
5. 执行 models 目录和协议级健康检查后才标记服务器 Runtime 为就绪。
6. 在停止、删除、失败补偿时清理服务器容器、卷、临时文件和旧凭据引用。

验收：节点日志、容器 inspect、数据库和前端均无明文 Key；不同团队的服务器 Runtime 无法挂载彼此凭据；local 回归测试证明既有本地配置未被本阶段修改。

## 阶段 4：模型配置与会话体验

目标：让用户获得可预测的模型选择行为。

1. ✅ 仅在 `remote` 部署中创建受管 Runtime，并按类型和协议展示 models 目录及 Runtime 默认模型；local 保持既有页面与模型行为。
2. ✅ 创建 AI员工时支持选择其专属默认模型，展示与 Runtime 默认模型的差异。
3. ✅ 在会话中实现 `/model`，仅持久化到当前会话。
   - 命令格式：`/model <modelId>` 设置覆盖，`/model clear` 或 `/model` 清除覆盖。
   - 群聊中必须 @ 一名 AI员工，以确定其会话；私聊数字员工时无需 @。
   - 仅 `Owner/Admin` 可执行；服务端通过 `assertWorkspaceRoleForContext` 校验。
   - 底层调用 `setSessionModelOverrideForChatCommandSync`，解析或创建 `agent_router_session` 后写入 `model_override`。
4. ✅ 在聊天界面清晰展示当前生效模型及其来源：会话、AI员工、Runtime 或团队策略。
   - 聊天顶部直接私聊会话显示当前生效模型和来源标签。
   - Owner/Admin 可从协议过滤的模型目录中选择会话覆盖模型；选择“继承默认”清除覆盖。
   - 实现文件：`apps/web/features/chat/chat-model-selector.tsx`、`apps/web/features/channels/actions.ts`、`packages/services/src/chat/model-override.ts`。
5. ✅ 对不兼容、不可用、余额不足、无权限模型提供可操作的错误状态。
   - `validateSessionModelOverrideForChatCommandAsync` 将 models 返回的异常归类为可读错误码（`model_unavailable` / `no_bound_runtime` / `not_a_managed_runtime` / `remote_mode_required`）。
   - `setChatModelOverrideAction` 返回结构化结果，`ChatModelSelector` 在顶部显示错误标签与原因，而不是仅抛通用异常。
   - `/model reset` 与 `/model clear` 均被识别为清除会话覆盖。
   - 实现文件：`packages/services/src/chat/model-override.ts`、`apps/web/features/channels/actions.ts`、`apps/web/features/chat/chat-model-selector.tsx`、`apps/web/features/chat/model-command.ts`。

验收：同一 Runtime 下的两个会话可以使用不同模型而不互相影响；不兼容协议的模型无法被选择或调用。

## 阶段 5：用量、计费、对账与术语迁移

目标：同时提供账务准确性和 AI员工归因可解释性。

1. 仅为服务器模式接入模型服务的余额、Key 用量、用量日志和对账快照；local 保持既有成本展示，不追加 models 账单或状态。
2. ✅ 记录 AI员工、Runtime、会话、模型、Token 与网关用量 ID 的关联。
   - `token_usage` 已扩展 `runtime_credential_id`、`gateway_request_id`、`router_session_id`、`billing_status`、`actual_cost_usd`、`currency`、`reconciled_at`。
   - 实现文件：`packages/db/src/postgres-schema.ts`、`packages/db/src/types.ts`、`packages/db/src/token-usage.ts`。
3. ⏳ 提供租户 / 团队、Runtime Key、Runtime、AI员工、会话维度的成本视图（骨架待细化）。
4. ✅ 用明确状态呈现“真实扣费 / 估算 / 已对账 / 未分配”。
   - `token_usage.billing_status` 为 `estimated | reconciled | unallocated`。
   - `packages/services/src/models/usage-sync.ts` 按 `runtimeCredentialId` 拉取 models `usage.tenantLogs`，匹配本地记录后标记 `reconciled`，未匹配则插入 `unallocated`。
   - `packages/services/src/costs/costs.ts` 的 `CostDashboardData` 暴露 `estimatedCostUsd`、`reconciledCostUsd`、`unallocatedCostUsd`、`totalActualCostUsd`、`lastReconciledAt`。
   - `apps/web/features/costs/costs-page-client.tsx` 展示三种状态金额、对账按钮与最近用量状态标签。
   - `apps/web/features/costs/actions.ts` 提供 `reconcileWorkspaceUsageAction`，Owner/Admin 可对账。
5. ✅ 将用户可见的“Agent”文案系统化迁移为“AI员工”，保留内部兼容层并完成埋点与审计字段迁移。
   - 已遍历 `apps/web/features` 中面向用户的标签、占位符、Toast、空状态、选项和测试断言，统一替换为 “AI员工 / AI employee”。
   - 保留内部标识、路由、类型名、第三方协议名（如 `DofeAgent`、`agentId`、`mention_agent` 值）不变。
6. ⏳ 建立异常告警：余额不足、凭据轮换失败、成本归因缺失、对账差异、跨团队访问尝试。
7. ⏳ 对平台超管的跨团队介入记录完整的平台侧审计；团队侧审计仅显示“平台运维”，
   不暴露超管账号，也不将其作为团队成员返回。

验收：团队账单可与模型服务核对；任意 AI员工成本记录都能追溯到模型调用关联；界面没有将估算金额误标记为最终扣费。

## 测试矩阵

| 范围 | 关键测试 |
| --- | --- |
| 模型服务 | Key 创建幂等、轮换宽限、撤销、生效模型过滤、跨团队拒绝、用量关联；确认 local 部署不触发新增内部接口。 |
| AgentSpace 控制面 | 启动时的 `local/remote` 配置解析及默认值、remote 任务状态机、重试、取消、重复提交、已有 Runtime 复用、模型优先级、Owner/Admin 与 Member 权限边界。 |
| 节点执行器 | remote 密钥挂载、原子轮换、容器清理、节点重启恢复、无明文日志。 |
| 端到端 | local 既有工作流回归；remote 新建 Runtime、创建 AI员工、会话 `/model`、真实用量回传、对账修正。 |
| 安全 | 租户越权、团队越权、Member 绕过、超管不写入成员关系且不出现在转移/分配结果、Key 泄露扫描、重放请求、伪造归因字段、审计完整性。 |

## 发布与迁移策略

1. 保持 `local` 为默认值并完成其回归验证；仅在显式设置 `DOFE_AGENT_RUNTIME_MODE=remote` 的内部部署中启用服务器受管 Runtime。
2. 逐 Runtime 类型灰度，优先选择协议清晰、安装脚本稳定的类型。
3. 在模型服务与 AgentSpace 同时记录对账关联，但不立即移除旧路径。
4. 连续多个结算周期完成账单与归因数据核验后，迁移既有 Runtime。
5. 仅在回滚方案、轮换方案、数据修复流程经过演练后扩大范围。

## 不应提前实施的内容

- 用本地模式掩盖服务器模式的 models 配置、凭据或计费故障，或在两种模式间自动回退。
- 在跨项目 Key 契约稳定前，直接将用户 Provider 配置写入服务器 Runtime 容器。
- 在归因字段可信链路明确前，将客户端上报的 `employeeId` 用于结算。
- 在安装任务具备清理与恢复能力前，开放批量创建 Runtime。
- 在模型协议过滤与健康检查完成前，允许用户选择任意模型。
