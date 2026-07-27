# 面向受管 Runtime 的 models.dofe.ai 契约优化

状态：**已实施（Phase 1）**。本文描述为了支持 AgentSpace 受管 Runtime，在 `../models.dofe.ai` 中补齐的内部服务能力与数据契约。实现代码见 [models.dofe.ai 仓库](https://github.com/dofe-ai/models.dofe.ai) 的 `apps/api/libs/domain/runtime-credential/`、`apps/api/src/modules/internal-api/`、`packages/contracts/src/schemas/runtime-credential.schema.ts` 与 `packages/models-sdk/src/internal.ts`。

## 1. 当前能力与不足

`models.dofe.ai` 已具备下列可复用能力：

- API Key 与租户、团队的关联；
- 按 Key、团队策略与协议过滤的 `/v1/models`；
- OpenAI、Anthropic、Gemini 协议入口；
- 余额、用量日志、账单统计与供应商路由；
- `models-sdk` 的内部模型、员工 Key、余额、用量查询能力。

现有 `employeeKeys` 面向 AI员工身份，创建参数主要是 `employeeId`、`ssoTeamId` 与名称。受管 Runtime 需要明确的 `runtimeId`、协议、生命周期和凭据状态，因此不应把 Runtime Key 隐式伪装成员工 Key。

## 2. 新增领域对象

建议引入 `RuntimeCredential`，由模型服务拥有并签发：

| 字段 | 说明 |
| --- | --- |
| `id` | Runtime 凭据稳定标识。 |
| `tenantId` | 账单与隔离主体。 |
| `teamId` | 团队隔离主体。 |
| `runtimeId` | AgentSpace Runtime 的外部引用。 |
| `runtimeType` | 例如 `claude-code`、`codex`、`openclaw`。 |
| `protocols` | 允许的协议集合，如 `openai`、`anthropic`、`gemini`。 |
| `allowedModels` | 可调用模型白名单；空时遵循团队策略。 |
| `defaultModel` | Runtime 默认模型建议值。 |
| `status` | `active`、`rotating`、`revoked`、`expired`。 |
| `keyFingerprint` | 用于审计和排障，不泄露明文。 |
| `expiresAt` | 可选到期时间。 |
| `rotationVersion` | 原子轮换版本。 |
| `metadata` | 非敏感来源、创建任务等关联信息。 |

明文 Key 只在创建或轮换响应中返回一次，之后不可再次读取。

## 3. 建议的内部 API

以下接口仅面向经过服务间认证的 AgentSpace 控制面；不得直接暴露给浏览器或 Runtime 容器。

### 3.1 创建 Runtime 凭据

`POST /internal/runtime-credentials`

- ts-rest 契约：`packages/contracts/src/api/internal.contract.ts` 中的 `runtimeCredentials.create`
- Zod schema：`packages/contracts/src/schemas/runtime-credential.schema.ts` — `CreateRuntimeCredentialRequestSchema`、`CreateRuntimeCredentialResponseSchema`
- 实现：`apps/api/libs/domain/runtime-credential/runtime-credential.service.ts` 的 `ensure`
- models-sdk：`packages/models-sdk/src/internal-types.ts` — `ModelsInternalCreateRuntimeCredentialRequest`、`ModelsInternalRuntimeCredentialSecret`、`ModelsInternalCreateRuntimeCredentialResponse`

请求：

```json
{
  "tenantId": "tenant_123",
  "teamId": "team_123",
  "runtimeId": "runtime_123",
  "runtimeType": "claude-code",
  "protocols": ["anthropic"],
  "allowedModels": ["claude-sonnet"],
  "defaultModel": "claude-sonnet",
  "idempotencyKey": "runtime_123:create:v1",
  "audit": {
    "actorId": "user_123",
    "taskId": "runtime_task_123"
  }
}
```

响应：

```json
{
  "credential": {
    "id": "rtc_123",
    "tenantId": "tenant_123",
    "teamId": "team_123",
    "runtimeId": "runtime_123",
    "status": "active",
    "keyFingerprint": "sha256:...",
    "rotationVersion": 1,
    "expiresAt": null
  },
  "secret": {
    "apiKey": "仅本次返回的明文 Key"
  },
  "secretIssued": true
}
```

`secret` 只会在首次成功创建或首次成功轮换时返回，且此时 `secretIssued` 为
`true`。同一作用域内的幂等重放只返回 `credential` 与
`secretIssued: false`，不重新返回或解密旧 Key；AgentSpace 必须在首次响应时将
明文写入 `secretRef`，而不能依赖重试恢复明文。

`idempotencyKey` 为创建、轮换和撤销请求的必填字段。模型服务只持久化其按操作、
租户、团队和 Runtime 作用域计算的哈希，不能记录原始值。

### 3.2 查询 Runtime 可用模型

`GET /internal/runtime-credentials/:id/models?tenantId=...&teamId=...&protocol=anthropic`

- ts-rest 契约：`packages/contracts/src/api/internal.contract.ts` 中的 `runtimeCredentials.models`
- Zod schema：`packages/contracts/src/schemas/runtime-credential.schema.ts` — `RuntimeCredentialModelsQuerySchema`、`RuntimeCredentialModelsResponseSchema`
- 实现：`apps/api/src/modules/internal-api/internal-api.service.ts` 的 `getRuntimeCredentialModels`
- models-sdk：`packages/models-sdk/src/internal-types.ts` — `ModelsInternalRuntimeCredentialModelsQuery`、`ModelsInternalRuntimeCredentialModelsResponse`

读取状态、查询模型、轮换和撤销均必须携带目标凭据的 `tenantId` 与 `teamId`。模型
服务以 `id + tenantId + teamId` 查找凭据；不匹配时返回与不存在相同的 404，避免跨团队
枚举。AgentSpace 仍须在调用前按当前操作者的团队权限完成授权，模型服务不信任 Runtime
数据面请求来决定控制面权限。

返回结果必须同时应用：租户 / 团队权限、Key 白名单、模型可用性、协议兼容性、供应商可用性及余额 / 风控策略。AgentSpace 不应在本地复制过滤逻辑。
凭据为 `revoked`、`expired`，或其 `rotating` 宽限期已结束时，该接口返回空目录；这与
网关拒绝实际调用的行为保持一致。

### 3.3 轮换凭据

`POST /internal/runtime-credentials/:id/rotate`

- ts-rest 契约：`packages/contracts/src/api/internal.contract.ts` 中的 `runtimeCredentials.rotate`
- Zod schema：`packages/contracts/src/schemas/runtime-credential.schema.ts` — `RotateRuntimeCredentialRequestSchema`
- 实现：`apps/api/libs/domain/runtime-credential/runtime-credential.service.ts` 的 `rotate`
- models-sdk：`packages/models-sdk/src/internal-types.ts` — `ModelsInternalRotateRuntimeCredentialRequest`

请求必须包含 `tenantId`、`teamId`、幂等键和轮换原因，例如 `expired`、`compromised`、`manual`、`gateway-rejected`。首次成功轮换响应返回新的明文 Key、`secretIssued: true` 和新的 `rotationVersion`；同一幂等键的重放只返回安全元数据与 `secretIssued: false`。旧 Key 的宽限期应由模型服务统一管理，宽限期结束时标记为 `expired` 并记录 `revokedAt`。

### 3.4 撤销凭据

`POST /internal/runtime-credentials/:id/revoke`

- ts-rest 契约：`packages/contracts/src/api/internal.contract.ts` 中的 `runtimeCredentials.revoke`
- Zod schema：`packages/contracts/src/schemas/runtime-credential.schema.ts` — `RevokeRuntimeCredentialRequestSchema`
- 实现：`apps/api/libs/domain/runtime-credential/runtime-credential.service.ts` 的 `revoke`
- models-sdk：`packages/models-sdk/src/internal-types.ts` — `ModelsInternalRevokeRuntimeCredentialRequest`

撤销请求必须包含 `tenantId`、`teamId` 和幂等键，例如 `runtime_123:revoke:v1`；同一凭据已处于 `revoked` 状态时重放不得重复修改底层 Key。撤销后网关必须拒绝该 Key；AgentSpace 负责停止或隔离引用该凭据的 Runtime，并同步展示不可用状态。

### 3.5 查询凭据状态

`GET /internal/runtime-credentials/:id`

- ts-rest 契约：`packages/contracts/src/api/internal.contract.ts` 中的 `runtimeCredentials.get`
- Zod schema：`packages/contracts/src/schemas/runtime-credential.schema.ts` — `RuntimeCredentialResponseSchema`
- 实现：`apps/api/libs/domain/runtime-credential/runtime-credential.service.ts` 的 `getStatus`
- models-sdk：`packages/models-sdk/src/internal-types.ts` — `ModelsInternalRuntimeCredential`

请求通过 `tenantId`、`teamId` 作用域后仅返回安全元数据，不返回 API Key。用于 AgentSpace 恢复任务、节点健康检查和审计展示。

## 4. 用量关联与对账契约

模型网关应接受或生成以下可检索的关联字段：

```json
{
  "runtimeCredentialId": "rtc_123",
  "runtimeId": "runtime_123",
  "employeeId": "employee_123",
  "conversationId": "conversation_123",
  "requestId": "request_123"
}
```

其中 `runtimeCredentialId` 可以由 Key 映射获得。运行时传递 `employeeId`、`conversationId` 时，必须使用 Runtime Key 对以下 UTF-8 内容计算 `HMAC-SHA256`：

```text
runtimeCredentialId + "\n" + runtimeId + "\n" + employeeId + "\n" + conversationId + "\n" + unixTimestampSeconds
```

请求头为 `x-dofe-employee-id`、`x-dofe-conversation-id`、`x-dofe-attribution-timestamp` 和 `x-dofe-attribution-signature`。ID 仅接受 128 字符以内的字母、数字、`.`、`_`、`:`、`-`；时间戳有效期为五分钟。缺少归因字段不影响正常调用；若已提供但签名、格式或时效校验失败，模型服务仍按该 Runtime Key 计费，但不得写入 `employeeId` 或 `conversationId`，并记录安全告警。`requestId` 由网关生成或从受信任的 AgentSpace 服务链路传入，不能把任意 Runtime 请求头当作账务归因事实。

当前实现：

- 代理入口在 API Key 校验后，若 `keyOwnerType === 'runtime'`，调用 `RuntimeCredentialDomainService.findByApiKeyId` 反查凭据。
- 状态非 `active/rotating`、轮换宽限期已过期、或请求协议不在 `credential.protocols` 内时直接返回 401；过期 rotating 凭据会被自动标记为 `expired` 并撤销底层 Key。
- 归因字段仅在上述签名通过后从请求头提取，与 `runtimeCredentialId`、`runtimeId` 一起写入 `GatewayUsageLog`；签名失败会被拒绝归因而不会污染 AI员工账单。
- 实现位置：`apps/api/libs/domain/proxy-core/proxy-core.service.ts`（Runtime 校验与 `logUsage`）与 `apps/api/libs/domain/proxy-core/runtime-attribution.helper.ts`（签名与时效验证）。

建议增加以下查询能力：

| 接口 / 事件 | 用途 | 实现 |
| --- | --- | --- |
| `GET /internal/usage?runtimeCredentialId=...` | Runtime Key 实际消耗。 | `internal.contract.ts` 已扩展 `InternalTenantUsageQuerySchema` 与 `InternalDateRangeQuerySchema`，支持 `runtimeCredentialId`、`runtimeId`、`employeeId`、`conversationId` 过滤。 |
| `GET /internal/usage?employeeId=...` | AI员工归因用量与金额。 | 同上。 |
| `GET /internal/usage?conversationId=...` | 会话级排障与归因。 | 同上。 |
| 用量 Webhook / 事件流 | 近实时更新 AgentSpace 成本视图。 | 本期未实现，保留扩展点。 |
| 对账快照 | 用于修正本地估算与不可变账单事实对齐。 | 本期未实现，保留扩展点。 |

每条返回记录应至少包含模型、协议、输入 / 输出 / 缓存 Token、实际金额、币种、计费状态、请求时间、网关用量 ID 及关联字段。若金额尚未最终结算，应显式标记 `estimated` 或 `pending_reconciliation`。

## 5. 安全与治理要求

1. 使用服务间身份认证、租户 / 团队作用域、最小权限和审计，而不是将管理端 API Key 下发到 AgentSpace 节点。当前通过 `InternalAuthGuard` + `MODELS_RUNTIME_CREDENTIAL_SERVICE_NAMES` 限制可调用服务名；凭据 ID 的控制面读取和变更必须同时匹配 `tenantId`、`teamId`。
2. 创建、轮换、撤销接口必须支持幂等键，防止安装任务重试生成重复 Key。
3. 单个 `runtimeId` 的活跃凭据数量需要策略约束；默认允许一个当前 Key 和一个轮换宽限 Key。
4. 模型服务应记录调用方服务身份、操作者、关联任务 ID、原因与 Key 指纹。内部认证提供调用服务身份；`create`、`rotate`、`revoke` 请求可选传递受 AgentSpace 控制面验证后的 `audit.actorId`、`audit.taskId`，模型服务将其写入凭据元数据和结构化日志，不能以 Runtime 数据面请求头作为审计主体。
5. 轮换、撤销、余额不足、模型禁用等状态变化应允许 AgentSpace 订阅或主动拉取。
6. 禁止在内部 API 响应日志、异常堆栈、分析事件中记录明文 Key。
7. 访问控制环境变量：`MODELS_RUNTIME_CREDENTIAL_MANAGEMENT=true` 开启管理 API；`MODELS_RUNTIME_CREDENTIAL_SERVICE_NAMES=agents-dofe-ai` 限定调用方服务名。

## 6. 迁移路径

1. 在模型服务中建立 `RuntimeCredential` 模型与内部接口，不修改现有用户 API Key 语义。
2. 扩展 `models-sdk`，增加类型安全的 Runtime Credential 客户端。
3. AgentSpace 先在新建受管 Runtime 上启用新契约；已有本地 Provider 保持只读兼容，标记为待迁移。
4. 为既有受管 Runtime 补发 Runtime Key，并将旧 `providerAccountId` 引用迁移到 `runtimeCredentialId`、`secretRef`、`configRef`。
5. 通过双写或对账任务验证 Runtime Key 用量与 AgentSpace 归因数据一致后，再逐步停用旧凭据路径。

## 7. 验收标准

1. AgentSpace 可以按幂等请求创建、轮换、撤销 Runtime 凭据。
2. 明文 Key 不会出现在 AgentSpace 数据库、浏览器、任务详情或审计日志中。
3. `GET /internal/runtime-credentials/:id/models` 的模型结果与网关实际可调用模型一致。
4. 模型网关可以按租户、团队、Runtime Key 产出真实账单，并可关联至 AI员工与会话。
5. 失效 Key 的自动恢复只发生一次受控轮换，不会在业务拒绝场景中形成循环。
