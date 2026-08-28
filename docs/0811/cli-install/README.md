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
   - 同 `(workspace, runtime, package_kind, package_source, package_slug, requested_action)` 唯一键约束，重复提交幂等；`createCapabilityRequestSync` 已迁移为 compare-and-set（返回 `{record, outcome}`），并发双提交只产生一条审计事件，非终态请求（pending/approved/running）不被脏写，终态请求自动重开。
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

### 6.2 Phase 2-7（进度更新 2026-08-11）

- **Phase 2**（部分）`selectCliHubReadiness` 已能从 daemon 读取 readiness；Execution Profile 已落地：daemon 就绪上报扩展 `executionProfile`（writableHome/persistentHome/runtimePackageExecutor/chromium 由宿主机断言，mcpGateway/managedServiceReachable 仅显式启用时断言，fail-safe 未知不宣称），投影按 profile 协商 CLI/MCP（writableHome/runtimePackageExecutor=false 时 CLI 降级 request_deployment；mcpGateway=false 时 MCP 不再误报可用），market loader/availability API/MarketPageData 均暴露 profile。Dockerfile 版本锁定、SBOM、签名矩阵仍未补齐。
- **Phase 3**（部分）`runtime_app_release` 已支持 yanked；`capability_request.release_id` 已绑定（提交 workspace-private CLI 自动 pin，批准时若被 yanked 则 fail closed）；`syncCliHubCatalog` 同步时将 npm 可变版本（`latest`/`head`/…）解析为 registry 精确版本（`isMutableCliVersion` + `resolveMutableNpmVersion`）。全量 release 治理队列仍待续。
- **Phase 4**（部分）后端 submit/approve/reject + 管理员待办面板 + 站内通知（dedupe by request id）+ 审计已落地；`createCapabilityRequestSync` CAS 幂等消除并发双审计/脏写；`decideCapabilityRequestSync` 返回 `{record, changed}`，调用方仅在状态真正从 pending 翻转时才派发 operation，重复批准/并发审批不会创建新 operation；`bindApprovedCapabilityRequestToMcpConnectionSync` 只匹配 `approved`，普通连接入口无法绕过 pending 审批直接运行；终态请求换申请人重开时 `requested_by_user_id` 同步转移，审批/通知路由到正确申请人。跨页面通知 UI 仍待续。
- **Phase 5**（部分）managed service 容器驱动已接通：`capability-service-driver.ts` 在获批 `managed_service` 请求派发时创建真实 `managed_skill_service` 实例 + provision operation（**不可变模板 ID pin**——`metadata_json.managedServiceCatalogId`，派发只认 pin 防 catalog 漂移；幂等复用 in-flight op；**ready 实例不重复 provision**），请求转 running 并在 metadata_json 记录 operation 链接；daemon complete/fail 路由按 operation 收敛 capability_request（metadata_json 定向查找，不受 200 条限制）；**managed-service 模式 MCP 先经容器驱动再连接**（provision 期间 running + mcpAutoConnect 标记，容器就绪后收敛钩子 auto-connect）；无已接纳模板时 fail-closed 不伪造镜像引用。镜像签名/健康/回收的策略与 `linked_runtime_provisioning_task_id` 自动绑定仍待容器驱动继续完善。
- **Phase 6**（**已落地**）CLI + MCP 统一启用向导 UI：详情面板按 `nextAction` 分支（install / request_deployment / connect / configure_credentials）；MCP 两种部署模式统一经 MCP-center 连接生命周期调度（零配置 MCP 批准即连，凭据/endpoint/必填配置型投影 `configure_credentials`），verify op 双向收敛；repair 态对成员显示友好文案、管理员可见 `reasonCode` 诊断码；普通成员 `install` / `connect` / `configure_credentials` 不再要求 canManage——点击后提交统一 capability_request，管理员 `request_deployment` 显示「部署并启用」而非「申请管理员部署」；管理员提交任意能力请求自动批准并 dispatch，返回真实 nextAction（MCP 不再假「处理中」）。
- **Phase 7**（部分）四个回滚开关全部就位（`CAPABILITY_REQUESTS_ENABLED` / `CAPABILITY_AVAILABILITY_PROJECTION_V2` 同时门控 loader 与 API / `MANAGED_SERVICE_PROVISIONING_ENABLED` / `RUNTIME_BASELINE_ROLLOUT_ENABLED`，后两者默认 fail-closed）。Runtime baseline 自动铺开执行体仍待续。

