# AgentSpace（DofeAgent）深度分析与优化建议

> 建立日期：2026-08-14。分析基线：`dev` 分支。
> 范围：`apps/*` + `packages/*` + `deploy/` + `scripts/` + `docs/`，约 38 万行 TS/TSX、1,200+ 源文件、415 个测试文件。
>
> **落地进展（2026-08-14 更新）**：除「测试 CI 缺失」专项（本轮明确排除）外，P0 全部完成、P1 完成大半。
> 各条目状态详见第二节总览表「状态」列与第三节行内标注（✅ 已完成含提交号 / 🟡 部分完成 / ⏳ 待办）。

---

## 一、项目概览

### 1.1 定位与技术栈

AgentSpace（代码内名 DofeAgent）是一个「人类 + Agent」协作工作空间：数字员工（Employee）作为一等公民被招募、分配、调度、授权、审计。它是 pnpm + Turborepo 的 monorepo，按「apps（可部署进程）/ packages（可复用库）」划分。

> 命名说明：本仓库/部署名为 **AgentSpace**（`agentspace.dofe.ai`，GitHub 仓库 `HKUDS/AgentSpace`），代码包前缀为 **`@dofe-agent`**，产品对外品牌为 **agent.dofe**，`Target.md` 中的代码内名是 **DofeAgent**——四者指同一项目。

| 维度 | 结论 |
| --- | --- |
| 语言/运行时 | TypeScript，Node 25.9.0（`--experimental-strip-types` 直接跑 `.ts`，**源码即运行时，无编译步骤**） |
| 包管理 | pnpm 10.26.2 + Turborepo 2.10 |
| Web | Next.js **16.3.0** App Router + React 19.2，**100% `force-dynamic` SSR**，零 SSG/ISR |
| 前端 | 无 UI 库/无 Tailwind/无状态管理库，手写 CSS（BEM）+ 自研模块缓存/失效体系 |
| 数据库 | PostgreSQL 16，**原生 `pg` + 手写 SQL（无 ORM）**，119 张表 |
| 执行引擎 | 远程 daemon + AgentRouter（归一化 claude/codex/antigravity/opencode/openclaw/hermes 六个 harness） |
| 测试 | node:test（`--experimental-strip-types`）+ vitest + Playwright；无独立测试 CI |
| 部署 | GitHub Actions self-hosted → systemd；PostgreSQL/Redis/RabbitMQ 由外部基础设施托管 |

### 1.2 架构分层

```
apps/web · apps/cli · apps/workflow-worker · apps/mcp-egress-proxy
        │
@dofe-agent/services   (业务服务层，363 文件 / 56 域模块 / 1,277 导出符号)
        │
@dofe-agent/db         (仓储层，130 文件，全同步 *Sync API，worker_thread 同步桥)
        │
@dofe-agent/domain     (纯类型/领域规则，25 文件，零依赖零运行时)
        │
PostgreSQL (pg)  ──  dofe-agent-daemon (远程执行底座，独立可分发产物)
```

依赖方向自顶向下、单向清晰：`apps → services → db → domain`。`daemon` 是唯一可独立打包的库（esbuild 全量 bundle 依赖进 `dist/`，tgz 压缩后 1.8MB）。

### 1.3 整体评价

这是一个**工程质量与代码纪律显著高于平均水平**的仓库：全库 `any` 近零、TODO/FIXME 近零、`ts-ignore/eslint-disable` 为零、结构化错误码贯穿、fail-closed 安全设计（egress 签名、凭据 vault、恢复演练、路径穿越防护）达到相当成熟度。主要问题集中在**单体文件过大、单连接串行化的 DB 访问、零代码分割、以及正在进行的 Prisma 迁移**四类「演进负债」，均属可渐进重构范围。

---

## 二、优化建议总览（按优先级）

