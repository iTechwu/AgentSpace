# AI员工 Runtime、模型与计费总体架构

状态：AgentSpace 仓库实施已于 2026-07-28 完成审查闭环，真实 `models.dofe.ai` 测试租户、网关和容器环境的 staging E2E 仍待验收。本文件定义的受管 Runtime 设计仅在 `remote` 模式生效；`local` 模式保持既有实现不变。

本文将 AgentSpace 中的 AI员工、Runtime、`models.dofe.ai` 网关与计费责任划分为可独立演进的边界。目标是在不依赖用户手工部署或配置 CLI Provider 的前提下，既能复用本机已有服务，又能在服务器上支持按团队隔离模型凭据、模型目录、账单归属与审计证据。

配套文档：

- [产品需求与交付规格](./00-产品需求与交付规格.md)
- [models.dofe.ai 契约优化](./models-contract.md)
- [实施计划](./implementation-plan.md)

## 1. 产品目标与边界

### 1.1 目标

1. `DOFE_AGENT_RUNTIME_MODE` 是部署级配置，在 AgentSpace 实例启动时读取；未设置时默认为 `local`。同一实例不混用两种模式，用户也不能在 Runtime 创建页面切换模式。
2. `local` 时，保持现有本地 Runtime、Provider 连接、模型选择、用量和错误处理路径不变；本次设计不要求迁移、重建或重新配置已有本地服务。
3. `DOFE_AGENT_RUNTIME_MODE=remote`（下文称“服务器模式”）时，用户通过 AgentSpace 创建或选择受管 Runtime；不允许在节点上手动安装 Runtime。
4. 服务器 Runtime 安装是可观察、可重试、可恢复的异步任务，而不是同步等待操作。
5. 每个服务器 Runtime 都由 `models.dofe.ai` 签发独立 Runtime Key，并仅注入该 Runtime 的环境与认证卷。
6. Runtime 支持不同协议：OpenAI 兼容、Anthropic 与 Gemini；可选模型必须由其实际连接服务的协议能力决定。
7. AI员工、Runtime 与会话可以分别声明默认模型，`/model` 仅影响当前会话。
8. 服务器模式由模型网关按 `tenantId`、`teamId`、API Key 进行真实扣费；AgentSpace 负责将调用量归因至 AI员工、Runtime 与会话。
9. 服务器模式的凭据签发、模型配置与密钥轮换均应留有可审计证据。

### 1.2 非目标

- 不在 AgentSpace 复制服务器模式的模型路由、余额扣减、供应商密钥管理或模型价格计算。
- 不允许在 AgentSpace 的数据库、日志或前端保存明文模型 API Key。
- 不要求每一个 AI员工拥有独立容器；Runtime 可以服务多个 AI员工。
- 不将 `/model` 作为 Runtime 的永久配置入口。

## 2. 核心对象与责任归属

| 对象 | 核心责任 | 归属系统 |
| --- | --- | --- |
| 租户 / 团队 | 隔离边界、余额与账单主体 | models.dofe.ai |
| Runtime | 受管执行环境、协议能力、运行状态 | AgentSpace |
| 运行模式 | 实例启动时决定保持既有本地路径或启用受管服务器与 models 网关 | AgentSpace 部署配置 |
| 本地服务连接 | 既有本机 Provider/服务及其可用模型 | AgentSpace 既有本地模式实现 |
| Runtime Key | Runtime 的模型网关访问凭据 | models.dofe.ai 签发；AgentSpace 节点短暂消费 |
| AI员工 | 业务身份、提示词、员工默认模型、成本归因主体 | AgentSpace |
| 会话 | 对话上下文、会话级模型临时覆盖 | AgentSpace |
| 模型目录 | 可见性、协议兼容性、可用状态 | models.dofe.ai |
| 真实用量与金额 | Token、金额、余额、供应商路由结果 | models.dofe.ai |
| AI员工成本视图 | 用量映射、估算 / 对账状态、审计展示 | AgentSpace |

### 2.1 简化团队权限与平台运维边界