### 6.13 受治理 baseline release 与真实 Docker E2E（进度更新 2026-08-11 第十二轮）

- **受治理 baseline release**：新增 `baseline-releases.ts` 受治理 release registry——每工具必须 pin 具体 artifact URL + sha256 integrity（env per-tool 覆盖或 `DOFE_AGENT_BASELINE_RELEASES_JSON` 治理 JSON），计划构建走 `resolveBaselineRelease`；malformed pin（非 https/坏 integrity）fail-closed。npm/python 无治理 release 时 fail-closed；uv/cli-hub 回退显式标注"未治理"命令计划。
- **真实 Docker baseline E2E**：`runtime-apps.e2e-real-docker.test.ts`（`DOFE_AGENT_RUN_DOCKER_E2E=1` 门控，本机 Docker 已验证）——docker-run 执行包装在真实 provider 镜像内运行命令 + 写入 Runtime HOME 的 marker 在第二个容器可见（baseline 安装持久化机制）。发现并记录：provider 镜像 python 无 ensurepip，工具级安装依赖镜像内容。
- cosign 签名镜像 E2E 需指定 CI 环境（cosign + 已签名镜像 + 公钥，见 `skill-service/e2e-real-docker.test.ts` 门控）。

### 6.12 取消真实生命周期验证（进度更新 2026-08-11 第十一轮）

- **端到端取消生命周期测试**：provision op 派发 → 容器置 ready（模拟 daemon 部署完成）→ 取消 → 断言请求 cancelled、显式 retire op 入队（补偿）、provision op 被 fence（迟到完成回调不能回写）。控制面 workflow 13/13、daemon service-operation-worker 8/8（retire 执行路径）均通过。

### 6.11 Feature Envy 重构与前端切换入口（进度更新 2026-08-11 第十轮）

- **Feature Envy 重构**：取消/补偿不再手改三个子系统数据表——新增 `cancelRuntimeAppOperationSync`（runtime-app）、`cancelManagedSkillServiceOperationSync`（skill-service）、MCP 走 `cancelUnfinishedMcpOperationsForConnectionSync` + `updateMcpConnectionStatusSync(disabled)` + `queueManagedSkillServiceRetireSync`。
- **前端多实现切换**：MCP 详情面板展示 `selectionReason` + `selectedImplementation`（CLI/MCP）+ alternatives（依赖 CLI 可切换），管理员可见协商结果。

### 6.10 事务、补偿与多实现切换（进度更新 2026-08-11 第九轮）

- **baseline 链式事务**：CLI op 创建 + request 重链接同一事务，进程中断不产生孤儿 op，重试恰好一次。
- **取消补偿**：取消 managed-service 能力时，若容器已 provisioned（op 有 service instance）立即 `queueManagedSkillServiceRetireSync`，不等下一轮扫描 + 空闲冷却。
- **多实现切换**：availability API 接受 `implementation=cli|mcp`（等价 kind 别名），管理员可程序化请求指定实现投影；投影已含 `alternativeImplementations`。
- **uv/cli-hub baseline**：支持 `DOFE_AGENT_BASELINE_UV/CLIHUB_ARTIFACT_URL+INTEGRITY` 配置驱动 pinned-artifact 计划；未配置时回退命令计划并标注"未治理"（npm/python 仍 fail-closed）。

### 6.9 MCP 主链闭环与取消状态机（进度更新 2026-08-11 第八轮）

