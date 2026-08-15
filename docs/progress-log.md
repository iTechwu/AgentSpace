# AgentSpace 优化落地进度日志

> 本文档是 [`optimization-suggestions.md`](optimization-suggestions.md) 的**落地记录**，随优化实施逐条更新。
> 「建议是什么/为什么/怎么做」看 optimization-suggestions.md；「做了什么/做到哪了/剩什么」看本文档。
>
> 状态约定：✅ 完成 · 🟡 部分完成 · ⏳ 待办 · ⏸ 明确排除/暂缓。
> 条目编号对应 optimization-suggestions.md 的 §3.x 章节。

---

## P0（已完成，除「测试 CI」专项排除）

### 3.1 仓库卫生 —— ✅ 完成

| 落地 | 提交 | 说明 |
| --- | --- | --- |
| AI 规则去重 | `66de23fc` | `CODEBUDDY.md`/`GEMINI.md`/`QODER.md`/`.cursorrules`/`.windsurfrules` 5 份重复文件改为指向 `CLAUDE.md` 的符号链接 |
| `.gitignore` 规则 | `66de23fc` | 新增 `dofe-agent-daemon-*.tgz`、`findings.md`/`progress.md`/`task_plan.md` |
| `-` plist 移除 | `5a39362f` | 真正从索引移除误提交的 macOS plist（`66de23fc` 只做了符号链接与 .gitignore，未真正 git rm） |
| tgz 产物移除 | `5a39362f` | 移除 `dofe-agent-daemon-0.1.3.tgz`（1.8MB），清理 `.gitignore` 过时的 `agent-space-daemon-*.tgz` 规则 |

复核结论（非落地动作，属原始条目纠正）：
- `.DS_Store`：当前 0 个被 git 跟踪（原始分析误判为「已入库」，实为仅存在于磁盘且被 `.gitignore` 覆盖）。
- `.github/workflows/migration-ci.yml`：已不存在于当前分支。
- `packages/db/dist-types/generated/prisma/`、`data/*.sqlite`：均为 `.gitignore` 内本地产物，不属跟踪残留。

### 3.5-1 daemon legacy 死代码 —— ✅ 完成

- `3b81dd12`：删除 `provider-runtime.ts` 中 859 行 legacy 死代码（`runCodexProviderTaskAttempt` + `runClaudeProviderTask` 及其平行事件映射 `mapCodexExecEvent`/`mapClaudeEvent`），文件 2,679→1,820 行，daemon 49/49 用例通过。

### 3.5-2 daemon-client blob 传输超时 —— ✅ 完成

- `0945c0cb`：三处 blob 传输（`getWorkspaceBlob`/`getWorkspaceBlobRange`/`uploadWorkspaceBlob`）加 300s（可配 `blobTransferTimeoutMs`）AbortController 超时。
- `0e02663e`：三方法收敛为共享 `requestBlobWithRetry` 并补直测。
- `779753bd`：重试收敛为仅网络错误/超时/5xx，明确 4xx 不重试。

### 3.5-3 版本号单一来源 —— ✅ 完成

- `0945c0cb`：`cli.ts` 改为 `import package.json with { type: "json" }` 读取版本，消除硬编码 `"0.1.3"`。

### 3.6-1 测试 CI 缺失 —— ⏸ 明确排除

- 本轮按决策明确排除，未动。相关建议见 optimization-suggestions.md §3.6-1 与 §四。

---

## P1（完成大半）

### 3.3-1 permissions.ts 拆分 —— ✅ 完成

- `374b1bc1`：2,439 行拆为 9 个单职责子模块（`permission-context` / `permission-diagnostics` / `permission-nodes-{agents,channels,documents,feishu-guests,runtime}` / `permission-types` / `permission-utils`），原文件收敛为 209 行门面。

### 3.3-2 runtime-provisioning.ts 拆分 —— ✅ 完成

- `7f9ee7d4`：2,258 行收敛为 ~74 行门面（显式 re-export 原 45 个公开符号，导入路径不变），拆出 capacity / tasks / models / credential-recovery / lifecycle / pipeline / models-client 7 个子模块；测试 53/54（1 例为共享测试库 schema 118 不可降级的环境性失败）。

### 3.4-1 dashboard/data.ts 拆分 —— ✅ 完成（两阶段）

- 第一阶段 `683f2d9e`：按「类型层 / 视图构建层 / 装配层」切开——`data.ts` 3,533 行（43 个引用方零改动）、`data-types.ts` 973 行、`dashboard-view-builders.ts` 1,410 行，依赖单向 `data.ts → view-builders → data-types`。
- 第二阶段 `ad4de69e`：`dashboard-view-builders.ts` 按领域拆为 `builders/` 九个子模块（`channel-documents` / `channel-files` / `channel-view` / `document-changesets` / `feishu-summary` / `knowledge-view` / `task-queue` / `text` / `workspace-members`），原文件收敛为 65 行 facade。

### 3.4-2 Web 代码分割 —— 🟡 部分完成

