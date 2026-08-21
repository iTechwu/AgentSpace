# GEO 管理 AI 员工与 GEOFlow MCP 浏览器验收记录

> 验收日期：2026-08-21
>
> 范围：AgentSpace 创建 GEO 管理 AI 员工，以及连接 `../geoflow.dofe.ai` MCP 的协议与能力边界。
>
> 浏览器工具说明：本工作区未暴露 Chrome DevTools MCP callable tool，本次使用同等 Chromium/Playwright 流程执行页面操作，并采集控制台、失败请求、截图、可访问性快照和横向溢出结果。

## 1. AgentSpace 浏览器流程

在隔离 E2E PostgreSQL 工作区中执行：

1. 打开 `/w/{workspace}/agents?mode=agent`。
2. 点击“新建 AI员工”，选择“空白自定义”。
3. 创建内部名称“GEO 管理员”、备注名“GEOFlow 管理员”，并写入 GEOFlow MCP 工作说明：目录查询、任务监控、启动、排队和停止，写操作前确认目标任务。
4. 创建完成后在员工目录中看到“GEOFlow 管理员”。

浏览器验收结果：

| 检查 | 结果 |
| --- | --- |
| 创建动作与目录回显 | ✅ 通过 |
| 页面横向溢出 | ✅ 未发现 |
| 浏览器 console error | ✅ 0 |
| requestfailed | ✅ 0 |
| 首屏新手引导 | ✅ 可关闭，不阻断创建流程 |

该流程只验证员工身份、说明和执行引擎表单，不能替代实际 GEOFlow MCP 写操作验收。

## 2. GEOFlow MCP 协议验收

使用隔离的本地 HTTP 进程连接外部 PostgreSQL/Redis，未启动或修改 PostgreSQL、Redis、RabbitMQ 容器。验证结果：

| 请求 | HTTP / JSON-RPC | 结果 |
| --- | --- | --- |
| `initialize` | 200 / result | ✅ 返回协议版本 `2025-06-18` 与 serverInfo |
| `tools/list` | 200 / result | ✅ 返回 14 个工具（含任务创建和文章工作流） |
| `notifications/initialized` | 204 | ✅ 符合通知无响应体约定 |
| `geoflow.catalog` | 200 / result | ✅ 返回 4 个 GEO prompt；模型、关键词库、标题库、知识库当前为空 |
| `geoflow.tasks.list` | 200 / result | ✅ 返回空任务列表 |
| 未认证请求 | 401 / `-32001` | ✅ 拒绝 |
| 未知工具 | 200 / `-32602` | ✅ 拒绝 |
| 不存在 task id | 200 / `-32000` | ✅ 返回工具执行失败 |

本地运行中，Laravel `artisan serve` 的 `/mcp` 请求曾因限流中间件读取 Redis 连接而返回 `NOAUTH Authentication required`；命令行配置显示限流器为 array store。切换为直接 `php -S` HTTP 进程后协议验收全部通过。该差异属于本地启动 harness 的配置/进程缓存问题，生产源文件未绕过 `throttle:120,1`，未保留临时路由修改。

## 3. 全流程结论与缺口

本轮已补齐 GEO 全流程所需的 MCP 工具面：

- 读取 GEOFlow 目录；
- 创建、查询任务和单任务监控；
- 启动任务；
- 停止任务；
- 排队任务；
- 创建、查询和更新文章；
- 审核、发布和回收文章。

工具面已经支持“创建任务 → 生成/入队 → 读取文章 → 更新 → 审核 → 发布/回收”。由于本地任务列表为空且没有单独隔离的 GEOFlow 测试数据库，本轮没有对现有业务数据执行写操作，只完成协议、权限、幂等和服务层回归。

## 4. 下一步验收门

下一步需要在 AgentSpace MCP 市场注册 GEOFlow 的不可变连接，并将连接绑定到 GEO 管理 AI 员工；再在隔离 GEOFlow 数据库中逐步回归“创建任务 → 读取目录 → 生成 → 质量检查 → 发布 → 读取产物 → 停止/重试”。系统令牌必须配置 `GEOFLOW_MCP_AUDIT_ADMIN_ID`，否则审核/发布会被安全拒绝。
