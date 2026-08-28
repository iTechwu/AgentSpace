# 解决方案设计

## 0. 2026-08-01 现场复测修订

本页原设计把 `codexReady` 同时用于“是否可选”和“是否已验证”。现场复测证明这会
把 149 个声明 `openai_response` 的模型全部置灰，因此修订为两个独立维度：

- 选择资格：LLM、启用、未废弃，并声明 `openai_response`。
- 验证证据：经 Models 网关完成 Responses 流式终态和工具闭环；用于状态展示、告警和路由质量，不用于清空选择器。

Codex Runtime 的外部 base URL 是 `https://model.local.dofe.ai/api/v1`；容器内受信任
调用可使用 `http://dofe-models-api:3101/internal/v1`。管理 API
`https://model.local.dofe.ai/api` 和供应商 endpoint 都不是 Codex 的 base URL。

原生 Responses-only 端点可能只实现流式请求。`stream=false` 基线应作为独立诊断项，
不得在真正的流式探测前直接判定 Codex 不可用。

## 1. 目标与原则

模型选择范围是所有声明支持 OpenAI Responses 的语言模型；验证结果与选择资格分离。

准入定义应为：

```text
Codex 可用
= 当前租户存在可用路由
+ 流式 Responses 协议合规
+ 工具调用往返合规
+ 终态、usage、错误语义可识别
```

模型名、供应商名称、是否 GPT 都不应成为硬编码条件。

## 2. P0 止血方案

### 2.1 默认模型

Codex Runtime 默认模型保持为 `gpt-5.6-terra`。当前代码位于：

```ts
// agentspace.dofe.ai/packages/domain/src/daemon-provider.ts
codex: "gpt-5.6-terra"
```

员工默认模型仍应优先于 Runtime/团队默认，但消息页必须显示本次任务最终解析出的模型，而不是旧会话标签或 Runtime 默认文案。

### 2.2 临时准入

在新的流式探测上线前：

- 不再把仅通过 `responses_smoke`（`stream=false`）的模型视为 Codex-ready。
- 已知缺少 `response.completed` 的 DeepSeek 路由应取消 `openai_response` 可用状态或标为 unhealthy。
- DeepSeek 仍可保留 `openai`/Chat Completions 能力，避免影响非 Codex 消费方。
- 模型选择器无可用模型时应明确提示“没有通过 Codex 流式 Responses 验证的模型”，而不是回退到任意模型。

这比按模型名维护 allowlist 更可靠，因为同一个模型在不同供应商、endpoint 或版本下的协议质量可能不同。

## 3. 能力模型升级

现有 `supportedProtocols: ['openai_response']` 粒度过粗。至少需要区分：

```ts
type ResponsesCapabilities = {
  nonStreaming: boolean;
  streaming: boolean;
  tools: boolean;
  usage: boolean;
  verifiedAt: string;
  verificationVersion: string;
};
```

可在现有 availability/verification 数据之上增加派生字段 `codexReady`：

```text
codexReady = route available
  && responses.streaming
  && responses.tools
  && verification fresh
```

`supportedProtocols` 决定 Codex 模型列表与任务启动时的协议兼容性。`codexReady` 是路由验证证据，不能再作为选择器硬门禁。

## 4. 流式 Responses 探测

将探测拆成互不替代的诊断项；Codex 准入探测从流式阶段开始。

### 阶段 A：基础响应

可保留 `stream=false` 探测，验证完整 JSON 响应，但失败只记录
`responses.nonStreaming=false`，不得跳过后续流式探测。

### 阶段 A：流式一致性

发送 `stream=true` 并验证：

1. HTTP 2xx 且 Content-Type 是 SSE。
2. SSE 能跨任意网络 chunk 边界正确解析。
3. 每个 `data:` 事件是合法 JSON；允许注释/心跳。
4. 事件属于 Responses，而不是 `chat.completion.chunk`。
5. 至少产生一个有效 output item 或工具调用。
6. 唯一成功终态是 `response.completed`，且 `response.status=completed`。
7. `response.failed` 和 `response.incomplete` 分别记录为明确失败，不得归为 completed。
8. EOF、超时或 `[DONE]` 到达但没有 `response.completed` 时，结果为 `responses_stream_incomplete`。

验证结果应使用新版本标识，例如 `responses_stream_smoke_v1`，避免旧的非流式验证记录继续被误用。

### 阶段 B：工具调用

Codex 不是纯文本客户端。对拟标记 `codexReady` 的路由，再执行一个低成本工具探测：

