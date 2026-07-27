# 受管 Runtime 与 AI员工计费实施计划

状态：**AgentSpace 仓库实施完成，等待 staging 联调验收**。该计划以可验证的契约和安全边界为先。`DOFE_AGENT_RUNTIME_MODE` 是部署级开关：未设置或为 `local` 时保持既有路径不变，只有 `remote`（服务器模式）才进入 `models.dofe.ai` 受管流程。

2026-07-28 的第二轮实施复审进一步闭环了 Runtime 归因 HMAC、取消与清理的持久生命周期、人工轮换操作幂等、managed-node 安装/重启、自托管恢复调度和 Runtime 详情入口。发现、修复与剩余外部门槛见 [todo/AGENT_PRICING_REAUDIT_2026-07-28.md](./todo/AGENT_PRICING_REAUDIT_2026-07-28.md)。

## 2026-07-28 审查闭环

本轮按照 2026-07-27 深度审查逐项复核并补齐以下仓库内交付：

1. Runtime 列表完整展示类型、协议、默认模型、已分配 AI员工、节点心跳、周期实际成本和状态，并提供 Provider、状态、模型与成本归因过滤；团队范围由工作区路由天然限定。
2. 创建向导从已注册 daemon 中选择目标服务器，默认自动放置且禁止选择离线节点；模型选择器支持搜索，并展示协议、上下文、能力、价格及不可用原因。
3. 任务详情展示请求时间、动态耗时、阶段进度、日志、重试与取消后果；任务和节点阶段具备超时、指数退避、离线重领与重启恢复。
4. OpenAI、Anthropic、Gemini 健康检查使用各自协议路径和认证头；永久配置错误不会自动重试，瞬时节点或网络错误进入受控重试。
5. 清理请求具备原子领取、超时回收、最多三次尝试、退避和 daemon 成功/失败回调；进入任务重试时不会提前清理 Runtime。
6. 成本页读取 models 的团队真实余额并区分总额、预留、可用、实际、估算、已对账和未分配费用；Runtime 列表同步呈现周期实际及未分配成本。
7. 团队 Owner/Admin 可访问工作区审计页，并按来源、操作者、AI员工、Runtime、会话、任务、模型和时间范围过滤；平台审计仍保持独立权限与真实操作者视图。
8. PostgreSQL schema 升级至 v34，补齐任务/清理恢复字段、索引迁移顺序及历史 `token_usage.task_queue_id` 可空迁移，并纳入专项门禁。

仓库内门禁为 `npm run test:agent-pricing`、`npm run typecheck` 与 `npm run lint:web`。未完成项不在代码仓库内：仍需真实 `models.dofe.ai` 测试租户、网关和容器环境执行 staging E2E、网络出口策略验证及正式账单核对。

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
   必须排除超管，平台侧与团队侧审计采用不同身份展示策略（已实现）。

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

状态：**已完成**。目标：将 Runtime 安装变成可恢复的异步工作流。

1. ✅ 仅为受管 Runtime 增加类型、协议能力、默认模型、团队归属和凭据引用字段；`runtimeCredentialId`、`secretRef`、`configRef` 只由 `remote` 部署写入。
2. ✅ 在受管创建和复用入口先检查部署模式：`local` 继续调用既有本地路径，不进入任何新增分支；`remote` 才校验 SSO 团队范围与 models 内部配置。两条路径均不得相互回退。
3. ✅ 引入仅用于服务器模式的 `RuntimeProvisioningTask`，记录阶段、进度、可读日志、错误、重试次数、幂等键与资源清理结果。
4. ✅ 为服务器 Runtime、任务、凭据状态、模型配置建立审计事件模型；不要求修改既有本地审计事件。
5. ✅ 在 API 中区分“创建新 Runtime”“选择已有 Runtime”“重试安装”“停止 / 删除 Runtime”。
   - 已有 managed runtime 可作为执行引擎在创建 AI员工时被选择；绑定通过 `bindEmployeeRuntimeSync` 复用已有 runtime，不再创建新 credential。
   - `sourceRuntimeId` 字段已支持在 `requestManagedRuntimeProvisioningSync` 中复用凭据与模型配置（当前仅在服务端保留入口，UI 复用通过选择已有 runtime 实现）。
