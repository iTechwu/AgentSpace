# AgentSpace MCP 独立化（0826）

本目录记录将 MCP 从 AgentRouter/runtime gateway 执行链中解耦，使 MCP 拥有独立联网能力的架构、产品和实施方案。

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [01-架构方案与解耦契约.md](./01-架构方案与解耦契约.md) | Proposed | 目标拓扑、模块边界、ToolSurface/Connector API、安全和迁移决策 |
| [02-产品优化方案.md](./02-产品优化方案.md) | Proposed | 用户问题、旅程、信息架构、连接向导、任务体验、研究与指标 |
| [03-实施方案与验收矩阵.md](./03-实施方案与验收矩阵.md) | Proposed | W0-W6 路线、代码改动、数据迁移、测试、发布门禁和回滚 |
| [04-W0依赖图与影响半径记录.md](./04-W0依赖图与影响半径记录.md) | Baseline recorded | 五个耦合证据文件的依赖边、影响半径、测试锚点和工具边界 |

## 核心结论

- MCP 服务是独立数据面：默认按原生镜像在可出站 Docker bridge 中运行；MCP Connector 作为需要 secret 隔离、统一会话或额外审计时的可选独立进程/容器。
- AgentRouter 只处理 harness 生命周期和通用 ToolSurface，不再携带 `mcpGatewayUrl`、MCP lease 或 catalog 类型。
- Control Plane 继续治理目录、连接、审批、租约、策略、审计和计费；不直接执行 MCP 网络请求。
- 独立联网不代表绕过安全策略：Connector 仍必须执行 host/TLS/私网/速率/租约 policy，可选择独立 egress proxy。
- Docker 部署下默认采用开放出站网络，第三方 MCP 按原生镜像即可接入；严格 egress 作为按连接启用的可选 profile，避免为接入 MCP 修改项目代码。
- 迁移采用 direct MCP 默认 → Connector 可选 → legacy gateway 兼容回滚的顺序，可按 workspace/runtime 回滚。

## 当前实施状态（2026-08-27）

- 已落地 `apps/mcp-connector` 独立服务：健康检查、任务会话、工具发现/调用/关闭、认证、endpoint 校验、超时和响应限制。
- 已落地 `packages/domain/src/tool-surface.ts` 与 daemon `McpConnectorClient`，AgentRouter 请求新增通用 ToolSurface 上下文；旧 `mcpGatewayUrl` 保留为回滚兼容字段。
- 已提供 `deploy/mcp-connector/Dockerfile` 与仅包含 Connector 的 Compose 配置；未添加 PostgreSQL、Redis 或 RabbitMQ 服务。
- 已验证：Connector types/build/tests、daemon ToolSurface 与 legacy gateway tests、Runtime 能力面板测试、Web typecheck、Connector/Web 本地 HTTP 与浏览器页面加载。
- 已完善：direct MCP endpoint 凭据校验、Connector 工具审批 fail-closed、restricted host allow-list（`MCP_CONNECTOR_ALLOWED_HOSTS`）及 `network_denied`/`network_policy_missing` 错误码映射；当前 Connector 测试覆盖 6 个场景。
- W0 基线已补齐：依赖图与影响半径见 [04-W0依赖图与影响半径记录.md](./04-W0依赖图与影响半径记录.md)；当前会话未配置 code-review-graph MCP，记录明确标注了扫描证据边界。仍待真实 MCP E2E、Connector UI 健康数据接线、legacy gateway 删除。Docker 镜像构建因本机 Docker Desktop 无 Docker Hub HTTPS 代理而未完成；Chrome DevTools MCP 未配置，浏览器验证使用隔离 Playwright 等价流程。

## 现状依据

当前代码中的 `task-execution.ts`、`agent-router/types.ts`、`agent-router/mcp-gateway.ts`、`mcp/client.ts` 和 `mcp/egress-client.ts` 是本方案的主要耦合证据。W0 的可复现依赖图与影响半径已记录在 [04-W0依赖图与影响半径记录.md](./04-W0依赖图与影响半径记录.md)；正式 `code-review-graph` MCP 节点/边评分仍待在具备该工具的会话中补充校验。
