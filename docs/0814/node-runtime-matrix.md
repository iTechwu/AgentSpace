# Node 运行时矩阵与版本策略

> 建立日期：2026-08-14。决策人：techwu@PardxAi。复核触发：下次 jsdom minor 发布、或决定升级 Node 主版本时。

## 结论

- **生产运行时固定为 Node 25.9.0**。所有容器基础镜像统一使用 `uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim`（见 `deploy/*/Dockerfile*`）。
- **不升级到 Node 26，不改 Docker 基础镜像**。升级主版本需另起评估（原生模块兼容、`--experimental-strip-types` 行为、Turbo/Next 支持）。
- `engines.node` 字段维持：`^22.22.2 || ^24.15.0 || ^25.9.0 || >=26.0.0`（声明 25.9 起可用，同时容忍 22/24 LTS 与未来 26）。

## 运行时矩阵

| 位置 | Node 版本 | 说明 |
| --- | --- | --- |
| 生产容器（daemon / web / worker / provider-runtime / egress-proxy） | 25.9.0 | `node:25.9-bookworm-slim` |
| 本地开发工作站 | 25.9.0 | 仅安装 v25.9.0，未安装 24/26，未使用 nvm/fnm/volta |
| `engines.node` 声明 | `^22.22.2 \|\| ^24.15.0 \|\| ^25.9.0 \|\| >=26.0.0` | 跨多主版本兼容，CI 可在不同 Node 上校验 |

## jsdom@30 与 Node 25 的 advisory 例外（限时跟踪）

`apps/web` 开发依赖 `jsdom@^30.0.1`，其 `engines.node` 声明为：

```
^22.22.2 || ^24.15.0 || >=26.0.0
```

该声明**显式排除 Node 25.x**（25.9.0 不匹配任何子句：既非 ^22/^24，也未被 `>=26.0.0` 覆盖）。

实际情况：
- jsdom 的 `engines` 字段是**advisory（建议性）**，pnpm 默认不强制（未触发 `ERR_PNPM_UNSUPPORTED_ENGINE`），仅在有 `engine-strict` 配置时才阻断。
- web 测试在 Node 25.9.0 上**实测通过**。jsdom 在 25.x 上的行为与在 26 上无实质差异（其引擎声明更接近“未正式测试 25”而非“已知不兼容”）。
- 我们无法把 25 加入 jsdom 的 `engines`——它是第三方包。

因此本仓库将此不一致**接受为限时例外**：

1. 不为规避 jsdom 的 engines 声明而升级 Node 26 或改 Docker。
2. 不启用 `engine-strict`（会因此阻断 25.9 安装）。
3. **复核触发**：每次 jsdom minor/major 升级时核对 engines 是否纳入 25，或当仓库决定升级到 Node 26 时该例外自动失效（届时 jsdom 声明已匹配）。

## 升级 Node 的前置条件（未来参考）

若决定升级生产 Node 主版本（如到 26）：

1. 所有 `deploy/*/Dockerfile*` 基础镜像同步更新。
2. `engines.node`（根 `package.json`、`packages/daemon/package.json`、`apps/mcp-egress-proxy/package.json` 等）更新。
3. 全量回归：`turbo run test --concurrency=2`、web 构建、daemon/CLI smoke。
4. 确认 `--experimental-strip-types`（本仓库无编译步骤，直接跑 `.ts`）在新版本行为一致。
5. 本复核文档随之上更新或归档。

## 相关提交

- `e5b4d483`：首次将 `engines.node` 收敛为多版本矩阵 `^22.22.2 || ^24.15.0 || ^25.9.0 || >=26.0.0`。
- 本文档：固化“保持 25.9”决策，记录 jsdom@30 advisory 例外。
