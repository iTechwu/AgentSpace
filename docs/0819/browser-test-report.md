# 0819 页面与流程浏览器测试报告

## 测试范围

- 日期：2026-08-19
- 环境：本地 Next.js 开发服务 `http://127.0.0.1:1455`，隔离 PostgreSQL 测试库，`DOFE_AGENT_E2E=1`，远程 Runtime 模式。
- 浏览器：Playwright 驱动的独立 Chromium（通过 Chrome DevTools Protocol 读取页面、网络响应和 Accessibility 树）。当前会话未挂载 Chrome DevTools MCP，因此使用同一 Chromium/CDP 能力完成等价验证。
- 数据：每轮测试创建独立工作区、用户、AI员工、频道和任务，不使用生产账号或生产数据。

## 页面覆盖

以下工作区页面均完成加载、标题/主要内容检查、控制台错误检查、失败网络请求检查和桌面横向溢出检查：

`/im`、`/inbox`、`/agents?mode=agent`、`/agents?mode=container`、`/approvals`、`/audit`、`/automations`、`/automations/new`、`/calendar`、`/contacts`、`/costs`、`/knowledge`、`/market`、`/org-chart`、`/performance`、`/runtimes`、`/skills`、`/tables`、`/task/board`、`/templates`、`/settings/preferences`、`/settings/security`、`/settings/permissions`、`/settings/integrations`。

补充验证了旧路径 `/task-board` 到 `/task/board` 的兼容跳转，以及 `/settings` 到 `/settings/preferences` 的默认跳转。移动端 390x844 验证了侧边栏打开、模块切换和页面横向溢出（无溢出）。

## 流程覆盖

- 消息：切换频道、URL focus 参数和编辑中的消息草稿保持。
- 任务：任务看板加载、状态列和筛选控件可见。
- 技能：打开首个技能、编辑器和安装面板加载。
- 工作流：新建工作流、填写名称、保存草稿并跳转到工作流详情。
- 设置：偏好设置、安全、权限中心和飞书集成分区加载；E2E SSO 绑定模式下集成表单可见。
- Runtime：进入创建向导第二步，覆盖模型目录请求和错误状态。
- 可访问性：通过 CDP Accessibility 树检查 textbox、combobox、checkbox、radio 均有可访问名称。

## 发现的问题

### BUG-0819-001（高）Runtime 模型目录请求返回 500，界面卡在加载态

- 复现路径：`/runtimes` → “新增执行引擎” → “下一步”。
- 观察结果：浏览器网络收到两次 `POST /w/{workspace}/runtimes` 500；服务端错误为 `managed_runtime.sso_binding_required`。
- 用户影响：模型选择器一直显示“正在加载模型…”，没有说明工作区缺少 SSO Runtime 绑定，也没有可执行的恢复提示；控制台出现错误。
- 预期：将“未配置/不可用”作为可预期状态返回，页面停止加载并显示明确提示，不产生未处理的 500。
- 修复：`listProtocolFilteredRuntimeModelsAction` 将 SSO 绑定缺失和模型服务不可用转换为结构化不可用结果；`RuntimeModelPicker` 结束加载并显示可操作提示，未知请求异常显示可恢复告警。
- 状态：已修复并回归通过。

### BUG-0819-002（中）执行时间线默认状态文案被错误结算

- 复现路径：会话页加载包含 Runtime 执行轨迹的消息；调用 `buildExecutionTimeline` 时未传入任务运行状态。
- 观察结果：未传入 `taskRunning` 时，状态“正在准备执行环境”被改写为“执行环境已准备”，与实时轨迹语义和默认函数契约不一致；时间线单测有 2 项失败。
- 用户影响：部分未附带任务状态的审计/消息数据会提前显示为已完成，造成执行进度误导。
- 修复：仅在显式传入 `taskRunning: false` 时结算遗留状态；未传入或传入 `true` 时保留原始状态文案。生产调用点均显式传递任务运行状态。
- 状态：已修复并回归通过。

### BUG-0819-003（低）附件发送测试 mock 参数类型缺失

- 复现路径：运行 `tsconfig.test.json` 类型检查。
- 观察结果：附件发送测试中的 `vi.fn(async () => {})` 被推断为无参数 tuple，访问首个调用参数触发 `TS2532/TS2493`；运行时行为本身正常。
- 用户影响：测试类型检查无法通过，降低回归检查可信度。
- 修复：为测试 mock 补充与 `ConversationShell.onSubmit` 一致的输入类型。
- 状态：已修复并回归通过。

### BUG-0819-004（低）消息气泡重构后测试选择器失效

- 复现路径：运行会话消息气泡组件测试。
- 观察结果：消息元信息和操作栏已经迁移到 `.inbox-message-*` 结构，但 3 个断言仍查询旧类名，导致回归测试失败。
- 修复：按当前 DOM 契约更新元信息、执行回复时间和消息操作栏断言；同时确认新结构对应样式存在，功能按钮和可访问名称保持完整。
- 状态：已修复并回归通过。

## 非缺陷观察

- 未配置 E2E 环境变量时，设置集成页会尝试访问真实 SSO 并出现 `auth.sso_user_lookup_failed`；使用隔离测试库和 `DOFE_AGENT_E2E=1` 后页面正常。这是测试启动配置问题，不计入业务缺陷。
- 消息切换期间被导航取消的 SSE 请求显示 `net::ERR_ABORTED`，对应页面离开时的预期取消，不计入业务缺陷。

## 回归验收标准

- Runtime 模型目录在缺少 SSO 绑定时不再返回 500。
- 模型选择器结束加载并显示明确的配置提示。
- 其他已覆盖页面和流程无新增控制台错误、网络 4xx/5xx 或横向溢出。

## 回归结果

- 浏览器：Runtime 创建向导进入模型步骤后，网络 4xx/5xx 为 0，控制台错误/警告为 0，页面显示“当前工作区尚未绑定 SSO Runtime，完成绑定后才能加载模型目录”。
- 组件测试：`features/runtimes` 共 9 个测试文件、34 个测试全部通过。
- 类型检查：`tsconfig.typecheck.json` 和 `tsconfig.test.json` 均通过。
- 组件测试：执行时间线、会话外壳、消息气泡和登录页共 60 项全部通过；Runtime 组件测试 34 项继续通过。
- 浏览器回归：桌面端 `/im`、`/inbox`、`/runtimes`、`/skills`、`/agents`、`/settings/preferences`、`/task/board`、`/automations/new` 独立会话加载无页面异常、控制台错误、4xx/5xx 或横向溢出；移动端 390x844 的 `/im`、`/inbox`、`/runtimes` 同样通过。
- Playwright 原生 E2E 命令因本机 Playwright Chromium 缓存缺失而无法启动；测试使用系统 Chrome 的 Playwright + CDP 脚本完成同等覆盖，未修改浏览器用户配置。