- **P0-S1**：managed_service 端点校验接受 `runtime-private://`（provisioned 容器端点），连接真正指向刚部署的容器而非静态预部署服务。
- **P0-S2**：MCP 回绑与成员补凭据接受 `deploy` + `connect`——request_deployment 生成的 deploy 请求不再无法收敛/完成。
- **P0-S3**：managed_stdio 依赖 CLI 自动安装——缺依赖时先排 `mcp-dependency:` CLI op，就绪后由 chain 创建 MCP connection；依赖失败则请求 fail-closed。
- **取消状态机**：runtime-app complete/fail 跳过 `cancelled` op（不能回写 succeeded）；baseline/MCP 依赖 chain 仅在请求仍 running 时接续；共享 provision op 仅最后一个引用取消；MCP 取消 fence 未完成 verify op。
- **reconciler CAS**：重新批准恢复用 `claimCapabilityRequestForDispatchSync`（approved→running 原子认领），并发管理员只一个派发。
- **Sp4**：容器 MCP 无已接纳模板时 submit 拒绝（防审批对象漂移）。

### 6.8 协商、签名与 baseline 补全（进度更新 2026-08-11 第七轮）

- **CLI/MCP 多实现协商**：投影新增 `selectedImplementation` / `alternativeImplementations` / `selectionReason` / `runtimeProfileRevision`。managed MCP 需要依赖 CLI 时以 MCP 为主实现、依赖 CLI 为可切换替代；profile 修订号让 UI 检测 runtime 能力变化后重新协商。
- **baseline npm/python 计划**：npm/python 为图像级组件默认 fail-closed；ops 配置 `DOFE_AGENT_BASELINE_NODE_ARTIFACT_URL/INTEGRITY`（或 python 版）时生成 pinned artifact 计划（下载 + sha256 校验 + 解压 + 验证）。pip/uv/cli-hub 走 ensurepip/pip/npm 计划。
- **镜像签名策略 fail-closed**：`signatureRequired` 模板若无 `signatureKeyPem` 则派发前拒绝（`template_not_admitted`），不部署无法校验的镜像。

### 6.7 收敛与路由收紧（进度更新 2026-08-11 第六轮）

- **全量收敛**：provision operation 收敛所有关联请求（不再 LIMIT 1 遗留 running）。
- **managed MCP 终态分流**：零配置 MCP 容器就绪后 auto-connect；凭据/endpoint 型 MCP 回 `approved`（configure_credentials）；容器 endpointRef（runtime-private://）接入 connection 而非静态模板。
- **managed_stdio 不进容器驱动**：仅 `catalog.transport=managed_service`（如 OpenMontage）走 Docker 容器；Chrome DevTools / MiniMax 走依赖 CLI + stdio worker。
- **MCP 回绑收紧**：校验 `requestedAction=connect` + 固定 `catalogItemId`。
- **reconciler**：被 flag/缺模板阻塞的 approved 请求重新批准时重新派发。
- **公共 CLI plan pin**：submit 时固定精确 install plan，派发不再重建漂移。
- **取消联动**：取消 envelope 时联动取消已关联 CLI/baseline/skill-service op 与 MCP connection。
- **retire 保护限定 runtime**；`metadata_json->>'skillServiceOperationId'` 表达式索引（schema v119）。

### 6.6 生命周期推进（进度更新 2026-08-11 第五轮）

- **retire 回收保护**：`retireUnreferencedManagedSkillServicesSync` 不再回收 capability 部署的服务——capability_request（pending/approved/running/completed）经 metadata `managedServiceCatalogId`/`serviceId` 引用即受保护；仅失败/拒绝/取消释放给空闲回收。修复 stateless 默认立即回收导致刚部署的 managed MCP 容器被误杀。
- **Runtime baseline 门控**：`RUNTIME_BASELINE_ROLLOUT_ENABLED=1` 时缺基础工具的 CLI 投影为 `install`（自动补装文案），普通成员不再阻塞在 `request_deployment`。
- **成员取消**：`cancelCapabilityRequestSync`（仅申请人或管理员）+ `cancelCapabilityRequestAction` + 我的请求面板取消按钮（pending/approved/running）；取消的 managed-service 能力释放容器给 retire 扫描。

### 6.5 目录重推导与身份收紧（进度更新 2026-08-11 第四轮）

