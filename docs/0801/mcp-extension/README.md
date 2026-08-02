# MCP Extension 文档索引

本目录定义 Docker Runtime 的 MCP 扩展方案。既有“应用市场”保留为唯一入口，页面内通过“CLI 市场”和“MCP 市场”两个 Tab 切换。

| 文档 | 用途 |
| --- | --- |
| [00-产品文档.md](./00-产品文档.md) | 用户问题、边界、角色、分期与验收目标 |
| [01-产品需求分解.md](./01-产品需求分解.md) | 可排期的 MVP Epic、用户故事、依赖与验收标准 |
| [02-架构设计.md](./02-架构设计.md) | 数据模型、控制面与 Runtime 执行面、接口和安全边界 |
| [03-UIUX设计方案.md](./03-UIUX设计方案.md) | 信息架构、页面规格、状态、交互与可用性验证 |
| [04-运行环境隔离决策.md](./04-运行环境隔离决策.md) | 基于当前 Docker Runtime 的 CLI/MCP 安装边界、取舍与实施决策 |
| [05-实施审查与推进.md](./05-实施审查与推进.md) | 截至 2026-08-03 的实现审查、已推进修复和阻塞项 |

## 产品决策

- “应用市场”包含 `CLI 市场` 与 `MCP 市场` 两个 Tab；CLI Tab 只管理 CLI-Anything Hub 等可执行应用。
- MCP Tab 的产品名称为“MCP 中心”，只管理 MCP Server 的连接、配置、工具授权、验证、健康和审计。
- MVP 支持审核的远程 `streamable_http` MCP；受管服务器安装 MCP 属于后续阶段，不能以任意 shell 命令或任意镜像实现。
- Runtime 仅连接通过验证且处于 `ready` 的 MCP 服务；目录中存在的服务不等于任务可调用能力。

## 当前发布边界（2026-08-03）

当前实现可发布为**“目录配置与远端连通性验证”内测**：

- 目录浏览、连接配置、密钥管理、daemon 远程验证、状态机、工具白名单和基础安全控制已完成。
- `ready` 在界面中显示为“已验证”，**不承诺任务可调用**。
- Claude Runtime 的 task-scoped loopback gateway、一次性凭据 claim（同 attempt 幂等重试）、调用审计文件 outbox（逐调用落盘、event_id 幂等、重启重放、整批校验事务写入）、gateway 在每次工具调用前的连接状态复核、MCP session 与任务 token 强绑定均已实现；被停用或改配的连接会立即停止服务运行中任务，跨任务复用 session 会被拒绝。
- 健康巡检已实现：`scheduleMcpHealthChecksSync` 由 runtime-maintenance 定时创建 `source='health_check'` 的 verify 操作，失败指数退避并置 `degraded`；连接详情页提供“概览/工具/配置/活动”四 Tab（`/market/mcp-connections/:id`）。
- Codex 注入已实现（`--ignore-user-config` + 整表替换 `--config mcp_servers=…`，尽力隔离用户/项目预置 MCP），但**隔离与真实 E2E 未验证**：市场页默认不将 Codex 标记为 MCP 可用，需显式开启 `MCP_CODEX_EXPERIMENTAL_ENABLED=1` 才可选。在指定 CI 环境通过端到端验证前，Codex 不得对外宣称支持 MCP。
- 其他 Provider（openclaw / hermes / opencode 等）未接入；接入方式是在 `packages/daemon/src/agent-router/mcp-gateway.ts` 增加对应 harness 的 builder。

不可变目录 release、Skill 对 MCP catalog release 的版本固定及运行时精确消费、托管 Skill 服务的 fail-closed 出站策略、市场分类筛选、持久审计 outbox、执行主体快照、终态授权清理和主密钥轮换已经落地。托管 Skill 服务的出站控制不等同于 Provider Runtime 二层隔离；完整“任务可调用 MCP”发布仍需等待：真实 Claude CLI 端到端验证、Codex 隔离与端到端验证、Provider Runtime 二层 egress 策略、受管 stdio/OAuth。

2026-08-03 的复审进一步关闭了 Skill Runner 配置泄漏、输出权限竞态、无并发上限、旧版 MCP lock 版本替换、Web 本地路径导入、ZIP 解压前资源消耗、managed-node 缺少 cosign 以及根测试空任务问题。真实 Runner Docker 发布测试已具备环境门禁；Provider 二层 egress 仍以独立代理方案推进，在容器负面验证通过前不改变发布边界。