6. ✅ 已实现任务状态迁移、超时租约、取消、补偿和节点离线恢复；创建参数持久化，重试与进程重启不会丢失 Runtime 名称或模型约束。
7. ✅ 在服务端对 Runtime、模型、成本、审计和 AI员工操作统一校验 Owner/Admin；
   Member 不返回可操作入口，且服务端必须拒绝绕过前端的请求。

实现文件：

- `packages/services/src/runtime-provisioning/runtime-provisioning.ts`（managed runtime 列表、创建/复用入口）
- `packages/db/src/daemons.ts`（managed 字段与 `bindEmployeeRuntimeSync`）
- `apps/web/features/dashboard/data.ts`（managed runtime 加入 `containerOptions`）
- `apps/web/features/agents/components/create-agent-modal.tsx`
- `apps/web/features/agents/actions.ts`（`createWorkspaceAgentAction` 绑定已有 runtime）

验收：未设置模式或 `local` 时既有本地流程回归通过、不生成新增 models 管理请求；`remote` 时在 models 配置或团队范围缺失时创建前失败；用户关闭页面后服务器任务继续运行；每次失败都可定位阶段；重试不会重复创建容器或 Runtime Key；Member 无法绕过前端操作 AI员工或 Runtime。

## 阶段 3：节点侧凭据解析与受管安装

状态：**已完成**。

目标：确保服务器模式凭据仅在正确的 Runtime 中短暂可用；本地模式不进入本阶段。

1. ✅ 实现服务器节点侧 `ManagedCredentialResolver`，按 `runtimeId` 从服务端凭据包端点拉取并解析为本地认证 profile。
2. ✅ 为每种服务器 Runtime 适配器建立固定网关 URL、环境变量映射和认证卷写入规则（`provider-templates.ts`）。
3. ✅ 使用受控 Docker 模板安装镜像和 CLI，命令来自服务端硬编码模板，禁止用户提供任意 shell 命令或宿主机 Provider 配置。
4. ✅ 控制面凭据使用 AES-256-GCM 加密的持久 vault，引用绑定 tenant/team/Runtime；节点使用版本化目录和原子切换的 `current` 链接写入认证卷（`0o700` 目录、`0o600` 文件），成功切换后才删除旧代，清理失败时保留凭据和可恢复状态。生产环境必须配置 `DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY`（base64 的 32-byte key）和 `DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR`。
5. ✅ 执行网关/协议级健康检查（`health_check`）后才标记服务器 Runtime 为就绪。
6. ✅ 在停止、删除、失败补偿时通过 cleanup 请求通知节点清理容器、卷、临时文件和旧凭据引用。

实现文件：

- 服务端模板与凭据包：`packages/services/src/runtime-provisioning/provider-templates.ts`
- 服务端任务编排：`packages/services/src/runtime-provisioning/runtime-provisioning.ts`
- 数据库任务/清理/运行时字段：`packages/db/src/runtime-provisioning-tasks.ts`、`packages/db/src/daemons.ts`、`packages/db/src/postgres-schema.ts`
- Daemon 凭据解析器：`packages/daemon/src/managed-provider-credentials.ts`
- Daemon 阶段执行器：`packages/daemon/src/managed-runtime-provisioning.ts`
- Daemon 轮询与心跳集成：`packages/daemon/src/remote-daemon.ts`
- 公共 API 类型：`packages/domain/src/daemon-api.ts`
- Daemon HTTP 客户端：`packages/daemon/src/daemon-client.ts`
- Managed runtime 容器任务执行：`packages/daemon/src/managed-provider-credentials.ts`（生成 Docker launcher，挂载 credential profile）、`apps/cli/src/commands/daemon.ts`（`recordTokenUsageSync` 绑定 credential profile 执行）
- 服务端路由：
  - `apps/web/app/api/daemon/provisioning-tasks/claim/route.ts`
  - `apps/web/app/api/daemon/provisioning-tasks/[taskId]/stages/[stage]/complete/route.ts`
  - `apps/web/app/api/daemon/provisioning-tasks/[taskId]/stages/[stage]/fail/route.ts`
  - `apps/web/app/api/daemon/runtimes/[runtimeId]/credential-bundle/route.ts`
  - `apps/web/app/api/daemon/managed-runtime-cleanup-requests/[requestId]/complete/route.ts`
  - `apps/web/app/api/daemon/managed-runtime-cleanup-requests/[requestId]/fail/route.ts`
  - `apps/web/app/api/daemon/heartbeat/route.ts`
  - `apps/web/app/api/daemon/register/route.ts`
  - `apps/web/app/api/cron/runtime-provisioning/route.ts`

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

