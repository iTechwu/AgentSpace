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
- 第三阶段（`b032931c` + `6592aa6f`）：`data.ts` 装配层本体（此时已增至 3,694 行）再拆为 `data/` 下 13 个域模块——`cached`（cache 读取器与常量）、`channels`（477 行）、`inbox`/`inbox-items`、`agents`（852 行）、`runtime-views`、`skills`、`agent-record`（564 行）、`task-board`、`org-chart`、`cost`、`knowledge`、`misc-pages`（performance/data-tables/automations/calendar/templates）。原文件收敛为 88 行 barrel（42 个原 export 按域 re-export + data-types 57 类型显式 re-export + approvals 转发），57 个引用方零改动。**踩坑两则**：① barrel 相对路径须为 `./data-types`（barrel 仍在 dashboard/ 下，写 `../` 触发 TS2307 且被 TS7006 连锁掩盖）；② `export *` 在该解析配置下不可靠，须显式 type re-export；③ 根 `.gitignore` 的无锚定 `data/` 规则误吞 `features/dashboard/data/`，首提交漏 13 个模块文件，`6592aa6f` 改锚定（`/data/` + `apps/web/data/`）补交。验证：web typecheck 0 新增错误；dashboard vitest 15 文件 124 用例 + 引用方域 19 文件 130 用例全过；inventory/engines 门通过。

### 3.4-2 Web 代码分割 —— ✅ 完成

- `32a1bb8a`：`WorkspaceModuleHost` 17 个页面客户端全部改 `next/dynamic` 按模块懒加载（路由 page.tsx 仍静态导入保证 SSR 直出），全量 vitest 144 文件 / 1,153 用例通过。
- knowledge-page-client 四件套拆分（`2a86a772` + `95349d52` + `a9ada12a` + `cce1b274`）：1,580→1,114 行，子组件移出独立文件——`parse-task-panel.tsx`、`assignment-panel.tsx`、`document-page-viewer.tsx`、`knowledge-tree-node.tsx`。
- `conversation-shell.tsx` 拆分（`139c9859`）：1,590→1,214 行组件本体 + `conversation-thread.ts` 275 行（线程类型与纯函数：排序/乐观消息匹配/slash 命令构造）+ `conversation-scroll-anchors.ts` 150 行（滚动锚点持久化与恢复）；公共导入面不变（12 个引用方零改动）。
- `agent-detail.tsx` 拆分（`9cbb98f6`）：1,657→1,296 行主组件 + `agent-detail-helpers.ts` 291 行（20 个纯格式化/解析函数）+ `agent-runtime-capabilities.tsx` 51 行 + `knowledge-picker-modal.tsx` 67 行；`AgentDetail`/`AgentDetailTab` 导出面不变（2 个引用方零改动）。

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

### 3.3-8 / 测试门覆盖 —— ✅ 完成

- `707e80a5`：`permissions`、`document-permissions` 纳入 services 默认测试脚本与 `verify-test-coverage.mjs` 的 COVERED_PREFIXES；daemon 默认测试纳入 `daemon-client.test.ts`。
- `a74f362c`：`packages/db/src/prisma/*.test.ts` 纳入 db 默认测试脚本与 `verify-test-inventory.mjs` 门禁。（注：本提交号现合并为 `f8e0f6d4`，squash 后 read-cutover.ts + .test.ts 与默认门禁同提交落地。）
- `a7c252eb`：`messages` / `notifications` / `channel-access` 三个测试包纳入 services 默认测试脚本与 inventory default-owned；messages 14 项受 managed_runtime 夹具约束的用例以 `MANAGED_RUNTIME_AVAILABLE=1` env 门控跳过。
- `52f49d7c`（收尾）：`documents` / `employees` / `knowledge` 三域 16 个测试文件纳入 services 默认测试脚本与 inventory default-owned（deferred 185→170）。**顺带修复预存失败**：`recovery-worker.test.ts`「审批解锁 worker」用例未跟上 `0696451d` 的恢复操作双人审批设计（`requiredApprovals` 默认 2），补第二位管理员审批断言——该测试从未进 CI 故未暴露，纳门即暴露。注意 `src/knowledge` 前缀须带斜杠（`src/knowledge/`），否则误吞 `knowledge-proposals`。验证：services 全门 954 pass / 0 fail。
- 飞书 24 个测试文件的纳门见 3.3-4（已完成）。

