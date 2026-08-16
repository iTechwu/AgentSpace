# Prisma dev 分支审查与优化建议

## 1. 当前状态

审查基线为 `dev` HEAD `8a990c2a`。当前 `packages/db/prisma/schema.prisma` 有 **25 个
model**；进度记录显示已接入 **22 个读域、4 个写路径**，并通过共享
`PrismaPg` 单例和按域 feature flag 渐进切流。定向验证结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @dofe-agent/db run prisma:validate` | 通过 |
| `pnpm --filter @dofe-agent/db run types` | 通过 |
| `pnpm --filter @dofe-agent/db run prisma:verify:pilot` | 通过，报告 25 models |

这些结果证明 schema 可生成、类型可编译、pilot 列级漂移检查可运行，不等于已经完成
全库约束、容量和生产切流验收。

## 2. 发现与风险

### P1（已部分落地）：drift 门禁已覆盖 Prisma unique/index/FK

`packages/db/src/prisma-schema-drift.ts` 现在同时读取非主键 PostgreSQL index，
`packages/db/src/prisma/schema-contract.ts` 解析并比较字段级/复合 `@unique`、`@@unique` 和
`@@index`，以及 relation `fields/references/onDelete` 外键契约。新增
`prisma:verify:contract` 命令与现有 pilot 使用同一入口，先补齐最容易发生且可由 Prisma
表达的约束漂移。

当前门禁仍不会发现 check constraint、enum、partial index、
trigger、function、view 或 migration 历史漂移。项目文档却将这些对象列为 Prisma 与自定义
SQL 的共同边界。

建议：拆成两个明确门禁：

1. `prisma:verify:contract`：继续扩展到枚举和删除动作；
2. `postgres:verify:invariants`：查询并校验 trigger/function/view/partial index 等
   Prisma 不表达的对象。

两者都应在 CI 的 schema/migration 变更时执行；若暂时不能全量实现，命令必须继续叫
`pilot`，进度文档不得把它描述为全库 drift gate。

### P1（已部分落地）：Prisma Client 的连接池与运行容量仍需验收

已在 `packages/db/src/prisma/prisma-client.ts:21-80` 增加按 `web/worker/daemon` 角色解析的
pool max、连接超时、空闲超时、statement timeout 和 `application_name`，并在
`prisma-client-config.test.ts` 覆盖默认值、非法值和上下界。该实现补齐了配置边界，
但还没有证明真实 Web/worker/daemon 并发下的连接池容量和饱和行为。

剩余建议：启动时打印脱敏后的有效配置，采集 active/waiting/timeout 指标，并在 Web、worker、
daemon 三种并发模型下分别做容量基线。未完成这些运行证据前，不应把本项标记为完整生产验收。

### P1（基础门禁已完成）：切流开关集中注册，仍需发布系统联动

当前源码中约有 **57 个 read flag 文件、56 个 shadow flag 文件和 8 个 write flag 文件**，
各域仍直接读取 `process.env.<DOMAIN>_PRISMA_*`。本轮新增
`packages/db/src/prisma/cutover-flags.ts`，以 typed registry 登记 23 个域的 read、shadow
和 write 能力，并在 Prisma Client 初始化时拒绝未知 flag、非法值、未注册 write 以及
shadow 未开启对应 read 的组合；拼写错误和 read/shadow 不同步现在会 fail-closed。

剩余建议：继续把依赖、允许的最大并发开启数、kill switch、owner 和 flag 版本纳入 registry，
由发布脚本生成环境模板并写入切流审计；当前实现解决的是进程边界配置错误，不替代发布系统的
多域并发护栏和回滚编排。

### P2：写路径覆盖仍不完整，跨域编排边界没有退出条件

`docs/progress-log.md:121-126` 明确 notifications 的 30+ 深层 sync 调用链和 task enqueue
暂不迁移。该选择是合理的风险控制，但如果没有调用方清单、完成定义和 deadline，Phase 2 会
长期停留在“4 个写路径已完成”的中间态。

建议：为每个剩余写域建立 inventory（调用方、事务边界、幂等键、事件副作用、负责人），
把 task enqueue、outbox、workflow lease 作为独立高风险批次；只有完成 legacy/Prisma
affected rows、错误类别、幂等、并发和事件顺序对照后，才允许关闭旧路径。

### P2：shadow 观测是日志采样，没有持久化 SLO 或自动回滚

`packages/db/src/prisma/cutover-observability.ts:28-57` 对异常全量记录、正常 primary 默认
只采样 1%，并脱敏错误文本；这解决了日志噪声和泄露问题，但没有按域聚合 mismatch/fallback
率、P95、连接池等待、P2034/deadlock，也没有在窗口超阈值时自动关 flag。

建议：把 `prisma.cutover` 事件接入可聚合指标，定义每域窗口阈值和 burn-rate 告警；维护
`last-known-good` flag 配置，发生 mismatch、fallback 或容量异常时自动生成回滚建议（最终
动作仍由发布系统确认）。

### P2（已部分完成）：Raw SQL 已参数化并增加 Unsafe 门禁

`packages/db/src/prisma` 当前约有 15 处 `$queryRaw/$executeRaw`，分布在 8 个文件；未发现
`$queryRawUnsafe/$executeRawUnsafe`。现已增加
`packages/db/scripts/verify-prisma-raw-sql.mjs`，并接入 `packages/db/package.json` 的
`pretest`，后续新增 Unsafe API 会直接阻断 DB 测试门。

剩余建议：继续要求每个 raw query 旁有用途和索引说明，返回值有显式类型，写入说明事务/
幂等语义，并增加 SQL 审计清单和慢查询回归测试。

## 3. 推荐落地顺序

先完成全量 schema/invariant drift gate、角色化连接池运行容量证据和 shadow SLO，再继续扩展
写路径；同时补齐 shadow 指标聚合与自动回滚证据。不要因为 pilot drift 通过就提前删除 legacy
路径或一次开启多个新域。
