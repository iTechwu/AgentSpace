# AgentSpace 优化落地进度日志

> 本文档是 [`optimization-suggestions.md`](optimization-suggestions.md) 的**落地记录**，随优化实施逐条更新。
> 「建议是什么/为什么/怎么做」看 optimization-suggestions.md；「做了什么/做到哪了/剩什么」看本文档。
>
> 状态约定：✅ 完成 · 🟡 部分完成 · ⏳ 待办 · ⏸ 明确排除/暂缓。
> 条目编号对应 optimization-suggestions.md 的 §3.x 章节。
> **维护约定**：提交号与落地结果**仅**记录于本文档（optimization-suggestions.md 只保留状态符号）；落地后在此追加记录，并同步 optimization-suggestions.md 的状态符号。

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
- 剩余：`agent-detail.tsx`(1,657) / `conversation-shell.tsx`(1,590) 文件内拆分 ⏳（`channels-page-client.tsx` 3,925 行已拆，见 3.4-3）。

### 3.4-7 readTtl*Cache 重命名 —— ✅ 完成

- `aafd88fb`：`readLoadtestWorkspaceModuleCache` / `readLoadtestWorkspaceModuleCacheTtlMs` 改名为 `readTtlWorkspaceModuleCache` / `readTtlWorkspaceModuleCacheTtlMs`（TTL 缓存语义）；保留环境变量 `LOADTEST_MODE` / `DOFE_AGENT_WORKSPACE_MODULE_LOAD_CACHE_TTL_MS`（运维契约）与 `resolveLoadtestAwareInitialImDetailChannelNames`（语义上是 load-test aware 频道名解析，与本缓存无关）。

### 3.4-4 关闭 ignoreBuildErrors 冗余开关 —— ✅ 完成

- `5877aea5`：`next.config.mjs` 的 `typescript.ignoreBuildErrors` 由 `true` 改为 `false`，`next build` 恢复类型检查，`prebuild` 继续提供更早的依赖与 Web 类型检查。

### 3.3-3 模块循环依赖 —— ✅ 完成（消环目标达成）

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

### 3.3-7 / 3.2-6 Prisma 迁移（战略项）—— 🟡 Phase 2 已覆盖 22 读域 + 4 写路径

