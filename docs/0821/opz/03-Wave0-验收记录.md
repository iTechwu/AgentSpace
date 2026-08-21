# Wave 0 验收记录（测试清单 / lint / 依赖漏洞 / ci:verify）

> 推进日期：2026-08-21
>
> 基线：`dev`（`7989d6f8` 补充全项目优化与 CI 容器化建议）
>
> 范围：docs/0821/opz 的 Wave 0 —— 修复测试清单漂移、Web lint 504 错误、生产依赖 deepmerge-ts high 漏洞，并新增统一质量门 `ci:verify`。
>
> 状态：**已完成并提交**。Wave 1-3（Node LTS 迁移、镜像不可变化、流式 I/O、readiness 等）未在本轮推进。

## 1. 完成的改动

### 1.1 P0-01 恢复可执行的质量门

**测试清单漂移**（`scripts/verify-test-inventory.mjs` 期望 172、实际 173）：

- 新增项 `packages/daemon/src/local-managed-node-env-config.test.ts` 是纯单测（无外部依赖、无真实 DB/TOS），判定应进入 daemon 默认测试脚本，而非留在 deferred 集。
- 改动：将该文件加入 `packages/daemon/package.json` 的 `test` 脚本，并在 `verify-test-inventory.mjs` 的 default-owned 集合中补记（消除脚本/inventory 双维护漂移）。

**Web lint 504 个 error**：

- 503 个 `@typescript-eslint/no-unused-vars`：其中 495 个集中在 7 个 channels 拆分文件的复制残留 import（channels-page-icons/shared/model/hooks/views/modals、channel-workspace-header），其余分布在 dashboard builders、workspace-module-loaders、knowledge、i18n。
- 1 个 `no-irregular-whitespace`：`inline-bilingual-consistency.test.ts` 的 CJK 正则中字面量全角空格 U+3000，改为 `\u3000` 转义（语义不变）。
- 全部清理为「移除未使用的命名 import」，未改动任何业务逻辑；`useEffect`、`ChatModelSelector` 等仍在使用的 import 保留。

**新增 `ci:verify`**（根 `package.json`）：

```bash
pnpm run ci:verify
# = prisma:generate → verify-test-inventory → audit-node-engines → audit-env-templates
#   → typecheck → lint:web → turbo run test --concurrency=2
```

### 1.2 P0-05 生产依赖漏洞（deepmerge-ts high）

- 路径：`prisma(CLI) → @prisma/config → deepmerge-ts@7.1.5`（< 8.0.0，CVE-2026-40345 递归合并栈耗尽）。
- 升级 Prisma 不可行：官方 latest 仍为 `7.9.1`，其 `@prisma/config` 仍钉 `deepmerge-ts@7.1.5`。
- 改动：
  1. `packages/db` 的 `prisma`（CLI）从 `dependencies` 移到 `devDependencies`——运行时只用 `@prisma/client` / `@prisma/adapter-pg`，CLI 只在 build/generate 阶段使用。
  2. 根 `package.json` 增加 `pnpm.overrides: { "deepmerge-ts": "^8.0.1" }`——唯一消费方 `@prisma/config` 的命名 import `deepmerge` 在 8.0.1 仍兼容（已通过 `prisma generate` 实测）。

### 1.3 附带修复：一处环境敏感的单测

`packages/daemon/src/managed-node-image-contract.test.ts` 的「Codex MCP canary switch」用例在 `--env-file-if-exists=../../.env` 加载 `.env` 时，`MCP_CODEX_EXPERIMENTAL_ENABLED=1` 会通过 `readEnvValue` 短路遮蔽 `previousSource` 中的 `true`，导致断言不触发。改为显式传 `{}` 环境，隔离 `process.env`，使测试确定性验证 `previousSource`。该问题不在扫描建议清单内，但会阻断「测试全绿」验收，故一并修复。

### 1.4 质量门与浏览器回归发现的问题

完整 `ci:verify` 首轮执行继续发现两处存量问题，均已测试先行修复：