| 优先级 | 主题 | 一句话 | 预估成本 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 仓库卫生 | 删除误提交的 `-`(plist) 文件、1.8MB tgz 构建产物入库、`.DS_Store`、失效 Prisma CI | 极低 | ✅ 66de23fc + 5a39362f（`-`/tgz 真正 git rm；AI 规则符号链接；`.DS_Store`/Prisma CI 核实已不存在） |
| P0 | daemon 死代码 | 删除 `provider-runtime.ts` 约 550 行未被调用的 legacy Codex/Claude 路径 | 低 | ✅ 3b81dd12（实际删除 859 行，2,679→1,820） |
| P0 | daemon-client 超时 | blob 上传/下载 fetch 无 AbortSignal，断网会无限挂起 | 低 | ✅ 0945c0cb（三处 blob 传输加 300s AbortController 超时） |
| P0 | 测试 CI 缺失 | 生产部署不跑任何单元/集成测试，仅靠人工自觉 | 中 | ⏸ 本轮明确排除，未动 |
| P1 | DB 异步池化 | 单连接全串行 + 每查询阻塞主线程，需引入 `pg.Pool` 异步平行路径 | 大 | ⏳ 待办（大工程，需按域渐进） |
| P1 | 巨型文件拆分 | permissions/data.ts/postgres-schema 等 10+ 个 >1500 行文件 | 中 | 🟡 data.ts 已拆（683f2d9e，5,737→3,533+973+1,410）、permissions.ts 已拆（374b1bc1，2,439→209 门面+9 子模块）、runtime-provisioning.ts 已拆（7f9ee7d4，2,258→74 门面+7 子模块）；postgres-schema 等待办 |
| P1 | Web 代码分割 | 全模块静态导入，首包含 3925 行 IM 页 | 中 | 🟡 WorkspaceModuleHost 17 模块已改 next/dynamic 懒加载（32a1bb8a，全量 1153 用例通过）；channels-page-client 等文件内拆分待办 |
| P1 | 模块循环依赖 | services 内 `messages↔automations↔workflows` 等两个环 | 中 | 🟡 文件级环 4→2（c8c7c37b，skills 三文件环与 feishu data-plane↔operation-plan 已解）；12 文件大 SCC 五处切断已实施 4 处（cut 1/2/4 8eb08332、cut 5 c8f32035）；最大 SCC 12→6；剩余 cut 3（channels→attachments GC 语义上移）跨域编排层非机械可切；runtime-provisioning 域内环归零（cc4047bd） |
| P1 | 飞书测试游离 | 24 个测试文件（8000+ 行）不在测试门内 | 低 | ⏳ 待办（属测试门禁类，与 CI 专项同批处理为宜） |
| P2 | 零 SSG 全动态渲染 | 所有访问都触发完整 DB 装配 | 中 | ⏳ 待办 |
| P2 | i18n 无 key | `tx(zh, en)` 内联双语无字典校验 | 中 | ⏳ 待办 |
| P2 | 构建/版本漂移 | esbuild `target:node20` vs engines `^25.9.0`、版本号硬编码 | 低 | 🟡 版本单一来源已做（0945c0cb，cli.ts 改读 package.json）；esbuild target/镜像 digest 锁定待办 |
| P2 | sandbox 抽象虚置 | Cube `exec()` 未实现，`connectSandbox()` 无调用方 | 中 | ⏳ 待办 |

---

## 三、分领域优化建议

### 3.1 仓库卫生与工程化（P0，成本极低，立即做）

> ✅ **已落地**：AI 规则 5 份重复文件改为指向 `CLAUDE.md` 的符号链接、`findings.md`/`progress.md`/`task_plan.md` 纳入 `.gitignore`（66de23fc）；误提交的 `-` plist 与 `dofe-agent-daemon-0.1.3.tgz` 真正从索引移除，并清理 `.gitignore` 过时的 `agent-space-daemon-*.tgz` 规则（5a39362f）。复核结论：`.DS_Store` 当前 0 个跟踪；`.github/workflows/migration-ci.yml` 已不存在；`packages/db/dist-types/generated/prisma/` 与 `data/*.sqlite` 均为 `.gitignore` 内的本地产物，不属跟踪残留。

