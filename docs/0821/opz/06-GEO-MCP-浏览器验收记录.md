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
- PostgreSQL、Redis、RabbitMQ：继续由 `../docker-helm.dofe.ai` 集中管理，AgentSpace 与 GEOFlow Compose 均未创建这些依赖。中央 PostgreSQL 已在 281 MB 全实例逻辑备份和隔离烟测后切换到 `dofe-postgres:18-pgvector-0.8.6`，36 个可连接数据库和约 1125 MB 数据均保留。
- GEOFlow 已按停机排空、外部迁移、启动和 readiness 顺序升级到提交 `380a319`；app 镜像 manifest 为 `sha256:84f15e7e2c38c165dfa672144aa3c5d46e5c7d8c948998cbfe0b2a63ab55e325`，web 为 `sha256:1aab4a139e8f57c97f5eeaf6b057a96d2d9b2059012ed6f3e900ef1c3ec5a19a`。
- AgentSpace managed-node 使用本机 recovery overlay 运行 Node `24.19.0`，镜像 manifest 为 `sha256:336f371fb08132bc5acbeda1ff7b2b52d0d830d8334a0d101a222c251fa02d75`；容器健康检查和 daemon status 均通过。

## 2. 浏览器全流程

最终 Chromium 回归执行了以下真实操作：

1. 以本地测试管理员会话打开 MCP 市场。
2. 清理名称严格匹配 live E2E 约定的历史测试夹具，再发布 `GEOFlow Docker Live mt69js5r` 私有目录项；Endpoint 为精确批准的 `http://127.0.0.1:18080/mcp`。
3. 配置加密保存的 Authorization 凭据，选择在线 Codex Runtime，并等待连接状态变为 `ready`。
4. 声明并发现五个带命名空间的工具：`create`、`status`、`autosave`、`validate`、`publish`。
5. 通过 `create=agent` 深链接打开创建页，以空白模板创建 `GEO Manager mt69js5r`，备注名为 `GEO 管理员工 mt69js5r`，绑定同一 Runtime，并显式选中本次新员工核对详情。
6. 在桌面和 390 x 844 移动视口检查员工目录、标题语义、文本布局、图标可见性和横向溢出，并分别运行 WCAG A/AA 与 best-practice Axe 扫描。

