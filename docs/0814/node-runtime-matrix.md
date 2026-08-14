# Node 运行时矩阵与版本策略

> 建立日期：2026-08-14。决策人：techwu@PardxAi。复核触发：jsdom 版本升级后 `pnpm audit:engines` 转红时、或决定升级 Node 主版本时。

## 结论

- **生产运行时固定为 Node 25.9.0**。所有容器基础镜像统一使用 `uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim`（见 `deploy/*/Dockerfile*`）。
- **不升级到 Node 26，不改 Docker 基础镜像**。升级主版本需另起评估（原生模块兼容、`--experimental-strip-types` 行为、Turbo/Next 支持）。
- `engines.node` 收紧为 `^25.9.0`（`>=25.9.0 <26.0.0`）：仅声明实测验证的生产版本。此前多版本矩阵 `^22.22.2 || ^24.15.0 || ^25.9.0 || >=26.0.0` 声明了未经验证的 22/24，且 `>=26.0.0` 无上限接受未来 27/28，已于 2026-08-14 收紧。升级到 26 需先完成下方「升级 Node 前置条件」并同步放开 engines。

## 运行时矩阵

| 位置 | Node 版本 | 说明 |
| --- | --- | --- |
| 生产容器（daemon / web / worker / provider-runtime / egress-proxy） | 25.9.0 | `node:25.9-bookworm-slim` |
| 本地开发工作站 | 25.9.0 | 仅安装 v25.9.0，未安装 24/26，未使用 nvm/fnm/volta |
| `engines.node` 声明 | `^25.9.0` | 仅保留实测验证的生产版本（`>=25.9.0 <26.0.0`） |

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
- jsdom 的 engines 只跟随 LTS 线（22/24/26+）；Node 25 是奇数非 LTS 线，**上游不会纳入**——「等 jsdom 支持 25」不是现实路径，例外真正的到期是升级到 Node 26（按下方前置条件评估，Node 26 GA 预计 2026-10）。
- **2026-08-14 全量审计**（`pnpm audit:engines`，scripts/audit-node-engines.mjs）：754 个唯一包中 399 个声明 engines.node，**唯一不覆盖 25.9.0 的就是 jsdom@30.0.1**——本例外的爆炸半径被精确圈定为单包，其余全部依赖的 engines 均覆盖 25.9.0。

因此本仓库将此不一致**接受为限时例外**：

1. 不为规避 jsdom 的 engines 声明而升级 Node 26 或改 Docker。
2. 不启用 `engine-strict`（会被 jsdom 单点阻断 25.9 安装）；作为等价替代，`pnpm audit:engines`（scripts/audit-node-engines.mjs）做两层检验并 fail-closed：
   - **仓库 manifest 层**：根与全部 workspace 包（`pnpm-workspace.yaml` 内）的 engines.node 必须覆盖目标 Node 版本，任何一处不匹配直接 exit 1——用受支持的运行时跑仓库属于配置错误，不做“仅供参考”降级。
   - **依赖层**：全部安装依赖的 engines.node 检验，出现 KNOWN_EXCEPTIONS（精确钉 `jsdom@30.0.1`）之外的违规即 exit 1。
   执行路径：已接入根 package.json 的 `pretest`，`pnpm test` 自动执行；也可手动 `pnpm audit:engines`（或 `--node <版本>` 假设性检查）。CI/部署工作流当前不自动运行本审计（生产部署只跑构建 + Skill Runner egress 门禁）。
   已知局限：依赖层扫描基于当前平台实际安装的 `node_modules/.pnpm`，其他平台的 optionalDependencies 未安装时不会被检验；跨平台结论需在目标平台各跑一次。
3. **复核触发**：jsdom 升级后若仍排除 Node 25，`pnpm audit:engines` 会因例外钉的版本失配而转红，需同步更新脚本内 KNOWN_EXCEPTIONS 与本文档；当仓库升级到 Node 26 时该例外自动失效（jsdom 声明已匹配，脚本会提示例外可移除）。

## 升级 Node 的前置条件（未来参考）

若决定升级生产 Node 主版本（如到 26）：

1. 所有 `deploy/*/Dockerfile*` 基础镜像同步更新。
2. `engines.node`（根 `package.json`、`packages/daemon/package.json`、`apps/mcp-egress-proxy/package.json` 等）更新。
3. 全量回归：`turbo run test --concurrency=2`、web 构建、daemon/CLI smoke。
4. 确认 `--experimental-strip-types`（本仓库无编译步骤，直接跑 `.ts`）在新版本行为一致。
5. 本复核文档随之上更新或归档。

## 相关提交

- `e5b4d483`：首次将 `engines.node` 收敛为多版本矩阵 `^22.22.2 || ^24.15.0 || ^25.9.0 || >=26.0.0`。
- 本文档：固化”保持 25.9”决策，记录 jsdom@30 advisory 例外。
- 2026-08-14：将 `engines.node` 从多版本矩阵收紧为 `^25.9.0`（仅保留实测验证的生产版本，去掉未验证的 22/24 与无上限的 `>=26`）。涉及根 `package.json`、`packages/daemon/package.json`、`apps/mcp-egress-proxy/package.json`。
- 2026-08-14：新增 `scripts/audit-node-engines.mjs`（`pnpm audit:engines`）；全量审计确认 jsdom@30.0.1 是唯一 engines 违规，并修正复核触发（jsdom 上游不会纳入奇数非 LTS 线，例外到期日 = 升级 Node 26）。
- 2026-08-14：审计加固——根/workspace manifest 的 engines.node 不匹配从“警告”改为直接 exit 1；扫描范围扩展到 `pnpm-workspace.yaml` 全部 workspace 包；接入根 `pretest`（`pnpm test` 自动执行），文档如实标注 CI/部署不自动运行与跨平台 optionalDependencies 局限。