- `docs/0808/db_migration_to_prisma/README.md` 给出 A→B 渐进路线（A=Prisma 管 schema/迁移；B=Prisma Client 与 SQL 并存按域替换）。
- `schema.prisma` 于 `9b4ceb0e` 首次落地，现含 25 个 model（含 Skill/SkillFile/SkillDraft、WorkflowDefinition/Version/Trigger/Run/NodeRun 全家桶、ChannelParticipant/AccessRequest/Invitation、DocumentAgentAccess(带 4 列唯一约束)/PermissionRequest、AgentAccessRequest、Attachment、SkillServiceCatalog 等）。共享 `PrismaPg` adapter 单例收敛在 `prisma-client.ts`（DI setter + shutdown hooks），员工绑定通过 `agent_runtime` relation 获取 provider/name。
- **读路径 22 域全双 runner**（每域 4 实现 + 2 测试文件：pg 原型 `*-async.ts`/`*-cutover.ts` @deprecated 迁移期 fallback + 真 Prisma `*-prisma.ts`/`*-prisma-cutover.ts` 生产路径）：audit-log、notifications、task-execution-events、workspace-memberships、employee-runtime-bindings、task-queue、agent-skill、knowledge-proposals、document-agent-access、document-permission-requests、agent-access-requests、attachments、skill-service-catalog、workflow-definitions、channel-participants、channel-access-requests、channel-invitations、workspace-skills、workflow-runs、workflow-triggers、workflow-node-runs、workflow-versions。通用工厂 `cutover-runner.ts`（buildDomainCutover/buildDomainWriteCutover）+ 可观测 `cutover-observability.ts`（`PRISMA_CUTOVER_METRICS_ENABLED` 门控、成功采样、error 脱敏为 `"present"`）。
- **写路径 4 面**：audit-log create（`AUDIT_LOG_PRISMA_WRITE_ENABLED`）；notifications create/markRead/archive（`NOTIFICATIONS_PRISMA_WRITE_ENABLED`，dedupe 为 partial unique index 改用 updateMany→create→并发读回，COALESCE 语义用 `$executeRaw` 保真）；document-agent-access grant/revoke（4 列唯一约束走 Prisma upsert，revoke COALESCE 用 `$executeRaw`）；skill-draft upsert/delete（复合主键 Prisma upsert）。写语义统一 fail closed：primary 抛错不重写（`fallbackInvoked: 0`）。
- notifications、task-execution-events、workspace-memberships、employee-runtime-bindings 已分别接入 Inbox、飞书设置成员列表与工作流编辑页；audit read 已接入平台/工作区审计页，audit write 已接入平台管理员登录审计。
- **写路径已接入业务调用方**（`c46775bc` + `2e277992`）：services 层新增 async 变体并在 web 调用面切换——Inbox 标记已读/归档（markNotificationReadAsync / archiveNotificationAsync）、权限页文档授权/撤销（grant/revokeDocumentAgentAccessAsync）、Skill 草稿保存/发布/丢弃（save/publish/discardSkillDraftAsync）、cron 备份演练告警（notifyWorkspaceAdminsAsync）。flag OFF 时 cutover 自动落回 sync，行为不变。notifications create 其余 30+ 深层 sync 调用链（channel-access / runtime-provisioning / capability-workflow 等）属跨域编排，与 task enqueue 同批有意延后。
- 每域均保留独立 read/shadow flag（`<域>_PRISMA_READ_ENABLED` / `_SHADOW_READ_ENABLED`）。根 `build` 与 `typecheck:deps` 会先执行 `prisma generate`。
- `packages/db/src/prisma/*.test.ts` 已纳入 DB 默认测试门（189 例全过）；库存门禁 `scripts/verify-test-inventory.mjs` 302 default-owned / 183 frozen（摘要 `b95ff63482e9`）。
- **有意不做**：task enqueue 切 Prisma 写路径 —— `enqueueNativeTaskSync` 缠绕 employee binding 解析 + router session 创建 + 双生命周期事件写入，属跨表编排而非机械单表写，待编排层整体迁移时一并处理。
- **迁移期收尾条件**：pg 原型 44 个文件（`*-async.ts`/`*-cutover.ts`）在 shadow 对比连续 30 天零 drift 后整体删除；届时同步评估删除 worker-thread 同步 DB 层与重复行映射。

### 3.5-6 构建/版本漂移 —— 🟡 部分完成

- 版本号单一来源已做（见 3.5-3，`0945c0cb`）。
- `0a8e2acc`：esbuild `target: node20` 改为 `node25`，与 `engines.node ^25.9.0` 对齐，避免为 Node 25 原生支持的特性做下兼容编译。
- 剩余：`remote-daemon.ts` 硬编码 `:latest` 镜像 tag 锁 digest、`provider-runtime.ts` 硬编码 4 个默认模型名。

### 3.2-1 DB 异步池化 —— ⏸ 已被 Prisma Phase 2 取代

- 原建议：为 sync worker-thread DB 层另建 `pg.Pool` 异步平行路径，按域渐进切换。
- 评估结论：**不再单独立项**。「生产访问走异步连接池」这一目标已由 3.3-7/3.2-6 的 Prisma 双 runner 切流承接（PrismaPg adapter 即连接池层），再建 pg.Pool 会引入第三条 DB 访问路径，与「全生产访问收敛到 Prisma、删除 worker-thread/直连 pg」的终态相反。剩余的异步化需求（task enqueue、notifications create 深层 sync 链）随编排层迁移在 Phase 2 框架内解决。

### 3.2-2 拆分 postgres-schema.ts —— ✅ 完成

- `4,878 行 → 190 行编排门面 + 15 个关注点模块`：629 条 DDL 按迁移阶段机械切分为 `postgres-schema/statements/01-11`（严格源顺序展开拼接，切分前后语句数组 sha256 完全一致 `b1bccc45267a3c7b`）；版本/锁常量、history 回填、计数器自愈、post-commit 在线索引各成模块。对外导出面不变。
- 遗留（HEAD 存量，与拆分无关）：`postgres.test.ts` / `postgres-schema-version-guard.test.ts` / `database-schema-lock.test.ts` 三处仍锚 schema 版本 116/117（实际已到 120），均属 deferred 测试集，待随版本锚定机制一并修。