团队可见角色仅为 `Owner`、`Admin`、`Member`。`Owner` 与 `Admin` 均为团队管理员，
拥有相同的日常团队管理、财务/运营、Runtime、模型、成本、审计与全部 AI员工操作
能力；仅 `Owner` 可以转移 team/tenant 所有权。`Member` 不具备上述管理能力，当前
版本也不能操作 AI员工。不要再创建财务、运营、AI员工负责人或资源级权限包。

平台超管是独立的平台运维身份，按需继承所有 tenant/team 的管理员能力，但不会被
写入任何团队成员关系。因此，成员列表、邀请、转移、分配、负责人选择器与团队侧
角色筛选均不得显示超管。平台侧审计保留实际操作者；团队侧仅在必要时以“平台运维”
记录介入，不暴露超管个人身份或制造其属于团队的印象。

## 3. 运行模式与总体架构

运行模式由 `DOFE_AGENT_RUNTIME_MODE` 决定，配置和值域为 `local | remote`：`local` 是默认
值，保持既有本地路径；`remote` 是服务器模式，启用本文件定义的受管能力。该变量必须在
实例启动时解析并固定，不能由前端、Runtime 记录或网络可达性推断，亦不得作为 Runtime
创建时的可选字段持久化。不得引入或写入 `server` 作为配置值。

| 配置 | 调用路径 | models 依赖 | 凭据与模型来源 | 费用语义 |
| --- | --- | --- | --- | --- |
| `DOFE_AGENT_RUNTIME_MODE=local` 或未设置 | 既有本地调用路径 | 不适用 | 沿用既有 Provider、模型与凭据配置 | 沿用既有用量与费用语义；本设计不改变它 |
| `DOFE_AGENT_RUNTIME_MODE=remote` | AI员工 -> 受管 Runtime -> `model.local.dofe.ai` -> 上游 Provider | 必需 | `RuntimeCredential` 与 models 兼容目录 | models 是实际账务事实，可按 Runtime Key 对账 |

本地模式不进入本文件新增的 `RuntimeCredential`、`secretRef`、`configRef`、受管容器或
服务器安装任务流程，也不因 `MODELS_BASE_URL` 缺失而失败；本地故障和恢复继续遵循既有
行为。服务器模式不得回退或读取本机 Provider 配置。

```mermaid
flowchart LR
  Employee[AI员工] --> Decision{DOFE_AGENT_RUNTIME_MODE}
  Decision -->|local| Main[既有本地调用路径]
  Main --> LocalProvider[本地 Provider / 服务]
  Decision -->|remote| AS[AgentSpace 控制面]
  AS --> Queue[Runtime 任务队列]
  Queue --> Node[节点执行器]
  Node --> Docker[受管 Docker Runtime]
  AS --> Models[models.dofe.ai 内部接口]
  Docker --> Gateway[model.local.dofe.ai/api]
  Gateway --> Provider[上游模型供应商]
  Gateway --> Billing[余额、用量与账单]
  AS --> Audit[AgentSpace 审计与归因]
  Billing --> Audit
```

### 3.1 服务器模式架构

```mermaid
flowchart LR
  User[用户] --> AS[AgentSpace 控制面]
  AS --> Queue[Runtime 任务队列]
  Queue --> Node[节点执行器]
  Node --> Docker[受管 Docker Runtime]
  AS --> Models[models.dofe.ai 内部接口]
  Docker --> Gateway[model.local.dofe.ai/api]
  Gateway --> Provider[上游模型供应商]
  Gateway --> Billing[余额、用量与账单]
  AS --> Audit[AgentSpace 审计与归因]
  Billing --> Audit
```

### 3.2 服务器模式模型网关地址

部署时必须分别配置控制面 `MODELS_BASE_URL` 与数据面
`MODELS_GATEWAY_BASE_URL`。前者只供 AgentSpace 服务端调用 models 内部接口；后者只用于
生成受管 Runtime 的协议 Base URL，不得用控制面地址兜底。余额预检使用
`MANAGED_RUNTIME_PREFLIGHT_CHARGE_USD` 作为缺省估算金额，默认 `0.01` 美元，且必须大于
零；调用方传入的正数估算金额优先。

