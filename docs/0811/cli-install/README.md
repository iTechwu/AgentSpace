# CLI 与服务能力安装方案

> 日期：2026-08-11
>
> 状态：Phase 1 已落地，Phase 2-7 待续
>
> 范围：AgentSpace CLI 应用、MCP 服务、Docker Runtime 基础能力，以及管理员部署流程

## 1. 结论

AgentSpace 应把“安装一个能力”设计成用户可以从页面发起并持续看到结果的统一任务，但底层不能把所有能力都当作一条 shell 命令安装到 Runtime。

推荐采用四种部署模式：

| 部署模式 | 适用对象 | 默认策略 |
| --- | --- | --- |
| `runtime_builtin` | Node/npm、Python/pip、CLI-Hub、Chromium 等基础工具 | 构建进标准 Runtime 镜像 |
| `runtime_package` | 固定版本、轻量、可验证的 npm/PyPI CLI | 用户点击后安装到 Runtime 私有 HOME |
| `managed_service` | OpenMontage、浏览器服务、重型 MCP、长期运行服务 | 管理节点预拉取审核镜像，首次启用时按需启动 |
| `external_service` | 第三方 HTTPS MCP/API | 配置凭据并连接，不在 AgentSpace 服务器安装 |

普通用户只需要理解“安装、连接、配置、申请管理员部署和查看进度”。版本未固定、镜像未签名、完整性摘要缺失等供应链问题只进入管理员治理界面，不再以不可操作的禁用按钮暴露给普通用户。

## 2. 核心产品决策

1. 基础工具提前安装到 Runtime 镜像，业务应用不全部预装。
2. 受管服务镜像可以提前拉取，但默认不启动所有容器。
3. 用户点击“启用”后，系统自动选择安装 CLI、部署服务或建立连接。
4. 普通用户无部署权限时，可以提交管理员处理请求，而不是停留在死路状态。
5. 目录条目只有通过发布治理后才进入普通用户的“可获取能力”列表。
6. 安全门禁继续保留：固定版本、镜像 digest、签名验证、受控 argv、最小网络、最小权限和审计。
7. PostgreSQL、Redis、RabbitMQ 始终使用 `../docker-helm.dofe.ai` 的集中服务，本方案不创建这些依赖容器。
8. 不使用 `daemonMode=local|remote` 直接决定 CLI/MCP；由 Runtime 的持久 HOME、受控安装器、MCP Gateway 和服务可达性进行能力协商。

## 3. 文档导航

- [00-方案总览与产品决策.md](./00-方案总览与产品决策.md)：问题、方案比较、能力分类和最终决策。
- [01-用户旅程与页面状态设计.md](./01-用户旅程与页面状态设计.md)：普通用户与管理员完整流程、页面状态、按钮和错误恢复。
- [02-Docker服务与Runtime部署架构.md](./02-Docker服务与Runtime部署架构.md)：标准 Runtime、受管服务、镜像缓存、按需启动和隔离边界。
- [03-数据模型与接口设计.md](./03-数据模型与接口设计.md)：目录 release、部署状态、请求、安装和连接的领域模型与 API。
- [04-分阶段执行实施计划.md](./04-分阶段执行实施计划.md)：按依赖顺序拆分的开发阶段、模块改动、迁移和回滚。
- [05-测试验收与运营指标.md](./05-测试验收与运营指标.md)：功能、安全、可用性、性能、故障恢复与上线门禁。

## 4. 与已有设计的关系

本方案建立在现有实现之上，不重新发明另一套安装系统：

- CLI 继续复用受控安装计划与 Runtime 私有 HOME；
- MCP 继续复用连接、工具授权、验证、Gateway 和审计；
- 重型服务复用现有 `managed_service` 目录、操作 Worker 和 Docker 生命周期实现；
- `managed_stdio` 继续使用隔离 Worker/Broker 目标架构，不在 Provider Runtime 中运行第三方服务进程；
- OpenMontage 继续采用独立 Docker 服务，通过 MCP Gateway 提供能力。

相关基线：

- [`docs/0804/cli-mcp`](../../0804/cli-mcp/)：CLI/MCP 市场现状与安装体验设计；
- [`docs/0802/mcp-install`](../../0802/mcp-install/)：MCP release、出口、OAuth 和 managed stdio 设计；
- [`docs/0805/montage/01-目标架构与接入决策.md`](../../0805/montage/01-目标架构与接入决策.md)：OpenMontage managed service 决策。

## 5. 研究限制

当前结论基于页面截图、现有代码、目录数据规则、Dockerfile 和既有产品文档，已形成明确的问题证据，但尚未完成 5 至 8 名真实用户的可用性测试。实施时应先交付可测试原型，再以任务完成率、处理时间和错误率验证文案与流程。

## 6. 实施进度（已落地）

> 本节在每次代码落地后由维护者追加。落地内容必须与代码同次提交。

### 6.1 Phase 1 — 统一能力任务（已落地）

落地要点：

