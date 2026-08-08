# AgentSpace 迁移到 Prisma 的评估与实施方案

## 结论摘要

当前项目已经是 **PostgreSQL 生产主库 + 自研同步 SQL Repository**，不是尚未选型的 SQLite 项目。若目标只是“使用 Prisma 做数据库管理”，改动可控制在中等范围；若目标是把所有数据库访问都改成 Prisma Client，改动会沿整个应用调用链扩散，属于大型基础设施重构。

| 目标 | 预计改动 | 风险 | 建议 |
| --- | --- | --- | --- |
| A. Prisma 只负责 Schema/迁移，Repository 继续使用现有 SQL | 中等：新增 Prisma schema、baseline、迁移门禁和 CI；保留现有运行时 SQL | 低到中 | **推荐先做** |
| B. Prisma Client 与现有 SQL 并存，按域逐步替换 | 中到大：每个域需要 async Repository、调用方改造、并发回归 | 中到高 | A 稳定后执行 |
| C. 全量 Prisma Client 化并删除同步兼容层 | 大型：约 70 个数据库生产文件、241 个生产 import 方和大量上层 async 传播 | 高 | 不建议作为一次性项目 |

推荐路线是 **A → B，C 不作为前置目标**。Prisma 不应被用来抹平 PostgreSQL 的锁、队列领取、触发器和在线 DDL 语义；这些行为继续由原生 SQL migration 或 `$queryRaw` 承担。

## 1. 评估范围与证据

本次评估基于当前 `dev` 工作区的静态代码和包清单完成。知识图谱 MCP 工具在当前会话不可用，因此按仓库约定回退到 `rg`/文件读取；未连接任何数据库，也未使用生产或测试管理员账户。

### 1.1 规模快照

| 指标 | 当前值 | 对迁移的含义 |
| --- | ---: | --- |
| `packages/db/src` 生产 TypeScript 文件 | 86 | 不是单一 ORM adapter，而是多个领域 Repository |
| `packages/db/src` 生产代码量 | 40,604 行 | 全量重写不可按“替换依赖”估算 |
| `packages/db/src` 测试代码量 | 10,941 行 / 41 文件 | 已有较多行为回归资产，迁移必须保留并扩充 |
| 直接调用 `getDatabase()` 的生产文件 | 70 | 需要逐文件分类，不宜大爆炸改写 |
| 生产 `prepare()` 调用 | 939 | 其中包含动态 SET、窗口函数和原子更新 |
| `withTransaction()` 使用点 | 87（34 个文件） | 同步事务 API 改为 Prisma interactive transaction 会触发 async 传播 |
| `@dofe-agent/db` 生产 import 方 | 241 个 TS 文件 | Web、services、daemon、CLI 均受影响 |
| `@dofe-agent/db` 测试 import 方 | 107 个 TS 文件 | 测试 fixture、清理和隔离方式需要同步改造 |
| Schema 文件 | 4,622 行 | 当前 schema 仍是按版本追加 SQL 的单文件工厂 |
| `CREATE TABLE` 语句 | 124 | 包含兼容/补列场景，不能直接把每条都当作新模型 |
| `POSTGRES_TABLE_NAMES` 条目 | 约 120 | Prisma schema 预计约 120 个 model，需人工清洗命名和关系 |
| 索引创建语句 | 177 | 包括唯一、部分索引和迁移后的索引治理 |
| 触发器 | 5 | Prisma schema 无法表达，必须保留在自定义 migration SQL |
| `ALTER TABLE` | 249 | 反映 116 个 schema 版本演进，不能丢失历史兼容逻辑 |
| JSONB 字段出现次数 | 117 | Prisma `Json` 类型可承接，但旧接口当前以 JSON 字符串暴露 |
| 外键引用 | 278 | 关系可由 Prisma 表达，但删除策略和旧数据清洗需逐一核对 |
| `ON CONFLICT` | 约 68 | 大部分可映射 `upsert`，复杂冲突更新仍可能保留 raw SQL |
| `FOR UPDATE` | 11 | 需要在同一 Prisma transaction 中执行，不能拆成独立 Client 调用 |
| `SKIP LOCKED` | 2 | 队列/lease claim 的核心并发语义，优先保留 raw SQL |