受管 Runtime 的适配器根据协议注入网关地址。**主机在部署时由 `MODELS_GATEWAY_BASE_URL` 解析**（`provider-templates.ts` 的 `resolveManagedRuntimeGatewayBaseUrl`）；下表中的 `model.local.dofe.ai/api` 是规范默认主机（字面量仅出现在测试中），只有路径后缀与 Gemini 的 https 升级是固定的：

| 协议 | Base URL（`gatewayBaseUrl` = `MODELS_GATEWAY_BASE_URL`，缺省 `model.local.dofe.ai/api`） |
| --- | --- |
| OpenAI 兼容 | `http://gatewayBaseUrl/v1` |
| Anthropic | `http://gatewayBaseUrl/anthropic` |
| Gemini | `https://gatewayBaseUrl/gemini`（强制 https 升级） |

服务器 Runtime 不直接使用用户在本地 Claude Code 或 Codex 配置过的 Provider。Provider、模型可见性、余额与最终路由均由模型网关统一控制。本地模式不适用本表，并继续使用既有配置。

## 4. 模型选择优先级

模型选择遵循从最具体到最通用的优先级：

1. 当前会话的 `/model` 覆盖；
2. AI员工专属默认模型；
3. Runtime 默认模型；
4. 团队 / 租户策略默认模型；
5. Runtime 协议可用模型中的系统兜底模型。

`/model` 仅更新会话设置，并写入会话审计事件；它不会修改 Runtime 默认模型，也不会影响同一 Runtime 中其他 AI员工或其他会话。

服务器模式的模型选择界面必须读取模型网关的协议过滤目录。例如 Claude Code Runtime 仅展示 Anthropic 协议可调用的模型，Codex Runtime 仅展示 OpenAI Responses 或 OpenAI 兼容协议可调用的模型。本地模式继续沿用既有模型选择行为；不得为接入本设计而调用 models 目录替换它。

## 5. Runtime Key 与凭据隔离（仅服务器模式）

### 5.1 运行时凭据原则

- 每个 Runtime 使用一个独立的 `runtimeCredentialId` 与 API Key。
- Key 绑定 `tenantId`、`teamId`、`runtimeId`、协议能力、允许模型和生命周期策略。
- AgentSpace 控制面只保存不可逆引用，例如 `secretRef`、`configRef`、Key 指纹与有效期；不保存明文 Key。
- 节点侧 `ProviderCredentialResolver` 在启动、恢复或轮换时解析引用，仅向目标容器的专属环境变量和认证卷注入明文。
- 容器停止、删除或凭据轮换时，旧认证卷与临时文件必须清理。

### 5.2 续期与轮换

Runtime Key 可采用长期有效策略，但必须支持服务端失效、手动撤销、泄露处置和自动重签发。建议在请求被网关拒绝为无效凭据时触发一次受控恢复，而不是在每次调用失败时盲目重试。

```mermaid
sequenceDiagram
  participant Runtime as Runtime
  participant Node as 节点执行器
  participant AS as AgentSpace 控制面
  participant Models as models.dofe.ai
  Runtime->>Node: 模型请求返回凭据无效
  Node->>AS: 上报 credential-invalid
  AS->>Models: 申请替换 Runtime Key
  Models-->>AS: 新 key 与 metadata
  AS->>Node: 更新 secretRef / configRef
  Node->>Runtime: 原子替换认证卷并重载
  AS->>AS: 写入轮换审计事件
```

自动续期必须有限流、幂等键和熔断保护。余额不足、团队被禁用、模型策略拒绝等业务错误不能触发无限制重签发。

## 6. Runtime 准备流程

本地模式不新增准备流程，继续执行既有本地行为。服务器模式采用以下完整流程：

Runtime 创建过程分为业务可见的任务状态：

`等待中 -> 申请凭据 -> 准备节点 -> 拉取镜像 -> 安装 CLI -> 写入凭据 -> 健康检查 -> 就绪`

失败状态需要明确失败阶段、可读原因、重试建议与是否已经回收资源。用户可以离开页面；前端通过任务详情、轮询或事件订阅展示进度，而非阻塞等待 Docker 安装完成。

现有 Runtime 可被选择复用。复用时必须校验：

- Runtime 所属租户、团队与访问权限；
- Runtime 类型、协议能力及所选模型兼容性；
- Runtime 当前健康状态与凭据可用状态；
- 是否允许新增 AI员工共享该 Runtime。