### 3.6-3 / 3.6-4 CLI 巨型文件与测试脚本 —— ✅ CLI 侧完成

- `apps/cli/src/commands/integrations/feishu.ts` 10,597 行已拆分（见下文 P2 §3.6-3）。
- `apps/cli/src/commands/daemon.ts` 2,233 行已拆分（见下文 P2 §3.6-3 补充）。
- CLI 测试脚本与 verify-test-inventory 的 default-owned 集已对齐（见下文 P2 §3.6-4）。

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

### 3.6-12 docs 按日期目录缺乏索引 —— ✅ 完成

- **改动**（`bc318f5`）：新增 `docs/README.md` 作为 docs/ 唯一入口——根级 3 常驻文档（progress-log / optimization-suggestions / deployment-topology）+ 14 个日期目录按主题分组索引（产品规格 11 / 架构决策 4 / 数据耐久 1 / 测试 4 / 运维发布 1 / superpowers）。
- **归档策略成文**：新主题建 `MMDD/<slug>/` 目录并在索引登记；主题完结追加状态与提交号；目录名稳定不删改（外部按路径引用）。
- **「大体积 evidence 移入 artifacts/」半项经核实不采纳**：`artifacts/` 在 `.gitignore`（移入即失去版本化留档），且 `0801/employee-data-durability/evidence/` 是 5 个演练脚本的硬编码输出路径、`0803/test/results/` 的 playwright 结果与截图被测试报告正文引用（含双 worker 竞争复现 JSON 供修复对照）——移动即断链。docs/ 全部 7.6M 中证据约 5.6M，属刻意留档而非构建垃圾。

### 3.5-7 测试路径与 `dist/` 产物对齐 —— ✅ 完成（dist 冒烟入测试门）

- **改动**（`f3e623b`）：新增 `packages/daemon/src/dist-smoke.test.ts` 并入包测试清单：每次先 `esbuild` 重建（亚秒级）再加载全部 6 个 dist 入口（dofe-agent / cli / agent-router / index / daemon-client / agent-router/index），断言导出面与 `--version` 行为——bundle 图可求值、CJS banner 的 require/__filename/__dirname 注入不冲突、入口 isMain 守卫在测试进程下不触发。
- **首跑即抓到真实缺口**：`services` 的 `preloaded-skill-sources.ts` 在模块顶层按 `import.meta.dirname` 运行时读同目录 JSON（3.3-6 有意外置），bundle 后路径解析到 `dist/` 而数据文件不随产物输出——`dist/dofe-agent.js` 正是 tgz 部署到 provider 容器的入口（`Dockerfile.provider-runtime` 的 `/usr/local/bin/dofe-agent`），import 即 ENOENT。线上容器未崩仅因现有镜像早于 4c648b38；**下次构建 provider-runtime 镜像必然崩溃**。
- **修复**：`scripts/build.mjs` 在 build 后把 `preloaded-skill-sources.json` 拷入 `dist/`（`files` 含 dist，tgz 随包发布）；dofe-agent/cli/index 三个引用 bundle 全部恢复 `--version` 可启动。冒烟测试永久守卫此契约。
- **验证**：dist 冒烟 4/4；daemon 全套 242 测试 0 fail（13 个 e2e 门控 skip）；typecheck:daemon 通过；pretest 三段链通过（inventory digest 同步 186→187）。

### 3.5-5 sandbox 抽象决策收口 —— ✅ 完成（移除未完成的 Cube provider）

- **决策**（`bbc935f`，P1）：cube/ 自仓库初始化后零迭代，exec() 数据面（envd/E2B，TODO 46）落地起未实现——旧版双开关（`SANDBOX_PROVIDER=cube` + `CUBE_ENABLE_EXPERIMENTAL=true`）打开只会**真实创建云沙箱后 exec 必抛 NOT_READY**，纯成本零能力；且无任何 env 模板/README 承诺该能力。按优化项给出的两个方向中可行的「移除」收口，恢复时从 git 历史取回。
- **改动**：删除 `packages/sandbox/src/cube/`（client/config/sandbox + 2 测试，-1,019 行）；`connectSandbox` 收口 local-only——显式 `local` 之外的 provider（含 legacy `SANDBOX_PROVIDER` env 名）一律 fail-closed 报错，绝不落到半可用实现；`SANDBOX_PROVIDER_ENV` 常量移入 factory。
- **条目前提修正**：「`connectSandbox()` 无调用方」已过时——`provider-runtime.ts` 两条执行路径（:1509/:1748）一直在用，`Sandbox`/`LocalSandbox`/`ExecController` 是热路径类型，全部保留未动。
- **验证**：sandbox 4/4、daemon 242 全过（13 e2e skip）、`typecheck:deps`/`typecheck:daemon` 零错误、inventory 默认集 308→306（删除 2 个默认集文件，deferred digest 不变）。