1. **删除误提交的 `-` 文件**：仓库根有一个名为 `-` 的 macOS plist（`mkcert` trustList，2019 字节，已 `git ls-files` 确认被跟踪），是 `curl -o -` 类操作误产物，含本机证书指纹，应删除并加入 `.gitignore`。✅ 已移除（5a39362f，产物与 `.gitignore` 规则一并清理）。
2. **构建产物移出 git**：`dofe-agent-daemon-0.1.3.tgz`（1.8MB 二进制）自首个提交起就被跟踪，应改为通过 CI artifact 或 release 附件发布。✅ 已移除（5a39362f，`.gitignore` 规则改为 `dofe-agent-daemon-*.tgz` 并清理旧规则）。
3. **`.DS_Store` 入库**：`apps/.DS_Store`、`docs/.DS_Store` 等 macOS 垃圾文件应从 git 移除。✅ 复核：当前 0 个 `.DS_Store` 被 git 跟踪（原始结论有误——它们仅存在于磁盘，且已被 `.gitignore` 覆盖，从未入库）。
4. **AI 规则文件重复**：`CLAUDE.md`(92 行) 与 `CODEBUDDY.md`/`GEMINI.md`/`QODER.md`/`.cursorrules`/`.windsurfrules`(各 38 行，MD5 完全一致) 内容重复。建议保留一份权威版本，其余改为 `@` 引用或符号链接，避免多编辑器规则漂移。✅ 已落地：5 份重复文件改为指向 `CLAUDE.md` 的符号链接（66de23fc）。
5. **失效的 Prisma CI 残留**：`.github/workflows/migration-ci.yml`（watch 已不存在的 `prisma/**` 路径）是历史 Prisma 尝试的残留，应删除或停用。✅ 复核：该 workflow 已不存在于当前分支，无需处理。当前 `dev` 分支源码无任何 Prisma 引用；`packages/db/dist-types/generated/prisma/` 是 `.gitignore` 内 `dist-types` 的本地构建产物，非跟踪残留。
6. **根目录 AI 工作笔记**：`findings.md`/`progress.md`/`task_plan.md` 是 Prisma 迁移的工作笔记，靠 `.git/info/exclude` 本地排除（未提交但未加入 `.gitignore`），易被 `git add -A` 误提交。建议移到 `docs/0808/db_migration_to_prisma/` 或明确 `.gitignore`。✅ 已纳入 `.gitignore`（66de23fc）。
7. **`data/*.sqlite` 旧文件**：SQLite→PG 迁移后 `data/` 下遗留空 sqlite/db 文件，建议清理并在文档中说明产物归属。✅ 复核：未被 git 跟踪（`.gitignore` 覆盖），属本地磁盘产物，可按需手动清理，非仓库卫生问题。

### 3.2 数据库层（db/domain）

现状：无 ORM，原生 `pg`。核心机制是 `database.ts` 用 **worker_thread 内单条 `pg.Client` + 主线程 `Atomics.wait` 轮询**，把异步 PG 包装成同步 `*Sync` API（模仿 `node:sqlite` 的 `DatabaseSync`），并做 `?`→`$N` 占位符转换、snake_case→camelCase 行键归一。

**这是全系统最大的结构性技术债**：services+daemon 共 220 个文件 import `@dofe-agent/db`，services 非测试代码中有 **3,020 处 `*Sync` 调用**。任何异步化/池化改造都会波及这 3000+ 调用点。

1. **【P1·大】引入 `pg.Pool` 异步平行路径**：当前单连接全串行、每查询主线程阻塞一次（worker 往返 + Atomics 轮询）。建议新增 `async getDatabaseAsync()` 平行 API，让新代码与热路径（`token-usage`、`task-queue`、`mcp-center`）逐步迁移；同步门面保留给存量调用。同时为 worker 协议加查询延迟/队列深度指标。
2. **【P1】拆分 `postgres-schema.ts`（4,838 行）**：119 张表 + 幂等 DDL 流 + 版本号 + 回填/在线索引全在一个文件。按领域（workflow/mcp/skill/token-usage/employee…）拆成多个语句数组，用有序版本化组合器拼装，保持幂等与版本号语义。
3. **【P1】消除双重行映射**：部分 SQL 用显式 `AS workspaceId`，部分用全小写别名（如 `skillartifactdigest`）依赖 worker 的 400+ 条别名表兜底。两种风格并存易漂移。建议以 schema 列名为唯一事实源，统一生成 camelCase 映射。
4. **【P2】巨型业务模块拆分**：`external-integrations.ts`(2,576)、`types.ts`(2,219，106 interface 可按模块拆后 re-export)、`mcp-center.ts`(1,467)。
5. **【P2】类型安全加固**：可评估 Kysely 之类轻量 typed query builder 做列名编译期校验，降低手写 SQL 与 `types.ts` 的漂移风险（无需完整 ORM）。
6. **【战略】Prisma 迁移已有详细方案**：`docs/0808/db_migration_to_prisma/README.md` 给出了 A→B 渐进路线（A=Prisma 只负责 schema/迁移；B=Prisma Client 与 SQL 并存按域替换），明确不建议一次性全量 Prisma Client 化。当前 `techwu/prisma-migration` 分支在推进，且 `dev` 分支已落地 Phase 2 read-cutover 影子读取骨架（`packages/db/src/prisma/read-cutover.ts`，a74f362c）。**建议**：坚持 A→B，`FOR UPDATE SKIP LOCKED`、触发器、advisory lock、在线 DDL 等高风险 SQL 继续保留原生实现。

