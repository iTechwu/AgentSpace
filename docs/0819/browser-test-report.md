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
- 类型检查：`tsconfig.typecheck.json` 通过；本次修改涉及文件 ESLint 通过。
- 仓库测试类型检查仍存在既有错误：`features/chat/conversation-shell.test.tsx:1140` 的 `TS2532/TS2493`，与本次改动无关。
- Playwright 原生 E2E 命令因本机 Playwright Chromium 缓存缺失而无法启动；测试使用系统 Chrome 的 Playwright + CDP 脚本完成同等覆盖，未修改浏览器用户配置。