### 3.5-4 拆分大文件 —— ✅ 完成（三大文件全部拆毕）

- **remote-daemon.ts**（`fc3bbe0`）：2,178 行单文件拆为 `remote-daemon/` 12 个模块（activity/errors/queue/config/usage/mcp/heartbeat/operations/task-execution/poll/command/internal，最大 574 行），原文件降为 41 行 barrel——显式重导出全部原有公共符号（6 类型 + 24 值），内部符号不外露；外部 import（workers/cli/index `export *`/测试）零改动。模块按 DAG 分层（leaf→config→mcp→heartbeat/operations/task-execution→poll→command），无值级环；workers 对 barrel 的 `type RemoteDaemonConfig` 为类型导入，编译后擦除。
- **task-context.ts**（`2cbad3cc`）：1,544 行拆为 `task-context/` 7 个模块（payload/notifications/materialize/skills/prompt-lines/prompt/prepare，最大 369 行），原文件降为 27 行 barrel 重导出 18 个公共符号。prepare.ts 保留主编排全序（durable head 物化→附件→skills 快照→知识/频道文档→prompt 组装），prompt-lines/prompt 按渲染层职责分层。
- **provider-runtime.ts**（`4d25905`）：1,820 行（88 个顶层声明）拆为 `provider-runtime/` 11 个模块（types/executables/catalog/tool-capabilities/health/metadata/provider-env/router-diagnostics/legacy-runtime/agent-router-task/failures，最大 455 行），原文件降为 20 行 barrel 重导出 15 个公共符号（8 类型含 RemoteRuntimeRecord 别名 + 7 值）。划分沿执行面分层：catalog 探测/工具能力/健康与凭据探测/元数据/provider env 与 sandbox exec/router 事件与失败分类/gemini+nanobot 直跑路径/agent-router 主流程/失败元数据；顺带移除死导入 randomUUID。
- **验证**：三轮均过 daemon `tsc --noEmit` + 全套 242 测试（229 pass/13 e2e skip，含 dist-smoke 重建 bundle 断言新模块图可打包）+ dist 构建 + apps/cli typecheck；聚焦测试 35/35、22/22、49/49。
- 关联余量：§3.6 构建漂移提到的「4 个默认模型名硬编码」现位于 `provider-runtime/catalog.ts`，条目仍 🟡。

### 3.3-4 飞书测试纳入测试门 —— ✅ 完成（含 1 个 dev 预存回归修复）

- **纳门**（`8a990c2`）：services `package.json` test 循环新增 `src/integrations/providers/feishu/__tests__/*.test.ts` 全部 23 个文件（12,145 行）——19 个纯单测文件 154 个测试实跑；5 个 `*-db.test.ts`（inbound/data-plane/outbound/websocket-worker/agent-bot-bindings，55 个测试）维持各自 `DOFE_AGENT_FEISHU_*_DB_TESTS=1` env 门控 skip，CI 可选开。`verify-test-coverage.mjs` 的 COVERED_PREFIXES/GLOBS 同步收编该目录（覆盖 69→92 文件），未来新增文件不再游离。
- **顺手修复 dev 预存回归**（`c02fd360`）：纳门后跑全门暴露 `prisma-write-cutovers.test.ts` 在 HEAD 即失败（stash 复现确认与本改动无关）——`upsertSkillDraftPrisma` 把 draftJson 字符串直接赋给 Prisma `Json` 字段产生 jsonb 双重编码，与 sync 路径（单层）不一致，读回 `parseDraftSnapshot` 形状校验失败返回 null。对齐 audit-log/notifications 既有「写入前 JSON.parse」惯例修复；db 侧既有测试用 mock client 回显，真实 jsonb 往返从未被覆盖（mock 盲区）。
- **验证**：23 文件单跑 154 pass + 55 env-gated skip；修复后 services 全门 916 tests / 847 pass / 0 fail / 69 skip；db 侧 5/5、`db types` 通过。

