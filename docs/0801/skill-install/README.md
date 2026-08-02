# 全形态 Skill 安装与使用方案

> 状态：提案
>
> 范围：让 AgentSpace 在本地与 Remote Runtime 模式下，可靠地导入、安装、配置、验证并使用受支持的 Skill；不把第三方代码或 MCP 服务安装到宿主机。

## 文档导航

| 文档 | 说明 |
| --- | --- |
| [01-产品方案.md](./01-产品方案.md) | 用户问题、能力范围、产品需求和成功指标 |
| [02-架构设计.md](./02-架构设计.md) | 统一包格式、Remote Runtime 执行面、安全边界和 API |
| [03-UIUX设计方案.md](./03-UIUX设计方案.md) | 信息架构、安装向导、状态、组件与可用性验证 |
| [04-执行计划与验收.md](./04-执行计划与验收.md) | 分期、代码落点、迁移、测试和验收清单 |
| [05-运维服务与版本治理.md](./05-运维服务与版本治理.md) | 支撑服务准入、部署、健康、升级、回滚和退役手册 |
| [06-实施计划.md](./06-实施计划.md) | 工程落地：表 DDL、领域类型、文件落点、迁移、测试矩阵与 7 阶段 PR 序列 |
| [07-实施差距审查.md](./07-实施差距审查.md) | 当前代码对照设计的阻断项、阶段完成度、测试证据与补齐顺序 |
| [08-任务执行快照计划.md](./08-任务执行快照计划.md) | 任务按 runtime/assignment digest 解析并持久化安装 revision 快照 |
| [09-complete协议防伪造计划.md](./09-complete协议防伪造计划.md) | complete/fail 共享 payload 解析、冻结组件集合、evidence 校验与原子提交 |
| [10-release-lock计划.md](./10-release-lock计划.md) | Release lock 生产接入、可重现性、消费链和测试计划 |
| [11-版本治理后端核心计划.md](./11-版本治理后端核心计划.md) | 升级审批、lineage invariant、并发控制与回滚 |
| [12-依赖安装验证计划.md](./12-依赖安装验证计划.md) | npm/pip 隔离安装、registry 固定与真实产物验证 |

## 决策摘要