### 3.2-3 消除双重行映射 —— ✅ 完成

- **根因**：同步层 SQL 有 1,180 处不带引号的 `AS camelCase` 输出别名，PG 对不带引号标识符做小写折叠（`workspaceId` → `workspaceid`），无下划线的小写键机械 snake→camel 规则救不回，只能靠 worker 内 404 条 `NORMALIZED_ROW_KEY_ALIASES` 人工表恢复 —— 新别名漏登记即静默读 null（双重维护点，曾两次踩坑）。
- **步骤 1（cec15928）**：1,180 处别名全部加引号（`AS "camelCase"`），PG 直接保留大小写，读侧拼写与人工表恢复结果完全一致；新增 `postgres-alias-drift-guard.test.ts` 源码扫描守卫（任何未引号 camelCase 别名即失败），入 db 默认测试门（308 default-owned）。顺带修掉 skill-drafts 写 cutover flag-off 用例借用共享库残留行的存量 flake（改自播种夹具）。
- **步骤 2**：删除 `database.ts` worker 源里的 404 条人工别名表（文件 1,432 → 1,008 行），`normalizeRowKey` 收敛为纯机械 snake→camel 单路径；task-queue 规避注释同步更新。
- **步骤 2 验证期补修（同根因两个变体）**：① 同语句内别名已引号化、但 `ORDER BY/GROUP BY/DISTINCT ON/USING` 后仍用裸 camelCase 引用 —— 折叠后与保留大小写的引号别名不匹配，直接报 `column does not exist`（db `skill-artifacts.ts` UNION 的 `ORDER BY skillId`、`mcp-center.ts` 子查询外层 `ORDER BY displayName`）；守卫已扩展覆盖该模式。② codemod 首轮只扫了 db 包与 2 个 services 源文件，**services 测试文件**里同样经 sync worker 发 SQL 的裸别名漏网（`connections.test.ts` 的 `AS keyVersion`、`capability-workflow.test.ts` 的 `AS metadataJson`），读侧得 undefined；已补引号并全仓扫描（api/web/apps 无残留）。顺带修复 coordinator.ts 双引号串内引号注入导致的 TS 解析错误（改模板字面量）。回归：db 全环绿、services 默认 69 文件全环 exit 0、db `pnpm types` 干净。
- **新发现（当日已修，见 3.2-7）**：db `pretest` 的 `prisma:verify:pilot` 在 HEAD 存量红 —— pilot schema 与真实库 drift 70+ 条（attachment PK 变复合键、7 张表 jsonb/默认值滞后等），堵住整个 db 默认测试门，已按域重新对齐 pilot schema。

### 3.2-7 pilot schema 重同步 —— ✅ 完成

- **根因**：pilot `schema.prisma` 的 10 个模型（77 条 drift）与真实库结构脱节。其中 Attachment 模型是重灾区 —— 虚构了 `content_digest`/`note`/`upload_id`/`deleted_at`/`deleted_by_*`/`updated_at` 列（疑似与 EAD 域 `employee_artifact` 的列混淆）、单列主键（真库为 `(workspace_id, id)` 复合键）、`source_message_time` 声明为 Timestamptz（真库为 TEXT）、`size_bytes` 声明 Int?（真库 BIGINT NOT NULL DEFAULT 0）。
- **修复**：按真库 information_schema 逐模型对齐（比较器为单向 Prisma→DB 校验，default 只查有无）：① jsonb 列全部 `String`→`Json`（skill_service_catalog×7、skill.config_json、skill_draft.draft_json、workflow 定义/运行/版本/触发器/节点全家 ×11）；② 库默认值补齐 `@default`（状态列、jsonb '{}'/'[]'、cap_drop_json `["ALL"]` 等）；③ attachment 重写为复合主键 + 真实列（`sha256` 映射 `contentDigest`、补 `kind` 列）；④ `workflow_run.current_sequence` BigInt→Int（真库 integer），补 `history_sequence` BigInt；⑤ `skill.source_type`/`config_json` 去 nullable（真库 NOT NULL），补 `active_artifact_digest`；⑥ `workflow_definition.createdBy` 补 `@map("created_by")`。
- **连带修复**：draft_json Json 化后 `skill-drafts-prisma-write.ts` 的行映射接口放宽为 JsonValue 并统一字符串化，保持 `SkillDraftRecord.draftJson: string` 契约不变。
- **验证**：`prisma:verify:pilot` 0 drift（25 模型全匹配）、`prisma generate` 通过（真实 Prisma 解析器接受全部 @default/复合主键）、db `pnpm types` 干净、**db `pnpm test` 全链 exit 0（pretest 门解除，默认测试环恢复可用）**。