### 3.6-3 apps/cli `feishu.ts` 巨型文件拆分 —— ✅ 完成

- **拆分**（`e4ba456`）：10,597 行按域拆为 `src/commands/integrations/feishu/` 下 12 个模块——`types`（类型与常量 752 行）、`command`（命令分发 666 行）、`create`/`agent-bot`/`bindings`/`data-operations`/`readiness`/`evidence`（3,885 行，证据域内部实现）/`smoke-env`/`smoke-plan`（各域 CLI 命令）、`cli-shared`（共享辅助）、`worker`（WebSocket worker 装配）。原文件收敛为 14 行 barrel，72 个公共导出按原路径再导出，`integrations/index.ts` 与 31 个测试导入零改动。
- **方法**：声明级重组——解析全部 ~230 个顶层声明，按域区块映射归入模块；内部声明补 `export`；外部依赖（db/services/args/format）与跨模块依赖按词边界扫描逐模块布线。无 `noUnusedLocals`，过近似导入无害。
- **验证**：apps/cli `tsc --noEmit` 0 错误；`integrations.test.ts` 182/182 通过（该文件 11k 行，仍按 3.6-2 决策排除在默认测试脚本外，作为手动验证跑）。

其余 P2 待办表至此清空。

### 3.6-3 补充 apps/cli `daemon.ts` 拆分 —— ✅ 完成

- **拆分**（`03a3d8d`）：`daemon.ts` 2,233 行拆为 `src/commands/daemon/` 下 6 个域模块——`config`（配置与 provider 探测）、`command`（命令分发与子命令编排 539 行）、`lifecycle`（pid/进程/日志管理）、`task-runner`（队列任务轮询与执行 1,145 行）、`runtime`（provider 运行时适配）、`utils`（任务/路径/恢复快照工具）。原文件收敛为 7 行 barrel，`runDaemonCommand` 等 5 个导出 + 3 个 lib re-export 按原路径再导出，`src/index.ts` 与 `daemon.test.ts` 零改动。
- **方法**：与 feishu.ts 相同的声明级重组；额外逐项保真 import 别名（`原名 as 正文名` 方向）、type-only import、内联 `type` 标记（首轮脚本踩坑：别名取错端 + type-only 被重组为 value import，导致 strip-types 运行时报 ESM 链接错误）。
- **验证**：tsc `--noEmit` 0 错误；`daemon.test.ts` 19 pass / 3 fail 与 HEAD 完全一致（stash 对比确认 3 个 TOS 附件用例为预存失败，缺 TOS 环境）；CLI 默认测试 24/24。

### 3.6-3 补充 services `skills/import.ts` 拆分 —— ✅ 完成

- **拆分**（`7242b7e`）：`packages/services/src/skills/import.ts`（2,305 行）拆为 `skills/import/` 下 11 个域模块——`types`、`import-api`（4 个公共入口）、`persist`（持久化与提交）、`importers`（存储/本地/GitHub/GitLab/skills.sh/ClawHub 各源导入器）、`source-parsers`、`local-zip`、`naming`、`github-refs`、`fetch-github`、`fetch-gitlab`、`http-shared`（响应限额与编解码）。原文件收敛为 12 行 barrel，13 个公共导出零改动（`src/index.ts` 与 `import.test.ts`）。
- **验证**：tsc `--noEmit` 0 错误；import.test.ts 43/43、installations 32/32、legacy-migration 12/12、dependencies 8/8、git-credentials 5/5、export 1/1。巨型文件总览剩最后一个非测试源文件 `apps/cli/src/commands/integrations/feishu/evidence.ts`（3,885 行，3.6-3 拆分的证据域产物）。

### 3.6-3 补充 cli `feishu/evidence.ts` 拆分 —— ✅ 完成（巨型文件清零）

