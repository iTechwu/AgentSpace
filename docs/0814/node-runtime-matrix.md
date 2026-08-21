# Node 运行时矩阵与版本策略

> 建立日期：2026-08-14。决策人：techwu@PardxAi。
>
> 复核触发：jsdom 版本升级后 `pnpm audit:engines` 转红时、或决定升级 Node 主版本时。
>
> 最近更新：2026-08-21 —— Node 25 已 EOL，迁移到 Node 24 LTS（v24.19.0）。

## 结论

- **生产运行时迁移到 Node 24.19.0（Latest LTS）**。Node 官方已把 v25.9.0 标记为 EOL，v24.19.0 标记为 Latest LTS；继续停留在奇数非 LTS 线（25）不再符合支持基线。所有容器基础镜像统一使用 `uhub.service.ucloud.cn/techwu/node:24.19-bookworm-slim`（见 `deploy/*/Dockerfile*`）。
- **不升级到 Node 26（Current，尚未 LTS）**。升级主版本需另起评估（原生模块兼容、`--experimental-strip-types` 行为、Turbo/Next 支持）。
- `engines.node` 收紧为 `^24.19.0`（`>=24.19.0 <25.0.0`）：仅声明实测验证的生产版本。运行时契约由 `.node-version` 与根 engines、CI 基础镜像同源。

## 运行时矩阵

| 位置 | Node 版本 | 说明 |
| --- | --- | --- |
| 生产容器（daemon / web / worker / provider-runtime / egress-proxy） | 24.19.0 | `node:24.19-bookworm-slim` |
| 本地开发工作站 | 24.19.0 | 由 `.node-version` 固定（nvm/fnm/volta/mise 均可读取） |
| `engines.node` 声明 | `^24.19.0` | 仅保留实测验证的生产版本（`>=24.19.0 <25.0.0`） |

## jsdom@30 例外：已随 Node 24 迁移失效（归档）

`apps/web` 开发依赖 `jsdom@^30.0.1` 的 `engines.node` 声明为：

```
^22.22.2 || ^24.15.0 || >=26.0.0
```

此前仓库停留在 Node 25.9.0（奇数非 LTS 线）时，该声明**显式排除 Node 25.x**，故以 `scripts/audit-node-engines.mjs` 的 `KNOWN_EXCEPTIONS` 精确钉 `jsdom@30.0.1` 接受为例外。

**2026-08-21 迁移到 Node 24.19.0 后该例外失效**：24.19.0 满足 `^24.15.0`，jsdom 不再违规，`KNOWN_EXCEPTIONS` 已清空。后续若升级 Node 主版本（如 26），需按下方「升级 Node 的前置条件」重新跑全量审计并核对是否有新的 engines 违规。

## 升级 Node 的前置条件（未来参考）

若决定升级生产 Node 主版本（如到 26）：

1. 所有 `deploy/*/Dockerfile*` 基础镜像同步更新，并对每个 provider 最终镜像执行 `node --version`、daemon 启动与 provider smoke（不接受只验证 wrapper build stage）。
2. `engines.node`（根 `package.json` 与全部 workspace 包）与 `.node-version` 同步更新。
3. 全量回归：`turbo run test --concurrency=2`、web 构建、daemon/CLI smoke、真实 Docker egress gate。
4. 确认 `--experimental-strip-types`（本仓库无编译步骤，直接跑 `.ts`）在新版本行为一致。
5. `scripts/audit-node-engines.mjs` 的 `KNOWN_EXCEPTIONS` 与本复核文档随之上更新或归档。

## 相关提交

- `e5b4d483`：首次将 `engines.node` 收敛为多版本矩阵 `^22.22.2 || ^24.15.0 || ^25.9.0 || >=26.0.0`。
- 2026-08-14：将 `engines.node` 从多版本矩阵收紧为 `^25.9.0`（仅保留实测验证的生产版本）；固化「保持 25.9」决策并记录 jsdom@30 advisory 例外。
- 2026-08-14：新增 `scripts/audit-node-engines.mjs`（`pnpm audit:engines`）；审计加固为两层 fail-closed，并接入根 `pretest`。
- 2026-08-21：**迁移到 Node 24 LTS**（v24.19.0）——11 个 manifest 的 `engines.node` 改为 `^24.19.0`，daemon esbuild target 改 `node24`，全部 Dockerfile 基础镜像改 `node:24.19-bookworm-slim`，`KNOWN_EXCEPTIONS` 清空（jsdom 例外失效），新增 `.node-version`。见 docs/0821/opz/03-Wave0-验收记录.md 与本次提交。