### 3.2-4 拆分 db 巨型文件 —— ✅ 完成

- **external-integrations.ts（2,576 → 614 行核心 + 8 域模块）**：私有共享层（select 片段 / 行映射 / 守卫 / JSON 规范化）下沉 `external-integration-internal.ts`；7 个绑定/映射/outbox 域实现迁入 `integrations/external-*.ts`；原文件保留核心集成 CRUD + 事件 + re-export barrel，导入面零改动。internal ↔ core 互引为函数声明级 ESM 环，live binding 安全。回归：services 飞书 DB 测试（data-plane 8/8 + outbound 6/6）运行时穿透验证。
- **types.ts（2,237 → 22 行 barrel + 20 域文件）**：216 个导出按域下沉 `src/types/`（identity…capability，24-344 行/文件），跨域引用生成 sibling `import type`，外部包类型（DaemonProvider/KnowledgeAssignmentMode）归位；`from "../types.ts"` 导入面零改动。
- **mcp-center.ts（1,467 → 72 行 barrel + 7 文件）**：26 个私有导出下沉 `mcp-center/mcp-center-internal.ts`（列片段/行映射/类型守卫，无环）；6 个域模块 catalog(8 fn)/connections(7)/secrets(4)/discovery(2)/operations(11)/tool-audits(3) 各持 input interface，域私有 helper（writeMcpCatalogItemSync/claimDueHealthCheckOperationSync/defaultConnectionStatusForFailedOperation）随域内聚不外泄。
- **验证**：db `pnpm types` 干净、db 全测试环 exit 0（含 mcp-center 10/10）、services `pnpm types` 干净。提交：996d281a / 82bde242 / d8192384。

### 3.2-5 类型安全加固 —— ✅ 完成（决策：不引入 Kysely）

- **决策**：不引入 Kysely 等 typed query builder。三个理由：① Kysely 是纯异步 API，套不进 worker_thread 同步层（`*Sync` 门面 3,020 处调用无法受益）；② Prisma Phase 2 正在逐域替换该层，Prisma Client 本身就是 typed query builder，再加第二个 builder 是反向投资；③ 双 builder 并存期维护面翻倍。
- **替代落地**：`postgres-sql-column-guard.test.ts`（已入测试门）—— 以 `postgres-schema/statements/` DDL 为唯一事实源（解析 CREATE TABLE + ALTER ADD/DROP COLUMN，跨行/单行形态，125 张表），静态扫描 `src/` 全部手写 SQL（模板字符串 + 测试文件双引号串，剥离 `${}` 插值）：限定引用 `table.column` 与 `INSERT INTO` 列清单逐列校验，typo 以 file:line 报告。零运行时依赖，负例注入验证可捕获。
- **现状扫描结果**：存量 SQL 无此类 typo（此前担心的引用均为解析器缺口而非真 bug）。与 3.2-3 的别名引号守卫互补：一个管别名大小写折叠，一个管列名存在性。

### 3.3-5 手写 `.d.ts` 孪生去重 —— ✅ 完成（删除孪生，单源 dist-types）