- 工作流 outbox 的 `workflow_outbox_event_unsupported` 与 `workflow_outbox_dispatch_failed` 已被业务抛出，但未登记到领域错误码与 Web 双语展示目录。现已补齐目录及防回归断言。
- PostgreSQL SQL 列守卫只读取目标 schema，未理解测试夹具中的 `ALTER TABLE ... ADD COLUMN` 历史库建模语句，误报已删除的 `workspace.join_code`。现按同一源码文件的 SQL 顺序应用 `ADD COLUMN`，同时保持文件间 schema 隔离。

隔离 Chromium 回归还发现 `/contacts?view=digital` 首屏把 `URLSearchParams` 实例跨 Server/Client Component 边界传递，序列化后丢失 `view=digital`，页面错误渲染消息工作台。现改为传递可序列化查询字符串，并新增生产构建 E2E 断言：联系人标题与“新建数字员工”入口必须出现，聊天输入框必须不存在。

## 2. 验收证据（本机 Node v25.9.0 / pnpm 10.26.2）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 测试清单 | `node scripts/verify-test-inventory.mjs` | ✅ 357 default-owned + 172 deferred（digest `08f3bc5c`） |
| Web lint | `pnpm run lint:web` | ✅ 0 error / 0 warning（579 文件） |
| 类型检查 | `pnpm run typecheck` | ✅ exit 0 |
| env 模板审计 | `node scripts/audit-env-templates.mjs` | ✅ 11 模板 / 224 键，无漂移 |
| 生产依赖审计 | `pnpm audit --registry=https://registry.npmjs.org --prod --audit-level=high` | ✅ No known vulnerabilities |
| Node engines 审计 | `node scripts/audit-node-engines.mjs` | ✅ Node 25.9.0；11 个 manifest；仅保留已登记的 `jsdom@30.0.1` 限时例外 |
| 统一质量门 | `pnpm run ci:verify` | ✅ 9/9 workspace；Web 151 文件 / 1216 用例；daemon 235 pass / 13 skip；CLI 228/228 |
| 生产构建 | `pnpm run build` | ✅ Next.js 16.3.0 构建与路由生成成功 |
| 浏览器全量回归 | `pnpm --filter @dofe-agent/web run test:e2e` | ✅ Chromium 30/30（桌面、移动端、键盘、路由、工作流、视频任务） |
| 联系人目录浏览器审计 | 隔离 Chromium，1440×900 | ✅ HTTP 200；创建入口 1；composer 0；横向溢出 0；console/page/network 错误 0 |

## 3. 后续范围

### 3.1 audit-node-engines（P0-02，Wave 1）

当前审计目标仍为 Node 25.9.0，门禁已通过，但 Node 25 的生命周期风险没有消失。P0-02 属于 Wave 1：应建立目标 LTS 兼容矩阵，再同步本机、`engines`、审计目标、esbuild target、README、CONTRIBUTING、`node-runtime-matrix`、provider runtime 准入和全部基础镜像。

> ✅ 已在 Wave 1 完成：见 [04-Wave1-Node24迁移.md](./04-Wave1-Node24迁移.md)。迁移后 `engines.node` 为 `^24.19.0`，`jsdom@30.0.1` 例外已移除，`audit-node-engines.mjs` 在 Node 24.19.0 下 0 违规。

### 3.2 部署边界

本轮没有 push、没有部署，也没有启动或触发 Jenkins。后续 CI/test 环境部署仍必须从已 push 的目标提交触发匹配 Jenkins 流程，并监控构建与服务健康到明确结论；应用部署不得创建 PostgreSQL、Redis、RabbitMQ 或其初始化 job/container。

## 4. 后续建议（Wave 1 起）

1. Node 24 LTS 迁移（P0-02）——独立提交，先跑兼容矩阵。
2. 增加 CI verify job（不部署），并让 Docker build 依赖其成功。
3. 统一 `.dockerignore`、Web standalone、Worker bundle（P1-01）。
4. workspace blob 流式 I/O（P0-04）与 readiness（P1-06）。
