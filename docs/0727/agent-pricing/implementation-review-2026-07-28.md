# Agent Pricing 实施复审（2026-07-28）

本次复审以 `00-产品需求与交付规格.md`、`README.md`、`models-contract.md` 和
`implementation-plan.md` 为基线，重新检查控制面、节点执行器、Web、数据库和自托管部署。

## 本轮发现与闭环

| 发现 | 风险 | 处理结果 |
| --- | --- | --- |
| 受管 CLI 请求没有注入 models 约定的 Runtime 归因签名 | AI员工和会话成本只能落到 Runtime Key，无法形成可信细分 | 节点在受管容器内启动本地转发代理，剥离外部 `x-dofe-*` 头并按 Runtime Key、Runtime、AI员工、会话和时间戳生成 HMAC-SHA256；加入固定向量测试。 |
| 取消/删除在节点清理前删除 Runtime，数据库级联同时删除待执行清理请求 | 容器或认证卷可能遗留，任务却被错误标记完成 | Schema 36 保留清理记录并关联 provisioning task；取消保持 `cancelling`，节点清理成功后才删除 Runtime 并完成任务，最终失败则记录失败证据。 |
| 人工轮换幂等键只包含凭据和原因 | 对同一凭据再次执行合法人工轮换会被 models 当成重放 | 每次人工操作加入独立 `operationId`；自动恢复继续使用自身稳定的恢复任务幂等键。 |
| managed-node 模式没有跨后台重启和安装更新持久化 | 节点重启后可能退回普通 Provider 节点 | CLI 重启命令、帮助、安装器和 `--update-existing` 均保留 `DOFE_AGENT_MANAGED_NODE`；managed-node 安装检查 Docker，并跳过主机 Provider CLI 登录检查。 |
| durable provisioning/cleanup 只有路由，没有自托管调度器 | 进程重启后的恢复依赖人工触发 | 自托管 Compose 增加 `runtime-maintenance` worker，使用 `CRON_SECRET` 周期调用恢复路由；local 模式保持空闲。 |
| Runtime 列表没有详情入口 | 无法从列表进入单个 Runtime 核对凭据 ID、成本和绑定状态 | 新增 workspace 范围、Owner/Admin 限制的只读 Runtime 详情路由，只展示安全元数据。 |
| service 层直接查询 `agent_runtime`，异步 API 使用 `Sync` 后缀 | 数据访问边界和接口语义不一致 | 原始查询移入 `packages/db`；Promise API 统一改为 `Async` 后缀；移除重复接口声明。 |
| 受管容器缺少基础 Docker hardening | 容器默认权限面过宽 | 增加只读根文件系统、受限 `/tmp`、`no-new-privileges` 和 capability drop。 |
| 远端计费状态被提前终结 | pending 金额可能被误标为正式结算且无法继续修正 | 增加 `pending_reconciliation` 状态并按远端最终状态重复更新。 |
| 用量归因字段不完整 | 缓存计费、协议和调用时段无法审计 | schema 39 增加网关用量 ID、协议、缓存 Token、调用时段与来源更新时间，并以远端用量 ID 建立唯一幂等约束。 |
| 用量写入与对账依赖请求内成功和人工全量操作 | 短暂数据库失败会丢失任务关联，历史全量扫描无法扩展 | 增加持久化重试队列、按 Runtime Credential 游标自动对账和 24 小时回看窗口；仍为 pending 的记录会把窗口扩展到最早待结算时间，避免延迟终态永久遗漏。 |
| Ready 检查未经过归因代理 | HMAC 或代理转发异常可能在创建时漏检 | 健康阶段新增经本地归因代理访问非计费模型目录的检查，并保留 CLI 可执行性检查。 |
| 受管容器未强制指定隔离网络 | 容器可能使用默认出口直连 Provider | 强制配置非默认 Docker 网络，并提供 `npm run verify:managed-runtime-egress` staging 门禁。 |
| 凭据轮换后只对账当前 Key | 旧 Key 宽限期内的延迟账单可能永久遗漏 | Schema 40 增加凭据级对账目标；当前 Key 保持 active，旧 Key 在可配置最短保留期内保持 draining，自动任务逐凭据续扫；仅在 Models 明确返回 `expired/revoked` 且无 pending 用量后才完成。 |
| 维护任务阶段和证据写入互相阻塞 | 单个故障可能阻断其余恢复工作，且缺少可追踪运行结果 | Schema 40 增加维护运行记录；四个阶段逐项隔离并持久化结果，连证据库创建失败也不会阻止业务阶段继续执行。 |
| 用量存储职责集中且缺少可重放账单演进 | 重试、游标、汇总与事实写入耦合，结算变化只能看最终状态 | 拆分账单汇总、重试 outbox、凭据对账游标/目标；Schema 41 增加同事务 append-only billing event 与迁移快照。 |
| 发布门禁只能探测 Provider 域名 | 直连 IP、代理旁路和账单归因仍依赖人工判断 | 网络门禁增加策略标签、域名、原始 IP、代理和镜像代理变量校验；新增真实账单精确归因门禁，统一生成 JSON 审计证据。 |

