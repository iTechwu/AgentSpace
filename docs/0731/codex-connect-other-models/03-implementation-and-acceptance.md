# 实施与验收

## 0. 当前落地结果

截至 2026-07-31，本地已实现：

1. `responses_stream_smoke` 三阶段探测：非流式基线、强制 function call 流、回传 `function_call_output` 后的最终流。
2. 独立 `responsesVerifiedAt` 时间戳和 24 小时新鲜度门禁；普通健康检查不会延长 Codex 验证有效期。
3. route 级门禁：每个 Provider/model availability 必须独立验证，其他 Provider 的成功不能为该路由背书。
4. endpoint 更新/删除后立即失效该 Provider 的既有 Codex 验证。
5. ProxyCore 严格、不可逆的 Responses 终态机；客户端流在上游 EOF 后先关闭，记账和健康更新在后处理完成。
6. Responses 验证失败只写协议验证失败，不覆盖模型级 Chat 可用性和健康分数。
7. Models 内部列表/详情、SDK、AgentSpace Runtime picker、创建前校验和员工绑定统一消费 `codexReady`。

两个仓库的本地验证、提交和 `dev` 分支推送已经完成。按照当前机器的发布约束，本机不使用 Jenkins 部署 `models.dofe.ai` 或 `AgentSpace`，本次未执行任何部署操作。Chat-only 模型到 Responses 的完整 Facade 仍属于 P2 独立工作，不会被本次原生 Responses 准入伪装为已支持。

## 1. 建议实施顺序

### P0：阻止继续误选和错误记账

1. 在 `models.dofe.ai` 暂停向 Codex 发布仅有 `responses_smoke` 的模型。
2. 对当前 DeepSeek Responses 路由运行流式探测；失败则将该路由的 `openai_response` availability 标为 unhealthy。
3. 保持 Codex 默认模型 `gpt-5.6-terra`。
4. 修改 `ProxyCore`：Responses EOF 未见 `response.completed` 时按失败结算、释放 reservation、下调路由健康度，禁止成功缓存。
5. 对首次协议不完整触发短时 endpoint/model 熔断，避免 Codex 5 次重试都命中同一坏上游。

### P1：建立真实 Codex 准入

1. 新增流式 Responses 探测与版本化 verification method。
2. 新增工具调用探测。
3. 引入 `codexReady` 或等价派生能力。
4. `agentspace.dofe.ai` 的 Runtime 模型查询与任务启动校验改为使用该能力。
5. 模型详情页显示“非流式、流式、工具、Codex-ready”四项结果和最近验证时间。

### P2：支持 Chat-only 的非 GPT 模型

1. 在 `models.dofe.ai` 实现独立 Responses Facade。
2. 先支持文本和 function tools，再逐项声明 reasoning、store、previous response 等能力。
3. 只有 Facade 的契约测试与真实 Codex E2E 都通过后，才发布 `codexReady=true`。

## 2. 建议修改点

### `models.dofe.ai`

| 文件 | 修改 |
| --- | --- |
| `apps/api/libs/infra/clients/openai-responses/openai-responses-probe.client.ts` | 增加 `stream=true` SSE 探测和严格终态校验 |
| `apps/api/libs/domain/provider-key/provider-key.service.ts` | 记录版本化 stream/tools verification，不再用非流式结果推导 Codex-ready |
| `apps/api/libs/domain/proxy-core/streaming-response-parser.service.ts` | 返回协议、精确终态、格式冲突；`[DONE]` 不再代表 Responses completed |
| `apps/api/libs/domain/proxy-core/proxy-core.service.ts` | 使用终态决定结算、健康、缓存和日志；增加协议失败熔断 |
| `apps/api/libs/domain/proxy-core/proxy-core.internal-fallback.spec.ts` | 用合法 SSE 替换当前无效 fixture，并覆盖缺失终态 |
| Prisma availability/verification schema | 增加细粒度能力或版本化 evidence；迁移时保持旧记录默认不具备 Codex-ready |

### `agentspace.dofe.ai`

| 文件 | 修改 |
| --- | --- |
| `packages/services/src/runtime-provisioning/runtime-provisioning.ts` | Codex 模型校验从 protocol 交集升级为 Codex-ready；服务端必须再次校验，不能只靠 UI |
| `apps/web/features/runtimes/runtime-model-picker.tsx` | 只展示已验证模型，或把未验证模型置灰并显示具体能力缺口 |
| `packages/services/src/messages/messages.ts` | 保留当前中断提示，同时按网关错误码区分协议不匹配、终态缺失、上游失败 |
| `packages/domain/src/daemon-provider.ts` | 保持 Codex 默认 `gpt-5.6-terra` 和 `openai_response` Runtime 协议 |