| 检查 | 最终结果 |
| --- | --- |
| MCP 目录发布、凭据配置和连接验证 | 通过，连接进入 `ready` |
| AI 员工创建与 Runtime 绑定 | 通过，数据库记录与 UI 一致 |
| live E2E 测试夹具 | 首轮清理 14 名员工 / 18 个目录项；次轮清理 1 / 1，最终保留 1 / 1 |
| 浏览器 console error / warning | 0 / 0 |
| `requestfailed` | 0 |
| HTTP 4xx / 5xx | 0 / 0 |
| 移动端横向溢出 | 0 px |
| 页面 DCL / load | 1930 ms / 2004 ms |
| 桌面 / 移动 LCP | 1876 ms / 1460 ms |
| 桌面 INP | 40 ms；移动端截图阶段未产生可计量交互 |
| 桌面 / 移动 CLS | 0 / 0 |
| 最大长任务 | 0 ms |
| 无名称交互控件 / 空标题 | 0 / 0；创建结果由 `role=status` 宣告 |
| Axe | 桌面 / 移动均为 0 violations |
| 移动顶部图标 | 两个控件均满足至少 3:1 图形对比度 |
| Playwright | 1 passed，34.1 s（总耗时 34.8 s） |

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
| AgentSpace task | `task-geo-live-mt69krz7` |
| GEOFlow enterprise project | `13`，发布前状态 `reviewing` |
| Knowledge base | `12` |
| Knowledge chunks | `3` |
| Embedding | models `embedding-vision` 实际路由返回，provider `dofe-models-api-local`，原始维度 `2048`；三个分块均写入 `vector(3072)` |
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
8. GeoFlow URL 导入原先先计数再创建，并发请求可能越过每租户上限。现按租户哈希锁串行化计数与创建；真实容器 5 路并发验证为 3 个创建成功、2 个稳定限流，测试记录随后清零。
9. GeoFlow `tools/list` 原先向只读令牌暴露写工具名称。现按令牌 scope 过滤目录；真实容器验证写令牌可见 51 个工具，只读令牌仅见 26 个且不包含任务创建和文章发布。
10. SSO 登录后的前端误用 `document.cookie` 验证生产 HttpOnly Cookie，成功登录也会输出 warning。修复改为调用后端 `/auth/session` 验证；真实隔离 Chromium 已完成手机号登录、OAuth authorize、AgentSpace callback 和工作区落地，所有关键响应成功。
11. 中央 PostgreSQL 18 镜像声明创建 `vector` 扩展，但镜像实际未包含 pgvector，且备份和初始化脚本仍残留旧 `pardx` 契约。现由 `docker-helm.dofe.ai` 固定安装 PGDG `postgresql-18-pgvector=0.8.6-1.pgdg13+1`，补齐全实例备份、隔离镜像烟测、`geo_dofe` 扩展对账和新环境幂等初始化；GeoFlow 以新迁移恢复 `embedding_vector vector(3072)`。
12. MCP 无效 Bearer 原会直接进入远端 SSO userinfo，并使用交互登录的长超时与重试，足以占满 PHP-FPM worker，表现为连接验证 `mcp.protocol_invalid` 超时。现先本地校验 SSO JWT 的三段格式、issuer 和 audience，仅候选令牌才访问 userinfo，同时为 MCP 单独设置 1 秒连接、3 秒总超时且不重试；真实环境无效令牌 0.30 秒返回 401，正确令牌 0.12 秒返回 initialize 200。
13. 浏览器证据原只断言新员工存在，桌面截图却仍展示旧员工详情。用例现显式点击本次创建员工并验证详情面板后截图，桌面和移动端证据均直接显示本次新建的员工。
14. 3072 维 `vector` 超过 pgvector 常规 ANN `vector` 运算类的维度上限，原检索只能精确排序。现新增 `halfvec(3072)` 余弦 HNSW 表达式索引，迁移以 `CREATE INDEX CONCURRENTLY` 在事务外执行；两个检索入口复用同一契约。真实 PostgreSQL 执行计划命中 `knowledge_chunks_embedding_halfvec_hnsw`，新知识库 8 的 3/3 分块均保留原始 2048 维 embedding 并返回 0.580077、0.303907、0.261949 的检索分数。
15. AI 员工 `create=agent` 深链接原先在打开弹窗的同一 effect 中立即清理 URL，真实 Next.js 导航重挂载后会丢失弹窗状态。现将参数作为一次性打开信号，仅在取消、关闭或创建成功后清理，并以组件测试和真实 Chromium 回归覆盖。
16. 增加 Axe 后发现员工页存在四处 AA 对比度不足、页面缺少 `h1`、员工详情从 `h1` 跳到 `h3`。现修正搜索提示、面板计数、成功状态、标签颜色，并将目录和详情主标题调整为 `h1` / `h2` 语义层级；桌面和移动扫描均为零违规。
17. 移动顶部栏继承了深色侧栏按钮颜色，浅色背景上的菜单和搜索图标几乎不可见。现为移动栏设置独立的浅色按钮契约，并新增两个图标控件至少 3:1 对比度的浏览器断言。
18. 成功 toast 默认显示 3.6 秒，原新增断言在详情加载后才读取，造成对短生命周期通知的误判。验收现于提交完成、弹窗关闭后立即核对 `role=status`，再继续详情和性能检查。
19. live E2E 原先每轮永久保留唯一员工、目录项、连接和密钥，失败重试也会留下半成品；实际已累积 14 名测试员工和 18 个测试目录项，拖长移动页面并污染性能基线。现测试启动时仅匹配严格的 `GEO Manager mt[a-z0-9]+` / `GEOFlow Docker Live mt[a-z0-9]+` 命名契约，通过员工业务删除和目录外键级联回收历史夹具，结束时注销临时登录会话；连续两轮真实 Chromium 分别验证 14/18 和 1/1 清理，最终数据库只保留本轮 1/1 对象。