> 亮点（值得保留）：手写幂等 DDL + advisory lock 迁移协议 + 前向版本守卫 + `CREATE INDEX CONCURRENTLY` 后台构建 + 测试库 URL 守卫，是一套成熟的「SQLite 无缝演进到 PostgreSQL」工具链。

### 3.3 业务服务层（services，363 文件 / 56 域模块）

1. **【P1】拆分 `permissions.ts`（2,439 行，全包最大）**：把 17+ 种数据源聚合为权限树/中心视图。`capabilities` 域已示范正确做法（facade + 4 个单职责子模块），照此拆分「数据源聚合 / 树构建 / 诊断」。✅ **已落地（374b1bc1）**：拆为 9 个单职责子模块（`permission-context` / `permission-diagnostics` / `permission-nodes-{agents,channels,documents,feishu-guests,runtime}` / `permission-types` / `permission-utils`），原文件收敛为 209 行门面。
2. **【P1】拆分 `runtime-provisioning.ts`（2,258 行）**：7 阶段供给状态机，按「阶段机 / 命令构建 / 凭证恢复」分文件。✅ **已落地（7f9ee7d4）**：原文件收敛为 74 行门面（显式 re-export 原 45 个公开符号，导入路径不变），拆出 capacity / tasks / models / credential-recovery / lifecycle / pipeline / models-client 7 个子模块；测试 53/54（1 例为共享测试库 schema 118 不可降级的环境性失败）。
3. **【P1】打破模块循环依赖**（已核实）：
   - `messages → automations → workflows → messages`
   - `documents → notifications → messages → documents`
   建议把「失败摘要格式化/状态替换」这类纯函数下沉到 `shared`，切断环。🟡 **文件级环 4→2 已落地（c8c7c37b）**：skills `release↔installations↔import` 三文件环解体（锁计算下沉 `release-lock.ts`、安装排队下沉 `skill-services/install-queue.ts`）；飞书 `data-plane↔operation-plan` 解体（描述符常量下沉 `data-operation-descriptors.ts`）。runtime-provisioning 拆分引入的域内环也已归零（cc4047bd：`ModelsCreateResult` 独立 types 文件 + 两个编排入口迁至 pipeline，pipeline→capacity 单向）。剩余为 12 文件大 SCC（channel/notification 域）与一个 type-only 运行时无害环（feishu agent-bot-bindings↔external-guests）。

   **12 文件 SCC 分层方案（已评估，2026-08-14）**：SCC 成员与全部反向边已核实——违反分层的只有 5 条边，其余边均可自然落入以下六层（底→顶）：L0 `shared/state-io`（快照持久化）→ L1 `documents/access`、`shared/audit`、`shared/conversation-execution-workspaces`（纯规则）→ L2 `attachments`、`channels`（存储域）→ L3 `channel-access`、`notifications`（访问/通知域）→ L4 `shared/messaging`、`runtime-access`（运行时消息）→ L5 `messages`、`automations/auto-continuation`（顶层编排）。5 处切断：
   1. ✅ **`state-io → documents/access`**（`ensureChannelDocumentAccessSeeds`，仅读写两条路径调用）：种子补全改由 `shared/channel-document-access-seeds.ts` 提供，state-io 仅依赖 shared，回归纯持久化（**8eb08332**）。
   2. ✅ **`documents/access → channels`**（`resolveChannelHumanMemberNames` ×3 + count）：纯函数下沉 `shared/channel-members.ts`，双方及 `messages` / `permissions` / `document-permissions` / `documents/files` / `attachments` / `channel-access` 共 6 处改引 shared（**8eb08332**）。
   3. ⏸ `channels → attachments`（`deleteUnreferencedWorkspaceAttachmentsSync`）：GC 语义上移至 channels 的调用方或回调注入；需梳理调用方语义，留待后续。
   4. ✅ **`attachments → channel-access`**（`isWorkspaceAdminOrOwnerRole` 部分）：纯角色判断下沉 `shared/channel-members.ts`（与 cut 2 同文件），`canReadChannelForActorSync` 嵌入 channel-access 域逻辑未下沉（**8eb08332**）。
   5. ✅ **`notifications → messages`**（`postMessageSync`）：发送核心下沉 `shared/messaging.ts`（追加 import state-io/realtime-events + 末尾追加函数体），`messages.ts` 改 `export const postMessageSync = postMessageSyncShared` 保留 facade（**c8f32035**）；notifications 直接引 shared，12 个外部调用方零改动。

   实施顺序建议：1/2/4 纯机械下沉低风险先行；3 需梳理调用方语义；5 触及消息发送路径（行为敏感），最后做并配 messages 域回归。**当前进度**：1/2/4/5 已落地（8eb08332 / c8f32035），最大 SCC 由 12 缩为 6；剩余 cut 3（GC 语义）跨域编排层非机械可切，**建议接受现状或留待 P2 重构周期**。
