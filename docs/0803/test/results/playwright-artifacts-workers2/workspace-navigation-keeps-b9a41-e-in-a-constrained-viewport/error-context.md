# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-navigation.spec.ts >> keeps managed runtime settings reachable in a constrained viewport
- Location: e2e/workspace-navigation.spec.ts:124:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('.workspace-sidebar-overlay')
    - locator resolved to <button type="button" aria-label="关闭侧边导航" class="workspace-sidebar-overlay"></button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="runtime-detail__field">…</div> from <main class="workspace-main" data-testid="workspace-main">…</main> subtree intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="runtime-detail__field">…</div> from <main class="workspace-main" data-testid="workspace-main">…</main> subtree intercepts pointer events
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <div class="runtime-detail__field">…</div> from <main class="workspace-main" data-testid="workspace-main">…</main> subtree intercepts pointer events
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - generic [ref=f1e2]:
    - button "关闭侧边导航"
    - complementary "工作区导航" [ref=f1e3]:
      - generic [ref=f1e4]:
        - button "切换团队工作区" [ref=f1e6] [cursor=pointer]:
          - img [ref=f1e8]:
            - generic [ref=f1e15]: EW
          - generic "E2E Workspace msdcqz69-4dz6hg" [ref=f1e16]
        - button "关闭侧边导航" [ref=f1e19] [cursor=pointer]
      - button "打开全局搜索" [ref=f1e22] [cursor=pointer]:
        - generic [ref=f1e27]: 搜索消息、任务、知识与文档
        - generic [ref=f1e28]: ⌘K
      - generic [ref=f1e29]:
        - heading "待处理" [level=2] [ref=f1e30]
        - list [ref=f1e31]:
          - listitem [ref=f1e32]:
            - link "打开任务 1" [ref=f1e33] [cursor=pointer]:
              - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/task/board
              - generic [ref=f1e38]:
                - generic [ref=f1e39]: 打开任务
                - strong [ref=f1e40]: "1"
          - listitem [ref=f1e41]:
            - link "待审批" [ref=f1e42] [cursor=pointer]:
              - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/approvals
          - listitem [ref=f1e49]:
            - link "知识页" [ref=f1e50] [cursor=pointer]:
              - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/knowledge
      - generic [ref=f1e57]:
        - heading "协作" [level=2] [ref=f1e58]
        - link "通知" [ref=f1e60] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/inbox
        - link "消息 3" [ref=f1e68] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/im
          - generic [ref=f1e69]: 消息
          - generic [ref=f1e76]: "3"
        - link "联系人 1" [ref=f1e78] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/contacts
          - generic [ref=f1e79]: 联系人
          - generic [ref=f1e85]: "1"
        - heading "数字员工" [level=2] [ref=f1e86]
        - link "员工管理 1" [ref=f1e88] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/agents?mode=agent
          - generic [ref=f1e89]: 员工管理
          - generic [ref=f1e96]: "1"
        - link "数字员工展板 1" [ref=f1e98] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/agents?mode=showcase
          - generic [ref=f1e99]: 数字员工展板
          - generic [ref=f1e106]: "1"
        - link "执行引擎管理" [ref=f1e108] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/runtimes
        - heading "能力资源" [level=2] [ref=f1e115]
        - link "技能库 6" [ref=f1e117] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/skills
          - generic [ref=f1e118]: 技能库
          - generic [ref=f1e123]: "6"
        - link "知识库" [ref=f1e125] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/knowledge
        - link "应用市场" [ref=f1e133] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/market
        - link "审计日志" [ref=f1e141] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/audit
      - generic [ref=f1e149]:
        - link "打开设置" [ref=f1e150] [cursor=pointer]:
          - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/settings
          - img [ref=f1e152]:
            - generic [ref=f1e157]: EO
          - generic [ref=f1e158]:
            - strong [ref=f1e159]: E2E Owner msdcqz69-4dz6hg
            - generic [ref=f1e160]: 超级管理员
        - button "退出登录" [ref=f1e162] [cursor=pointer]
    - main [ref=f1e166]:
      - generic [ref=f1e167]:
        - button "打开导航" [ref=f1e168] [cursor=pointer]
        - generic [ref=f1e171]:
          - strong [ref=f1e172]: 执行引擎管理
          - generic [ref=f1e173]: E2E Owner msdcqz69-4dz6hg
        - button "打开搜索" [ref=f1e174] [cursor=pointer]
      - generic [ref=f1e181]:
        - generic [ref=f1e182]:
          - link "返回执行引擎列表" [ref=f1e183] [cursor=pointer]:
            - /url: /w/sso-team-e2e-msdcqz69-4dz6hg/runtimes
          - generic [ref=f1e186]:
            - generic [ref=f1e187]: C
            - generic [ref=f1e188]:
              - generic [ref=f1e189]: 托管执行引擎
              - heading "Compact Runtime" [level=1] [ref=f1e190]
              - paragraph [ref=f1e191]: Claude Code 部署
            - 'generic "Status: 离线" [ref=f1e192]':
              - generic [ref=f1e193]: 离线
              - generic [ref=f1e194]: 等待节点心跳
        - generic [ref=f1e195]:
          - region [ref=f1e196]:
            - generic [ref=f1e197]:
              - generic [ref=f1e198]:
                - generic [ref=f1e199]: 运行概览
                - heading "连接信息" [level=2] [ref=f1e200]
              - paragraph [ref=f1e201]: 查看当前连接状态，以及用于接收任务的执行身份。
            - generic [ref=f1e202]:
              - generic [ref=f1e203]:
                - term [ref=f1e204]: 默认模型
                - definition [ref=f1e205]: glm-5.2
              - generic [ref=f1e206]:
                - term [ref=f1e207]: 支持协议
                - definition [ref=f1e208]: anthropic
              - generic [ref=f1e209]:
                - term [ref=f1e210]: 最近心跳
                - definition [ref=f1e211]: 从未上报
              - generic [ref=f1e212]:
                - term [ref=f1e213]: 运行凭据
                - definition [ref=f1e214]: runtime-...991111
          - region [ref=f1e215]:
            - generic [ref=f1e216]:
              - generic [ref=f1e217]:
                - generic [ref=f1e218]: 容量与费用
                - heading "当前周期" [level=2] [ref=f1e219]
              - paragraph [ref=f1e220]: Token 与费用均来自 models 权威账单，任务数保留 AgentSpace 业务口径。
            - generic [ref=f1e221]:
              - generic [ref=f1e222]:
                - term [ref=f1e223]: AI 员工
                - definition [ref=f1e224]: "0"
              - generic [ref=f1e225]:
                - term [ref=f1e226]: 任务
                - definition [ref=f1e227]: "0"
              - generic [ref=f1e228]:
                - term [ref=f1e229]: 输入 Token
                - definition [ref=f1e230]: 暂不可用
              - generic [ref=f1e231]:
                - term [ref=f1e232]: 输出 Token
                - definition [ref=f1e233]: 暂不可用
              - generic [ref=f1e234]:
                - term [ref=f1e235]: 应计费用
                - definition [ref=f1e236]: 暂不可用
              - generic [ref=f1e237]:
                - term [ref=f1e238]: 实际扣费
                - definition [ref=f1e239]: 暂不可用
            - status [ref=f1e240]:
              - generic [ref=f1e241]: models 权威账单暂不可用，本页不展示本地推算金额
        - generic "执行引擎设置" [ref=f1e242]:
          - region [ref=f1e243]:
            - generic [ref=f1e244]:
              - generic [ref=f1e245]:
                - generic [ref=f1e246]: 模型策略
                - heading "默认模型" [level=2] [ref=f1e247]
              - paragraph [ref=f1e248]: 当任务没有指定模型时，使用此处设置的语言模型。
            - generic [ref=f1e249]:
              - generic [ref=f1e250]:
                - strong [ref=f1e251]: 默认模型
                - generic [ref=f1e252]: 当 AI 员工或会话未指定模型时，使用此设置。
              - generic [ref=f1e254]:
                - button "默认模型" [disabled]:
                  - generic:
                    - strong: glm-5.2
                    - generic: 跟随系统默认
              - button "保存模型" [disabled]
              - paragraph [ref=f1e256]: 模型目录暂时不可用，请稍后重试。
          - region [ref=f1e257]:
            - generic [ref=f1e258]:
              - generic [ref=f1e259]:
                - generic [ref=f1e260]: 分配规则
                - heading "允许分配给 AI 员工" [level=2] [ref=f1e261]
              - paragraph [ref=f1e262]: 控制新创建的 AI 员工能否使用此执行引擎。
            - generic [ref=f1e263] [cursor=pointer]:
              - generic [ref=f1e264]:
                - strong [ref=f1e265]: 允许新员工使用
                - generic [ref=f1e266]: 新创建的 AI 员工可以分配到此执行引擎。
              - checkbox "允许新员工使用 新创建的 AI 员工可以分配到此执行引擎。" [checked] [ref=f1e268]
  - alert [ref=f1e270]