1. ✅ 仅为服务器模式接入模型服务的余额、Key 用量、用量日志和对账快照；local 保持既有成本展示，不追加 models 账单或状态。
2. ✅ 记录 AI员工、Runtime、会话、模型、Token 与网关用量 ID 的关联。
   - `token_usage` 已扩展 `runtime_credential_id`、`gateway_request_id`、`router_session_id`、`billing_status`、`actual_cost_usd`、`currency`、`reconciled_at`。
   - 实现文件：`packages/db/src/postgres-schema.ts`、`packages/db/src/types.ts`、`packages/db/src/token-usage.ts`。
3. ✅ 提供租户 / 团队、Runtime Key、Runtime、AI员工、会话维度的成本视图。
   - `packages/db/src/token-usage.ts` 新增 `getRuntimeCostSummarySync`、`getRuntimeCredentialCostSummarySync`、`getSessionCostSummarySync` 及对应的列表查询。
   - `packages/services/src/costs/costs.ts` 新增 `getRuntimeCostProfileSync`、`getRuntimeCredentialCostProfileSync`、`getSessionCostProfileSync`、`listRuntimeCostProfilesSync`、`listRuntimeCredentialCostProfilesSync`、`listSessionCostProfilesSync`。
   - `apps/web/features/costs/costs-page-client.tsx` 增加 Runtime / Runtime Key / 会话费用明细表格。
4. ✅ 用明确状态呈现“真实扣费 / 估算 / 已对账 / 未分配”。
   - `token_usage.billing_status` 为 `estimated | reconciled | unallocated`。
   - `packages/services/src/models/usage-sync.ts` 按 `runtimeCredentialId` 拉取 models `usage.tenantLogs`，匹配本地记录后标记 `reconciled`，未匹配则插入 `unallocated`。
   - `packages/services/src/costs/costs.ts` 的 `CostDashboardData` 暴露 `estimatedCostUsd`、`reconciledCostUsd`、`unallocatedCostUsd`、`totalActualCostUsd`、`lastReconciledAt`。
   - `apps/web/features/costs/costs-page-client.tsx` 展示三种状态金额、对账按钮与最近用量状态标签。
   - `apps/web/features/costs/actions.ts` 提供 `reconcileWorkspaceUsageAction`，Owner/Admin 可对账。
5. ✅ 将用户可见的“Agent”文案系统化迁移为“AI员工”，保留内部兼容层并完成埋点与审计字段迁移。
   - 已遍历 `apps/web/features` 中面向用户的标签、占位符、Toast、空状态、选项和测试断言，统一替换为 “AI员工 / AI employee”。
   - 保留内部标识、路由、类型名、第三方协议名（如 `DofeAgent`、`agentId`、`mention_agent` 值）不变。
6. ✅ 建立异常告警：余额不足、凭据轮换失败、成本归因缺失、对账差异、跨团队访问尝试。
   - 余额不足：`packages/services/src/runtime-provisioning/runtime-provisioning.ts` 在 billing preflight 拒绝时发送 `billing.insufficient_balance` 通知。
   - 凭据轮换失败：`rotateManagedRuntimeCredentialAsync` 在 models 未返回新 secret 时发送 `runtime.credential_rotation_failed` 通知。
   - 成本归因缺失 / 对账差异：`syncRuntimeCredentialUsageAsync` 发现未匹配费用时发送 `usage.reconciliation_discrepancy` 通知。
   - 预算超支：`packages/services/src/budgets/budgets.ts` 在 `checkBudgetSync` 超出限额时发送 `budget.exceeded` 通知。
   - 跨团队访问尝试：已有 SSO 团队范围校验与 models 侧拒绝，触发时会记录审计事件；通知可基于同一机制扩展。
7. ✅ 对平台超管的跨团队介入记录完整的平台侧审计；团队侧审计仅显示“平台运维”，
   不暴露超管账号，也不将其作为团队成员返回。
   - 平台超管由 SSO `authoritativeUser.isAdmin = true` 标识，持久化到 `users.is_admin`，并在 `AuthUser.isPlatformAdmin` 中暴露。
   - 超管登录不写入任何团队成员关系；访问团队时使用内存中的合成 Admin 权限，历史 SSO 成员关系会被清理。
   - 新增独立 `platform-audit` 审计账本与 `/platform/audit` 看板，仅平台超管可访问并保留真实操作者和目标团队。
   - `tryRecordWorkspaceAuditEventSync` 检测到操作者为平台超管时，将团队侧审计事件的执行者替换为“平台运维”并移除用户 ID / 邮箱等敏感字段。
   - `listWorkspaceMemberUsersSync`、`countWorkspaceMembersSync` 与 `transferWorkspaceOwnershipSync` 均排除平台超管。