- **定性**：`lark-cli.d.ts` 与 `integrations/core/*.d.ts`(9) 并非人工维护的孪生，而是 2026-07 旧 dist-types 构建产物的手工拷贝被误提交。漂移已实际发生：lark-cli 孪生 interface 全为空壳（成员丢失），outbox 孪生落后再生版 1 行。
- **删除依据**：仓内导入一律显式 `.ts` 扩展名（tsc 从不读取同级 `.d.ts` 孪生）；对外类型出口由 `dist-types`（git-ignored，`pnpm types` 再生）统一产出，天然单源。
- **回归**：services `pnpm types` 干净、`lark-cli.test.ts` 11/11、web `pnpm typecheck` 干净。

### 3.3-6 `preloaded-skill-sources.ts` 内联字符串外置 —— ✅ 完成

- **改动**：176KB 内联字符串（146 行巨型模块，diff 全是转义内容）外置为同目录 `preloaded-skill-sources.json`（3 skill / 19 文件，逐键缩进）；模块收敛为 46 行类型 + 查找门面，常量与 `findPreloadedAgentTemplateSkillSource` 导入面零改动。
- **加载方式**：运行时 `readFileSync`（服务端专用包）—— tsc/declaration 不解析整份 JSON，dist-types 不引用数据文件，无 import-attributes 兼容面。
- **验证**：冒烟 3 entries 加载、SKILL.md 内容完整（1631/13167/7848B）、finder 命中「金融分析代理」；services `pnpm types` 与 web `pnpm typecheck` 干净。

### 3.3-9 `xlsx` CDN tarball 供应链锁定 —— ✅ 完成

- **缺口**：SheetJS 0.20.x 只经自有 CDN 分发（npm registry 停留在 0.18.5），services 依赖为 `https://cdn.sheetjs.com/...tgz` URL 形态；实测 pnpm 对 URL tarball 依赖**不记录 integrity**（`--lockfile-only` 重生成后 lockfile 仍无 hash），每次 `pnpm install` 都重新信任 CDN 当下返回的字节。
- **修复**：tarball 一次性下载入仓 `packages/services/vendor/xlsx-0.20.3.tgz`（2.3MB，sha512 记录于 `vendor/README.md`），依赖改 `file:vendor/xlsx-0.20.3.tgz`；lockfile 现固定 `integrity: sha512-...`，install 不再触网，构建可离线复现。README 含升级与校验步骤。
- **验证**：xlsx 0.20.3 运行时导入与写入 OK、`parse-file.test.ts` 6/6、services `pnpm types` 干净。

### 3.4-3 拆分 `channels-page-client.tsx` —— ✅ 完成

- **改动**：3,925 行单文件拆为 2,091 行主组件 + 7 个域模块（shared 135 / model 604 / hooks 261 / icons 193 / modals 378 / views 559 / channel-workspace-header 376）；主文件保留 "use client"、原导入面与组件结构，跨模块导入全部生成后人工补齐。
- **附带修复**：全量 vitest 暴露 3 个与拆分无关的滞留失败 —— `c46775bc` Prisma cutover 将 `markNotificationRead/archiveNotification/notifyWorkspaceAdmins` 改名 `*Async` 后，`inbox/actions.test.ts` 与 `cron/backup-recovery-drill/route.test.ts` 的 `vi.mock` 仍导出旧名。已补齐并改 `mockResolvedValue`（d105c02）。
- **验证**：web `pnpm typecheck` 0 错误；channels 44/44、workspace-frame 35/35；修复后全量 vitest 144 文件 1,155 用例全绿。

### 3.4-5 评估部分静态渲染 —— ✅ 完成（结论：保持 `force-dynamic`）

