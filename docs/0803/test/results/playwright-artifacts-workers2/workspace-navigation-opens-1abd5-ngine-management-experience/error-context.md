# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-navigation.spec.ts >> opens the deployment-appropriate execution engine management experience
- Location: e2e/workspace-navigation.spec.ts:75:1

# Error details

```
Error: Client errors: none

expect(locator).toBeVisible() failed

Locator: getByRole('heading', { name: /创建托管执行引擎|Create managed runtime/i })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Client errors: none with timeout 5000ms
  - waiting for getByRole('heading', { name: /创建托管执行引擎|Create managed runtime/i })

```

```yaml
- complementary "工作区导航":
  - button "切换团队工作区": E2E Workspace msdcqlxk-69r5wz
  - button "收起侧边导航" [expanded]
  - button "打开全局搜索": 搜索消息、任务、知识与文档 ⌘K
  - heading "待处理" [level=2]
  - list:
    - listitem:
      - link "打开任务 1":
        - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/task/board
        - text: 打开任务
        - strong: "1"
    - listitem:
      - link "待审批":
        - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/approvals
    - listitem:
      - link "知识页":
        - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/knowledge
  - heading "协作" [level=2]
  - link "通知":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/inbox
  - link "消息 3":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/im
  - link "联系人 1":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/contacts
  - heading "数字员工" [level=2]
  - link "员工管理 1":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/agents?mode=agent
  - link "数字员工展板 1":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/agents?mode=showcase
  - link "执行引擎管理":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/runtimes
  - heading "能力资源" [level=2]
  - link "技能库 6":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/skills
  - link "知识库":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/knowledge
  - link "应用市场":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/market
  - link "审计日志":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/audit
  - link "打开设置":
    - /url: /w/sso-team-e2e-msdcqlxk-69r5wz/settings
    - strong: E2E Owner msdcqlxk-69r5wz
    - text: 超级管理员
  - button "退出登录"
- main:
  - text: 数字员工
  - heading "执行能力管理" [level=1]
  - paragraph: 系统优先复用兼容的共享执行能力，缺失时自动在托管节点通过 Docker 部署。
  - text: 0 个在线节点 0 个部署任务
  - tablist "执行引擎视图":
    - tab "执行引擎列表 0"
    - tab "新增执行引擎" [selected]
    - tab "运维详情"
  - tabpanel "新增执行引擎":
    - region "配置执行能力":
      - text: 新建
      - heading "配置执行能力" [level=2]
      - list "创建进度":
        - listitem: 1. 供应商
        - listitem: 2. 模型
        - listitem: 3. 确认
      - text: 执行能力类型
      - combobox "执行能力类型":
        - option "Claude Code" [selected]
        - option "Codex"
        - option "Antigravity CLI"
        - option "Gemini CLI"
        - option "OpenCode"
        - option "OpenClaw"
        - option "NanoBot"
        - option "Hermes Agent"
      - group: 高级设置
      - button "下一步"
- alert
```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | import {
  3   |   createManagedAgentRuntimeSync,
  4   |   createRuntimeProvisioningTaskSync,
  5   | } from "../../../packages/db/src/index.ts";
  6   | import { openSeededWorkspacePage, seedChannelScopedGuestSession } from "./helpers";
  7   |
  8   | const runtimeMode = process.env.DOFE_AGENT_RUNTIME_MODE?.trim().toLowerCase() === "remote"
  9   |   ? "remote"
  10  |   : "local";
  11  |
  12  | test("preserves the IM composer draft across workbench module switches", async ({ page }) => {
  13  |   const session = await openSeededWorkspacePage(page, "/im");
  14  |   const draft = `draft-${Date.now().toString(36)}`;
  15  |
  16  |   const composer = page.getByPlaceholder(new RegExp(`发送到 ${escapeRegExp(session.channelName)}|Send to ${escapeRegExp(session.channelName)}`, "i"));
  17  |   await expect(composer).toBeVisible();
  18  |   await composer.fill(draft);
  19  |
  20  |   await page.getByRole("link", { name: /打开任务|Open tasks/i }).click();
  21  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  22  |   await expect(page.getByRole("button", { name: /按状态|By Status/i })).toBeVisible();
  23  |
  24  |   await page.getByRole("link", { name: /消息|Messages/i }).click();
  25  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  26  |   await expect(composer).toHaveValue(draft);
  27  |
  28  |   await page.goBack();
  29  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  30  |   await page.goForward();
  31  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  32  |   await expect(composer).toHaveValue(draft);
  33  | });
  34  |
  35  | test("restores the selected IM conversation after refresh", async ({ page }) => {
  36  |   const session = await openSeededWorkspacePage(page, "/im");
  37  |
  38  |   await page.getByRole("button", { name: session.privateChannelName }).click();
  39  |   await expect(page).toHaveURL(new RegExp(
  40  |     `/w/${escapeRegExp(session.workspaceSlug)}/im\\?focus=channel%3A${escapeRegExp(encodeURIComponent(session.privateChannelName))}`,
  41  |   ));
  42  |   await expect(page.getByRole("heading", { name: session.privateChannelName })).toBeVisible();
  43  |
  44  |   await page.reload();
  45  |
  46  |   await expect(page).toHaveURL(new RegExp(
  47  |     `/w/${escapeRegExp(session.workspaceSlug)}/im\\?focus=channel%3A${escapeRegExp(encodeURIComponent(session.privateChannelName))}`,
  48  |   ));
  49  |   await expect(page.getByRole("heading", { name: session.privateChannelName })).toBeVisible();
  50  | });
  51  |
  52  | test("keeps runtime management destination and active content through navigation and refresh", async ({ page }) => {
  53  |   const session = await openSeededWorkspacePage(page, "/agents?mode=container");
  54  |   const runtimePath = runtimeMode === "remote" ? "/runtimes" : "/agents?mode=container";
  55  |   const runtimeHeading = runtimeMode === "remote"
  56  |     ? /创建托管执行引擎|Create managed runtime/i
  57  |     : /在线执行引擎|Online execution engines/i;
  58  |
  59  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}${escapeRegExp(runtimePath)}$`));
  60  |   await expect(page.getByRole("heading", { name: runtimeHeading })).toBeVisible();
  61  |
  62  |   await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();
  63  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/agents\\?mode=agent$`));
  64  |   await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();
  65  |
  66  |   await page.goBack();
  67  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}${escapeRegExp(runtimePath)}$`));
  68  |   await expect(page.getByRole("heading", { name: runtimeHeading })).toBeVisible();
  69  |
  70  |   await page.reload();
  71  |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}${escapeRegExp(runtimePath)}$`));
  72  |   await expect(page.getByRole("heading", { name: runtimeHeading })).toBeVisible();
  73  | });
  74  |
  75  | test("opens the deployment-appropriate execution engine management experience", async ({ page }) => {
  76  |   const clientErrors: string[] = [];
  77  |   page.on("pageerror", (error) => clientErrors.push(error.message));
  78  |   page.on("console", (message) => {
  79  |     if (message.type() === "error") clientErrors.push(message.text());
  80  |   });
  81  |
  82  |   const session = await openSeededWorkspacePage(page, "/agents?mode=agent");
  83  |   const runtimeLink = page.getByRole("link", { name: /执行引擎管理|Execution Engine Management/i });
  84  |   const expectedPath = runtimeMode === "remote" ? "/runtimes" : "/agents?mode=container";
  85  |   await expect(runtimeLink).toHaveAttribute("href", `/w/${session.workspaceSlug}${expectedPath}`);
  86  |   await runtimeLink.click();
  87  |
  88  |   if (runtimeMode === "remote") {
  89  |     await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/runtimes$`));
  90  |     await expect(
  91  |       page.getByRole("heading", { name: /创建托管执行引擎|Create managed runtime/i }),
  92  |       `Client errors: ${clientErrors.join("\n") || "none"}`,
> 93  |     ).toBeVisible();
      |       ^ Error: Client errors: none
  94  |     await expect(page.getByRole("button", { name: /接入服务器|Connect server/i })).toHaveCount(0);
  95  |   } else {
  96  |     await page.locator("button.agents-pane__container-button").click();
  97  |     await expect(
  98  |       page.getByRole("dialog").getByRole("heading", { name: /接入服务器|Connect server/i }),
  99  |       `Client errors: ${clientErrors.join("\n") || "none"}`,
  100 |     ).toBeVisible();
  101 |   }
  102 | });
  103 |
  104 | test("keeps the runtime model menu visible outside the creation panel", async ({ page }) => {
  105 |   test.skip(runtimeMode !== "remote", "Managed runtime creation is only available in remote mode.");
  106 |
  107 |   await openSeededWorkspacePage(page, "/runtimes");
  108 |   await page.getByRole("button", { name: /下一步|Continue/i }).click();
  109 |
  110 |   const modelTrigger = page.getByRole("button", { name: /默认模型|Default model/i });
  111 |   await expect(modelTrigger).toBeEnabled();
  112 |   await modelTrigger.click();
  113 |
  114 |   const menu = page.getByRole("listbox", { name: /默认模型|Default model/i });
  115 |   const fallback = menu.getByRole("option", { name: /跟随系统默认|Inherit system fallback/i });
  116 |   await expect(menu).toBeVisible();
  117 |   await expect(fallback).toBeVisible();
  118 |   await expect(menu).toHaveClass(/model-catalog-select__menu--portal/);
  119 |   await expect(page.locator("body > .model-catalog-select__menu--portal")).toBeVisible();
  120 |   await fallback.click();
  121 |   await expect(menu).toBeHidden();
  122 | });
  123 |
  124 | test("keeps managed runtime settings reachable in a constrained viewport", async ({ page }) => {
  125 |   test.skip(runtimeMode !== "remote", "Managed runtime details are only available in remote mode.");
  126 |   await page.setViewportSize({ width: 1280, height: 560 });
  127 |   const session = await openSeededWorkspacePage(page, "/runtimes");
  128 |   const task = createRuntimeProvisioningTaskSync({
  129 |     workspaceId: session.workspaceId,
  130 |     requestedByUserId: session.userId,
  131 |     idempotencyKey: `e2e-runtime-detail-${Date.now()}`,
  132 |     runtimeType: "claude",
  133 |     protocols: ["anthropic"],
  134 |     requestedName: "Compact Runtime",
  135 |     requestedModel: "glm-5.2",
  136 |   });
  137 |   const runtime = createManagedAgentRuntimeSync({
  138 |     id: `runtime-detail-${Date.now()}`,
  139 |     workspaceId: session.workspaceId,
  140 |     provider: "claude",
  141 |     name: "Compact Runtime",
  142 |     protocols: ["anthropic"],
  143 |     defaultModel: "glm-5.2",
  144 |     managedCredentialId: `runtime-credential-${Date.now()}`,
  145 |     provisioningTaskId: task.id,
  146 |   });
  147 |   await page.goto(`/w/${session.workspaceSlug}/runtimes/runtime/${runtime.id}`);
  148 |
  149 |   const detail = page.locator(".runtime-detail");
  150 |   await expect(detail).toHaveCSS("overflow-y", "auto");
  151 |   await expect(detail).toHaveCSS("flex-basis", "0px");
  152 |   const dimensions = await detail.evaluate((element) => ({
  153 |     clientHeight: element.clientHeight,
  154 |     scrollHeight: element.scrollHeight,
  155 |   }));
  156 |   expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  157 |   const sharingHeading = page.getByRole("heading", { name: /允许分配给 AI 员工|Allow assignment to AI employees/i });
  158 |   await sharingHeading.scrollIntoViewIfNeeded();
  159 |   await expect(sharingHeading).toBeInViewport();
  160 |   expect(await detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  161 |
  162 |   await page.setViewportSize({ width: 390, height: 720 });
  163 |   const sidebarOverlay = page.locator(".workspace-sidebar-overlay");
  164 |   if (await sidebarOverlay.isVisible()) await sidebarOverlay.click();
  165 |   const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  166 |   expect(horizontalOverflow).toBeLessThanOrEqual(1);
  167 |   await sharingHeading.scrollIntoViewIfNeeded();
  168 |   await expect(sharingHeading).toBeInViewport();
  169 | });
  170 |
  171 | test("keeps the final active module after rapid desktop switching", async ({ page }) => {
  172 |   const session = await openSeededWorkspacePage(page, "/inbox");
  173 |
  174 |   await page.getByRole("link", { name: /通知|Feed/i }).click();
  175 |   await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();
  176 |   await page.getByRole("link", { name: /知识页|Knowledge/i }).click();
  177 |   await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();
  178 |
  179 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/agents\\?mode=agent$`));
  180 |   await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();
  181 |   await expect(page.getByRole("link", { name: /员工管理|Agent Management/i })).toHaveClass(/workspace-sidebar__section-link--active/);
  182 | });
  183 |
  184 | test("removes the message page from layout after navigating to employee management", async ({ page }) => {
  185 |   const session = await openSeededWorkspacePage(page, "/im");
  186 |
  187 |   await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
  188 |   await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();
  189 |
  190 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/agents\\?mode=agent$`));
  191 |   await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();
  192 |   await expect(page.locator(".workspace-module-stage__preserved[hidden]")).toBeHidden();
  193 | });
```