### 1.2 当前数据库运行时

核心实现位于以下模块：

- `packages/db/src/database.ts`：通过 `worker_threads` 驱动 `pg.Client`，把同步 `exec/prepare/all/get/run` 适配到 PostgreSQL；负责连接缓存、请求超时、schema advisory lock、事务与 savepoint。
- `packages/db/src/postgres-schema.ts`：输出当前 schema 版本 `116` 的 SQL，包含建表、补列、索引、外键、触发器、数据清洗、回填和 post-commit concurrent index。
- `packages/db/src/postgres.ts`：负责 SQLite → PostgreSQL、PostgreSQL → PostgreSQL、schema lock、后台维护、在线索引和回填。
- `packages/db/src/types.ts`：约 120 个表对应的应用记录类型；大量 JSON 字段仍以 `string` 形式向上层暴露。
- `packages/db/src/index.ts`：包含 690 个唯一的 `Sync` API 标识符，成为 services、web、daemon、CLI 的稳定接口；上层生产代码约有 1,754 个对应调用点。

现有连接变量由 `packages/db/src/postgres-config.ts` 解析，兼容 `DOFE_AGENT_PG_URL`、`DATABASE_URL` 等来源，并对测试库 URL 做安全校验。部署约束是 PostgreSQL 由外部基础设施管理，应用 Dockerfile/Compose 不得新增 PostgreSQL、Redis 或 RabbitMQ 服务；Prisma 迁移必须继续连接外部 PostgreSQL。

### 1.3 高风险 SQL 行为

以下行为不能简单替换成生成的 CRUD：

1. **队列领取与租约**：`FOR UPDATE SKIP LOCKED`、条件更新、lease token/generation 和 `RETURNING` 共同保证多 worker 不重复领取。
2. **工作流运行历史**：窗口函数计算快照，trigger 在 workspace 内分配 `history_sequence`，回填期间用 MAX bigint 哨兵防止分页漏行。
3. **Schema 并发治理**：advisory lock 115/116/117、前向版本守卫、失败索引清理、事务外 `CREATE INDEX CONCURRENTLY`。
4. **JSONB 数据迁移**：`jsonb_set`、`jsonb_array_elements`、`jsonb_agg` 等数据修复不能由 Prisma schema 自动生成。
5. **数据库触发器**：工作流序号、员工显示名同步、token usage 约束等 trigger 必须以 SQL 维护。
6. **原子状态迁移**：大量 `UPDATE ... WHERE status = ... RETURNING`，先读后写会引入竞态。

## 2. Prisma 能解决什么，不能解决什么

### 2.1 可直接获得的收益

- 从 PostgreSQL schema 生成类型安全的 model/client，减少手写字段映射和拼写错误。
- 用 `prisma db pull` 从现有库生成初始数据模型；官方支持对已有数据库做 baseline，再用 `prisma migrate deploy` 部署后续迁移。
- 标准 CRUD、关系读取、批量写入和常规 `upsert` 可统一 API，降低重复 SQL。
- 迁移文件进入版本控制，schema diff、review 和 CI 门禁更清晰。
- 通过 driver adapter 继续使用 `pg`，不必更换外部 PostgreSQL 基础设施。

### 2.2 不能假设 Prisma 自动覆盖的能力

官方文档明确指出 stored procedure、trigger、view 等不能表示在 Prisma schema 中，需要手工定制 migration SQL。因此当前 5 个 trigger、PostgreSQL advisory lock、在线 concurrent index、复杂回填都应保留为 SQL migration/maintenance 脚本。

Prisma Client 是异步 API。当前同步 worker 适配层若直接替换，所有 `Sync` Repository 和其上层调用方都要改成 `async/await`；这会影响 Next.js route、services、workflow worker、daemon 和 CLI 的接口边界。Prisma interactive transaction 也有 `maxWait`/`timeout`，不能在事务里进行网络调用或长时间等待。