- **盘点**：34/34 个 page.tsx 均声明 `force-dynamic`（全仓含 API route 共 120 处）。逐页核对：`/w/*` 全部经 `getWorkspacePageContext → cookies()` 会话门控；`/platform`、`/platform/audit`、`/channel-invite` 经 `getCurrentUser()`；`/` 与 `/auth/error` 读 `searchParams`。
- **结论 1（路由级 `revalidate`/SSG 不可行）**：所有页面读 cookies 或 searchParams，任一访问都强制请求期渲染；且会话门控数据进共享 ISR 缓存存在跨用户泄漏风险——不是「低个性化」问题而是结构不可用。
- **结论 2（降载目标已被现有架构承担）**：客户端导航零请求由自研 WorkspaceModuleCache + TTL（3.4-7 `readTtl*Cache`）+ 失效事件体系承担；首屏由 SSR 数据 seed 直出（文档标注保留亮点）。
- **结论 3（升级路径为 `cacheComponents`，暂不启用）**：Next 16.3 的 cacheComponents（组件级 PPR 谱系）会**替代**全部 `dynamic`/`revalidate` 段配置（全仓 120 处声明迁移）；本站外壳本身高度个性化（工作区名/计数器/用户身份），静态壳占比趋近于零；唯一候选 `/platform/audit` 为低流量管理页。无实测 SSR 吞吐/TTFB 瓶颈数据前收益不抵迁移风险。
- **重启条件**：出现 SSR 吞吐/TTFB 实测瓶颈，或新增真正无会话公共页面（营销/登录改版）时，再评估 `cacheComponents` 增量接入。

### 3.4-8 统一 page.tsx 样板 —— ✅ 完成（13/34 页收敛）

- **改动**：新增 `app/w/[workspaceSlug]/_lib/render-workspace-module.tsx` 封装「getWorkspacePageContext → loadWorkspaceModuleDataWithMeta → WorkspaceInitialModuleData → *PageClient」四步；13 个标准形态页收敛为单次调用（8 个无 viewer：automations/calendar/costs/org-chart/performance/skills/tables/templates；5 个 withViewer：approvals/inbox/knowledge/market/task-board），25-34 行 → 16 行，净删 119 行。
- **不收敛范围**：带 searchParams / 自定义 loader options 的 im、settings、contacts、agents 及重定向页/详情页保持原样 —— 它们的样板差异不是纯样板而是页面逻辑。
- **验证**：逐页 diff 对齐 render props（typecheck 抓出 automations 需补 workspaceId/workspaceSlug）；web `pnpm typecheck` 0 错误、全量 vitest 1,155/1,155。

### 3.4-6 i18n 无 key 体系评估 —— ✅ 完成（结论：保持现状，记录迁移路径）

- **现状盘点**：`LanguageProvider`（localStorage 持久化 zh/en）+ `tx(zh, en)` 内联三元；4,263 个 `tx(` 调用点 / 103 文件；`presentation.ts`（620 行）集中 ~20 个 `translate*(value, tx)` 枚举标签映射，测试齐全。
- **结论（不迁移）**：仅 2 种语言时 `tx(zh, en)` 内联即**编译期类型安全字典**——两串同签名、无 key 漂移、无缺译运行时错误；4,263 调用点迁移成本巨大而当下收益为零。无 key 的真实代价（翻译平台协作、缺译检测、文案全量检索）仅在 >2 语言或外包翻译时兑现。
- **迁移路径（若触发，已验证可行）**：`tx` 调用点是机械可提取源——codemod 将每对 `(zh, en)` 提取为字典条目（key 用 zh 串 slug 化），`tx` 签名不变、内部改查字典 → **调用面零改动**；`presentation.ts` 映射表天然就是字典片段；协作时字典导出 XLIFF/CSV。
- **触发条件**：产品决定上线第 3 种语言，或引入翻译平台（Crowdin 等）协作。在此之前不投入。

### 3.5-8 `pollRemoteTasks` 轮询请求放大 —— ✅ 完成

- **改动**（`9fd0836`）：操作队列 claim（app/MCP/skill/service/mount 五连级联）加空闲背压——级联全空后按 `operationClaimIntervalMs`（默认 15s，±20% 抖动）跳过后续级联，认领成功立即重置；**任务 claim 保持每 tick 一次**（用户延迟零回归）。空闲稳态请求量 6/tick/runtime → 1/tick。
- **配置**：新 `--operation-claim-interval` flag / `DOFE_AGENT_OPERATION_CLAIM_INTERVAL` env（下限 1s），relaunch 参数与 help 同步；默认值常量收敛 `state.ts`。
- **验证**：remote-daemon 35/35（新增背压 interval 解析 4 分支 + activity map 用例）、install-remote-daemon-script 9/9、daemon `pnpm types` 干净。
- **不做合并端点的原因**：五队列响应形态/执行流各异，服务端合并 claim 需新 API + 兼容面；daemon 侧背压零 API 改动即达同等降噪。