- **拆分**（`ee1ee98`）：`apps/cli/src/commands/integrations/feishu/evidence.ts`（3,885 行 / 137 声明，3.6-3 拆分产出的证据域）再拆为 `feishu/evidence/` 下 8 个域模块——`report`（报告装配+新鲜度+格式化+锚点对账，595 行）、`core`（buildFeishuIntegrationEvidence+操作/治理计数谓词，873 行）、`issues`（buildFeishuEvidenceIssues+整改规格映射，538 行）、`interactions`（回复/机器人/策略/身份绑定/自动开通/话题协作谓词，739 行）、`failures`（失败 outbox 与数据操作原文上下文守卫，168 行）、`smoke`（OpenAPI 冒烟与 bot-added 载荷核验，533 行）、`proofs`（脱敏守卫+期望证明+哈希/读取助手，295 行）、`satisfaction`（工作区满足度+安全引用比对+终态判定，319 行）。原文件收敛为 14 行显式 re-export barrel（含 `export type` 分组），导出面不变。
- **验证**：`tsc -p tsconfig.json --noEmit` 0 错误；integrations.test.ts 182/182。**全仓 >1500 行非测试源码至此全部拆完**（feishu.ts / daemon.ts / data.ts / skills-import.ts / evidence.ts 五连），巨型文件总览行翻 ✅。
- **过程坑**：导入区 `type X`（无别名内联类型）需单独解析，否则 65 个 TS2304；barrel 对 type/interface 声明必须 `export type`（isolatedModules 下 3 个 TS1205）。

### 3.6-4 CLI 测试脚本与 verify-test-inventory 双维护对齐 —— ✅ 完成

- **对齐**（`3feec450`）：cli 包默认测试脚本一直显式执行 `src/lib/task-completion-outbox.test.ts` 与 `src/lib/task-completion-token-usage.test.ts`（5 文件清单），但 verify-test-inventory 的 default-owned 集只记了其余 3 个——两个文件被错记为 deferred。补入 apps/cli 显式 Set，重冻结 deferred digest（`23fdb8fd`→`4c1efe6e`）。
- **核对发现**：round 6 注释中的「179 文件」为笔误——上版 digest 实际对应 187 个 deferred 文件（HEAD 版脚本对当前树实测 307 owned / 187 deferred），本轮 187-2=185，已在 round 7 注释中记录该勘误。
- **验证**：verify-test-inventory 通过（309 owned / 185 deferred）；apps/cli 默认测试 24/24。

### 3.3-7 services `index.ts` 巨型 barrel 域化拆分 —— ✅ 完成（含全仓导入迁移）

- **拆分**（`1253fd31`）：`packages/services/src/index.ts`（1,614 行 / 143 条 re-export / 1,277 符号）按源目录归入 19 个域 barrel——`workflows`(19 源)、`skills`(36，含 skill-services/clihub)、`employees`(8)、`workspace`(7，含 shared/notifications)、`mcp-center`(5)、`models`(5)、`runtime`(10，含 runtime-access/health/maintenance/provisioning/config/observability)、`integrations`(2)、`openmontage`(5)、`capabilities`(3)、`channels`(3，含 channel-access/contacts)、`messaging`(3，messages/chat/realtime)、`tasks`(3，含 approvals/task-execution-events)、`collaboration`(4)、`knowledge`(4，含 knowledge-proposals)、`documents`(3，含 document-parsing)、`content`(9，materials/attachments/templates/tables/search/context)、`finance`(4)、`operations`(10，policies/agent-*/automations/schedules/permissions/document-permissions)。语句原文搬运、仅调整相对路径；3 条 `@dofe-agent/db` 包级 re-export 按语义归 content/runtime/openmontage。
- **根入口**收敛为 22 行 `export *` 域聚合——此前担心的 web 解析器 `export *` 不可靠仅限 web 内部别名 barrel，包级链路五端 typecheck 实证可用。
- **子路径**：package.json exports 新增 19 个域入口（`@dofe-agent/services/<domain>` → `src/<domain>/index.ts`），存量 storage/mcp-center 叶子子路径不动。
- **验证**：services（types 重建后）+ web + cli + workflow-worker + mcp-egress-proxy typecheck 全 0 错；services 默认测试门全过（注：与 cli 测试并发跑会因共享真实 PG 状态互相踩，须顺序执行）；cli 24/24、integrations 182/182、web dashboard vitest 15 文件 124/124。
- **剩余**：~~web/daemon 200+ 处根导入迁移~~ 已完成，见下；`export type {}` 语句在首轮解析器中曾被漏掉（漏 3 条即级联 web 侧 TS2724/TS7006），已修。

