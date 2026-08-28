# Wave 1 - P0-02 Node 24 LTS 迁移验收记录

> 推进日期：2026-08-21
>
> 范围：docs/0821/opz 的 P0-02 —— 从 Node 25（EOL）迁移到 Node 24 LTS（v24.19.0）。
>
> 状态：**已完成，待提交**。CI 自动部署与镜像不可变规则（Wave 2）未在本轮推进。

## 1. 决策

- Node 官方发布页在 2026-08-21 将 v25.9.0 标记为 EOL，将 v24.19.0 标记为 Latest LTS。继续停留在奇数非 LTS 线（25）不再符合支持基线。
- 迁移目标定为 **Node 24.19.0**（Latest LTS，代号 Krypton）。不升级到 Node 26（Current，尚未 LTS）。
- `engines.node` 收紧为 `^24.19.0`（`>=24.19.0 <25.0.0`），新增根目录 `.node-version` 作为运行时契约单点，与根 engines、CI 基础镜像同源。

## 2. 改动清单

| 位置 | 改动 |
| --- | --- |
| 11 个 `package.json`（根 + 10 workspace） | `engines.node` `^25.9.0` → `^24.19.0` |
| `packages/daemon/scripts/build.mjs` | esbuild `target: "node25"` → `"node24"` |
| `apps/mcp-egress-proxy/package.json` | esbuild `--target=node25` → `node24` |
| 8 个 `deploy/*/Dockerfile` | 基础镜像 `node:25.9-bookworm-slim` → `node:24.19-bookworm-slim` |
| `scripts/audit-node-engines.mjs` | 移除 `jsdom@30.0.1` 限时例外（jsdom 的 `^24.15.0` 已覆盖 Node 24） |
| `pnpm-workspace.yaml` catalog | `@types/node` `^25.9.5` → `^24.13.3`（对齐 Node 24 类型） |
| 新增 `.node-version` | `24.19.0` |
| `README.md` / `CONTRIBUTING.md` / `packages/daemon/README.md` | Node 版本说明同步为 24.19.0 |
| `.github/workflows/deploy-production.yml` / `deploy/feishu-worker/Dockerfile` | Corepack 注释改为「避免依赖 corepack 打包策略差异」，不再归因 Node 25 移除 |
| `docs/0814/node-runtime-matrix.md` | 结论与矩阵改 Node 24，jsdom 例外归档为「已失效」 |

## 3. 兼容矩阵验收（下载 Node 24.19.0 darwin-arm64 实测）

| 检查 | 命令（Node v24.19.0 / pnpm 10.26.2） | 结果 |
| --- | --- | --- |
| engines 审计 | `node scripts/audit-node-engines.mjs` | ✅ 11 manifest 覆盖；674 唯一包 0 违规（jsdom 例外已失效） |
| 测试清单 | `node scripts/verify-test-inventory.mjs` | ✅ 357 owned + 172 deferred |
| 类型检查 | `pnpm run typecheck`（含 @types/node@24.13.3） | ✅ exit 0，未发现 Node 25 独有 API 依赖 |
| Web lint | `pnpm run lint:web` | ✅ 0 error / 0 warning |
| daemon 构建 | `pnpm --filter dofe-agent-daemon run build`（esbuild node24） | ✅ exit 0 |
| daemon 受限测试 | `pnpm --filter dofe-agent-daemon test` | ✅ 235 pass / 13 skip / 0 fail |

## 4. 未在本轮验证（需目标平台）

- **Docker 基础镜像**：私有仓库 `uhub.service.ucloud.cn/techwu/node:24.19-bookworm-slim` 标签是否存在需在可拉取该仓库的节点上核对；每个 provider 最终镜像需执行 `node --version`、daemon 启动与 provider smoke（不接受只验证 wrapper build stage）。
- **Web 生产构建（Next build）与浏览器 E2E**：本轮以 typecheck + lint + daemon 受限测试覆盖兼容面，Next `build` 与 Playwright E2E 未在本机重跑（构建产物巨大，且 E2E 依赖测试服务）。
- **跨平台 optionalDependencies**：audit 依赖层扫描基于 darwin-arm64 实际安装的 `node_modules/.pnpm`，linux/amd64 结论需在目标平台各跑一次。

## 5. 本机环境提示

- 本工作站 Homebrew 已把 `node` 升到 v26.5.0（Current，非 LTS）。本轮用下载到 `/tmp/node24` 的 Node 24.19.0 二进制完成兼容矩阵验证；开发者应通过 `.node-version`（nvm/fnm/volta/mise）切到 24.19.0。
- 本机 `audit-node-engines.mjs` 默认以 `process.versions.node` 为目标，因此在仍为 Node 26 的宿主机上会继续转红——这是 fail-closed 正确行为（运行时与声明目标不匹配），在 Node 24 的 CI/本机即通过。
- `prisma generate` 在本工作站沙箱下需 `PRISMA_SCHEMA_ENGINE_BINARY` 指向已缓存引擎（沙箱禁写 `~/.cache/prisma`）；CI/正常本机无此限制。