- `32a1bb8a`：`WorkspaceModuleHost` 17 个页面客户端全部改 `next/dynamic` 按模块懒加载（路由 page.tsx 仍静态导入保证 SSR 直出），全量 vitest 144 文件 / 1,153 用例通过。
- knowledge-page-client 四件套拆分（`2a86a772` + `95349d52` + `a9ada12a` + `cce1b274`）：1,580→1,114 行，子组件移出独立文件——`parse-task-panel.tsx`、`assignment-panel.tsx`、`document-page-viewer.tsx`、`knowledge-tree-node.tsx`。
- 剩余：`agent-detail.tsx`(1,657) / `conversation-shell.tsx`(1,590) / `channels-page-client.tsx`(3,925) 文件内拆分 ⏳。

### 3.4-7 readTtl*Cache 重命名 —— ✅ 完成

- `aafd88fb`：`readLoadtestWorkspaceModuleCache` / `readLoadtestWorkspaceModuleCacheTtlMs` 改名为 `readTtlWorkspaceModuleCache` / `readTtlWorkspaceModuleCacheTtlMs`（TTL 缓存语义）；保留环境变量 `LOADTEST_MODE` / `DOFE_AGENT_WORKSPACE_MODULE_LOAD_CACHE_TTL_MS`（运维契约）与 `resolveLoadtestAwareInitialImDetailChannelNames`（语义上是 load-test aware 频道名解析，与本缓存无关）。

### 3.3-3 模块循环依赖 —— 🟡 部分完成

**文件级环（4→2）** `c8c7c37b`：
- skills `release↔installations↔import` 三文件环解体（锁计算下沉 `release-lock.ts`、安装排队下沉 `skill-services/install-queue.ts`）。
- 飞书 `data-plane↔operation-plan` 解体（描述符常量下沉 `data-operation-descriptors.ts`）。
- `cc4047bd`：runtime-provisioning 拆分引入的域内环归零（`ModelsCreateResult` 独立 types 文件 + 编排入口迁至 pipeline）。

**12 文件大 SCC 分层切断（六层目标）**：

| Cut | 边 | 状态 | 提交 |
| --- | --- | --- | --- |
| 1 | `state-io → documents/access`（种子补全下沉 `shared/channel-document-access-seeds.ts`） | ✅ | `8eb08332` |
| 2 | `documents/access → channels`（`resolveChannelHumanMemberNames` 下沉 `shared/channel-members.ts`，6 处改引 shared） | ✅ | `8eb08332` |
| 3 | `channels → attachments`（`deleteUnreferencedWorkspaceAttachmentsSync` GC 语义上移） | ⏸ 跨域编排层，非机械可切 | — |
| 4 | `attachments → channel-access`（角色判断下沉 `shared/channel-members.ts`） | ✅ | `8eb08332` |
| 5 | `notifications → messages`（`postMessageSync` 下沉 `shared/messaging.ts`，messages 保留 facade） | ✅ `shared/messaging` 不再依赖 `runtime-access`，原 5 节点环已消除 | `c8f32035`、`2a63cf67` |
| 6 | `attachments → channel-access`（访问判定下沉 `shared/access-decisions.ts`，channel-access 改 facade） | ✅ | `87bc2e43` |

**当前进度**：原 12 文件大 SCC 已消除；当前仅剩一个 type-only、运行时无害的飞书双节点环（`agent-bot-bindings↔external-guests`）。cut 3（附件 GC 语义上移）仍是分层优化项，但已不再阻塞消环目标。

### 3.3-8 / 测试门覆盖 —— 🟡 部分完成

- `707e80a5`：`permissions`、`document-permissions` 纳入 services 默认测试脚本与 `verify-test-coverage.mjs` 的 COVERED_PREFIXES；daemon 默认测试纳入 `daemon-client.test.ts`。
- `a74f362c`：`packages/db/src/prisma/*.test.ts` 纳入 db 默认测试脚本与 `verify-test-inventory.mjs` 门禁。（注：本提交号现合并为 `f8e0f6d4`，squash 后 read-cutover.ts + .test.ts 与默认门禁同提交落地。）
- `a7c252eb`：`messages` / `notifications` / `channel-access` 三个测试包纳入 services 默认测试脚本与 inventory default-owned；messages 14 项受 managed_runtime 夹具约束的用例以 `MANAGED_RUNTIME_AVAILABLE=1` env 门控跳过。
- 剩余：`employees`、`documents`、`knowledge` 等待办；飞书 24 个测试文件仍游离（3.3-4）。

### 3.6-3 / 3.6-4 CLI 巨型文件与测试脚本 —— ⏳ 待办

- `apps/cli/src/commands/integrations/feishu.ts` 10,597 行、`daemon.ts` 2,222 行：未拆分。
- CLI 测试脚本（5 文件）与 verify-test-inventory default-owned 集（3 个+deploy）不一致：未处理。

### 3.6-5 runtime-maintenance 自旋轮询 —— ⏳ 待办

---

## P2（部分完成，多数待办）

### 3.3-7 / 3.2-6 Prisma 迁移（战略项）—— 🟡 Phase 2 试点可运行

