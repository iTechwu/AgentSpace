# AgentSpace 部署拓扑与组件所有权

> 统一索引：一张图看全所有部署面、每个组件归谁管、哪些约定最容易踩坑。
> 各部署面的**操作细节**（env 逐项、构建命令、升级/回滚步骤）仍在各自 README，本文只做拓扑与所有权收敛，不重复它们。
> 对应优化项 3.6-11。

## 1. 组件清单

| 组件 | 是什么 | 产物 / 入口 |
| --- | --- | --- |
| **web** | Next.js 应用（UI + API + cron 路由） | `apps/web`，`pnpm run start:web` / 容器内 `node server.js` |
| **workflow-worker** | 定时 Trigger、节点分派、outbox、故障恢复 | `apps/workflow-worker`，`deploy/workflow-worker/Dockerfile` |
| **daemon（local 模式）** | 本机执行守护：runtime 执行器 + **内嵌飞书 WebSocket worker** | `packages/daemon`，CLI `daemon start --mode local` |
| **daemon（remote 模式）** | 远程执行守护（每容器一个 provider） | `deploy/daemon/Dockerfile` / `Dockerfile.provider-runtime` |
| **feishu-worker（独立）** | 飞书 WebSocket worker 独立容器（与 daemon 解耦时用） | `deploy/feishu-worker/`（源码挂载型镜像） |
| **mcp-egress-proxy** | MCP 出口代理（策略快照 + JTI 重放防护 + OAuth 注入） | `deploy/daemon/Dockerfile.mcp-egress-proxy` → `dist/index.js` |
| **managed-node** | 托管运行时工作节点（provider 中立 daemon + Docker socket，动态拉起 runtime 容器） | `deploy/daemon/docker-compose.managed-node.yml` |
| **runtime 容器（codex/claude/openclaw/hermes）** | 一容器一 provider CLI + daemon 薄包装 | `deploy/daemon/docker-compose.runtimes.yml` / `remote-images.yml` |
| **runtime-maintenance** | 周期对账（task-commit 恢复；remote 模式下续跑 provisioning） | `deploy/self-hosted/runtime-maintenance.mjs` |
| **employee-runtime-recovery 演练镜像** | EAD 数据耐久 D-07/D-08 恢复演练用的带标签薄层 | `deploy/drills/Dockerfile.employee-runtime-recovery` |
| **nginx** | 本地域名 TLS 反代（`dofe-agent.local.dofe.ai` → `127.0.0.1:1455`；`agentspace.local.dofe.ai` 在宿主 nginx 配置，不在本文件） | `deploy/nginx/dofe-agent.conf` |
| **PostgreSQL / Redis / RabbitMQ** | **不在本仓库部署**——由 `../docker-helm.dofe.ai` 集中管理，应用只连不建 | 见 §4 约束 1 |

## 2. 部署面（一个组件可能出现在多个面，以所有权表为准）

| # | 部署面 | 位置 | 适用 | 组成 |
| --- | --- | --- | --- | --- |
| A | **self-hosted Compose（单机生产形态）** | `deploy/self-hosted/` | 单台主机跑全套 | web + workflow-worker + db-init + daemon-claude + daemon-codex + runtime-maintenance + release-gate 脚本；外部 PG |
| B | **systemd 裸机** | `deploy/systemd/` | 裸机/VM 不用 Docker 时 | `dofe-agent.service`(web) + `-daemon` + `-feishu-worker` + `-workflow-worker` 四个 unit + env 模板 |
| C | **开发拓扑（mac + dev-server）** | 仓库本身 | 本机开发 | mac：`pnpm dev`(web) + `scripts/dev-daemons.sh start`(local daemon，内嵌飞书)；dev-server：`docker-compose.remote-images.yml` 跑 4 个 provider runtime 容器回连 mac web |
| D | **one-runtime-per-container** | `deploy/daemon/docker-compose.runtimes.yml` | 固定 provider 凭据隔离部署 | 每 provider 一个 daemon+runtime 容器，凭据目录只读挂载进唯一容器 |
| E | **managed-node（托管运行时）** | `deploy/daemon/docker-compose.managed-node.yml` + `ensure-ci-managed-nodes.sh` | remote 模式动态供给 | 一个 provider 中立 daemon，按控制面指令拉起/复用 `dofe/agent-runtime-<provider>:<tag>` 兄弟容器；CI 每 workspace 一个节点 |
| F | **staging 发布门** | `deploy/staging/` | managed-runtime 发布验证 | 镜像构建/打标 + 出口网络 + 凭据 seed + egress/billing 双门（脚本本体在 `deploy/self-hosted/`） |
| G | **独立 feishu-worker** | `deploy/feishu-worker/` | 飞书 worker 与 daemon 解耦时 | 单容器长连进程，源码由宿主仓库挂载 |