4. **【P1】飞书 24 个测试文件游离于测试门之外**：`src/integrations/...`（含全包最大测试 `inbound.test.ts` 2,406 行、`data-plane.test.ts` 2,239 行）不在 `package.json` 的 test glob 内，`verify-test-coverage.mjs` 注释为 "intentional"。**8,000+ 行测试形同虚设**——要么纳入门禁（纯单测无需外部环境），要么给独立 CI 任务。
5. **【P2】手写 `.d.ts` 孪生去重**：`lark-cli.ts` 与 `lark-cli.d.ts` 各 26 个导出需人工同步，易漂移。改为单源生成或删孪生、由 `dist-types` 统一产出。
6. **【P2】`preloaded-skill-sources.ts` 176KB 内联字符串**：技能内容应外置为数据资源（JSON/独立文件），避免 diff 污染与 bundle 膨胀。
7. **【P2】`index.ts` 巨型 barrel（1,614 行 / 1,277 符号）**：继续按域拆子路径（`/workflows`、`/skills`…），收窄 web/daemon 的 200+ 处 import。
8. **【P2】测试门覆盖不均**：门内只含 runtime-maintenance/skills/mcp-center/skill-services/openmontage/workflows/attachments；`permissions`、`employees`、`documents`、`messages`、`knowledge` 等核心域无自动测试门，建议把 verify 脚本的 COVERED_PREFIXES 扩到这些域。🟡 **部分已落地（707e80a5）**：`permissions`、`document-permissions` 已纳入 services 默认测试脚本与 COVERED_PREFIXES；`employees`、`documents`、`messages`、`knowledge` 等待办。
9. **【P3】供应链**：`xlsx` 依赖是 CDN tarball URL（`cdn.sheetjs.com`）非 registry 包，建议评估锁定与镜像策略。

### 3.4 Web 前端（apps/web，Next.js 16）

