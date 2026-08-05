# SSO Workspace 对账与清理设计

## 背景与目标

AgentSpace 将 SSO tenant/team 映射为本地 workspace。当前应用库存在 97 个未归档的 `sso-*` workspace，但按 SSO 当前有效目录只能形成 3 个 workspace scope。其余记录包括 75 个 `E2E Workspace`、12 个 `Loading Visual Check` 和 7 个历史失效 SSO binding。

目标是让 SSO 成为 workspace 身份与有效性的唯一事实来源，同时保留本地 workspace 中的业务数据，避免因 SSO 停用或短暂故障造成不可恢复的数据删除。

## 方案选择

### 采用：持久化镜像 + 归档对账

- SSO 有效 scope 以确定性 workspace ID 在本地 upsert。
- SSO 中不再有效的已绑定 workspace 标记为归档，不物理删除。
- 重新有效的 scope 自动恢复对应 workspace。
- 平台管理员只看到未归档且存在 SSO binding 的 workspace。
- 明确标识的 E2E/视觉测试 workspace 通过维护命令归档。

该方案能立即隐藏污染数据，同时保留恢复和审计能力。

### 未采用：仅在前端过滤

只过滤名称或 ID 前缀无法修复后台任务、权限解析和运行时维护仍会读取脏 workspace 的问题，也无法处理历史 binding。

### 未采用：与 SSO 做物理级联删除

直接删除 workspace 会连带删除消息、员工、任务、运行时和知识数据。SSO 误操作或临时停用时无法恢复，因此不作为自动同步行为。

## 权威 Scope 规则

1. 只读取 ACTIVE tenant。
2. 只接受自身为 ACTIVE 且父 tenant 也为 ACTIVE 的 team。
3. 每个有效 team 映射为一个 team workspace。
4. 仅当 tenant 没有有效 team 时，映射为一个 tenant workspace。
5. workspace ID 继续由 scope 类型和 SSO 外部 ID 确定性生成。
6. 同一 SSO team 或 tenant scope 在数据库中只能绑定一个 workspace。

SSO 当前返回 3 个 ACTIVE tenant 和 11 个 ACTIVE team，其中 8 个 team 的父 tenant 不再 ACTIVE。这 8 个 team 不进入 AgentSpace 有效 scope，同时应在 SSO 侧停用或修复父子状态。

## 应用内对账流程

登录同步分为两类：

- 普通用户登录：只同步该用户的 workspace 和成员角色；撤销用户不再拥有的成员关系，不对其他 workspace 做全局归档。
- 平台管理员登录：SSO 内部目录返回全量有效 scope；在同一轮同步中 upsert/恢复有效 workspace，并归档所有不在权威集合中的已绑定 workspace。

平台管理员的 workspace 解析不再依赖 `sso-` ID 前缀，而是从未归档 workspace 与 `workspace_sso_binding` 的关联结果构造。这样未绑定的测试 workspace 即使尚未清理，也不会进入切换器或获得合成管理员权限。

## 数据模型与数据库约束

- 保留 `workspace.archived_at` 作为有效性镜像，不新增重复状态字段。
- 增加恢复 workspace 的数据库操作，用于 SSO scope 重新启用。
- 增加查询未归档且已绑定 SSO 的 workspace 操作。
- 为非空 `team_id` 增加唯一索引。
- 为 `source = 'tenant'` 的 `tenant_id` 增加唯一索引。
- 对账归档保留 `workspace_sso_binding`，用于恢复和追溯。

迁移前必须检测重复 binding；发现重复时停止迁移并输出冲突，不自动选择保留项。

## 测试数据隔离与回收

- E2E 继续强制使用独立测试数据库，禁止回退到应用数据库。
- E2E 全局 setup 清理上一次异常中断遗留的精确测试标识，global teardown 回收本轮数据。
- 回收条件必须同时匹配测试 ID 和测试名称/身份特征，禁止按宽泛 `sso-*` 前缀删除。
- 应用库现存测试 workspace 使用一次性维护命令逻辑归档；不物理删除 workspace 业务数据。

## 一次性现网清理

维护命令默认 dry-run，展示分类、workspace ID、名称和数量；只有显式 `--apply` 才执行。

执行顺序：

1. 读取 SSO 全量 ACTIVE tenant/team，生成权威 scope 集合。
2. 验证数据库中没有重复外部 binding。
3. 恢复权威集合内已归档的 workspace。
4. 归档不在权威集合内的已绑定 workspace。
5. 归档严格匹配的 `E2E Workspace` 和 `Loading Visual Check` 未绑定 workspace。
6. 输出处理前后计数和所有变更 ID，保存为本地运维证据。

本次不删除测试用户、身份和会话；它们不参与平台管理员 workspace 解析。物理清理应作为独立的数据保留策略实施，避免扩大本次变更范围。

## SSO 侧修复

SSO 应保证 tenant 停用后其 team 不再通过 ACTIVE team 列表返回。优先修复目录查询或 tenant 停用事务，使父 tenant 非 ACTIVE 的 team 被停用或从 ACTIVE 列表排除。

AgentSpace 保留父 tenant ACTIVE 校验作为防御性约束，但不在本项目内直接修改 SSO 数据状态。SSO 修复需要在 SSO 仓库独立提交和验证；一次性数据修复必须先 dry-run 列出 8 个目标 team。

## 错误处理与可恢复性

- SSO 目录读取失败时不执行归档，只让登录失败并保留本地状态。
- 全局对账在事务中完成，任一数据库写入失败则整体回滚。
- 自动同步永不物理删除 workspace。
- 已归档 workspace 重新出现在 SSO 有效 scope 后自动恢复。
- 维护命令重复执行应得到相同结果，第二次执行变更数为零。

## 验收标准

- 平台管理员 workspace 列表只显示当前 3 个权威 SSO scope。
- 普通用户仍只看到自己的有效成员 workspace。
- 未绑定的 `sso-team-e2e-*` workspace 不再被平台管理员读取。
- 全量对账会归档失效 binding，并恢复重新启用的 binding。
- SSO team/tenant binding 唯一约束生效。
- E2E 测试结束后不遗留 workspace；异常中断遗留能在下一次运行前清理。
- 一次性维护命令 dry-run 与 apply 输出可核对，重复 apply 无额外变化。
- 定向测试、Web/DB 类型检查和数据一致性复核通过。

## 非目标

- 不改变 workspace 内消息、员工、知识、任务或运行时的数据模型。
- 不自动硬删除任何真实或历史 workspace。
- 不在 AgentSpace 中复制 SSO 的 tenant/team 管理功能。
- 不把本次治理扩展为通用用户和会话数据保留系统。