## 3. 目标架构

### 3.1 推荐的“双轨数据库包”

```text
packages/db
├── prisma/
│   ├── schema.prisma          # 规范化后的 120 个左右 model
│   └── migrations/             # baseline + 后续可审查迁移
├── generated/prisma/           # 生成代码，不手写
├── src/prisma/
│   ├── client.ts               # 单进程 PrismaClient/pg adapter 生命周期
│   ├── transaction.ts          # 统一事务、超时和重试策略
│   └── raw.ts                  # 允许的 typed/raw SQL 白名单入口
├── src/legacy/                 # 现有同步 Repository，迁移期间保留
└── src/postgres-maintenance/   # trigger、advisory lock、backfill、concurrent DDL
```

边界规则：

- Prisma Migrate 管理**可声明的表、列、普通关系和索引**。
- 自定义 migration SQL 管理 trigger、函数、partial/concurrent index、数据清洗、回填和约束验证。
- `src/prisma/raw.ts` 只允许参数化 `$queryRaw`/`$executeRaw` 或 TypedSQL；禁止把用户输入拼接进 `$queryRawUnsafe`。
- 旧 `getDatabase()/prepare()` 在所有域切换完成前继续可用，但不再新增调用。
- `PrismaClient` 按进程单例复用；为 Web/worker/daemon 分别设置连接池上限和超时，不能每个请求实例化 client。

### 3.2 Schema 设计原则

1. 先以真实 PostgreSQL 为基线：用 `prisma db pull` 生成候选 schema，再人工核对 `@@map`、`@map`、复合唯一键、部分索引和删除动作。
2. 保留数据库 snake_case 名称，通过 Prisma model/field 的 `@@map/@map` 与现有表兼容；不要为“好看”改物理表名。
3. 日期列优先映射为 `DateTime`，BigInt/sequence 列按实际范围选择 `BigInt`；在 Repository DTO 层继续转换为当前对外的 string/number，避免一次性破坏 API。
4. JSONB 映射为 `Json`，但对敏感凭据、事件 payload 和外部协议继续在边界层做 schema/脱敏校验。
5. 将 278 个外键按业务域分组补齐 relation 名称和 `onDelete` 行为；不能仅依赖 introspection 的默认推断。
6. 将 `app_metadata.schema_version` 与 Prisma `_prisma_migrations` 的职责分开：前者是运行时实例兼容/前向守卫，后者是 Prisma migration 历史。

## 4. 分阶段实施方案

### Phase 0：冻结边界与建立基线

**目标：** 在不改变运行时行为的情况下，得到可 review 的 Prisma schema 和数据差异报告。

实施项：

- 选择一套脱敏的测试 PostgreSQL，记录表/列/索引/外键/trigger 数量、行数和关键约束。
- 安装 `prisma` CLI、`@prisma/client`、`@prisma/adapter-pg`（版本以实施时官方兼容矩阵为准）。仓库镜像当前使用 Node 25.9，而 Prisma 最新官方要求只列出 Node 20.19、22.12、24.x；推荐先把应用运行时固定到 Node 24 LTS，并单独完成兼容回归。
- 执行 `prisma db pull` 生成初稿；禁止直接把初稿提交为最终 schema。
- 建立 schema lint：model/field 映射、禁止删除/改类型、`Json`/`BigInt` 显式审查、未识别 trigger/index 清单。
- 为当前 116 版做 baseline migration：生成 `0_init`，人工补回 trigger/function/特殊索引，然后只在测试库 `migrate resolve --applied 0_init`。

**退出条件：** baseline SQL 在空库可重建；在现有测试库执行 resolve 后 `migrate deploy` 无 destructive diff；schema diff 与现有库零意外差异。

### Phase 1：引入 Prisma Client，但不改业务调用方

**目标：** 先验证连接、生成、事务和部署，不承担全量查询迁移。