1. **【P0·收益最大】拆分 `features/dashboard/data.ts`（5,737 行）**：23 个服务端装配函数 + 40+ 模块公共 import 汇。按模块拆为 `features/*/server-data.ts`，每函数保留 `react cache()` 记忆化。✅ **第一阶段已落地（683f2d9e）**：先按「类型层 / 视图构建层 / 装配层」切开——`data.ts` 3,533 行（各域 loader，`export *` 对外导入路径不变，43 个引用方零改动）、`data-types.ts` 973 行、`dashboard-view-builders.ts` 1,410 行，依赖单向 `data.ts → view-builders → data-types`。后续按域再拆 `features/*/server-data.ts` 有了干净落点。✅ **第二阶段已落地（ad4de69e）**：`dashboard-view-builders.ts` 按领域拆为 `builders/` 九个子模块（`channel-documents` / `channel-files` / `channel-view` / `document-changesets` / `feishu-summary` / `knowledge-view` / `task-queue` / `text` / `workspace-members`），原文件收敛为 65 行 facade。
2. **【P1】代码分割**：`WorkspaceModuleHost` 静态导入全部 17 个模块客户端页，首包必然含 3925 行的 IM 页。用 `next/dynamic` 按模块懒加载（已有 `WorkspacePageLoading` 基础设施，接入成本低）。同批处理 `agent-detail.tsx`(1,657)、`conversation-shell.tsx`(1,590)、`knowledge-page-client.tsx`(1,580)。✅ **WorkspaceModuleHost 部分已落地（32a1bb8a）**：17 个页面客户端全部改 `next/dynamic` 按模块懒加载，路由 page.tsx 仍静态导入保证 SSR 直出；全量 vitest 144 文件 / 1,153 用例通过。✅ **knowledge-page-client 已完成四件套拆分（2a86a772 + 95349d52 + a9ada12a + cce1b274）**：1,580→1,114 行，子组件全部移出独立文件——`parse-task-panel.tsx`（ParseTaskPanel）、`assignment-panel.tsx`（KnowledgeAssignmentPanel/DraftControls + toggleEmployeeSelection）、`document-page-viewer.tsx`（DocumentPageViewer + formatKnowledgeTime/DocumentSize 私有）、`knowledge-tree-node.tsx`（KnowledgeTreeNode 递归）。文件内拆分（agent-detail / conversation-shell / channels-page-client）⏳ 待办。
3. **【P1】拆分 `channels-page-client.tsx`（3,925 行）**：轮询/性能埋点/执行时间线/pin 逻辑已「文件内堆叠」，先抽 hooks 再抽子组件。
4. **【P2】`next.config.mjs` 的 `typescript.ignoreBuildErrors: true`**：构建跳过类型检查，正确性完全依赖 CI 的 `typecheck:web:only`（而 CI 目前不跑 typecheck）。建议移除该开关，让 `next build` 前强制 `tsc --noEmit`。
5. **【P2】评估部分静态渲染**：全站 `force-dynamic`，但 `/platform`、设置只读 section、模板库等低个性化数据可评估 `revalidate` 或客户端缓存降载。
6. **【P2】i18n 无 key 体系**：`tx(zh, en)` 内联双语 + `presentation.ts` 集中翻译，无字典/key 校验，翻译散落 90+ 调用点。>2 种语言或翻译平台协作时需迁移。
7. **【P2】清理 "loadtest" 命名**：`readLoadtest*Cache` 三处是通用 TTL 缓存（`LOADTEST_MODE` 开关），命名与实际功能脱节，重命名为 `readTtlCache` 语义。
8. **【P2】统一 34 个 page.tsx 样板**：重复 `getWorkspacePageContext → loadWorkspaceModuleDataWithMeta → WorkspaceInitialModuleData → *PageClient` 四步，可收敛为 `renderWorkspaceModule()` 辅助或生成器。

> 亮点（值得保留）：服务端薄页 + 客户端胖壳 + 自研 `WorkspaceModuleCache`/失效事件体系，SSR 数据 seed 进客户端缓存实现「首屏零额外请求」；`any`/TODO/console.log 全零。

### 3.5 执行引擎（daemon/sandbox）

1. **【P0】删除 legacy 死代码**：`provider-runtime.ts` 的 `runCodexProviderTaskAttempt`（830-916）与 `runClaudeProviderTask`（1589-~2050）从未被调用（Codex/Claude 已全走 AgentRouter），`mapCodexExecEvent`/`mapClaudeEvent` 仅被死路径使用——合计约 550 行，且与 `agent-router/events.ts` 存在平行事件映射重复。✅ **已落地（3b81dd12）**：实际删除 859 行（含完整 Claude 诊断链与全部平行事件映射），文件 2,679→1,820 行，daemon 49/49 用例通过。
2. **【P0】daemon-client blob 传输加超时**：`getWorkspaceBlob`/`getWorkspaceBlobRange`/`uploadWorkspaceBlob` 的 fetch **没有 AbortSignal 超时**（`requestJson` 有 10s），大文件传输断网会无限挂起。✅ **已落地（0945c0cb）**：三处 blob 传输加 300s（可配 `blobTransferTimeoutMs`）AbortController 超时，对齐 requestJson 模式。
3. **【P1】版本号单一来源**：`cli.ts:14` 硬编码 `"0.1.3"`（与 package.json 重复），建议构建注入或加测试断言。✅ **已落地（0945c0cb）**：改为 `import package.json with { type: "json" }` 读取单一来源。
4. **【P1】拆分三大文件**：`provider-runtime.ts`(2,679，清死代码后 ~2,100)、`remote-daemon.ts`(2,138，heartbeat/poll/execute 拆独立模块)、`task-context.ts`(1,544)。
5. **【P1】sandbox 抽象决策收口**：Cube `exec()` 未实现（`CUBE_EXEC_NOT_READY`，"TODO 46"）；`connectSandbox()` 当前无调用方，`Sandbox` 接口未被执行路径真正接线。要么完成 Cube envd/E2B 数据面，要么移除实验开关与 README 承诺，避免「看似可选实则不可用」的抽象。
6. **【P2】构建/版本漂移**：esbuild `target: node20` vs engines `^25.9.0`；`remote-daemon.ts` 硬编码 `dofe/agent-runtime-${provider}:latest`（生产应锁 digest）；4 个默认模型名硬编码在 `provider-runtime.ts`。
7. **【P2】测试路径与产物不对齐**：单测跑 TS 源码，`dist/`（esbuild 产物，含 CJS banner 注入兼容）不被单测覆盖，仅靠 e2e。建议加一个最小 smoke test 直接加载 `dist/*.js`。
8. **【P2】轮询请求放大**：`pollRemoteTasks` 每 3s 每 runtime 最多 6 次 claim 请求，可合并为单一 claim 端点或加 jitter/背压。

