# GEO 管理 AI 员工与 GEOFlow MCP 真实环境验收记录

> 验收日期：2026-08-24
>
> 范围：通过 AgentSpace UI 创建 GEO 管理 AI 员工，连接 `../geoflow.dofe.ai` 的 Docker MCP，并完成企业知识创建、生成、审核和发布。
>
> 浏览器工具说明：当前会话未暴露 Chrome DevTools MCP callable tool，按 `browser-testing-with-devtools` 技能要求使用本机 Chromium/Playwright 等价执行，并采集 console、失败请求、性能、桌面与移动端截图。

## 1. 真实部署拓扑

- AgentSpace Web：本机开发服务 `http://127.0.0.1:1455`。
- AgentSpace Runtime：Docker 管理节点 `dofe-agentspace-yootun-managed-node-managed-node-1`，健康状态为 `healthy`。
- GEOFlow：`geoflow-app-prod`、`geoflow-web-prod`、`geoflow-queue-prod`、`geoflow-scheduler-prod`、`geoflow-reverb-prod` 全部为 `healthy`。
- PostgreSQL、Redis、RabbitMQ：继续使用 `../docker-helm.dofe.ai` 管理的外部容器；本轮未创建、重建或初始化这些依赖。
- GEOFlow 应用镜像从提交归档构建，避免未提交工作区内容进入镜像；最终本机镜像 manifest 为 `sha256:ba11c9c7101975dd01eb1ec72d0ce9f29b4be55eeb874c72f906d425892ebb66`。

## 2. 浏览器全流程

最终 Chromium 回归执行了以下真实操作：

1. 以本地测试管理员会话打开 MCP 市场。
2. 发布 `GEOFlow Docker Live mt64arnt` 私有目录项，Endpoint 为精确批准的 `http://127.0.0.1:18080/mcp`。
3. 配置加密保存的 Authorization 凭据，选择在线 Codex Runtime，并等待连接状态变为 `ready`。
4. 声明并发现五个带命名空间的工具：`create`、`status`、`autosave`、`validate`、`publish`。
5. 打开 AI 员工创建页，以空白模板创建 `GEO Manager mt64arnt`，备注名为 `GEO 管理员工 mt64arnt`，绑定同一 Runtime。
6. 在桌面和 390 x 844 移动视口检查员工目录、文本布局和横向溢出。

| 检查 | 最终结果 |
| --- | --- |
| MCP 目录发布、凭据配置和连接验证 | 通过，连接进入 `ready` |
| AI 员工创建与 Runtime 绑定 | 通过，数据库记录与 UI 一致 |
| 浏览器 console error / warning | 0 / 0 |
| `requestfailed` | 0 |
| 移动端横向溢出 | 0 px |
| 页面 DCL / load | 807 ms / 807 ms |
| Playwright | 1 passed，35.0 s |

证据：

- [桌面截图](./evidence/geo-mcp-live-desktop.png)
- [移动端截图](./evidence/geo-mcp-live-mobile.png)
- 自动化入口：`apps/web/e2e/geo-mcp-live.spec.ts` 与 `apps/web/playwright.live.config.ts`

## 3. AI 员工真实 MCP 业务闭环

`pnpm verify:geo-mcp-live` 通过 AgentSpace 的真实任务授权和 MCP Gateway 执行：

1. 创建真实 `agent_task_queue` 任务并领取一次性加密 MCP grant。
2. 每个工具调用前重新校验 workspace、runtime、task、connection 和 tool 授权。
3. 调用 `geoflow.enterprise_knowledge.create` 创建租户隔离的企业知识项目。
4. 每 2 秒调用 `status`，直到异步队列明确进入 `reviewing`，最长等待 120 秒。
5. 调用 `autosave` 保存人工审核稿，调用 `validate` 校验。
6. 使用显式 `confirmation=PUBLISH` 调用 `publish`。
7. 按本次唯一 `taskId` 核对 AgentSpace 工具审计，再将任务置为 completed。

