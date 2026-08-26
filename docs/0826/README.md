# AgentSpace MCP 独立化（0826）

本目录记录将 MCP 从 AgentRouter/runtime gateway 执行链中解耦，使 MCP 拥有独立联网能力的架构、产品和实施方案。

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [01-架构方案与解耦契约.md](./01-架构方案与解耦契约.md) | Proposed | 目标拓扑、模块边界、ToolSurface/Connector API、安全和迁移决策 |
| [02-产品优化方案.md](./02-产品优化方案.md) | Proposed | 用户问题、旅程、信息架构、连接向导、任务体验、研究与指标 |
| [03-实施方案与验收矩阵.md](./03-实施方案与验收矩阵.md) | Proposed | W0-W6 路线、代码改动、数据迁移、测试、发布门禁和回滚 |

## 核心结论

- MCP Connector 是独立数据面：拥有独立进程/容器、网络、连接池、协议执行和调用审计。
- AgentRouter 只处理 harness 生命周期和通用 ToolSurface，不再携带 `mcpGatewayUrl`、MCP lease 或 catalog 类型。
- Control Plane 继续治理目录、连接、审批、租约、策略、审计和计费；不直接执行 MCP 网络请求。
- 独立联网不代表绕过安全策略：Connector 仍必须执行 host/TLS/私网/速率/租约 policy，可选择独立 egress proxy。
- 迁移采用 legacy gateway 兼容层 → 双写灰度 → Connector 默认 → 删除 gateway 的顺序，可按 workspace/runtime 回滚。

## 现状依据

当前代码中的 `task-execution.ts`、`agent-router/types.ts`、`agent-router/mcp-gateway.ts`、`mcp/client.ts` 和 `mcp/egress-client.ts` 是本方案的主要耦合证据。当前会话未配置 code-review-graph MCP，因此这些依据来自仓库只读扫描；实施 W0 需补齐正式依赖图和影响半径记录。