实现文件：

- 用量写入与多维查询：`packages/db/src/token-usage.ts`
- 成本视图封装：`packages/services/src/costs/costs.ts`
- 对账同步与差异告警：`packages/services/src/models/usage-sync.ts`
- 通知基础设施：`packages/services/src/notifications/notifications.ts`
- 余额 / 轮换 / 预算告警：`packages/services/src/runtime-provisioning/runtime-provisioning.ts`、`packages/services/src/budgets/budgets.ts`
- UI 成本看板：`apps/web/features/costs/costs-page-client.tsx`、`apps/web/features/costs/actions.ts`
- `gateway_request_id` 捕获链路：`packages/daemon/src/agent-router/utils.ts`、`packages/daemon/src/agent-router/events.ts`、`packages/daemon/src/provider-runtime.ts`、`apps/cli/src/commands/daemon.ts`

验收：团队账单可与模型服务核对；任意 AI员工成本记录都能追溯到模型调用关联；界面没有将估算金额误标记为最终扣费。

## 阶段 6：受控恢复与远程创建体验

状态：**已完成**。

1. ✅ Daemon 只把结构化 `provider.auth_invalid` 上报给恢复流程；模型不可用、余额、策略和限流错误不会触发轮换。
2. ✅ `runtime_credential_recovery_task` 持久化幂等键、尝试次数、冷却时间和租约；最多重试三次，重复 401 只创建一个任务。
3. ✅ 恢复中和人工处理态暂停任务调度；成功后恢复 `managed/online`，耗尽重试后进入 `needs_attention/offline` 并通知团队管理员。
4. ✅ 心跳接管进程中断的恢复任务，包括最后一次租约过期后的熔断，以及“Runtime 已更新、任务未落盘”窗口的成功对账。
5. ✅ Runtime 页面使用三步向导（执行环境、模型策略、确认），服务端在签发 Key 前重新校验协议模型目录和余额；浏览器响应不包含 `secretRef` / `configRef`。
6. ✅ Runtime 列表展示恢复状态，并在 `needs_attention` 时提供人工轮换入口。
7. ✅ Runtime 详情页展示安全凭据 ID、协议、模型、AI员工数、心跳、实际成本和未分配成本，不返回 secret/vault 引用。
8. ✅ 自托管 `runtime-maintenance` worker 使用 `CRON_SECRET` 周期恢复 provisioning 和 cleanup；local 模式不执行受管恢复。
9. ✅ 受管节点通过容器内代理按 models 契约生成 HMAC 归因头，并剥离调用方自带的 `x-dofe-*` 头；完整出口隔离仍由 staging 网络策略验收。

## 测试矩阵

| 范围 | 关键测试 |
| --- | --- |
| 模型服务 | Key 创建幂等、轮换宽限、撤销、生效模型过滤、跨团队拒绝、用量关联；确认 local 部署不触发新增内部接口。 |
| AgentSpace 控制面 | 启动时的 `local/remote` 配置解析及默认值、remote 任务状态机、重试、取消、重复提交、已有 Runtime 复用、模型优先级、Owner/Admin 与 Member 权限边界。 |
| 节点执行器 | remote 密钥挂载、原子轮换、容器清理、节点重启恢复、无明文日志。 |
| 端到端 | local 既有工作流回归；remote 新建 Runtime、创建 AI员工、会话 `/model`、真实用量回传、对账修正。 |
| 安全 | 租户越权、团队越权、Member 绕过、超管不写入成员关系且不出现在转移/分配结果、Key 泄露扫描、重放请求、伪造归因字段、审计完整性。 |

仓库内功能域门禁：`npm run test:agent-pricing`。该命令让 Node 测试文件分别运行，避免共享 PostgreSQL 测试数据互相污染，并单独执行 Runtime、成本和 SSO Web 测试。完整 staging 验收仍需真实 `models.dofe.ai` 测试租户、网关和容器运行环境。

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
