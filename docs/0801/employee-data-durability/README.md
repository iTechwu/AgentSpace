# AI 员工数据持久化与恢复设计

状态：**Partially Implemented（2026-08-02 第二轮推进后）**
日期：2026-08-01
范围：AgentSpace 中 AI 员工的工作数据、Skill 制品和运行时恢复。

> **实施状态标注（2026-08-02）**
>
> 本次推进后，P0 基线防护、P1 工作空间提交语义、P2 Skill 导入 rename 冲突、P1 稳定 `employeeId`、外部备份-恢复演练可留存结果、P4 员工详情页数据保护面板/告警/手动演练均已落地并通过测试。
>
> - **已修复**：任务完成必须基于 `committed` 状态；Skill 制品损坏/缺失在运行时物化阶段 fail-closed；workspace revision 为完整快照；blob 元数据写入真实 provider/bucket/region/key；generation guard 严格相等并覆盖任务认领与写入路径；恢复编排实现 provisional binding + 分 phase 校验 + 原子激活；Skill 导入 `rename` 不再覆盖内置 skill。
> - **已实施**：
>   - 稳定 `employeeId`：`workspace_employee.id` 生成不可变 UUID，`ActiveEmployee.id` 暴露该 ID；EAD 表（`employee_persistent_workspace`、`employee_workspace_revision`、`employee_artifact`、`employee_runtime_binding`、`employee_recovery_operation`、`task_commit_journal`）新增 `employee_id` 外键，生产写入使用 `employeeId`。
>   - 备份-恢复演练：`backup_restore_drill_run` 持久化元数据级演练结果；`runBackupRestoreDrillRunSync` 抽样员工并重算 workspace manifest/Skill digest；Cron 路由 `app/api/cron/backup-recovery-drill/route.ts` 接入外部调度，失败时返回 503 并通知管理员。
>   - 产品运维闭环：员工详情页数据保护面板展示健康告警、最近恢复操作、最近演练记录与手动“运行演练”按钮；新增 `evaluateWorkspaceDataProtectionHealthAction`、`listWorkspaceBackupRestoreDrillRunsAction`、`triggerEmployeeBackupRestoreDrillAction`。
> - **部分实现**：恢复编排的运行时创建/挂载仍依赖调用方提供 `targetRuntimeId`，真正的容器重建与 secret 注入由外部 runtime-provisioning 服务完成。
> - **剩余**：`employee_skill_assignment` 等非 EAD 表尚未迁移到 `employeeId`；D-10 当前为元数据级演练，真正的跨环境物理恢复仍需外部 PostgreSQL PITR / 对象存储备份与隔离恢复环境。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [01-员工数据持久化与恢复架构.md](./01-员工数据持久化与恢复架构.md) | 目标架构、数据边界、核心决策、恢复模型与部署约束。 |
| [02-实施路线与验收.md](./02-实施路线与验收.md) | 分阶段实施、迁移、恢复演练、可观测性与验收标准。 |
| [03-实施审查与后续优化.md](./03-实施审查与后续优化.md) | 依据当前代码和测试形成的实施完成度、上线阻断项与后续优先级。 |

## 核心结论

1. Docker 容器、Provider Home、`.codex/skills` 投影目录和任务 `workDir` 都不是员工业务数据的唯一保存位置。
2. 员工身份、Skill 制品及其版本锁定、员工持久工作空间、正式产物和恢复点必须有独立于运行时镜像的持久化事实来源。
3. 运行时绑定是可替换的租约；员工的稳定标识、数据和已绑定 Skill 不随容器、镜像或节点变化。
4. Skill 以不可变制品和内容摘要管理，安装到运行时只是可重复、可校验的缓存与投影过程；脚本和二进制资源必须完整进入制品。
5. 任何从临时目录产生的有效结果，必须先原子提升为员工工作空间版本或正式产物，任务清理后才可视为完成。

本设计补充而不取代现有的 [Skill 安装架构](../skill-install/02-架构设计.md) 和 [员工 Skill 环境设计](../../0731/employee-skill-environment/00-产品设计规格.md)。前者定义 Skill 的制品化与安装契约；本文定义这些制品及员工数据在运行时故障、重建和重新绑定后的存续契约。