## 3. 必须补充的测试矩阵

### SSE 解析单元测试

| 场景 | 预期 |
| --- | --- |
| `response.completed` 被拆在多个 TCP chunk | completed |
| 多个 SSE event 位于一个 chunk | completed |
| 只有 `[DONE]` | incomplete |
| Chat chunk + `[DONE]` 出现在 Responses 路由 | protocol mismatch |
| `response.failed` | failed，不是 completed |
| `response.incomplete` | incomplete，不是 completed |
| 文本 delta 后 EOF | incomplete |
| malformed JSON 后 EOF | parse/protocol failure |
| 心跳、空行、CRLF | 正常处理，不影响终态 |

### ProxyCore 集成测试

每个用例同时断言下列副作用，不能只断言 HTTP 200：

- 下游实际字节；
- lease settle 的 success 参数；
- billing reservation 是否释放；
- health-score 成功或失败；
- timeline status；
- 缓存是否写入；
- 是否触发备用路由/熔断。

### 探测测试

- 非流式成功、流式失败时，`codexReady=false`。
- 流式文本成功、工具失败时，`codexReady=false`。
- 文本与工具均成功时，`codexReady=true`。
- verification 过期、endpoint 改动、密钥轮换后，必须重新验证。
- 不同 provider key/endpoint 的结果不能互相污染。

### Codex CLI 黑盒 E2E

使用固定版本 Codex CLI 和本目录复现器验证：

- 任意未知模型名 + 合法 `response.completed` 可以完成任务。
- 缺失 `response.completed` 必须失败。
- Chat chunks 不能被误认为 Responses。
- 通过网关的合法流与直接连接复现器行为一致。
- function tool 调用、tool output 回传、最终回答完整完成。

该测试应在 Codex CLI 升级时运行，防止客户端契约变化未被发现。

## 4. 验收标准

### 功能

- Codex 新建 Runtime 的默认模型是 `gpt-5.6-terra`。
- 员工设置默认模型后，新任务的实际执行模型和消息页显示一致。
- DeepSeek 只有在当前路由通过 stream + tools 探测后才可选。
- 合规的非 GPT 模型可以完成文本与工具任务，不再出现 completion 缺失错误。

### 正确性

- Responses 成功率以观察到 `response.completed` 计算，不以 HTTP 200/EOF 计算。
- `[DONE]`-only 流绝不能记为 Responses 成功。
- `response.failed`、`response.incomplete` 和无终态 EOF 均不会写成功缓存或上报健康成功。
- 不完整输出不会被网关伪造成完成。

### 费用与稳定性

- 首次确认某 route 协议不完整后，后续 Codex 重试不会再次调用同一坏上游。
- 一次用户任务的上游调用放大系数可观测；正常目标接近 1。
- 失败请求的 reservation、usage 与供应商真实计费采用明确、一致的策略。

### 可观测性

- 能通过 request id 查到 route、检测格式、终态、EOF 类型、结算结果。
- Dashboard 能区分 HTTP 成功率和 Responses 语义完成率。
- 告警能定位到具体 provider/model/endpoint，而不是只显示“Codex exited 1”。

## 5. 发布门禁

按照仓库测试环境规则执行：

1. 分别在本地验证 `models.dofe.ai` 与 `agentspace.dofe.ai` 改动。
2. 运行最小相关测试；禁止无约束 `pnpm test`。API 单文件 Jest 使用 `--runInBand`。
3. 提交并推送目标分支。
4. 从该提交触发对应 Jenkins 测试环境部署。
5. 持续观察 Jenkins 和部署后服务健康，直到明确成功或失败。

灰度建议先只对测试租户发布 `codexReady` 模型，再开启 10%/50%/100% 路由流量。任一阶段出现 Responses incomplete 或重试放大立即回退该模型路由的 Codex-ready 状态，无需回退其 Chat 能力。

## 6. 本次实施边界

- 已用 Codex CLI 0.145.0 完成本地黑盒复现。
- 已只读检查本地测试环境模型网关日志，未读取或记录密钥。
- 官方 OpenAI 文档站和已安装的文档 MCP 在当前会话中无法访问（HTTP 403/MCP 需重启后加载），所以本报告没有依赖未验证的远程文档表述；最终契约以本地 Codex 黑盒行为为直接证据。
- 已修改并本地验证模型网关与 AgentSpace 业务代码。
- 已将两个仓库的改动提交并推送到各自 `dev` 分支。
- 按照当前机器的发布约束，本机不使用 Jenkins 部署 `models.dofe.ai` 或 `AgentSpace`；本次未执行部署。
