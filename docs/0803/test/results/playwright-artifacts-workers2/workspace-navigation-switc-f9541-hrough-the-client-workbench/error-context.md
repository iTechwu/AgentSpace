# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-navigation.spec.ts >> switches settings sections through the client workbench
- Location: e2e/workspace-navigation.spec.ts:247:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.settings-group__eyebrow').filter({ hasText: /偏好设置|Preferences/i })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('.settings-group__eyebrow').filter({ hasText: /偏好设置|Preferences/i })

```

```yaml
- alert
- main:
  - alert "工作台暂时没有响应":
    - text: Workspace error
    - heading "工作台暂时没有响应" [level=1]
    - paragraph: 协作窗口和员工市场的数据层刚刚中断了一次，请重新加载当前视图；如果问题持续，再回到原料入口检查最近一次操作。
    - text: Error state
    - strong: 先恢复当前视图，再排查最近一次导致失败的动作。
    - paragraph: 这样能优先验证问题是否只是瞬时中断，而不是继续在损坏状态里操作。
    - button "重新载入"
```

# Test source

```ts
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
  265 |           moduleId: "settings",
  266 |           data: {
  267 |             currentMembershipRole: "owner",
  268 |             currentUserDisplayName: session.userDisplayName,
  269 |             currentUserId: session.userId,
  270 |             currentWorkspaceSlug: session.workspaceSlug,
  271 |             initialSection: section,
  272 |             sessions: [],
  273 |           },
  274 |         },
  275 |       }),
  276 |     });
  277 |   });
  278 |
  279 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/preferences(?:\\?.*)?$`));
> 280 |   await expect(settingsSectionLabel(page, /偏好设置|Preferences/i)).toBeVisible();
      |                                                                 ^ Error: expect(locator).toBeVisible() failed
  281 |   await expect(page.locator(".settings-page[data-hydrated='true']")).toBeVisible();
  282 |
  283 |   await page.getByRole("link", { name: /安全与会话|Security/i }).click();
  284 |   await expect.poll(() => securityApiHits).toBe(1);
  285 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/security(?:\\?.*)?$`));
  286 |   await expect(settingsSectionLabel(page, /安全与会话|Security & sessions/i)).toBeVisible();
  287 | });
  288 |
  289 | test("closes the mobile sidebar after module navigation and restores with back", async ({ page }) => {
  290 |   await page.setViewportSize({ width: 390, height: 844 });
  291 |   const session = await openSeededWorkspacePage(page, "/im");
  292 |   const layout = page.locator(".workspace-layout");
  293 |
  294 |   if (!await layout.evaluate((element) => element.classList.contains("workspace-layout--sidebar-open"))) {
  295 |     await page.getByRole("button", { name: /打开导航|Open navigation/i }).click();
  296 |   }
  297 |   await expect(layout).toHaveClass(/workspace-layout--sidebar-open/);
  298 |
  299 |   await page.getByRole("link", { name: /打开任务|Open tasks/i }).click();
  300 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  301 |   await expect(layout).not.toHaveClass(/workspace-layout--sidebar-open/);
  302 |   await expect(page.getByRole("button", { name: /按状态|By Status/i })).toBeVisible();
  303 |
  304 |   await page.goBack();
  305 |   await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  306 |   await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
  307 | });
  308 |
  309 | test("keeps channel-scoped guests inside authorized IM data", async ({ page }) => {
  310 |   const session = await seedChannelScopedGuestSession(page);
  311 |
  312 |   await page.goto(`/w/${session.workspaceSlug}/im`);
  313 |   await expect(page.locator(".workspace-layout")).toBeVisible();
  314 |   await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
  315 |   await expect(page.getByText(session.privateChannelName, { exact: true })).toHaveCount(0);
  316 |
  317 |   const imResponse = await page.request.get(`/api/workspaces/${encodeURIComponent(session.workspaceSlug)}/modules/im`);
  318 |   expect(imResponse.status()).toBe(200);
  319 |   const imPayload = await imResponse.json() as {
  320 |     data: {
  321 |       moduleId: "im";
  322 |       data: {
  323 |         channels: Array<{ name: string; channelName?: string }>;
  324 |         threads: Array<{ channelName: string }>;
  325 |       };
  326 |     };
  327 |   };
  328 |   const channelNames = imPayload.data.data.channels.map((channel) => channel.channelName ?? channel.name);
  329 |   expect(channelNames).toContain(session.channelName);
  330 |   expect(channelNames).not.toContain(session.privateChannelName);
  331 |   expect(imPayload.data.data.threads.map((thread) => thread.channelName)).not.toContain(session.privateChannelName);
  332 |
  333 |   const taskBoardResponse = await page.request.get(`/api/workspaces/${encodeURIComponent(session.workspaceSlug)}/modules/task-board`);
  334 |   expect(taskBoardResponse.status()).toBe(403);
  335 | });
  336 |
  337 | function escapeRegExp(value: string): string {
  338 |   return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  339 | }
  340 |
  341 | function settingsSectionLabel(page: Page, name: RegExp) {
  342 |   return page.locator(".settings-group__eyebrow").filter({ hasText: name });
  343 | }
  344 |
```