`deploy/postgres/docker-compose.yml` 是本地开发遗留的 PG 启动器，**不是部署路径**（见 §4 约束 1）。`deploy/daemon/jenkins/` 是指定 CI 环境的 managed-node 对账 job 配置（本工作站不触发 Jenkins）。

## 3. 组件所有权矩阵

> 同一逻辑能力在任意时刻**只能有一个所有者进程**；「所有者」列是判断"该不该再起一个"的依据。

| 逻辑能力 | 所有者（按部署面） | 明确不是所有者的 |
| --- | --- | --- |
| 飞书 WebSocket 长连 | A：`daemon-claude`（全栈唯一 `DOFE_AGENT_MANAGE_FEISHU_WORKER=true`）；B：`dofe-agent-feishu-worker.service`；C：local daemon（`dev-daemons.sh`）；G：独立 feishu-worker 容器 | 其余所有 daemon（开关必须 false）——见 §4 约束 2 |
| 任务执行 / runtime | A：daemon-claude + daemon-codex；C：mac local daemon + dev-server 4 容器；D：每 provider 容器；E：managed-node 动态容器 | web、workflow-worker 不执行任务 |
| Workflow Trigger 写入 | workflow-worker（切流后唯一写者） | web 只读展示；`dual_read` 前必须 dry-run（见 `deploy/workflow-worker/README.md`） |
| task-commit 对账 / 恢复 | A：runtime-maintenance 服务 | cron 手动触发仅作补充 |
| 模型调用出口 | remote 模式：mcp-egress-proxy（受限网络）→ models 网关 | runtime 容器不得直连 provider 端点（egress 门校验） |
| DB / Redis / RabbitMQ | `../docker-helm.dofe.ai` | 本仓库一切 Dockerfile / Compose |

## 4. 易踩坑约定（升级 / 新增部署面前必读）

1. **基础设施外部化**：所有部署物不得创建、运行或内嵌 PostgreSQL / Redis / RabbitMQ。`deploy/postgres/docker-compose.yml` 仅限本机开发数据库，禁止当作部署组件引用；各 env 里的 DB/中间件地址一律指向 `../docker-helm.dofe.ai` 管理的外部实例。
2. **飞书 worker 单一所有权**：daemon 托管与独立 `deploy/feishu-worker` **二选一**。同一集成内两个 worker 同跑 = 事件重复消费或互踢。切换所有者时：关掉一侧开关 → 确认 `DOFE_AGENT_FEISHU_WORKER_ID` 在集成内唯一 → 再起另一侧。新增 daemon 服务时保持 `DOFE_AGENT_MANAGE_FEISHU_WORKER=false`，除非明确移交所有权。
3. **daemon token 绑定首个注册的 daemon**：一个 token 只能属于一个容器/进程，跨容器复用会静默失败；每容器/每 workspace 独立发 token（CI 多 workspace 见 `ensure-ci-managed-nodes.sh`）。
4. **web 与 workflow-worker 必须同 `DATABASE_URL` 且切流状态一致**：`WORKFLOW_CUTOVER_MODE(S)` 两端不对齐会产生双写/漏写。
5. **remote 模式上线前置**：egress + billing 双门在每个 managed node 通过并留存 JSON 证据（`pnpm run verify:managed-runtime-release`），否则保持 `local` 模式。
6. **升级/回滚**：A 面重建即升级（卷保留，DB 归外部 PG）；G 面围绕宿主仓库提交（checkout → install → build → `up -d`），回滚即回到上一已验证提交；C 面 daemon 重启用 `scripts/dev-daemons.sh restart`。细节见各 README。

## 5. 各部署面细节入口

- A/B 面：`deploy/self-hosted/README.md`、`deploy/systemd/`（unit + env 模板）
- D/E 面：`deploy/daemon/README.md`（凭据目录、provider accounts、镜像构建）、`deploy/REMOTE_DAEMON_TEST.md`、`deploy/install-remote-daemon.sh`
- F 面：`deploy/staging/README.md`（含真实计费证据的产生方式）
- G 面：`deploy/feishu-worker/README.md`（含与 daemon 托管互斥的完整说明）
- workflow-worker：`deploy/workflow-worker/README.md`
- 开发拓扑：`scripts/dev-daemons.sh --help`、本文件 §2-C