## 仓库验证

- `npm run test:agent-pricing`
- `npm run typecheck`
- `npm --prefix apps/web run typecheck:test`
- `npm run lint:web`
- `git diff --check`

上述命令是本轮提交的完成门禁；测试矩阵已纳入 HMAC、延迟取消、managed-node 安装/重启和 cron 授权路径。

## 仍属于发布门槛

以下项目不能用仓库单元测试替代，继续保持未完成：

1. 使用真实 `models.dofe.ai` 测试租户、Runtime Key、网关和批准的容器镜像完成 staging E2E。
2. 在目标基础设施验证 Runtime 只能访问 models 网关，不能通过 DNS、直连 IP、代理环境变量或其他出口访问上游 Provider。
3. 核对真实账单中的 Runtime Key、AI员工、会话、模型和请求 ID，并演练未分配用量修复。
4. 演练节点中断、清理最终失败、Key 撤销失败、轮换宽限期和回滚流程，保留审计证据。

在上述门槛完成前，生产环境继续保持 `DOFE_AGENT_RUNTIME_MODE=local`。

## 本轮遗留项实施状态

| 优先级 | 内容 | 实施状态 |
| --- | --- | --- |
| P0 | 真实 staging 网络隔离与账单 E2E | **业务代码已落实，待目标环境执行。** `verify:managed-runtime-egress` 校验网络策略标签、网关可达性，以及 Provider 域名、原始 IP、代理端点和代理环境变量旁路；`verify:managed-runtime-billing` 对真实请求的 Runtime Credential、Runtime、AI员工、会话、请求、模型、终态费用和币种做精确核验；`verify:managed-runtime-release` 串行执行并保存 JSON 证据。 |
| P1 | models SDK 用量契约扩展 | **AgentSpace 侧已落实。** 本地契约适配器兼容 `cacheTokens`/`cachedTokens`、`cacheReadTokens + cacheWriteTokens` 和调用起止/更新时间，测试已覆盖；models SDK 正式类型发布仍是 models 仓的跨仓发版动作。 |
| P1 | 凭据轮换后的历史对账 | **已落实。** 新增持久化凭据对账目标；人工轮换、自动恢复、停止、删除和取消都会把旧 Key 转为 draining，自动对账不再依赖 Runtime 当前 Key；退出还必须取得 Models 的 `expired/revoked` 终态证据。 |
| P2 | 对账任务可观测性与故障隔离 | **已落实。** 维护运行和凭据失败原因持久化，管理员告警具备去重键；四阶段及不同凭据目标相互隔离，通知或证据写入失败不会中断其余目标。 |
| P2 | 用量存储模块拆分 | **已落实。** 账单汇总、重试 outbox、对账游标/凭据目标已从通用 usage repository 拆出，公共导出保持兼容。 |
| P2 | 历史快照 / 事件流 | **已落实。** `token_usage_billing_event` 由数据库触发器与事实变更同事务追加，覆盖发现、记录、归因、计费状态变化及迁移快照；持久化延期也追加独立事件。 |

仓库内本轮列出的 P0/P1/P2 业务代码项已全部实施。剩余工作只包括目标基础设施上的真实执行、审计证据归档，以及 models SDK 的跨仓版本发布，不应被标记为 AgentSpace 业务代码缺失。