### 3.6-6 env 模板漂移审计 —— ✅ 完成（一致性下限，非生成器）

- **改动**（`4041898`）：新增 `scripts/audit-env-templates.mjs` 并接入根 `pretest`（随 `pnpm test` 机器强制）：自动发现全部 git 跟踪 env 模板（11 个 / 186 键，新增模板自动纳入）、键名规范 `^[A-Z][A-Z0-9_]*$`、单模板重复键、跨模板编辑距离 ≤2 近重复（疑似 typo）三类检查；`KNOWN_NEAR_DUPLICATE_PAIRS` 登记经代码确认的 4 对合法共存。配 7 用例测试（`audit-env-templates.test.mjs`），deferred digest 同步。
- **不做单一 schema 源生成器**：各模板注释即部署文档，生成会牺牲；机器强制一致性下限先落地，生成器留待模板数量继续增长时再评估。
- **验证**：三段 pretest 链全通过；审计首次运行即扫出 4 对近重复并逐一代码核实为合法（豁免表注明出处）。

### 3.6-7 `dev-daemons.sh` 硬编码本机路径 —— ✅ 完成

- **改动**（`b72a144`）：`REPO` 改为脚本自定位（`dirname` 推导）；`NODE_BIN` 取交互 PATH 的 `node`（daemon 依赖交互 PATH 探测 provider CLI，注释已说明）；workspace id、daemon id、device/runtime 名称、providers 五项保留本机 dev 默认值并全部支持 `DOFE_AGENT_DEV_*` env 覆盖。任意克隆可直接运行。
- **验证**：`bash -n` + `cmd`（自定位路径、`%q` 转义、env 覆盖 `ws-test` 均生效）+ `status` 冒烟。

### 3.6-8 `audit-node-engines.mjs` 借用 `.pnpm` 的 semver —— ✅ 完成

- **改动**（`8562ee4`）：根 `package.json` devDependencies 显式声明 `semver ^7.8.5`（进 lockfile 锁定）；脚本删除 `createRequire` + `loadSemver()` 兜底加载（约 25 行），改为顶层 `import semver from "semver"`（ESM 按脚本自身位置解析到仓库根 node_modules）。
- **测试夹具跟进**：`linkSemverInto`（symlink 借用 `.pnpm/semver@x`）随之移除；夹具改为创建空 `node_modules/.pnpm` 目录——依赖扫描目录的存在性此前由 symlink 顺带保证，删除后 `readdirSync` 直接抛错（首次运行即被 8 用例中的全绿用例抓出）。
- **验证**：真实仓库审计通过（11 manifest / 869 唯一包 / jsdom 唯一已知例外）；测试 8/8；三段 pretest 链通过。

### 3.6-9 bin wrapper `spawnSync` 子进程开销 —— ✅ 完成

- **改动**（`e0e46c9`）：`apps/cli/bin/dofe-agent.js` 与 `apps/mcp-egress-proxy/bin/dofe-mcp-egress-proxy.js` 不再 `spawnSync` 子进程传 `--experimental-strip-types`，改为顶层 `import { main }` 后调用（Node ≥23.6 类型剥离默认开启，engines 锁 `^25.9.0`），与 `packages/daemon/bin` 既有模式对齐。每次调用省一层进程开销。
- **proxy 入口跟进**：`main` 改 export + `isMain` 守卫（`argv[1]` URL 比对 `import.meta.url`）——直接执行（Docker ENTRYPOINT 跑 `dist/index.js`）仍自启，被 wrapper import 时由 wrapper 显式调用，不重复执行。esbuild 打包后 dist 冒烟确认自启正常。
- **顺带修复 3.5-8 遗漏**：CLI `DaemonConfig` 补 `operationClaimIntervalMs` 字段（`DOFE_AGENT_OPERATION_CLAIM_INTERVAL` env 可覆盖，默认 15s 与 daemon 侧 `state.ts` 一致）——此前 `typecheck:cli` 报 TS2345。
- **验证**：CLI `doctor`/`daemon status`/未知子命令退出码 0/0/1；proxy wrapper 与 dist 缺 key 错误路径均 exit 1；proxy 48 测试通过；CLI + daemon typecheck 通过。