```

# Test source

```ts
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
  93  |     ).toBeVisible();
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
> 164 |   if (await sidebarOverlay.isVisible()) await sidebarOverlay.click();
      |                                                              ^ Error: locator.click: Test timeout of 30000ms exceeded.
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
  194 |
  195 | test("keeps workspace chrome mounted during client module switches", async ({ page }) => {
  196 |   const session = await openSeededWorkspacePage(page, "/im");
  197 |   await page.locator("[data-testid='workspace-layout']").evaluate((element) => {
  198 |     const key = "__dofeAgentWorkspaceChrome";
  199 |     const record = {
  200 |       layout: element,
  201 |       main: document.querySelector("[data-testid='workspace-main']"),
  202 |       sidebar: document.querySelector("[data-testid='workspace-sidebar']"),
  203 |     };
  204 |     (window as typeof window & Record<string, unknown>)[key] = record;
  205 |   });
  206 |
  207 |   await page.getByRole("link", { name: /打开任务|Open tasks/i }).click();
  208 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  209 |   await expect(page.getByRole("button", { name: /按状态|By Status/i })).toBeVisible();
  210 |
  211 |   await page.getByRole("link", { name: /消息|Messages/i }).click();
  212 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  213 |   await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
  214 |
  215 |   await expect.poll(async () =>
  216 |     page.evaluate(() => {
  217 |       const record = (window as typeof window & {
  218 |         __dofeAgentWorkspaceChrome?: {
  219 |           layout: Element | null;
  220 |           main: Element | null;
  221 |           sidebar: Element | null;
  222 |         };
  223 |       }).__dofeAgentWorkspaceChrome;
  224 |       return Boolean(
  225 |         record?.layout?.isConnected
  226 |           && record.main?.isConnected
  227 |           && record.sidebar?.isConnected
  228 |           && record.layout === document.querySelector("[data-testid='workspace-layout']")
  229 |           && record.main === document.querySelector("[data-testid='workspace-main']")
  230 |           && record.sidebar === document.querySelector("[data-testid='workspace-sidebar']"),
  231 |       );
  232 |     }),
  233 |   ).toBe(true);
  234 | });
  235 |
  236 | test("restores settings preferences after refresh", async ({ page }) => {
  237 |   const session = await openSeededWorkspacePage(page, "/settings/preferences");
  238 |
  239 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/preferences(?:\\?.*)?$`));
  240 |   await expect(settingsSectionLabel(page, /偏好设置|Preferences/i)).toBeVisible();
  241 |
  242 |   await page.reload();
  243 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/preferences(?:\\?.*)?$`));
  244 |   await expect(settingsSectionLabel(page, /偏好设置|Preferences/i)).toBeVisible();
  245 | });
  246 |
  247 | test("switches settings sections through the client workbench", async ({ page }) => {
  248 |   const session = await openSeededWorkspacePage(page, "/settings/preferences");
  249 |   let securityApiHits = 0;
  250 |
  251 |   await page.route("**/api/workspaces/**/modules/settings**", async (route) => {
  252 |     const url = new URL(route.request().url());
  253 |     const section = url.searchParams.get("section");
  254 |     if (section !== "security") {
  255 |       await route.fallback();
  256 |       return;
  257 |     }
  258 |
  259 |     securityApiHits += 1;
  260 |
  261 |     await route.fulfill({
  262 |       contentType: "application/json",
  263 |       body: JSON.stringify({
  264 |         data: {
```