> 亮点（值得保留）：结构化错误类 + 错误码贯穿（`provider.*`/`harness.*`/`skill_runner.*`/`mcp.*`）、fail-closed 贯穿、逐 chunk 输出脱敏、Skill Runner Docker + iptables egress 双层强制、e2e docker 测试用 `DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1` 门禁自动 skip。

### 3.6 CLI / Worker / 出站代理 / 部署

1. **【P0】测试 CI 缺失**：`deploy-production.yml` 在 push 到 `main` 时自动部署，但**只跑 preflight + build + Skill Runner egress 门禁，不跑任何单元/集成测试**；`.github/workflows` 下没有独立测试 CI。「失败禁止发布」目前只靠发布者自觉执行 `docs/0814/release-preflight-checklist.md`。**建议**：加一个 `ci.yml`（`pnpm install --frozen-lockfile` + `turbo run test --concurrency=2`，需预置测试库 URL），把 `pretest` 的两个门禁（verify-test-inventory、audit-node-engines）变成机器强制。
2. **【P0】11k 行 `integrations.test.ts` + 844 行 `daemon.test.ts` 不在默认测试列表**：被 verify-test-inventory 的 "deferred 冻结" 掩盖了「没跑」的事实。要么并入默认 glob，要么明确降级为集成测试目录并在 CI 单独 job 跑（带 env guard）。
3. **【P1】巨型文件：`apps/cli/src/commands/integrations/feishu.ts` 达 10,597 行（全仓最大单文件）**，`daemon.ts` 2,222 行。建议抽出 `feishu-worker` / `feishu-cli` / `provider-runner` 等子模块。
4. **【P1】CLI 测试脚本与 verify-test-inventory 的 default-owned 集不一致**：脚本跑 5 个文件，inventory 只记 3 个+deploy 门禁（`task-completion-outbox`/`token-usage` 被脚本执行却不在 inventory 集）。以脚本为准或让 inventory 从 `package.json` 解析，消除人工双维护。
5. **【P1】`runtime-maintenance.mjs` 用容器内自旋轮询**代替 in-process 定时：每 30s 打 3 个 HTTP cron 端点，异常只打日志无退避/告警。建议改为内置定时器或接外部 cron + 指标。
6. **【P2】多套 env 模板漂移风险**：根 `.env.example`、`deploy/self-hosted/.env(.example)`、`deploy/staging/.env.staging.example`、`scripts/feishu/.env`、systemd 4 个 env 模板并存。建议单一 schema 源（JSON Schema 或生成器）+ 校验脚本。
7. **【P2】`dev-daemons.sh` 硬编码本机绝对路径**（`/Users/techwu/...`、`node-v24.9.0`、固定 workspace id），不可共享，应参数化/从环境读取。
8. **【P2】`audit-node-engines.mjs` 从 `.pnpm` 目录「借用」semver** 的 hack，应改为在 devDependencies 显式声明 `semver`。
9. **【P2】两个 bin wrapper（cli/mcp-egress-proxy）都是 `spawnSync` 子进程再执行**，每次调用多一层进程开销，可直接 `import` 后调 main。
10. **【P2】`apps/workflow-worker` 的 `types` 依赖 `apps/web/node_modules/.bin/tsc`**：monorepo 内多个包（根 `typecheck:deps`、workflow-worker、domain/db/services/sandbox 的 types 脚本）用相对路径指向 web 的 tsc，web 是事实上的 tsc 宿主，若其依赖被剪就连锁失败。应在根/共享包显式依赖 typescript。
11. **【P2】部署物分散**：systemd（web/daemon/feishu-worker/workflow-worker）+ self-hosted Compose + staging + daemon（一容器一 runtime + managed-node + mcp-egress）并存，升级/回滚说明散落各 README，建议出一份统一的「部署拓扑 + 组件所有权」文档（飞书 worker 由 daemon-claude 托管、不可与独立 feishu-worker 同跑这一约定易被遗漏）。
12. **【P2】docs 按日期目录缺乏索引**：`docs/0724 ~ 0814` 无根索引文件，且日期目录里混入 playwright 产物/截图等构建产物类文件。建议加 `docs/README.md`（主题索引 + 归档策略），大体积 evidence 移入 artifacts/。