- 发送一个确定性 function tool；
- 验证 function call 的 item、参数 delta/done 与完成终态；
- 回传 tool output；
- 验证第二轮能得到最终 `response.completed`。

若供应商不支持工具调用，可保留 `responses.streaming=true`，但 `codexReady=false`。

## 5. 网关流状态机

`ProxyCore` 不应再用 Node stream 的 `end` 代表业务成功。为每次流维护协议相关状态：

```ts
type ResponsesStreamState = {
  format: 'responses' | 'chat' | 'unknown';
  terminal: 'none' | 'completed' | 'failed' | 'incomplete';
  sawDoneSentinel: boolean;
  eventCount: number;
  byteCount: number;
};
```

状态转移规则：

| 输入 | 状态/动作 |
| --- | --- |
| `response.completed` | `terminal=completed` |
| `response.failed` | `terminal=failed` |
| `response.incomplete` | `terminal=incomplete` |
| Chat chunk 出现在 Responses 路由 | 格式冲突，失败 |
| `[DONE]` | 只记录 sentinel，不改变 Responses terminal |
| EOF 且 terminal=none | `responses_stream_incomplete` |
| EOF 且 terminal=completed | 唯一成功路径 |

只有 `terminal=completed` 才能：

- `settle(resourceLease, true, ...)`；
- 上报 health success；
- 记录 attempt success；
- 增加成功请求计数；
- 将响应写入成功缓存。

其他终态或 EOF 必须：

- 以 failure 结算 resource lease；
- 释放或按实际消费规则处理 billing reservation；
- 下调当前“供应商 + endpoint + model + protocol”路由健康度；
- 记录结构化错误码，而不是笼统的 stream close；
- 不把不完整响应写入缓存。

注意：若 2xx 和部分 SSE 已经发送，下游 HTTP 状态已经不能修改。此时网关可以透传真实失败事件并关闭连接，但不能伪造 `response.completed`。为了避免 Codex 对相同坏路由连续调用 6 次，需要配合快速熔断：第一次确认协议不完整后，后续重试在发出 SSE 首字节前以明确的 502/503 拒绝，并切换健康路由（若存在）。

## 6. 两种非 GPT 接入路径

### 路径 A：原生 Responses 透传，推荐

供应商真实支持流式 Responses 及工具调用时，保持现有原生 endpoint 透传。准入由上述探测证明，不根据模型名判断。

优点是语义损失最小，维护成本低。

### 路径 B：Responses Facade 适配器

如果 DeepSeek 上游只有 Chat Completions，应在 `models.dofe.ai` 建立专门的 Responses Facade，而不是把 Chat chunks 直接挂到 `/responses`。

适配器至少负责：

- 把 Responses `input`、system/developer/user items 映射为 Chat messages；
- 把 Responses tools/tool choice 映射为 Chat tools；
- 将文本与 tool-call delta 转换为合法 Responses 事件序列；
- 分配稳定的 response/item/call id；
- 产生 item/content done 事件；
- 最终产生包含 usage 的 `response.completed`；
- 对不能支持的 `previous_response_id`、store、reasoning、include 等字段返回明确 4xx，不能静默丢弃。

适配器必须是有状态、经过契约测试的协议边界。仅改 URL、Content-Type 或最后附加 `response.completed` 不构成可靠适配。

## 7. 可观测性和费用保护

每个 Responses 流记录以下低基数字段：

- request id、provider、endpoint route、model、protocol；
- detected format、terminal event、saw done、bytes、events；
- upstream `end`/`close`/`error`；
- Codex 重试关联 id（若可得）；
- billing reservation 的最终处理结果。

新增指标：

- `responses_stream_completed_total`
- `responses_stream_incomplete_total`
- `responses_protocol_mismatch_total`
- `responses_stream_failed_total`
- `codex_retry_amplification_ratio`

告警应基于 `provider + model + endpoint`，不能只按模型全局熔断。这样一个坏供应商不会错误下线其他健康路由。

## 8. 代码所有权

| 责任 | 仓库 |
| --- | --- |
| Responses 探测、能力记录、路由健康、终态判定、Chat-to-Responses 适配 | `models.dofe.ai` |
| Codex 默认模型、模型选择 UI、任务最终模型展示、用户错误文案 | `agentspace.dofe.ai` |
| Codex Responses 消费规则 | Codex CLI；通过固定版本契约测试锁定 |

Runtime 本地归因代理应继续保持字节透明，避免在两个仓库重复实现协议转换。