1. **数据库**
   - 新增 `capability_request` 表（schema v117），承载 4 种部署模式（`runtime_builtin` / `runtime_package` / `managed_service` / `external_service`）与 4 类动作（`install` / `deploy` / `connect` / `upgrade`）的二维状态机。
   - 同 `(workspace, runtime, package_kind, package_source, package_slug, requested_action)` 唯一键约束，重复提交幂等。
   - `metadata_json` / `linked_runtime_app_operation_id` / `linked_runtime_mcp_connection_id` / `linked_runtime_provisioning_task_id` 保留到 4 类底层子系统的指针，避免拆表。
   - `packages/db/src/capability-requests.ts` 提供 `createCapabilityRequestSync` / `decideCapabilityRequestSync` / `transitionCapabilityRequestSync` / `cancelCapabilityRequestSync` / `listCapabilityRequestsSync` 等 CRUD。

2. **服务端投影（4 模式 → 9 nextAction）**
   - `packages/services/src/capabilities/capability-availability.ts` 提供 `projectCliCapabilityAvailability` 与 `projectMcpCapabilityAvailability` 两条投影：
     - `runtime_builtin` / `runtime_package` 走 CLI 投影，按 runtime readiness + 不可变 release 决策；
     - `managed_service` / `external_service` 走 MCP 投影，按 `runtime_mcp_connection.status` + 活跃 `runtime_mcp_operation` 决策；
     - 任意投影都收敛到 9 个 `CapabilityNextAction` 之一。
   - 投影输入只有持久化标识（id、runtime 状态、readiness、active operation），不接受浏览器提交的 endpoint、image digest、command、release 引用。
   - `submitCapabilityRequestSync` 是用户面统一入口：自动管理员的 `runtime_package` 安装会立刻触发底层 `runtime_app_operation` 创建并回写 `linked_runtime_app_operation_id`；其它模式进入 `wait_for_operation` 或 `wait_for_approval`。

3. **API 路由**
   - `GET /api/workspaces/:workspaceId/capabilities/availability?runtimeId=…&kind=cli|mcp`：返回 projections + activeRequests，普通成员/管理员共用。
   - `POST /api/workspaces/:workspaceId/capability-requests`：用户主动作入口，校验输入仅暴露给业务字段。
   - `GET /api/workspaces/:workspaceId/capability-requests?mine=1&statuses=…`：我的请求列表。
   - `POST /api/workspaces/:workspaceId/capability-requests/:requestId/decision`：管理员批准 / 拒绝入口。
   - 所有路由使用 `getCurrentWorkspaceContext`，管理员分支独立校验 `role ∈ {owner, admin}`。

4. **关键不变量（docs §1 结论落地点）**
   - 用户始终只看到 9 个 `nextAction` 之一对应的按钮，不再出现长期禁用的“不可安装”。
   - 底层子系统保持分离：`runtime_app_operation`（CLI）、`runtime_mcp_operation` + `runtime_mcp_connection`（MCP）、`runtime_provisioning_task`（受管 Runtime）。统一任务层不替代它们，只持久化 envelope 与跨子系统指针。
   - “把能力当作一条 shell 命令安装到 Runtime” 仅在 `runtime_package` + 管理员同意 + 受控 install plan 的窄路径下发生；其它路径（`runtime_builtin` / `managed_service` / `external_service`）由 daemon / managed node / MCP Gateway 处理。

### 6.2 Phase 2-7（待续）

未落地项（按 docs 优先级）：

- **Phase 2** Runtime baseline 镜像与 readiness 探针的强制管线化（当前 `selectCliHubReadiness` 已能从 daemon 读取 readiness，但 Dockerfile 版本锁定、SBOM、签名矩阵未补齐）。
- **Phase 3** release 治理与不可变 manifest 完整化（`runtime_app_release` 已存在并支持 yanked，但与 `capability_request` 的 release 引用尚未绑定）。
- **Phase 4** 普通成员申请管理员部署的端到端 UI、通知与审计。
- **Phase 5** managed service lifecycle 与 lease/fencing（已有 `runtime_provisioning_task` 与 `managed_runtime_cleanup_request`，但 `capability_request` → `runtime_provisioning_task` 的自动绑定尚未接通）。
- **Phase 6** CLI + MCP 统一启用向导 UI（API 已就绪，页面尚未消费 `nextAction`）。
- **Phase 7** 灰度上线与回滚开关。

## 7. 落地代码索引（Phase 1）

| 路径 | 角色 |
| --- | --- |
| `packages/db/src/capability-requests.ts` | capability_request CRUD + 状态机 |
| `packages/db/src/postgres-schema.ts`（v117） | `capability_request` 表 + 索引 |
| `packages/services/src/capabilities/capability-availability.ts` | 投影 + 提交 + 审批 |
| `apps/web/app/api/workspaces/[workspaceId]/capabilities/availability/route.ts` | GET 投影 |
| `apps/web/app/api/workspaces/[workspaceId]/capability-requests/route.ts` | POST 提交 + GET 我的请求 |
| `apps/web/app/api/workspaces/[workspaceId]/capability-requests/[requestId]/decision/route.ts` | POST 管理员决策 |