- 在 `packages/db` 内新增 Prisma client 单例和显式 shutdown hook。
- 增加 `prisma:generate`、`prisma:migrate:deploy`、`prisma:validate` 脚本；CI 仅对 migration 目录变化运行 deploy job，连接串由 secret 注入。
- 将结构迁移从应用请求/启动路径移到 CI/release step，由 `prisma migrate deploy` 单点执行；运行时 `ensureRuntimeSchema` 只保留 `app_metadata` 版本/sentinel 检查和前向守卫，advisory lock 与后台维护命令继续保留。
- 让 legacy SQL 与 Prisma Client 指向同一外部 PostgreSQL，增加双连接 smoke test、连接池耗尽测试和 graceful shutdown 测试。
- 不在 Docker/Compose 中添加数据库服务；不在本机启动 Jenkins 或执行部署。

**退出条件：** 新实例只执行 Prisma migration；旧实例仍可读写；滚动发布中旧实例遇到更高 `schema_version` 不降级；所有现有 db 测试通过。

### Phase 2：先迁移低风险、读多写少的域

按域逐批替换，每批都保留旧函数的兼容 wrapper：

1. `user-auth`、workspace membership、SSO binding、notification、audit read path。
2. skills/catalog、MCP catalog、runtime display/config 等常规 CRUD。
3. attachment/content blob、employee workspace metadata 等关系明确但不含 claim 的域。
4. token usage、billing、recovery、OpenMontage 等写入密集域。
5. workflows、task queue、outbox、runtime maintenance 等并发敏感域最后处理。

每个域的替换模板：

- 新建 async Repository，返回现有 `Stored*Record` DTO，先不把 Prisma 类型泄漏到 services/web。
- 用 Prisma CRUD/`upsert` 替换直白 SQL；动态筛选使用结构化 `where/orderBy`，禁止动态 SQL 标识符。
- 复杂查询用参数化 `$queryRaw`，并给返回行定义显式 TypeScript 类型。
- 在同一个 `$transaction(async tx => ...)` 内完成锁定、条件更新和后续写入；事务内禁止网络请求。
- 给每个替换函数保留 legacy 对照测试：同一 fixture 下比较结果、affected rows、错误类别、幂等和并发行为。
- 上层调用方一次只改一个 async 边界，避免把整个 `packages/services` 一次性改成异步。

### Phase 3：并发域专项迁移

该阶段不是“把 SQL 翻译成 API”，而是复刻并验证数据库事实：

- Queue/lease claim：优先保留 `SELECT ... FOR UPDATE SKIP LOCKED` 的 raw SQL；Prisma 只负责事务上下文和 DTO。
- Workflow run/node：保留 trigger 分配序号、窗口函数快照、keyset cursor、条件状态迁移；先引入 raw adapter，再考虑拆分为多个 Prisma 操作。
- Outbox/token retry：保留 `UPDATE ... FROM due ... RETURNING` 原子 claim，增加双 worker 并发测试。
- Advisory lock/online DDL/backfill：保留独立 `pg` 管理连接，不通过 Prisma Client 事务执行 `CREATE INDEX CONCURRENTLY`。

**退出条件：** 并发、故障恢复、重复事件、锁等待、分页快照和迁移回滚的行为与现有基线一致；P95、连接数和 deadlock 指标不回退。

### Phase 4：收敛与删除遗留层（可选）

只有当所有调用方都不再依赖同步 API 时才考虑：

- 删除 `worker_threads` 同步 PostgreSQL 适配和 `getDatabase()/prepare()` 导出。
- 把 `@dofe-agent/db` 的 `Sync` 命名从公共契约中移除，更新 services/web/daemon/CLI 的类型检查和测试。
- 将 PostgreSQL 维护命令独立成 migration/maintenance package，而不是塞回 Prisma model 层。
- 保留至少一个版本周期的 legacy read-only rollback adapter，确认无旧实例后再删除。

## 5. 工作量估算

以下是工程量级，不是工期承诺；一人日按 6 小时有效编码估算，需以 Phase 0 的真实 `db pull`/diff 结果校准。

