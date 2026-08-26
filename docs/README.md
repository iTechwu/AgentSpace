# docs 索引

> 本文件是 `docs/` 的唯一入口：根级常驻文档、按主题的日期目录索引、归档策略。
> 对应优化项 3.6-12。

## 根级常驻文档（随代码演进，不按日期归档）

| 文档 | 内容 |
| --- | --- |
| [progress-log.md](./progress-log.md) | 优化轮次逐项落地记录（P0/P1/P2 状态 + 提交号） |
| [optimization-suggestions.md](./optimization-suggestions.md) | 优化建议清单（含已完成项的收口结论） |
| [deployment-topology.md](./deployment-topology.md) | 部署拓扑与组件所有权（7 部署面 + 所有权矩阵 + 易踩坑约定） |

## 按主题索引日期目录

目录名 `MMDD` 为立项日期；一个目录 = 一个主题，目录内 `00/01/02…` 编号为该主题的文档序列。

行尾状态标记：✅ 已完成/收口 · 🟡 部分完成或进行中 · 无标记 = 设计稿/提案。状态以各主题 README 自述为准（2026-08-17 首次全量对齐）。

### 产品与设计规格

| 目录 | 主题 |
| --- | --- |
| `0724/uiux` | 体验审计与设计目标 🟡 进行中（界面代码已开始落地） |
| `0727/agent-pricing` | AI 员工 Runtime、模型与计费产品需求及交付规格 🟡 仓库侧实施完成（2026-07-28），staging E2E 待验收 |
| `0731/employee-skill-environment` | 员工 Skill 环境变量配置设计（设计稿，Demo 阶段 MVP） |
| `0801/skill-install` | Skill 直接安装使用方案（DSP 全链）✅ 全链实施+测试完成（c1314ea3）；drift-compare 与 feature-flag 项有意延后 |
| `0801/mcp-extension` | MCP 中心与 CLI 市场产品文档 ✅ P0/P1 完成（含 E4 多 harness gateway 注入层）；仅真实 codex 连 gateway 的 E2E 待 CI 环境验证 |
| `0803/0801-0803整体实施差距审查.md` | 0801 三主题（skill-install / mcp-extension / employee-data-durability）实施差距审查；被三主题 README 引用为权威状态 |
| `0802/mcp-install` | MCP 安装与治理总体架构（设计稿，Proposed） |
| `0804/cli-mcp` | CLI MCP 现状审计与产品判断（提案，待评审） |
| `0805/montage` | OpenMontage 接入决策与目标架构 🟡 实施中（核心 Job 控制面已落地） |
| `0806/agent-team` | AI 员工团队编排设计 🟡 核心实施完成，发布门禁 NO-GO |
| `0811/cli-install` | CLI 安装方案（产品决策 → 落地）🟡 Phase 1 已落地，Phase 2-7 部分进行 |
| `0815/` | novel-production 编排落地（自带 [README](./0815/README.md)）🟡 部分实现（`7f360d27..585ab010`），验收差距待收口 |

### 架构决策与迁移

| 目录 | 主题 |
| --- | --- |
| `0826/` | MCP 独立化架构、产品优化与实施方案（Proposed） |
| `0731/codex-connect-other-models` | Codex 连接其他模型：根因与证据 ✅ 本地实施/验证/提交完成（未部署） |
| `0803/mcp-egress-proxy` | ADR：MCP Egress Proxy（monorepo 内 Compose 专用）🟡 Phase 0-2 已实施，Phase 3 待迭代 |
| `0808/db_migration_to_prisma` | 迁移 Prisma 的评估与实施方案 🟡 Phase 2 进行中（22 读域 + 4 写路径已切流，实时状态见 [progress-log.md](./progress-log.md)） |
| `0814/node-runtime-matrix.md` | Node 运行时矩阵（engines 限时例外依据）✅ 决策已定（2026-08-14） |

### 数据耐久与演练

| 目录 | 主题 |
| --- | --- |
| `0801/employee-data-durability` | 员工数据持久化与恢复架构 🟡 部分实施（EAD schema v51 + artifact/workspace/recovery 服务已建并测试，recovery API 路由 + UI + daemon 接线延后）；`evidence/` 为演练脚本输出目录（见归档策略 §2） |

### 测试

| 目录 | 主题 |
| --- | --- |
| `0801/test-logs` | 测试日志索引 ✅ 收口（应用级失败已修正，生产构建绿） |
| `0803/test` | 全系统测试（流程 / 用例矩阵 / 报告 / results 证据）✅ 已执行，报告留档 |
| `0804/test` | 端到端测试 ✅ 已执行（2026-08-04 执行报告留档） |
| `0805/test` | 全量测试 ✅ 已执行（2026-08-05 执行报告留档） |

### 运维与发布

| 目录 | 主题 |
| --- | --- |
| `0814/release-preflight-checklist.md` | 发布前置检查清单（活文档，最近修订 2026-08-14） |
| [0821/opz](./0821/opz/README.md) | 全项目扫描、优化建议与本机原生开发到 CI Docker 的迁移路线；GEOFlow MCP 真实 Docker 全链验收已完成 🟡 |
| `0823/` | DeepSeek Harness Runtime 接入产品、架构、实施与验收方案 🟡 本地实施/验证/提交完成（已合并到 `dev`，合并提交 `1e8af517`）；发布受外部阻断（Node 24.19 基础镜像、真实 key/签名镜像） |

### 其他

| 目录 | 主题 |
| --- | --- |
| `superpowers/` | superpowers 技能产出（plans/ 实施计划 + specs/ 设计），文件名带日期 ✅ 两组 spec/plan 均已实施（见各文件头部状态注） |

## 归档策略

1. **新主题** → 新建 `docs/MMDD/<主题slug>/` 目录，首篇文档从 `00-` 或 `01-` 开始编号；在本 README 对应主题小节登记一行。单篇独立文档（如 `0814/*.md`）可直接放日期目录下。
2. **证据文件留在原目录，不移入 `artifacts/`**：`artifacts/` 在 `.gitignore` 中（不进版本库），而 `docs/` 下的证据是刻意留档的发布/验收记录——`0801/employee-data-durability/evidence/` 是 5 个演练脚本的硬编码输出路径（`scripts/employee-data-durability/*.mjs`），`0803/test/results/` 的 playwright 结果与截图被测试报告正文引用（含双 worker 竞争复现 JSON）。移动即断链。
3. **主题完结** → 在本 README 行尾追加完成状态与关键提交号（参照 `progress-log.md` 风格），目录本身不删不改名（外部引用按路径稳定）。
4. **根级三文档**不按日期归档；它们的内容本身就是最新状态。
