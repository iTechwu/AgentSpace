# Codex 连接非 GPT 模型审查

审查日期：2026-07-31；现场复测修订：2026-08-01

> 2026-08-01 修订：模型选择器不应以 `codexReady` 作为可选项门禁。选择器按
> `openai_response` 协议声明、LLM 类型、启用和未废弃过滤；`codexReady` 仅作为
> 验证证据展示。Codex 的外部网关 base URL 是
> `https://model.local.dofe.ai/api/v1`，不能把供应商直连探测结果等同于经 Models
> 网关的端到端结果。详见[现场复测与方案修订](./04-live-retest-and-correction.md)。

## 结论

这不是“Codex 只允许 GPT/DeepSeek”或模型名称导致的问题。Codex CLI 0.145.0 可以使用任意模型标识，只要上游严格返回 OpenAI Responses 流，并以 `response.completed` 结束。

当前故障链是：

1. Codex Runtime 声明自己需要 `openai_response`。
2. 模型目录把通过非流式 `/responses` 探测的模型标记为支持 `openai_response`。
3. DeepSeek 的实际流式响应没有产生 Codex 可接受的 `response.completed`，或者 `/responses` 返回了 Chat Completions 格式。
4. 模型网关只要看到上游 HTTP 流正常 `end`，就把请求、供应商健康度和资源结算记为成功，没有验证 Responses 终态。
5. Codex 认为流未完成并自动重试 5 次，最终显示“模型的流式响应在完成前中断”。

因此，当前所谓 Runtime “白名单”并不是写死的模型列表，而是动态条件：模型必须是启用、未废弃的语言模型，并且模型目录的 `supportedProtocols` 与 Codex Runtime 的 `openai_response` 相交。只有 DeepSeek 时，说明模型服务当时只向该租户发布了 DeepSeek 的 `openai_response` 可用记录；这条记录目前只证明非流式可用，不能证明 Codex 可用。

Codex 默认模型保持为 `gpt-5.6-terra`，但默认值只负责兜底。模型名称不参与白名单判断；模型选择按 `openai_response` 协议声明开放，验证状态不能把选择器清空。真正的执行验收必须通过 Models `/api/v1/responses` 完成流式与工具闭环。

## 实施状态

本地实现、验证、提交和 `dev` 分支推送已完成：

- Models 已具备 Provider/model 路由探测，但 2026-08-01 复测证明非流式基线会误拒绝 Responses-only 端点，不能继续作为 Codex 准入前置门槛。
- `codexReady` 继续保留为可观测验证证据，不作为 AgentSpace 选择器和 Runtime 创建的硬门禁。
- AgentSpace 的 Codex 选择器、Runtime 创建、默认模型修改和员工模型绑定按 `openai_response` 协议交集校验。
- ProxyCore 只把 `response.completed` 且 `response.status=completed` 视为成功；Chat chunks、`[DONE]`-only、malformed、failed、incomplete 与无终态 EOF 均失败。
- Responses 验证失败只撤销 Codex/Responses 准入，不关闭同一模型的 Chat 路由。
- Provider endpoint 变更会立即把既有 Responses 验证置为 `needs_validation`。

## 文档

- [根因与证据](./01-root-cause-and-evidence.md)
- [解决方案设计](./02-solution-design.md)
- [实施与验收](./03-implementation-and-acceptance.md)
- [现场复测与方案修订](./04-live-retest-and-correction.md)
- [本地可控复现器](./repro-responses-stream.mjs)

本次已完成本地业务代码实施、相关验证以及两个仓库的提交和推送。按照当前机器的发布约束，本机不使用 Jenkins 部署 `models.dofe.ai` 或 `AgentSpace`，本次也未执行任何部署操作。