- **目录缺失拒绝**：`resolveCapabilityDeploymentPlan` 无法解析目录条目时 `submit` 直接拒绝（`capability_request.catalog_not_found`），不再回退浏览器声明的 deploymentMode。
- **source 权威化**：MCP 重推导以目录 `source` 覆盖客户端提交的 source（同 slug 多来源不再不一致）。
- **service 类目仅 managed_service**：`external_service` 不是 service 的可执行组合，客户端声明被服务端重推导为 managed_service。
- **MCP 完成入口收紧**：`completeCapabilityRequestMcpConnectionSync` 只消费 `requestedAction=connect` 的获批请求；`requireManage` 公开布尔改为内部 `materializeMcpConnectionSync`（无调用方可伪造旁路）。
- **Execution Profile 诚实上报**：`persistentHome` 按 `/proc/mounts` 探测（tmpfs/ramfs/zram 报 ephemeral，本地或临时 Runtime 不误报持久）。

### 6.4 代码结构（进度更新 2026-08-11）

- **能力模块拆分**：`capability-availability.ts` 收敛为公共 facade，职责拆分到 `capability-projection.ts`（9 态投影）、`capability-workflow.ts`（submit/approve/reject/owner-complete + 通知 + release pin）、`capability-dispatchers.ts`（获批请求派发 CLI/MCP/service）、`capability-config.ts`（四个回滚开关）、`capability-service-driver.ts`（managed service 容器驱动 + 收敛）。对外导出面不变，index.ts 无需改动。

### 6.3 MCP 派发身份与部署模式重推导（进度更新 2026-08-11）

- **MCP 身份不可变引用**：submit 时把 `catalogItemId` 写入 `capability_request.metadata_json`（`buildCapabilityRequestMetadataJson`），派发时优先按 ID 读取目录条目，不再回退到 slug「最新」；同 slug 多版本不会派发到错误 release。
- **零配置判断完整化**：`isZeroConfigMcp` 同时检查 secretFields、endpointTemplate 和 configuration schema 的必填非密钥字段；含必填配置的 MCP 进入 `configure_credentials`，不再用空配置自动连接后被校验拒绝。
- **部署模式重推导**：`submitCapabilityRequestSync` 不再信任浏览器声明的 deploymentMode——按 CLI install strategy / MCP transport 从真实目录条目重推导（`resolveCapabilityDeploymentPlan`），浏览器声明仅作形状校验（`assertCapabilityDeploymentPlan`），displayName 采用目录权威值。

## 7. 落地代码索引

| 路径 | 角色 | 阶段 |
| --- | --- | --- |
| `packages/db/src/capability-requests.ts` | capability_request CRUD + 状态机 | Phase 1 |
| `packages/db/src/postgres-schema.ts`（v117） | `capability_request` 表 + 索引 | Phase 1 |
| `packages/services/src/capabilities/capability-availability.ts` | 投影 + 提交 + 审批 + MCP 调度统一 | Phase 1/4/6 |
| `packages/services/src/clihub/catalog.ts` + `install-plan.ts` | 公共目录同步时解析 npm `latest` 为精确版本（`isMutableCliVersion` / `resolveMutableNpmVersion`） | Phase 3 |
| `apps/web/app/api/workspaces/[workspaceId]/capabilities/availability/route.ts` | GET 投影 | Phase 1 |
| `apps/web/app/api/workspaces/[workspaceId]/capability-requests/route.ts` | POST 提交 + GET 我的请求 | Phase 1 |
| `apps/web/app/api/workspaces/[workspaceId]/capability-requests/[requestId]/decision/route.ts` | POST 管理员决策 | Phase 1 |
| `apps/web/features/market/capability-projection-loader.ts` | 服务端投影包装 | Phase 6 |
| `apps/web/features/market/capability-next-action-ui.ts` | 9 状态 → 按钮 copy + enable | Phase 6 |
| `apps/web/features/market/market-page-loader.ts` | 注入 `capabilityProjections` + `capabilityRequests` | Phase 6 |
| `apps/web/features/market/market-page-client.tsx` | 详情面板 `nextAction` 徽章 + 主按钮按 nextAction 分支 + 我的请求面板 | Phase 6 |
| `apps/web/features/market/actions.ts` | `submitCapabilityRequestAction` + `decideCapabilityRequestAction` | Phase 6 |