### 3.3-7 补充 全仓 services 根导入迁移至域子路径 —— ✅ 完成

- **迁移**（`84c4a3e6`，240 文件）：apps/web 163、apps/cli 41、packages/daemon 32、workflow-worker 2、mcp-egress-proxy 1 个文件的 `import {...} from "@dofe-agent/services"` 按符号域改写为 `@dofe-agent/services/<domain>`——261 条语句中 99 条跨域拆分为多条；`feishu-credentials.ts` 的 `export {} from` 再导出一并迁移（脚本漏处理该形态，手改 1 处）。
- **vitest 适配**：web 144 个测试文件中 32 个 `vi.mock("@dofe-agent/services")`，域子路径直连会绕过根 mock。`vitest.config.ts` 将 19 个域子路径别名指回根 barrel——mock 拦截语义复原、测试零改动；生产构建走 package.json exports 按域收窄不受影响。
- **连带修复**（`fdec0329`）：迁移后 `next build` 终验暴露预存构建断裂——`preloaded-skill-sources.ts` 的 `readFileSync(join(import.meta.dirname, ...))` 在 Turbopack 产物中 dirname 为 undefined，page-data 收集即抛 ERR_INVALID_ARG_TYPE（HEAD 同栈复现确认，vitest/node 均容忍故未早发现）。改为 `import ... with { type: "json" }`（daemon/cli.ts 先例），next build 全绿。
- **过程坑**：①迁移脚本多域拆分把两条 import 拼到同一行（`;import`，99 处，合法但格式破坏），全局正则补换行后五端 tsc 复验；②daemon `skill-imports.test.ts` 4/5 一例失败为预存（stash 对比 HEAD 同结果），未追。
- **验证**：五端 tsc 0 错；web vitest 144 文件/1155 用例、cli 24/24、integrations 182/182、`next build`（compiled + static pages 6/6）全绿。
- **过程坑**：用户并发提交给根 barrel 追加了包级 re-export，拆分基线须取当前 HEAD 而非历史认知。

### 3.5-6 daemon 构建与版本漂移单点化 —— ✅ 完成

- **治理**（`f37d5357`）：①新增 `managed-runtime-image.ts`——provisioning/credentials/remote-daemon（heartbeat/mcp/operations）共 5 处内联 `MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest"` 收敛为 `buildManagedRuntimeImage()`/`resolveManagedRuntimeImageTag()`，生产（NODE_ENV=production）未锁定 tag 时回落 latest 并 console.warn（锁 digest 只需设 env，支持 sha256:... 形式）；②`provider-runtime/catalog.ts` 4 个默认模型名（claude-haiku-4-5 / gemini-2.0-flash-lite / opencode-default / nanobot-default）去重为 `DEFAULT_MODEL_IDS` 单点，目录定义与 `resolveModelId` 兜底共用同一常量（此前两处各写一份字面量，行为不变）；③mcp-egress-proxy esbuild `--target=node20`→`node25`，对齐根 engines `^25.9.0` 与 daemon build.mjs 的 node25。
- **验证**：daemon tsc 0 错；provider-runtime.test.ts 49/49；mcp-egress-proxy `pnpm run build` 通过（52.4kb）；web typecheck 0 错。
- **过程坑**：自动插 import 误落进 `buildAttributionProxySource()` 模板串内的伪 `import` 行——插入位置须以首个实体声明为界而非「最后一个 import 行」。

---

## 测试与 CI/CD（专项，⏸ 本轮排除）

> 按决策，本轮优化明确排除测试 CI 专项。§3.6-1（ci.yml 流水线）、§3.6-2（`integrations.test.ts` 11k 行 + `daemon.test.ts` 844 行入默认列表）整体保持待办。§3.3-4（飞书测试入内）已完成，见上文。
> 已推进的子项：`permissions`/`document-permissions`/`prisma` 测试纳入默认门禁（见 3.3-8）；飞书 23 个测试文件纳入默认门禁（见 3.3-4）。

---

*本日志与 `optimization-suggestions.md` 配套维护；落地后在本日志追加记录，并在 optimization-suggestions.md 的总览表「状态」列同步符号。*