| 工作包 | A：Schema/Migrate | B：并行逐域 | C：全量 Client |
| --- | ---: | ---: | ---: |
| 依赖、生成、连接池、CI 脚本 | 2–4 人日 | 2–4 | 4–7 |
| 120 model schema 清洗与 baseline | 5–10 | 5–10 | 7–14 |
| trigger/函数/在线 DDL/回填迁移 | 4–8 | 4–8 | 5–10 |
| 数据核对、SQLite/PG 迁移工具适配 | 2–5 | 3–6 | 5–10 |
| 低风险域 Repository | 0 | 10–20 | 15–30 |
| 中高风险域 Repository | 0 | 15–30 | 25–50 |
| 并发域与 async 调用链 | 0 | 10–20 | 30–60 |
| 测试、压测、故障演练、文档 | 4–8 | 10–20 | 20–40 |
| **合计量级** | **17–35 人日** | **59–118 人日** | **111–221 人日** |

建议把 A 作为 2–4 周的独立基础设施项目；B 按 4–8 个业务批次推进。C 的上限受 241 个生产 import 方、约 1,754 个公开 `Sync` API 生产调用点和 87 个事务 helper 使用点影响，不能按 ORM 代码生成量线性估算。

## 6. 测试与验收矩阵

### 6.1 Schema/Migrate

- 空 PostgreSQL：baseline migration 可从空库创建所有声明对象，并在同一 migration 中恢复 trigger/function/特殊索引。
- 现有 PostgreSQL：`migrate resolve` 后 `migrate deploy` 只应用新 migration；不得重复建表、降级 `schema_version` 或删除数据。
- 双实例滚动：旧版本遇到更高版本只读写，不执行旧 migration；锁竞争错误可重试且不会缓存未验证连接。
- 在线 DDL：大表索引必须事务外 concurrent 创建；中断后可检测 invalid index 并清理重建。

### 6.2 Repository 对照

- 每个迁移域用同一 fixture 同时跑 legacy 与 Prisma 实现，比较 DTO、null/日期/数字/JSON 映射和 affected rows。
- 对 `upsert`、唯一冲突、重复事件、条件状态迁移、错误码做幂等断言。
- JSONB 边界验证：写入对象、读取对象、旧字符串 DTO 兼容、非法 payload 拒绝和敏感字段脱敏。

### 6.3 并发与容量

- 两个以上 worker 同时 claim queue/outbox/retry，断言无重复领取、无丢失、lease 超时可恢复。
- workflow run 并发创建、分页 snapshot/keyset、approval scan、history backfill 前后对照。
- 连接池压测：Web route、workflow worker、daemon 分别测峰值连接、等待超时、慢查询和 graceful shutdown。
- 运行现有 `packages/db` 全量测试；仓库根测试继续使用 `turbo run test --concurrency=2`，不得执行无约束的 `pnpm test`。

## 7. 发布、回滚与运维

### 发布顺序

1. 合并 Prisma schema、baseline 和 CI 校验，但不切换业务读写。
2. 在测试库执行 baseline resolve、下一版 migration 和数据校验。
3. 发布包含 Prisma Client 的应用，legacy SQL 仍为事实写入路径。
4. 按域启用 feature flag；监控错误率、锁等待、连接数、慢查询、P2034/deadlock、队列重复率。
5. 至少一个完整发布周期后，再删除某域 legacy 写路径。

### 回滚原则

- 应用回滚优先通过 feature flag 切回 legacy Repository；不要自动执行 down migration。
- 已应用的破坏性 schema migration 不做自动回滚，使用前向修复 migration 或维护脚本。
- 保留 `app_metadata.schema_version` 前向守卫和现有迁移命令，直到确认没有旧实例。
- 数据迁移必须先 dry-run，记录 source/target row count、checksum、跳过行和 warning；失败时保留源库和审计证据。

## 8. 建议的最小提交序列

每个提交都应可构建、可测试、可回滚：

