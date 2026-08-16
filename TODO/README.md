# DofeAgent TODO

> 状态基线：2026-08-17 文档清理。
> 历史条目 06-119 的详细文档已不在仓库（`Done/`/`Backlog/`/`Abandon/` 目录从未入库，链接不可恢复），
> 以下仅保留编号、标题与结论作为历史索引。
> 当前活跃条目：[120（飞书 Bot 收尾）](./120-feishu-agent-bot-native-experience.md)、[121（Slack 接入）](./121-slack-message-transport-and-agent-experience.md)。

## 架构

```
packages/
  domain/      类型定义
  db/          数据库访问层 (@dofe-agent/db)
  services/    业务逻辑层 (@dofe-agent/services)
  daemon/      Agent 运行时守护进程 (@dofe-agent/daemon)
  sandbox/     沙箱抽象（当前 local-only）
```

services 按域拆子目录（channels/employees/skills/messages/documents/mcp-center/integrations 等 40+ 域）。
加新功能：在 `services/src/` 新建文件夹 → 写逻辑 → `index.ts` 加 re-export。

## 活跃待办

| # | 功能 | 状态 |
|---|---|---|
| 120 | Feishu Agent Bot Native Experience | Phase 0-5 已实施（代码见 `packages/services/src/integrations/providers/feishu/`），剩 Phase 6 真实飞书租户 smoke/E2E，见 [TODO/120](./120-feishu-agent-bot-native-experience.md) |
| 121 | Slack Message Transport + Agent Experience | 未实施，见 [TODO/121](./121-slack-message-transport-and-agent-experience.md) |

## 长期演进（backlog，无详细文档）