最终结果：

| 业务实体 / 证据 | 值 |
| --- | --- |
| AgentSpace task | `task-geo-live-mt647r33` |
| GEOFlow enterprise project | `5`，发布前状态 `reviewing` |
| Knowledge base | `4` |
| Knowledge chunks | `3` |
| Embedding | models 实际路由返回，model id `7`，维度 `2048` |
| 成功工具审计 | 五个工具全部存在 `succeeded` 记录 |

这条链路不是直接调用 GeoFlow service：请求实际经过 AgentSpace 目录、连接密钥解密、任务级授权、daemon gateway、Streamable HTTP MCP、GeoFlow queue 和 models embedding 调用。

## 4. 测试发现并修复的问题

1. GeoFlow `/mcp` 原 `throttle:120,1` 按代理 IP 共享额度，多 AI 员工会互相触发 429。现改为令牌 SHA-256 指纹主额度和更宽的 IP 防护额度，明文凭据不进入限流键。
2. GEOFlow 工具使用 `geoflow.*` 命名空间，而 AgentSpace 目录和 daemon 原规则拒绝点号。现控制面与运行面都接受点号并保留长度、首字符约束。
3. AgentSpace 默认只允许 HTTPS。新增双开关、精确 URL 的本机 Docker 例外，只接受 `127.0.0.1` 高端口非根路径；启用 egress enforcement 时仍拒绝 HTTP。
4. 中央 PostgreSQL 未提供可选 `embedding_vector` 列。同步逻辑原先检测到不可用后仍写该列，导致发布得到 0 个分块。现仅在 vector 类型和列同时存在时写 vector 列，否则仍保存真实 `embedding_json`、model id、维度和 provider。
5. 企业知识 AI 生成约 30-63 秒，旧验收在 60 秒超时后继续发布，后台任务可能覆盖人工稿。现业务端在 queued/processing 状态拒绝保存、校验和发布，队列任务使用原子状态条件写回；验收必须等待 `reviewing`。
6. 浏览器表单的 HTML pattern 对 `-` 转义不完整，且工具名不允许点号。现已修正 slug、版本和工具名 pattern，并补充组件测试。
7. 审计验收原用分页总数差切片，历史达到 25 条上限后误报空审计。现将查询上限提高到 100，并按本次 `taskId` 精确过滤。

GeoFlow 对应提交：`ca3eeba`（按凭证隔离限流）、`cd9a7ff`（发布竞态保护）、`41cb1c6`（无 pgvector 列兼容）。

## 5. 自动化回归结果

| 范围 | 结果 |
| --- | --- |
| GeoFlow MCP、企业知识、管理端、embedding | 94 passed，434 assertions；可选向量列专项复测 30 passed，168 assertions |
| AgentSpace MCP security/client/connections | 65 passed |
| AgentSpace MCP 市场组件 | 33 passed |
| AgentSpace daemon typecheck | 通过 |
| 真实 AgentSpace -> GEOFlow MCP | 通过，五工具、3 chunks、五条成功审计 |
| Chromium 桌面/移动端 | 1 passed；0 console issue；0 failed request；0 overflow |

## 6. 保留限制

- 宿主机当前为 Node `25.9.0`，仓库契约为 Node `24.19.0`，因此 pnpm 会正确发出 engine warning。正式 CI 和发布镜像仍必须使用 Node 24.19.0；本机 managed-node overlay 仅用于这次 Docker 联调，不作为发布镜像。
- 本轮外部 SSO 登录页按钮没有产生回调请求，因此浏览器验收使用数据库创建的本地短期测试会话。MCP、员工、Runtime 和业务数据均为真实本地/测试环境数据，但外部 SSO provider 登录仍需在其可用环境单独回归。
- 本机没有启动或触发 Jenkins，也没有 push。GeoFlow Docker 部署仅为用户明确要求的本机真实环境回归。