GeoFlow 对应提交：`ca3eeba`（按凭证隔离限流）、`cd9a7ff`（发布竞态保护）、`41cb1c6`（无 pgvector 列兼容）、`0015eb5`（URL 导入并发保护）、`308c62f`（工具发现权限过滤）、`94c220e`（恢复 pgvector 存储列）、`bfcbcd5`（限制 MCP SSO 回退超时）、`a045cac`（提前拒绝无效身份令牌）、`380a319`（3072 维 halfvec HNSW 检索）。中央基础设施对应提交：`fd60ab7`（PostgreSQL 18 pgvector 镜像、备份和扩展对账）。SSO 对应提交：`736cebc`（HttpOnly 会话验证）。

## 5. 自动化回归结果

| 范围 | 结果 |
| --- | --- |
| GeoFlow MCP、企业知识、管理端、embedding | 94 passed，434 assertions；可选向量列专项复测 30 passed，168 assertions |
| GeoFlow pgvector 迁移聚焦回归 | 54 passed，318 assertions；Pint 通过 |
| GeoFlow ANN 契约、检索、向量同步与 Worker | 64 passed，306 assertions；Pint 通过 |
| GeoFlow MCP / SSO 鉴权回归 | 50 passed，149 assertions；无效令牌 0.30 s 返回 401 |
| AgentSpace MCP security/client/connections | 65 passed |
| AgentSpace MCP 市场组件 | 33 passed |
| AgentSpace 员工管理组件 | 56 passed（含创建深链接与标题语义回归） |
| AgentSpace daemon typecheck | 通过 |
| 真实 AgentSpace -> GEOFlow MCP | 通过，五工具、3 chunks、五条成功审计 |
| Chromium 桌面/移动端 | 连续两轮通过；最终 1 passed，34.1 s；LCP 1876/1460 ms；桌面 INP 40 ms；CLS 0/0；Axe 0 violations；0 console issue；0 failed request；0 HTTP 4xx/5xx；0 overflow；夹具最终 1/1 |
| 外部 SSO 隔离 Chromium | 登录 POST 200；authorize 302；callback 307；工作区 200 |
| GeoFlow MCP 权限目录 | 写令牌 51 个；只读令牌 26 个且隐藏写工具 |
| GeoFlow URL 导入并发 | 5 路并发：3 创建、2 限流；清理后 0 条测试记录 |
| managed-node Node 基线 | `v24.19.0`；daemon healthy；真实五工具任务通过 |
| PostgreSQL / pgvector | PostgreSQL healthy；vector 0.8.6；halfvec HNSW 计划命中；3/3 新分块向量非空；2048 原始维度补齐至 3072 存储维度 |

## 6. 保留限制

- 宿主机仍为 Node `25.9.0`，因此宿主 pnpm 会正确发出 engine warning；真实 managed-node 已使用官方发行包和固定 SHA-256 运行 Node `24.19.0`。正式 CI 仍必须发布批准的私有 `node:24.19-bookworm-slim` 基础镜像，本机 recovery overlay 不作为发布镜像。
- SSO 源码修复已在 `sso.dofe.ai` 本地提交并通过单测、ESLint、Web TypeScript；本机没有远端 SSO 的非 Jenkins 部署入口，因此线上页面仍可能输出旧 warning，但真实登录和 AgentSpace callback 已成功。
- 本机没有启动或触发 Jenkins，也没有 push。GeoFlow Docker 部署仅为用户明确要求的本机真实环境回归。