| # | 功能 | 说明 |
|---|---|---|
| 09 | Skills Service/API 演进 | 等 CLI/多端接入时再做 |
| 11 | Litewrite 协作借鉴 | diff/merge 工作台、协作者管理、实时 presence |
| 14 | LLM 顺序规划 | 关键词规则→LLM planner 升级 |
| 35 | Sandbox-Agent 分离 | 接口抽象 + Local 实现 + 重构 daemon（sandbox 包已存在，当前 local-only） |
| 36 | 云端 Agent 部署 | Fly.io Sandbox + Durable Task |
| 52 | 相对主流 Agent 系统的短板分析 | durable control plane、sandbox 远程执行、多 agent 编排与协作层补齐 |
| 54 | 前端视觉系统与体验刷新 | 品牌感、导航层级、核心页面信息密度与动效系统升级 |
| 55 | 工作台导航卡顿与客户端过渡优化 | 高频切换客户端化、上下文解析去重、state 读取降成本 |
| 56 | 知识页按数字员工分配 | 知识页分配模型、Agent 侧绑定入口、运行时知识范围收口 |
| 57 | Agent 跨服务器 Runtime 换绑与无损续跑 | runtime handoff、resume、workDir snapshot、memory/knowledge 显式化 |
| 59 | 工作区邀请码与群邀请 | 每 workspace 一个 owner 管理的邀请码，并补齐目录级默认可见、群申请审批与跨工作区群邀请机制 |
| 60 | 真人联系人、好友关系与同工作区私聊 | 明确加入同一 workspace / 未来好友边界，并把同工作区真人成员的一对一 direct conversation 统一进正式会话模型 |
| 62 | 设置界面分层与信息架构重做 | 把当前单页堆叠式设置页改成多层级、多角色、可深链的设置系统 |
| 63 | 存储分层与隔离策略系统化整理 | 明确数据库、workspace 文件目录、daemon 执行目录的职责边界、隔离维度、生命周期与清理 contract |
| 64 | Agent Runtime 健康诊断与 Provider 可用性治理 | 区分 runtime online 与 provider usable，补齐 provider 错误归一化、健康检查、preflight 与统一诊断语义 |
| 65 | OpenClaw Daemon 权限、鉴权继承与 Provider 可用性修复 | 单独解决 OpenClaw 在 daemon 代跑场景下的权限边界、auth profile 继承、preflight 与错误归一化 |
| 66 | 对话级持久 Execution Workspace | 为 direct/group 对话引入每对话持久执行目录与正式状态模型，解决所有需要跨轮保留本地工作目录状态的 agent 连续性问题 |
| 68 | 协作平台核心能力补齐 | 补齐 collaborative object、评论、activity、assignments、presence、版本、agent proposal 与 review inbox，让真人和 agent 围绕文档/表格/TODO/任务共同工作 |
| 69 | Agent 预设模板与一键初始化 | 内置财务分析、产品经理、产品设计等岗位模板，预置 instructions、skills、runtime/knowledge 检查，让用户可以一键创建可工作的数字员工 |
| 71 | 群文档多格式扩展 | 将频道群文档从 Markdown 扩展到表格与演示文稿，比较内建 sheet/deck、Google Workspace、Notion、Microsoft 365 的可行性与易用性 |
| 72 | Google Workspace API 接入 | 说明 Sheets-first 的 Google Cloud/OAuth 配置、token 存储、Drive/Sheets API 调用、权限同步和 agent 操作审计接入方式 |
| 77 | 多 Agent 硬隔离与 Codex 执行安全 | 将当前 workspace/runtime/task 软隔离升级为 sandbox、凭据、网络、资源和 session 级硬隔离，支撑大量 Agent 并发执行 |
| 78 | Google Workspace 改为对接官方 gws CLI 执行 | 明确平台↔Agent 通过 skill/task context 保留控制面，Agent↔Sheets/Docs data plane 完全走 Google 官方 gws CLI，并把官方 CLI 的 schema、dry-run、JSON output 等能力反哺控制面 |
| 82 | Agent 执行过程可见化与任务时间线 | 学习 WUPHF 的可见执行现场，把 daemon/task/runtime-output 信号收口为结构化任务执行时间线 |
| 83 | 任务级 Execution Workspace 隔离与产物回收 | 学习 WUPHF per-task worktree 思路，将当前对话级 workDir 升级为任务级隔离执行现场和正式产物回收链路 |
| 84 | 外部集成 Adapter Contract | 为消息、文档、runtime provider 建立统一 adapter contract、health、typed errors 和唯一注册入口 |
| 85 | Agent 动作权限 Policy 与审批联动 | 将权限中心、runtime grant、OAuth delegation 与审批串成执行前 policy decision：allow / require_approval / deny |
| 86 | 工程质量 Ratchet 与静态边界治理 | 建立文件大小、跨层 import、explicit any、secret 检查的 forward-only 质量门槛 |
| 91 | Runtime / Provider / gws 状态 Contract | 区分 daemon online、runtime online、provider usable、gws usable，并补 preflight 与前端状态展示 |
| 92 | Provider permissions / sandbox 策略层 | 将 provider 执行权限、审批、沙箱和危险模式从硬编码收口为可配置策略 |
| 110 | 真正的 AgentRouter：平台级 Session 与跨 Runtime 连续性 | 将当前 harness execution adapter 升级为平台级 Agent session/router，持有 transcript、provider session mapping、handoff snapshot 与 runtime fallback 语义 |

## 已完成（历史索引，条目 06-119）

> 下列条目的详细文档已不存在，仅保留标题与结论。

