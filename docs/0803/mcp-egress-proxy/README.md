# MCP Egress Proxy：Docker Compose 实施方案

> 状态：Proposed
>
> 范围：AgentSpace 当前 monorepo、Docker Compose 受管 Runtime 和远程 MCP Server。

本目录将 MCP egress 方案收敛为 Docker Compose 部署，不以 Kubernetes 为实施前提。代理在当前仓库中作为独立 app、独立镜像和独立 Compose service 运行；不新建仓库，不成为通用互联网代理。

| 文档 | 内容 |
| --- | --- |
| [00-架构决策.md](./00-架构决策.md) | 为什么新增专用 proxy，以及仓库、镜像和权限边界 |
| [01-Docker-Compose-网络拓扑.md](./01-Docker-Compose-网络拓扑.md) | Compose 双网络、远程控制面/本地一体化两种部署形态 |
| [02-代理协议与安全边界.md](./02-代理协议与安全边界.md) | lease、policy、DNS/TLS、OAuth 注入和 Provider 隔离 |
| [03-实施计划与验收.md](./03-实施计划与验收.md) | 代码拆分、分期、Compose 验证和发布门禁 |

## 最终决策

1. 新增一个每台受管主机一组的 `mcp-egress-proxy` service，而非每个 Runtime/MCP 各一个 proxy。
2. proxy 是当前 monorepo 的独立 app；它单独构建镜像、发布版本、健康检查和扩缩容，但不直接读取应用数据库。
3. Runtime 的 MCP 调用必须是 `Provider -> loopback gateway -> daemon -> mcp-egress-proxy -> remote MCP`。Provider 不获得 endpoint、proxy lease 或 OAuth token。
4. 对远程控制面部署，Compose 自定义网络必须配合宿主机 `DOCKER-USER` 规则实现默认拒绝；单靠 Compose network 名称、label 或 `HTTP_PROXY` 不足以阻止旁路。
5. Dockerfile/Compose 不创建 PostgreSQL、Redis、RabbitMQ；所有此类依赖继续连接 `../docker-helm.dofe.ai` 管理的外部基础设施。

`docs/0802/mcp-install/01-二层-egress-出口代理.md` 保留通用安全与协议设计；本目录是其 Docker Compose 具体化版本，并以本目录为后续实施基线。