## 7. 计费与归因

### 7.1 账务事实与归因事实

服务器模式的模型网关按 `tenantId`、`teamId`、API Key 结算，因而 Runtime Key 是账务隔离的直接边界。一个 Runtime 可服务多个 AI员工，因此仅依据 Key 无法精确分摊到员工。本地模式沿用既有费用和用量语义，不纳入本节的 models 对账设计。

AgentSpace 在每次模型调用中附带或记录以下关联字段：

- `tenantId`、`teamId`、`runtimeId`、`runtimeCredentialId`；
- `employeeId`、`conversationId`、`requestId`；
- 协议、模型、输入 / 输出 / 缓存 Token、调用开始与结束时间；
- 网关返回的用量记录 ID 或可对账关联 ID。

模型网关的用量记录是实际账务事实；AgentSpace 使用员工关联字段呈现 AI员工成本。若价格、缓存计费、异步任务或网关聚合使逐请求金额无法直接获得，员工成本必须标记为“估算”，并在对账后更新为“已对账”。

### 7.2 费用展示

服务器模式建议提供四个层级：

1. 租户 / 团队余额与账单总额；
2. Runtime Key 的实际消耗；
3. Runtime 的聚合消耗；
4. AI员工、会话和模型维度的归因消耗。

服务器模式界面必须区分“models 实际扣费”“估算归因”“待对账”，避免将估算误表示为结算金额。本地模式维持原有展示，不追加本节状态或文案。

## 8. 审计与合规

以下事件需要不可篡改或可追溯的审计记录：

- 服务器 Runtime 的创建、复用、停止、删除、迁移；
- 服务器 Runtime Key 的创建、读取、挂载、轮换、撤销、失效；
- Runtime、AI员工和会话的模型变更；
- 模型调用关联、用量同步、对账修正；
- 余额不足、策略拒绝、模型不可用与凭据异常；
- Owner、Admin、平台运维及自动任务的操作身份。

审计日志中只记录 Key 指纹、引用和脱敏配置；不得写入 API Key、Authorization 头或完整敏感提示词。

## 9. 已排除的方案

| 方案 | 排除原因 |
| --- | --- |
| 在服务器模式复用用户机器上的 Claude Code / Codex Provider 配置 | 无法稳定获得团队级账单、合规隔离与可审计性；本地模式保留既有路径，属于不同边界。 |
| 每个 AI员工一个容器 | 隔离更强，但成本、调度和运维复杂度过高，不适合作为默认模型。 |
| 仅按 Runtime Key 统计 AI员工费用 | 共享 Runtime 时无法准确归因，缺少员工、会话关联维度。 |
| 将 `/model` 写入 Runtime 全局配置 | 会造成同一 Runtime 下不同 AI员工 / 会话相互影响。 |

## 10. 验收标准

1. `DOFE_AGENT_RUNTIME_MODE` 未设置或为 `local` 时，既有本地 Runtime 和 Provider 调用行为保持不变，不调用本设计新增的 models 管理接口或受管安装流程。
2. `DOFE_AGENT_RUNTIME_MODE=remote` 的 Runtime 无法绕过 AgentSpace 手工部署；其创建页面始终可查看异步任务阶段、失败原因和重试入口。
3. 每个服务器 Runtime 仅加载自己的模型凭据；不同团队不能读取、复用或计费到对方的 Key。
4. 服务器模式模型目录按 Runtime 协议和 Key 权限过滤；本地模式目录只来自实际本地服务。
5. 会话 `/model` 覆盖不会影响其他会话。
6. 模型网关账单可按租户、团队、Runtime Key 对账；AgentSpace 可按 AI员工、会话、模型展示归因。本地模式不会将本地费用标为 models 账单。
7. 所有模式、凭据与模型变更可审计，且不存在明文 Key 泄漏到数据库、日志或前端。
8. 团队角色仅为 Owner、Admin、Member；Owner/Admin 均能管理团队、财务/运营和全部 AI员工，Member 不可操作 AI员工，且仅 Owner 可转移 team/tenant 所有权。
9. 超管可跨 tenant/team 执行平台运维，但不出现在团队成员、转移、分配或负责人选择结果中。