> 亮点（值得保留）：mcp-egress-proxy 的纵深安全（Ed25519 短期 lease + JTI 防重放 + policy digest 校验 + pinned DNS + 私网段拦截 + OAuth broker + 脱敏审计）是教科书级实现；`verify-test-inventory` 的冻结摘要机制有效防测试漂移；docs 诚实标注未关闭门禁（NO-GO/自述非自动）非常健康。

---

## 四、测试与 CI/CD 现状与建议（专项）

> ⏸ **本轮未处理**：按决策，本轮优化明确排除测试 CI 专项，本节全部建议（含 3.6-1/2、3.3-4）保持待办状态。

| 现状 | 问题 | 建议 |
| --- | --- | --- |
| 415 个测试文件、node:test + vitest + Playwright | 无独立测试 CI，生产部署不跑单测 | 新增 test CI job；部署前强制 `turbo run test --concurrency=2` |
| `verify-test-inventory.mjs` 门禁 | 只覆盖部分域，飞书 24 文件、employees 等核心域仍游离 | 扩 COVERED_PREFIXES；飞书纯单测纳入门内（`permissions`/`document-permissions` 已纳入 707e80a5，`prisma` 已纳入 a74f362c） |
| `audit-node-engines.mjs`（engines 审计） | 已接入 `pretest`，但 CI/部署不自动运行 | 纳入 CI job |
| vitest `fileParallelism: false` | 149 文件单线程（共享 DB 种子竞态） | 迁移每用例独立 workspace（已在推进，见 git log） |
| db 测试依赖真实 PG | CI 需预置测试库 | 评估 testcontainers ephemeral PG |
| 发布前人工预检清单 | TOS 预签名回归等需真实凭据，仅靠自觉 | secrets 化 + 审批前置，或定时 job |

---

## 五、附：值得长期保留的工程实践

- **同步门面 + 幂等 DDL + advisory lock 迁移协议**（db）：SQLite→PG 的无缝演进，前向版本守卫防滚动升级降级。
- **结构化错误码单一事实源**：`domain/workflow-error-codes.ts` 派生 i18n/白名单，编译期保证不漂移；daemon 错误码贯穿 provider/harness/skill_runner/mcp。
- **fail-closed 安全纵深**：MCP 凭据永不下发、requiresApproval 能力零注入、输出/日志逐 chunk 脱敏、Skill Runner iptables egress 双层强制、no-follow 写入防路径穿越。
- **自研模块缓存/失效体系**（web）：SSR 数据 seed 进客户端缓存，Server Action 后按资源类型精准失效。
- **状态机 + claim→operate→complete 幂等模式**：runtime-provisioning 7 阶段、MCP 连接、技能安装均用此模式，重试安全。
- **注释质量与决策留痕**：关键决策（tos-signer 自实现、engines 收紧、egress 门禁）均带 WHY 注释或沉淀到 `docs/日期` 目录，工程纪律极高。

---

*本文档由一次全仓深度分析（db/domain、services、web、daemon/sandbox、cli/worker/proxy/deploy 五个并行子任务 + 根目录静态核查）汇总而成，所有结论基于真实代码与 git 状态，未使用生产数据或测试管理员账户。*