### 3.6-10 `workflow-worker` types 依赖 `apps/web` 的 tsc —— ✅ 完成

- **改动**（`847a069`）：根 `package.json` devDependencies 显式声明 `typescript ^5.9.3`（与 web/db/cli/workflow-worker 既有声明同版本，pnpm 去重同一实例）；根 `typecheck:deps`（5 处）/`typecheck:web:only`/`typecheck:daemon`（cli 宿主）、`packages/{domain,db,services,daemon}` `types`/`pretypes`、`apps/{mcp-egress-proxy,workflow-worker}` `types` 共 9 处 `node_modules/.bin/tsc` 相对路径借用全部改为裸 `tsc`——pnpm run 将包级→根级 `node_modules/.bin` 依次加入 PATH，自身未声明 typescript 的包（domain/services/sandbox/daemon/mcp-egress-proxy）解析到根实例。
- **web 的 `./apps/web/node_modules/.bin/next typegen` 保留**：next 是 web 自身声明依赖，非借用。
- **验证**：`typecheck:deps`、`typecheck:daemon`、daemon `pretypes` 全链（domain→db→services→sandbox→daemon）、mcp-egress-proxy 与 workflow-worker `types` 全部通过，无 error TS。

### 3.6-11 部署物分散 —— ✅ 完成（统一部署拓扑 + 组件所有权文档）

- **改动**（`9030a87`）：新增 `docs/deployment-topology.md`，不重复各 README 的操作细节，只收敛三件事：
  - **7 个部署面**：A self-hosted Compose（单机生产）/ B systemd 裸机 / C 开发拓扑（mac web+local daemon，dev-server 4 provider 容器回连）/ D one-runtime-per-container / E managed-node（含 CI 多 workspace）/ F staging 发布门 / G 独立 feishu-worker。`deploy/postgres/` 标注为本地 dev 遗留、非部署路径。
  - **所有权矩阵**：飞书长连、任务执行、Trigger 写入、task-commit 对账、模型出口、DB/中间件各映射唯一所有者进程（按部署面），「其余皆非所有者」列直接回答"能不能再起一个"。
  - **易踩坑约定**：飞书 worker 单一所有权（daemon-claude 托管 vs 独立 compose 二选一）置顶，另含 token 绑定首注册、`WORKFLOW_CUTOVER_MODES` 两端对齐、发布门前置、基础设施一律外部化。
- **事实核对**：self-hosted compose 服务清单（db-init/web/runtime-maintenance/workflow-worker/daemon-claude/daemon-codex）与 nginx conf 域名（仅 `dofe-agent.local.dofe.ai`，`agentspace.local` 在宿主 nginx）均对照源文件确认后写入。

### 其余 P2 待办（未启动）

| 条目 | 主题 |
| --- | --- |
| 3.3-4 | 飞书 24 个测试文件游离于测试门之外 |
| 3.5-4 | 拆分 `remote-daemon.ts`(2,138)/`task-context.ts`(1,544) |
| 3.5-5 | sandbox 抽象决策收口（Cube `exec()` 未实现，`connectSandbox()` 无调用方） |
| 3.5-7 | 测试路径与 `dist/` 产物对齐（esbuild CJS banner 覆盖） |
| 3.6-12 | docs 按日期目录缺乏索引 |

---

## 测试与 CI/CD（专项，⏸ 本轮排除）

> 按决策，本轮优化明确排除测试 CI 专项。§3.6-1（ci.yml 流水线）、§3.6-2（`integrations.test.ts` 11k 行 + `daemon.test.ts` 844 行入默认列表）、§3.3-4（飞书测试入内）整体保持待办。
> 已推进的子项：`permissions`/`document-permissions`/`prisma` 测试纳入默认门禁（见 3.3-8）。

---

*本日志与 `optimization-suggestions.md` 配套维护；落地后在本日志追加记录，并在 optimization-suggestions.md 的总览表「状态」列同步符号。*
