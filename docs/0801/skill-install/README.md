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

当前实现已经形成高级 Remote 安装原型：不可变 artifact/blob、Daemon materializer、组件 evidence、任务 revision snapshot、真实 npm/pip/uv 安装验证、release lock/approval，以及 managed service 的 Docker provision、健康、binding、卸载、退役、签名和蓝绿切换均已进入生产调用链。旧问题中的 script component 重复和任务 executable mode 丢失已经关闭。

第四次复审确认，剩余问题不再是“有没有 worker”，而是 worker 的结果能否被任务真实使用，以及安全边界是否不可绕过：

1. dependency env 安装并验证后没有挂载到任务，也未注入 `NODE_PATH/PYTHONPATH/PATH`，仍会出现 ready 后无法 import/require。
2. 空 egress allow-list 同时连接 internal 与共享网络，不能保证零出站；非空列表只阻断 DNS，raw-IP 可绕过。
3. service secret 通过 `docker create --env NAME=value` 进入 argv 和 Docker inspect。
4. installation plan、approval 消费、service operation complete/binding 跨多个事务，失败会留下部分状态；本轮 release 测试为 **15/18**。
5. Skill upgrade 不会为 candidate artifact 的新增/升级 service 排队或绑定，service-enabled v2 可能永久 blocked。
6. cache 虽重算 SHA/root digest，但仍信任可改写 meta，未与当前 claim 比对；cache 也未只读。
7. lease 有 heartbeat/requeue，但没有 claim generation/token，旧 worker 可能提交新 lease 的结果。
8. `skill_artifact_binding` 数据表已存在，但导入、history UI、upgrade/rollback 尚未完整消费。

此外仍缺 artifact 下载 SSRF/流式上限、统一 package authority/ingress budget、真正 canary、bundle SHA/聚合预算、五步 UI、lineage backfill/GC、更新检查和指标告警。managed service 的 real-Docker E2E 证明生命周期可运行，但没有验证 egress 不可绕过、secret 不泄漏或 stale-worker fencing。

因此当前状态应标记为 **Remote 安装高级原型 / 不可用于不受信任 Skill 的生产安装**。下一里程碑应优先打通 dependency task env，并修复 service 网络/secret 边界和跨层事务，再扩展新来源或 UI。详见 [实施差距第四次复审](./07-实施差距审查.md)。