- 06 daemon 原生运行时
- 07 mention 机制
- 08 Agent 附件输出（协议、落盘、展示、清理与测试）
- 10 前端附件打磨（三处统一组件 + 移动端响应式 + 加载失败降级）
- 12 频道文档
- 13 workspace Agent 状态一致性
- 14 后端架构重构
- 20 全局搜索（FTS5）
- 21 审批/确认流
- 22 知识库（页面树 + Markdown 编辑 + 素材导入 + 全局搜索）
- 23 Pin/引用回复/频道搜索
- 24 Agent 绩效看板（完成率/响应时间/错误率/满意度）
- 25 结构化数据表（多列类型 + 行 CRUD + Grid 视图）
- 26 任务看板
- 27 自动化工作流（Trigger→Condition→Action 规则引擎 + UI）
- 28 日历/定时任务（重复策略 + 时间线视图）
- 29 模板系统（频道/任务/技能/工作流 四类模板）
- 30 组织架构图（人+Agent 树形/频道视图）
- 31 Agent 关系上下文（内联事实 + Context Tool/API + workspace-context skill）
- 32 任务成本对比 + 工作台移动端适配
- 33 预算管控（三层预算 + daemon 超支拦截）
- 34 任务预估与派单（历史法 + 规则兜底 + 报价单 UI）
- 37 Daemon 远程部署与 HTTP 通信（remote daemon 已在 dev-server 落地，见 docs/deployment-topology.md）
- 38 Skills 系统演进（独立表 + 外部导入 + provider-native 注入 + CLI / UI 收口）
- 39 Web 进程纳入 systemd 托管
- 40 standalone daemon 改为编译后 JS 分发
- 41 默认改为用户态 daemon 引导，systemd 降级为高级选项
- 42 多租户多工作区总览（含 42-1~42-5 拆分：多工作区/成员关系/访问控制、state_json 拆分与并发治理、PostgreSQL 迁移与数据切换、执行引擎与存储隔离、身份系统与 Google 登录）
- 47 前端说明性文案清理（删除重复教学型说明，保留必要规则/权限/安全提示）
- 48 Monorepo typecheck / lint 稳定化（共享包声明边界 + 根级 typecheck/lint 收口）
- 49 私聊收敛为 direct channel，会话模型统一
- 50 静态检查 CI 与编辑器收尾
- 51 知识库拆分为知识页面与文档页面
- 53 Daemon Provider 扩展（opencode / openclaw adapter 已落地，见 packages/daemon/src/agent-router/adapters/）
- 58 PostgreSQL 主库切换与 SQLite 下线（PostgreSQL 已是唯一主库，SQLite 运行时已删除）
- 61 登录页产品叙事与转化优化
- 67 已注册 runtime 可分配给真人成员
- 70 Remote daemon session resume
- 73 群文件上传与删除权限治理
- 74 群消息实时同步（SSE）
- 75 Agent 级 Google Workspace OAuth 委托
- 76 Agent 主动 @ 人和 Agent
- 79 runtime-output CLI 化与轻量回收协议
- 80 统一权限管理中心
- 81 Agent Google Sheets 编辑链路端到端可用
- 87 Agent 侧 gws 执行总览
- 88 Agent 侧 gws 执行环境与授权注入
- 89 Sheets Result CLI 与 Server 回收审计
- 90 Claude empty response 诊断收口
- 93 CLI-Hub Runtime 应用市场（packages/services/src/clihub/ 已实现）
- 94 AgentRouter Harness MVP
- 95 AgentRouter provider gws/runtime 修复
- 96 Runtime Tool Capability Registry
- 97 文档 Agent 权限
- 98 Runtime Output CLI-only 清理
- 99 Direct Channel 隐私边界
- 100 Mode A 云端持久化（Neon + Cloudflare R2）
- 102 AgentRouter OpenClaw Provider Hardening
- 105 Reliable Notification System
- 106 Agent 自主知识沉淀审批流
- 109 Agent Fork 分享给同事
- 111 Agent 新建 Google Sheet 并自动挂到频道云文档
- 112 Workspace 主模块切换客户端工作台化
- 114 数字员工展板与 Agent 权限申请（由 115 产品化收编）
- 115 数字员工展板产品化与发现体验
- 119 Feishu Message + Data Plane Adapter（代码见 packages/services/src/integrations/providers/feishu/）

## 已放弃

- 46 CubeSandbox 作为 sandbox provider 接入 — 未完成实现于 2026-08-16 刻意移除（commit bbc935f6），沙箱收敛为 local-only；如需恢复从 git 历史找回
- 106 微信登录支持
- 107 手机号验证码登录
- 108 邮箱验证码登录

## 实施顺序回顾（历史）

```
Phase 1: 20(全局搜索) + 23(消息增强)            ✅
Phase 2: 21(审批) + 26(看板)                     ✅
Phase 2.5: 30(组织架构) + 32(成本) + 33(预算)    ✅
Phase 3: 22(知识库) + 31(Agent关系上下文)         ✅
Phase 4: 24(绩效) + 25(数据表) + 34(预估)        ✅
Phase 5: 27(自动化)                              ✅
Phase 6: 28(日历) + 29(模板)                     ✅
Phase 7: 08+10(附件前端展示)                     ✅
```
