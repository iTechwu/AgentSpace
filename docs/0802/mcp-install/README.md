# MCP 安装与治理大型工程设计

> 日期：2026-08-02
>
> 状态：Proposed
>
> 适用范围：AgentSpace MCP 中心、受管 Runtime、受管 node 与控制面

本目录承接 `docs/0801/mcp-extension` 已落地的远程 `streamable_http`、任务级 loopback gateway、工具白名单、连接复核和调用审计，设计其余四项需要独立立项的大型工程。

| 文档 | 工程 | 主要结论 |
| --- | --- | --- |
| [00-总体架构与边界.md](./00-总体架构与边界.md) | 总体方案 | 四条工作流独立交付，通过 release、policy 与 lease 契约集成 |
| [01-二层-egress-出口代理.md](./01-二层-egress-出口代理.md) | 二层 egress | 应用层校验之外增加网络默认拒绝和带短期租约的 L7 出口代理 |
| [02-MCP-目录不可变-release-version.md](./02-MCP-目录不可变-release-version.md) | 不可变目录 | 稳定 package 与不可变 release 分离，连接固定引用 release digest |
| [03-市场分类与筛选模型.md](./03-市场分类与筛选模型.md) | 分类筛选 | 分类是受治理的 package 元数据；风险、传输、状态仍是独立 facet |
| [04-受管-stdio-MCP.md](./04-受管-stdio-MCP.md) | 受管 stdio | 第三方进程只在隔离 worker 中运行，由 broker 转换为内部 HTTP MCP |
| [05-OAuth-授权与凭据代理.md](./05-OAuth-授权与凭据代理.md) | OAuth 代理 | 控制面管理授权，凭据不进入 Provider；节点代理按短期 lease 注入令牌 |
| [06-实施路线与验收.md](./06-实施路线与验收.md) | 推进计划 | 数据迁移、分期、发布门禁、测试矩阵与工程拆分 |

## 决策摘要

1. “二层 egress”指第二道基础设施强制边界，不指用 OSI Layer 2 做域名过滤。域名策略由 L7 proxy 执行，网络层保证 Runtime 只能到达 proxy 和必要控制面。
2. `slug` 标识 MCP package；`version + manifest_digest` 标识不可变 release。已经发布的 release 不允许更新或删除，只允许 deprecated/yanked。
3. 连接、任务快照、审计和回滚都引用 release ID 与 digest，不引用“当前最新版”。升级是显式操作。
4. 分类不进入 release digest。分类变化只影响发现和筛选，不改变已安装连接的执行政策。
5. `stdio` 不在 Provider Runtime 或宿主机安装。受管 worker 固定镜像 digest、只读根文件系统、无 Docker socket、私有网络、最小资源和专属状态卷。
6. OAuth refresh token 只在控制面凭据库中保存；Provider 永远拿不到 refresh/access token。节点侧代理使用一次性 lease 获取并注入短期凭据。
7. 本项目的 Dockerfile 和 Compose 不创建 PostgreSQL、Redis 或 RabbitMQ；这些依赖继续使用 `../docker-helm.dofe.ai` 管理的外部服务。

## 与现有文档的关系

- `docs/0801/mcp-extension/02-架构设计.md` 是当前 MCP 中心基线。
- `docs/0801/mcp-extension/04-运行环境隔离决策.md` 已决定 stdio 必须从 Runtime 与宿主机隔离。
- `docs/0801/mcp-extension/05-实施审查与推进.md` 已列出本目录四项缺口。
- 本目录不推翻现有 gateway，而是补齐其网络、供应链、发现和授权边界。
