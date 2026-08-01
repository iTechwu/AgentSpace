# 2026-08-01 现场复测与方案修订

## 1. 结论

“没有一个模型可以选择”不是正确的产品行为，但它与当前验证数据一致：数据库中有
149 条 availability 声明 `openai_response`，本轮 149 条全部完成重新探测，24 小时内
`codexReady=true` 为 0。把 `codexReady` 当选择器硬门禁必然得到空列表。

本轮还证明当前探测层级和顺序存在两个问题：

1. 管理页探测直接请求供应商 endpoint，不是从 Codex 经 Models 网关的端到端探测。
2. 探测先执行 `stream=false`，Responses-only 端点在真正流式测试前即可被 400 淘汰。

因此应把“能选择”和“已通过验证”拆开。选择器按协议声明开放；验证状态用于提示、
告警和路由质量。最终验收必须通过 Models `/api/v1/responses`。

## 2. URL 边界

| 用途 | 正确 base URL |
| --- | --- |
| Models 管理/控制面 | `https://model.local.dofe.ai/api` |
| Codex 外部 Responses 数据面 | `https://model.local.dofe.ai/api/v1` |
| 容器内受信任 Responses 数据面 | `http://dofe-models-api:3101/internal/v1` |
| 供应商直连探测 | 各 Provider Key 的 `openai_response` endpoint |

本机 Nginx 会把 `http://model.local.dofe.ai/...` 重定向到 HTTPS。Runtime 凭据中应注入
`OPENAI_BASE_URL=https://model.local.dofe.ai/api/v1`；Codex 0.144+ 还需要通过
`model_providers.<name>.base_url` 和 `wire_api="responses"` 显式配置该 base URL。

Nginx 的 `/api/` 路由会剥离该前缀再转发到 Models API，因此外部
`/api/v1/responses` 对应后端 `/v1/responses`。不要在 Runtime 中配置 HTTP 后依赖
301：流式 `POST` 经过重定向可能改变方法或丢失认证信息。AgentSpace 应把这个已知本地
公有主机统一规范化为 HTTPS。

## 3. 实测结果

复测时间从 `2026-08-01 00:08 +08:00` 开始。数据库迁移
`responses_verified_at` 已应用，Models API/Web 使用当前本地构建运行；未使用 Jenkins。

| Provider Key | 模型数 | 结果 |
| --- | ---: | --- |
| `DeepSeek-wumin` | 1 | HTTP 400 |
| `kimi-techwu` | 4 | HTTP 404 |
| 四个 GLM Key | 32 | HTTP 404 |
| `火山云-yootun` | 13 | 12 个 HTTP 200 但非 completed Responses；1 个 HTTP 403 |
| `ylsagi-kulv` | 6 | HTTP 400，包括 `gpt-5.6-terra` |
| `数据宝-xicai` | 93 | 0 healthy；包含 `response.failed`、`response.incomplete`、缺少 `response.completed`、400/403/404/500/502/503 和超时 |

合计：149 tested，0 healthy，149 unhealthy。

这些结果只证明“当前供应商直连探测没有通过”，不能证明从
`https://model.local.dofe.ai/api/v1/responses` 发起的 Runtime 请求必然失败。

## 4. 根因分层

### 4.1 零可选模型

直接原因是把 `codexReady=false` 映射成不可选择。149 条声明协议的记录在迁移后没有
历史流式证据，重新探测又全部失败，所以列表被完全置灰。

修复：选择资格只依赖 LLM 类型、启用/未废弃、团队策略和
`supportedProtocols` 包含 `openai_response`。`codexReady` 单独显示为验证状态。

### 4.2 Responses-only 假阴性

`OpenAiResponsesProbeClient.probe()` 当前先发送 `stream=false`，只有响应满足
`status=completed` 且 `output` 非空才进入流式探测。任何只实现 Codex 所需流式模式的
端点都会被提前判失败。

修复：流式 function call 和 `function_call_output` 回传是 Codex 主验证路径；
非流式探测独立执行并单独记录，不能短路主验证。

### 4.3 验证层级错误

供应商直连验证可诊断 endpoint 配置，但 Runtime 实际连接 Models 数据面。最终
`codexReady` 证据必须由临时 RuntimeCredential 经 `/api/v1/responses` 产生，并验证：

- SSE Content-Type；
- `response.completed` 且 `response.status=completed`；
- function call id/name/arguments；
- tool output 回传后的第二个完成终态；
- usage 和 request id 可关联。

### 4.4 Runtime 使用 HTTP 入口

现场配置曾把 `MODELS_BASE_URL` 和 `MODELS_GATEWAY_BASE_URL` 都设为
`http://model.local.dofe.ai/api`。控制面客户端已有 HTTPS 升级保护，因此管理功能看似
正常；Runtime 网关解析此前没有同样的保护，生成的 Codex base URL 会是
`http://model.local.dofe.ai/api/v1`。

这会让 Responses 流式 `POST` 先经过 Nginx 301，存在方法变更、认证丢失或客户端拒绝
重定向的风险。AgentSpace 现已在 `resolveModelsGatewayBaseUrl()` 中对该已知公有主机
强制升级 HTTPS，本地 `.env` 也改为显式 HTTPS。其他内部 HTTP 主机仍保持原值。

## 5. 实施要求

1. AgentSpace picker 和创建前校验保持 protocol-only，不以 `codexReady` 禁用模型。
2. Codex 默认模型保持 `gpt-5.6-terra`。
3. Runtime 的 `OPENAI_BASE_URL` 和 Codex `model_provider.base_url` 指向 Models `/api/v1`。
4. Models 探测改为 stream-first；非流式能力独立记录。
5. 增加 Models 网关端到端 probe，供应商直连 probe 只作为次级诊断。
6. UI 同时展示“协议已声明”和“网关验证状态”，不得用笼统 `healthy` 冒充 Codex 验证。
7. 路由执行仍必须严格识别 `response.failed`、`response.incomplete` 和无终态 EOF，不能伪造完成事件。

## 6. 本机边界

本次只进行了本地构建、数据库迁移、管理页触发的真实探测和只读结果审查。没有启动、
安装或触发本地/远程 Jenkins，也没有部署 Models 或 AgentSpace。
