# 整体 Skill 安装方案（0815）

> 状态：方案稿（待评审），尚未进入实现
>
> 范围：在 [0801 skill-install](../0801/skill-install/README.md) 已落地的“单个 Skill 生命周期”之上，补齐**依赖闭包统一解析 + 多 Runtime 批量安装 + 编排场景落地**三件事。本文档不重写 0801 的导入/安装/激活状态机，只做增量。

## 文档导航

| 文档 | 说明 |
| --- | --- |
| [01-整体安装方案.md](./01-整体安装方案.md) | 控制面统一解析锁定、Runtime 只执行、三种安装范围、一次审批模型 |
| [02-依赖模型与接口契约.md](./02-依赖模型与接口契约.md) | `skillDependencies` 语义、`planSkillRollout` 深模块、Artifact Revision 契约 |
| [03-novel-production编排落地.md](./03-novel-production编排落地.md) | 5 Skill 独立 + 编排入口 Skill + Workflow DAG 的端到端落地用例 |
| [04-实施计划与验收.md](./04-实施计划与验收.md) | 数据模型变更、现有代码调整清单、分阶段实施与验收 |
| [05-SkillRolloutPlan落点与测试矩阵.md](./05-SkillRolloutPlan落点与测试矩阵.md) | 逐文件改动点、函数签名、T01–T22 测试矩阵 |
| [06-Issue拆解与PR顺序.md](./06-Issue拆解与PR顺序.md) | 9 个可执行 issue、依赖关系、PR 顺序与门禁 |

## 决策摘要

1. **依赖由控制面统一解析和锁定，Runtime 只执行安装计划**，不自行决定装哪些 Skill；默认也不全量安装，而是装到“实际会执行该 Skill 的 Runtime 集合”。
2. **三种安装身份分离**：Skill 逻辑身份 `UNIQUE(workspace_id, name)`、Artifact 内容身份 `UNIQUE(workspace_id, digest)`、Runtime 安装身份 `UNIQUE(workspace_id, runtime_id, artifact_digest, revision)`。Skill artifact 只导入一次，installation 按 Runtime 隔离。
3. **新增 `skillDependencies`（Skill→Skill 依赖）**，与现有 npm/pip/uv/system 运行环境依赖分离；用稳定 `coordinate` 做依赖身份，不按可重命名的显示名称关联。
4. **新增 `planSkillRollout` 深模块**：一次解析依赖闭包、锁定 digest、计算目标 Runtime 集合、汇总风险、生成 `Runtime × Artifact` 安装项，用户只批准一次完整计划。
5. **新增 `skill_rollout_plan` 审批载体**：一次审批绑定“依赖闭包 + 目标 Runtime 集合 + planDigest”，所有子安装引用该批准，替代当前单 installation 消费一次审批。
6. **现有两处实现需配合调整**：`createSkillInstallationSync` 的“先查询再 INSERT”改为数据库原子 `INSERT ... ON CONFLICT ... RETURNING`；批量安装的审批消费改为引用 rollout plan。
7. **novel-production 不做超级 Skill**：5 个生产 Skill 保持独立，新增薄编排入口 Skill + `shot-generation` + 失败归因；AgentSpace Workflow 负责顺序/并行/审批/重试/产物传递。

## 与 0801 的关系（增量，非重写）

| 维度 | 0801 已落地 | 0815 新增 |
| --- | --- | --- |
| 安装粒度 | 单 artifact × 单 Runtime | 依赖闭包 × 多 Runtime |
| 依赖 | npm/pip/uv/system 运行环境 | 新增 Skill→Skill 依赖闭包 |
| 审批 | 单 installation 消费一次审批 | rollout plan 一次审批覆盖全部子安装 |
| 目标选择 | 手动指定 Runtime | 自动计算目标 Runtime 集合 |
| 幂等写 | 先查询再 INSERT | 原子 ON CONFLICT |
| 使用入口 | 逐个 Skill 安装 | 一个入口补齐 5 个 Skill |

## 关键代码锚点

- 图节点类型与环路拒绝：`packages/domain/src/workflows.ts:1`（仅 `employee_task`/`join`/`approval`，`workflow_graph_cycle`）
- 节点声明所需 Skill：`packages/services/src/workflows/validation.ts:228`（`requiredSkillIds`）
- 节点输出 256 KB 上限：`packages/services/src/workflows/completion.ts:21`（`MAX_WORKFLOW_OUTPUT_BYTES = 256 * 1024`）
- 运行环境依赖类型：`packages/domain/src/skill-package.ts:66`（`npm|pip|uv|system`）
- 三张身份表：`packages/db/src/postgres-schema.ts:1303`（skill）、`:3342`（skill_artifact）、`:3517`（skill_installation）
- 先查询再 INSERT：`packages/db/src/skill-installations.ts:78`
- 单安装审批消费：`packages/services/src/skills/installations.ts:140`
- 按名称 rename/replace/skip：`packages/services/src/skills/import.ts:442`