1. 引入 Prisma CLI/client/adapter 依赖、生成脚本和版本锁定。
2. 从测试 PostgreSQL introspection 生成并人工清洗初始 `schema.prisma`。
3. 生成 `0_init` baseline，补入 trigger/function/特殊索引 SQL，添加 schema diff CI。
4. 新增 Prisma client 单例、连接池配置、shutdown 和测试 fixture，不改业务路径。
5. 将运行时结构迁移入口接入 `prisma migrate deploy`，保留 app metadata/advisory lock/maintenance。
6. 新增 legacy vs Prisma 对照 harness、行数/checksum 校验和迁移 dry-run 门禁。
7. 迁移 user/workspace/auth/notification 等第一批低风险读路径。
8. 迁移 skills/MCP/runtime catalog 第二批 CRUD 路径。
9. 迁移 attachment/employee data/token usage 等写路径，逐域补 async adapter。
10. 迁移 queue/outbox/workflows 并发路径，保留 raw SQL 并完成双 worker/故障测试。
11. 删除已切域的 legacy wrapper 和未使用导出；每个域单独提交。
12. 最后评估是否删除同步 worker 和 `pg` 直连；若仍需要在线 DDL/维护，保留独立 maintenance client。

## 9. 决策记录

- **数据库提供商不变：** 继续使用外部 PostgreSQL；本项目不创建 PostgreSQL、Redis、RabbitMQ 服务。
- **先迁移治理，再迁移访问：** 先引入 Prisma schema/migrations，避免把 schema 版本治理和业务 API 改造绑成一个高风险发布。
- **双轨而非 Big Bang：** legacy sync Repository 和 Prisma async Repository 可短期共存；同一张表禁止两套实现写出不同状态机语义。
- **Raw SQL 是受控能力：** queue/workflow/maintenance 保留参数化 raw SQL；不以“全 Prisma”作为质量指标。
- **DTO 稳定优先：** Prisma 生成类型不直接穿透 domain/services/web，继续由 `packages/db` 映射为现有 `Stored*Record`。
- **迁移历史分离：** `_prisma_migrations` 记录 Prisma migration；`app_metadata.schema_version` 保留应用滚动兼容语义。
- **连接池显式治理：** Prisma Client 单例、按进程设置 pool max/timeouts；Web、workflow worker、daemon 分别压测后定值。
- **Node 版本先行：** 当前仓库/镜像使用 Node 25.9；Prisma 最新官方系统要求未列出 Node 25。推荐先固定 Node 24 LTS，再引入 Prisma，避免把 ORM 迁移与不受支持的奇数 Node 版本绑定。

## 10. 不在本次迁移范围内

- 不迁移 PostgreSQL 到其他数据库，不引入新的缓存/消息中间件。
- 不重做业务领域模型、状态机、表名或租户隔离策略。
- 不把 JSON 字段全部规范化成关系表。
- 不在本机启动 Jenkins，不执行测试环境/生产部署。
- 不以自动生成的 `schema.prisma` 取代人工审查、数据清洗和并发验证。

## 11. 实施前必须补齐的输入

1. 一份可脱敏的测试 PostgreSQL 连接串和库级对象清单（包括 extensions、functions、triggers、views、RLS、权限）。
2. 生产数据量、最大表大小、连接上限、PgBouncer/连接代理模式和备份恢复目标。
3. 是否需要保持 SQLite 本地迁移能力；若需要，Prisma provider/schema 需要单独评估，不能与 PostgreSQL schema 直接共用。
4. 每个业务域的负责人、切流 feature flag、回滚窗口和验收人。

## 参考资料

- [Prisma：将 Prisma ORM 加入已有 PostgreSQL 项目](https://www.prisma.io/docs/prisma-orm/add-to-existing-project/postgresql)
- [Prisma：为已有数据库建立 baseline](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining)
- [Prisma：Raw queries](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries)
- [Prisma：Unsupported database features](https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)
- [Prisma：Transactions and batch queries](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)
- [Prisma：Deploying database changes](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate)
- [Prisma：Connection pool](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool)
- [Prisma：System requirements](https://www.prisma.io/docs/orm/reference/system-requirements)
