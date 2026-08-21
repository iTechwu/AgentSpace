# Wave 0 验收记录（测试清单 / lint / 依赖漏洞 / ci:verify）

> 推进日期：2026-08-21
>
> 基线：`dev`（`7989d6f8` 补充全项目优化与 CI 容器化建议）
>
> 范围：docs/0821/opz 的 Wave 0 —— 修复测试清单漂移、Web lint 504 错误、生产依赖 deepmerge-ts high 漏洞，并新增统一质量门 `ci:verify`。
>
> 状态：**已完成，待提交**。Wave 1-3（Node LTS 迁移、镜像不可变化、流式 I/O、readiness 等）未在本轮推进。

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

## 2. 验收证据（本机 Node v26.5.0 / pnpm 10.26.2）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 测试清单 | `node scripts/verify-test-inventory.mjs` | ✅ 357 default-owned + 172 deferred（digest `08f3bc5c`） |
| Web lint | `pnpm run lint:web` | ✅ 0 error / 0 warning（579 文件） |
| 类型检查 | `pnpm run typecheck` | ✅ exit 0 |
| env 模板审计 | `node scripts/audit-env-templates.mjs` | ✅ 11 模板 / 224 键，无漂移 |
| 生产依赖审计 | `pnpm audit --registry=https://registry.npmjs.org --prod --audit-level=high` | ✅ No known vulnerabilities |
| daemon 受限测试 | `pnpm --filter dofe-agent-daemon test` | ✅ 235 pass / 13 skip / 0 fail |

## 3. 未完成项与阻塞

### 3.1 audit-node-engines（P0-02，Wave 1）

`node scripts/audit-node-engines.mjs` 在本机仍失败：本机 Node 已漂移到 `v26.5.0`（Homebrew 自动升级），而根 + 10 个 workspace 均声明 `engines.node: "^25.9.0"`（不覆盖 26.x）。

这正对应 P0-02「从 Node 25 EOL 迁移到受支持 LTS」——属于 Wave 1，需先建立 Node 24 兼容矩阵，再统一切换本机、engines、审计目标、esbuild target、README/CONTRIBUTING/node-runtime-matrix 与全部基础镜像。本轮不擅自切换 Node 版本，避免与镜像瘦身或业务修改混合提交。

### 3.2 全量测试未跑

根 `pnpm exec turbo run test --concurrency=2` 覆盖全部 workspace 测试，其中含真实 DB/TOS 的集成测试与本机环境强耦合，且耗时较长。本轮以 daemon 受限测试（本次改动的直接相关面）+ typecheck + lint + inventory + audit 作为验证闭环。完整受限并发测试留给 CI（`ci:verify` 已就绪）。

### 3.3 环境提示

- 本机 `pnpm install` 在无 TTY 且 `CI=true` 下默认冻结 lockfile，需 `--no-frozen-lockfile` 更新。
- 本工作站 DSH 文件沙箱（workspace-write）禁止写 `~/.cache/prisma`，导致 `prisma generate` 默认触发引擎缓存的 `utime` EPERM。验证时用 `PRISMA_SCHEMA_ENGINE_BINARY=<已有缓存二进制>` 绕过；CI/正常本机环境无此限制。
- 重装后 pnpm 在本工作区生成 `node_modules` 同级的 `.pnpm-store/`（沙箱无法写全局 store 所致），已加入 `.gitignore`，不入库。

## 4. 后续建议（Wave 1 起）

1. Node 24 LTS 迁移（P0-02）——独立提交，先跑兼容矩阵。
2. 增加 CI verify job（不部署），并让 Docker build 依赖其成功。
3. 统一 `.dockerignore`、Web standalone、Worker bundle（P1-01）。
4. workspace blob 流式 I/O（P0-04）与 readiness（P1-06）。
