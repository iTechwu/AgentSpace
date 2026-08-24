# AgentSpace 全项目优化建议

> 扫描日期：2026-08-21
>
> 扫描基线：`dev` / `de3a907a`
>
> 目标：保持本机原生开发体验，同时为后续 CI 机器构建、发布 Docker 镜像建立可靠基线。

## 结论

项目当前可以完成生产构建，类型检查也通过；认证隔离、运行时出口控制、数据库迁移守卫和环境变量审计已有较好基础。但它还不适合直接切换为“CI 构建镜像后自动部署”，首要原因不是业务功能，而是发布门、运行时版本和镜像交付方式尚未闭环。

优先处理以下五项：

1. **恢复质量门**：`verify-test-inventory` 已漂移，Web lint 有 504 个错误。当前 build 会忽略 lint 失败并正常生成产物。
2. **迁移出 Node 25**（✅ 已完成）：本机、所有 workspace 和主要运行镜像原锁定 Node 25.9.0；Node 官方已将 25 标记为 EOL。已迁移到 Node 24.19.0（Latest LTS）并通过兼容矩阵验证，见 [04-Wave1-Node24迁移.md](./04-Wave1-Node24迁移.md)。
3. **改为不可变 Docker 交付**：现有生产 workflow 在部署机原地 `git reset`、安装依赖和构建，既不是 Docker 发布，也不能保证“构建一次、原样晋级、按 digest 回滚”。
4. **消除大对象同步阻塞**：workspace blob 路由可把 512 MiB 请求整体读入内存，并调用同步 `curl`；这在内存受限容器中容易阻塞 Node 事件循环或 OOM。
5. **修复生产依赖 high 漏洞**：官方 npm audit 发现 `prisma -> @prisma/config -> deepmerge-ts` 的 high 漏洞。Prisma CLI 当前被放在生产依赖中，扩大了每个消费者的镜像与攻击面。

## 文档导航

- [01-全项目扫描与优化建议.md](./01-全项目扫描与优化建议.md)：范围、证据、P0-P2 建议及逐项验收标准。
- [02-CI-Docker迁移路线.md](./02-CI-Docker迁移路线.md)：从本机原生环境迁移到 CI 构建 Docker 的推荐拓扑、流水线、镜像策略和实施顺序。
- [03-Wave0-验收记录.md](./03-Wave0-验收记录.md)：Wave 0 已完成改动的逐项验收证据、未完成项与阻塞说明。
- [04-Wave1-Node24迁移.md](./04-Wave1-Node24迁移.md)：P0-02 Node 24 LTS 迁移的决策、改动清单与兼容矩阵验收。
- [05-Wave1-P1-01-P1-06-CI.md](./05-Wave1-P1-01-P1-06-CI.md)：P1-06 readiness 分离、P1-01 统一 .dockerignore 与 Web standalone、CI verify workflow（不部署）。
- [06-GEO-MCP-浏览器验收记录.md](./06-GEO-MCP-浏览器验收记录.md)：GEO 管理 AI 员工创建、Docker GEOFlow MCP 七工具业务闭环、无需人工 ID 的历史夹具安全回收、models embedding、审计和桌面/移动端验收证据。

## 建议实施顺序

| 阶段 | 时间建议 | 目标 | 退出条件 |
| --- | --- | --- | --- |
| Wave 0 | 1-2 天 | 修复测试清单、lint、依赖漏洞 | `pretest`、typecheck、lint、受限并发测试全部通过（✅ 已完成，见 [03-Wave0-验收记录.md](./03-Wave0-验收记录.md)） |
| Wave 1 | 3-5 天 | Node LTS、CI 验证流水线、镜像不可变规则 | CI 产出 commit SHA + digest + SBOM，尚不自动部署 |
| Wave 2 | 1-2 周 | 最小生产镜像、流式 I/O、readiness、安全基线 | Web/Worker/Daemon 镜像通过容器级集成测试和资源压测 |
| Wave 3 | 持续推进 | DB 异步切流、循环依赖、前端预算、可观测性 | 关键 SLO 有基线、阈值、告警和回归门 |

## 不应做的事

- 不在本仓库的 Dockerfile、Compose 或 CI 中创建 PostgreSQL、Redis、RabbitMQ；它们继续由 `../docker-helm.dofe.ai` 统一管理。
- 不在本机启动或触发 Jenkins。本次仅提供 CI 侧方案，没有执行部署。
- 不用 `latest` 作为可发布产物的唯一身份，不在部署机重新构建回滚版本。
- 不在没有基准数据时盲目添加缓存或 `memo`。先建立延迟、内存、镜像和 bundle 基线。

## 扫描说明

项目规则要求优先使用 `code-review-graph`，但本会话未提供对应 MCP 工具。本次采用 Repomix 全仓压缩索引、Madge 依赖图、定向源码检查以及实际 typecheck/lint/build/audit/Compose 校验作为降级方案。没有访问生产数据，也没有使用测试管理员账户。