1. 以 [Agent Skills specification](https://agentskills.io/specification) 的 `SKILL.md` 目录为兼容基线，完整保留 `scripts/`、`references/`、`assets/` 和其他受允许文件；平台附加元数据放在独立 manifest，绝不改写上游 `SKILL.md`。
2. “安装”拆成四种不同语义：导入内容包、准备依赖、绑定 Runtime 能力、激活到员工。界面与状态机不得把它们混成一次同步操作。
3. Remote Runtime 下，指令、文件、依赖、脚本和 MCP 都能直接使用，但各自有明确执行位置。第三方脚本不得继承 Provider 凭据；远程 MCP 是受控连接，`stdio` MCP 是受管服务，不是任意命令执行。
4. 每次安装锁定不可变 artifact digest。Git/注册表链接只用于发现；实际安装记录 commit/digest、文件清单、风险结论、依赖解析结果和审批。
5. Skill 与 MCP 关联但不等同。Skill 声明它需要的逻辑能力；MCP Center 管理 Runtime x MCP connection、密钥、发现工具、网络策略和调用审计。沿用 [MCP 中心架构](../mcp-extension/02-架构设计.md) 的安全边界。
6. Skill 若需要常驻支持服务，只能引用审核的 `service catalog template@version`。运维以 image digest、资源边界、外部依赖、健康检查和回滚计划创建服务；Skill 包不能自行创建 Compose、容器、数据库或后台进程。

## 支持边界

“任何形式”在本方案中指可安全归一化为下列形态的 Skill，而不是允许任意 URL、shell 文本、Docker 镜像或宿主机路径直接执行。

| 维度 | 必须支持 | 处理方式 |
| --- | --- | --- |
| 来源 | 手工创建、目录、ZIP、Git SHA、Skills.sh、ClawHub、审核私有仓库、Runtime 产物、CLI 市场同步 | 均解析为不可变 artifact；注册表和分支只用于解析来源 |
| 内容 | `SKILL.md`、Markdown/配置、脚本、二进制 assets、references、模板、数据文件 | 文件清单保存 type、mode、size、sha256；只读 materialization |
| 依赖 | npm、Python、系统工具、CLI 市场应用 | 受控的锁定计划、专属目录、就绪门禁；禁止来源返回自由 shell |
| 外部能力 | 远程 Streamable HTTP MCP、受管 stdio MCP、已安装 CLI | 连接/能力绑定，不以环境变量或说明文本伪装为“已安装” |
| Provider | Codex、Claude、OpenCode、OpenClaw、NanoBot，及无原生目录的兼容模式 | 一个规范包，多目标 provider adapter；兼容目录仅作只读投影 |

## 规范与已有约束

- Agent Skills 规定目录至少包含 `SKILL.md`，并将脚本、参考资料、资产设计为按需加载资源；规范也强调渐进加载。[规范](https://agentskills.io/specification)
- MCP 标准传输是 `stdio` 和 Streamable HTTP。`stdio` 由客户端启动子进程；HTTP MCP 是独立服务并需要认证与 Origin 等安全控制。[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- 本项目既有决策：远程 MCP 不安装到服务器；本地/stdio MCP 必须是独立受管服务容器；CLI 保持 Runtime 内隔离。见 [运行环境隔离决策](../mcp-extension/04-运行环境隔离决策.md)。
- 任何部署实现不得新建 PostgreSQL、Redis 或 RabbitMQ 容器，继续连接集中管理的基础设施。

## 当前基线与目标差距

当前实现已经形成可运行的 Remote 安装闭环原型：不可变 artifact/blob、installation/component/operation、Daemon claim/start/complete/fail、artifact materializer、digest cache、component verifier、控制面 evidence 校验、任务的 Runtime readiness gate 和不可变 revision snapshot，以及**真实依赖安装验证**和 **service 控制面操作生命周期**（plan 排队 provision operation → claim → complete → 绑定 → 就绪传播，带 lease/fencing/维护重排）均已进入真实调用链。导入坏包不会修改 Skill；GitHub/Skills.sh 也会在读取前锁定 commit SHA。

这不等于已经达到生产可用。第三次复审确认仍有以下阻断上线的问题（排序已按事实更新）：

1. Runtime cache hit 只校验文件大小并信任旧 meta，同尺寸内容篡改不会重算 SHA/root digest。
2. 依赖已真实安装+校验；**service 控制面已裁决 ready/blocked，但 managed-node worker 未实现**——没有任何 daemon 消费者 claim skill-service 操作，服务容器永远不会被拉起，required service 的 Skill 无法真正 ready。
3. 原子导入生成的 artifact 没有绑定新 Skill，安装历史和回滚可能断链，单一 `artifact.skill_id` 也无法表达共享 artifact lineage。
4. entrypoint 同时为 `0755` 时会生成重复 script component，触发数据库唯一约束。
5. 任务 bundle 不传 mode/SHA，安装阶段验证通过的 executable 到 Remote task workDir 后会丢失执行位；任务也没有复用已验证 cache。
6. skill-install operation 的租约/心跳/fencing/崩溃重排已实现；**service operation 的 CRUD/lease 与完整流程缺专属测试**（当前仅被安装测试间接触发）。

此外，下载 URL 仍缺 storage origin/redirect 限制和流式硬上限；package manifest 的 version/integrity/mode/完整文件集合仍会丢失；持久审批、managed-node worker、五步 UI、迁移与可观测性尚未完成。Release lock 已接入安装和升级路径，service/MCP 字段、可重现 `lockDigest`、落库与 claim 均有测试；但 unresolved required 项、Daemon/task/approval/rollback 消费链和历史重建仍未完成。

因此当前状态应标记为 **Remote 安装闭环原型 / 不可用于不受信任 Skill 的生产安装**。下一里程碑不是增加更多入口，而是先补 service managed-node worker、cache 完整性校验、artifact lineage 和任务 mode 丢失。详见 [实施差距第三次复审](./07-实施差距审查.md)。