- `docs/0808/db_migration_to_prisma/README.md` 给出 A→B 渐进路线（A=Prisma 管 schema/迁移；B=Prisma Client 与 SQL 并存按域替换）。
- 已落地 audit-log、notifications、task-execution-events、workspace-memberships、employee-runtime-bindings 五域 Prisma Client read cutover；共享 `PrismaPg` adapter/单例通过真实 PostgreSQL `SELECT 1` smoke，员工绑定通过 `agent_runtime` relation 获取 provider/name，不再把 JOIN 字段误当表列。
- notifications、task-execution-events、workspace-memberships、employee-runtime-bindings 已分别接入 Inbox、飞书设置成员列表与工作流编辑页；audit read 已接入平台/工作区审计页，audit write 已接入平台管理员登录审计。同步业务调用方仍按风险逐步迁移。
- 每域均保留独立 read/shadow flag；audit write 在 flag 打开后对不明确的 primary 失败 fail closed，禁止 legacy 二次写入。根 `build` 与 `typecheck:deps` 会先执行 `prisma generate`。
- `packages/db/src/prisma/*.test.ts` 已纳入 DB 默认测试门；`prisma:verify:pilot` 会在测试前对照真实 PostgreSQL 检查六个试点模型的列类型、可空性、默认值和主键。剩余工作是补全量 baseline、可观测指标与灰度/回滚运行手册，而不是一次性替换原生 SQL。

### 3.5-6 构建/版本漂移 —— 🟡 部分完成

- 版本号单一来源已做（见 3.5-3，`0945c0cb`）。
- `0a8e2acc`：esbuild `target: node20` 改为 `node25`，与 `engines.node ^25.9.0` 对齐，避免为 Node 25 原生支持的特性做下兼容编译。
- 剩余：`remote-daemon.ts` 硬编码 `:latest` 镜像 tag 锁 digest、`provider-runtime.ts` 硬编码 4 个默认模型名。

### 其余 P2 待办（未启动）

| 条目 | 主题 |
| --- | --- |
| 3.2-1 | DB 异步池化（`pg.Pool` 平行路径，最大结构债，需按域渐进） |
| 3.2-2 | 拆分 `postgres-schema.ts`（4,838 行） |
| 3.2-3 | 消除双重行映射（`AS` 别名 + worker 别名表漂移） |
| 3.2-4 | 拆分 `external-integrations.ts`(2,576)/`types.ts`(2,219)/`mcp-center.ts`(1,467) |
| 3.2-5 | 类型安全加固（Kysely 等轻量 typed query builder） |
| 3.3-4 | 飞书 24 个测试文件游离于测试门之外 |
| 3.3-5 | 手写 `.d.ts` 孪生去重（`lark-cli.ts`/`.d.ts` 26 导出人工同步） |
| 3.3-6 | `preloaded-skill-sources.ts` 176KB 内联字符串外置 |
| 3.3-9 | `xlsx` CDN tarball 供应链锁定 |
| 3.4-3 | 拆分 `channels-page-client.tsx`（3,925 行） |
| 3.4-4 | 移除 `next.config.mjs` 的 `typescript.ignoreBuildErrors: true` |
| 3.4-5 | 评估部分静态渲染（全站 `force-dynamic`） |
| 3.4-6 | i18n 无 key 体系迁移 |
| 3.4-8 | 统一 34 个 page.tsx 样板 |
| 3.5-4 | 拆分 `remote-daemon.ts`(2,138)/`task-context.ts`(1,544) |
| 3.5-5 | sandbox 抽象决策收口（Cube `exec()` 未实现，`connectSandbox()` 无调用方） |
| 3.5-7 | 测试路径与 `dist/` 产物对齐（esbuild CJS banner 覆盖） |
| 3.5-8 | `pollRemoteTasks` 轮询请求放大（每 3s × 6 次 claim） |
| 3.6-6 | 多套 env 模板漂移（单一 schema 源） |
| 3.6-7 | `dev-daemons.sh` 硬编码本机绝对路径 |
| 3.6-8 | `audit-node-engines.mjs` 借用 `.pnpm` 的 semver |
| 3.6-9 | bin wrapper `spawnSync` 子进程开销 |
| 3.6-10 | `workflow-worker` types 依赖 `apps/web` 的 tsc |
| 3.6-11 | 部署物分散（统一部署拓扑 + 组件所有权文档） |
| 3.6-12 | docs 按日期目录缺乏索引 |

---

## 测试与 CI/CD（专项，⏸ 本轮排除）

> 按决策，本轮优化明确排除测试 CI 专项。§3.6-1（ci.yml 流水线）、§3.6-2（`integrations.test.ts` 11k 行 + `daemon.test.ts` 844 行入默认列表）、§3.3-4（飞书测试入内）整体保持待办。
> 已推进的子项：`permissions`/`document-permissions`/`prisma` 测试纳入默认门禁（见 3.3-8）。

---

*本日志与 `optimization-suggestions.md` 配套维护；落地后在本日志追加记录，并在 optimization-suggestions.md 的总览表「状态」列同步符号。*
