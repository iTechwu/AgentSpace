import { expect, test, type Page } from "@playwright/test";
import {
  createManagedAgentRuntimeSync,
  createRuntimeProvisioningTaskSync,
} from "../../../packages/db/src/index.ts";
import { openSeededWorkspacePage, seedChannelScopedGuestSession, seedWorkspaceSession } from "./helpers";

const runtimeMode = process.env.DOFE_AGENT_RUNTIME_MODE?.trim().toLowerCase() === "remote"
  ? "remote"
  : "local";

test("keeps first-visit onboarding keyboard-modal and the workspace interactive after closing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const browserIssues: string[] = [];
  page.on("pageerror", (error) => browserIssues.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserIssues.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) browserIssues.push(`${response.status()} ${response.url()}`);
  });

  const session = await seedWorkspaceSession(page);
  await page.goto(`/w/${session.workspaceSlug}/im`);

  const layout = page.getByTestId("workspace-layout");
  const onboarding = page.getByRole("dialog", { name: /新手引导|Onboarding tour/i });
  await expect(onboarding).toBeVisible();
  await expect(onboarding).toHaveAttribute("aria-modal", "true");
  await expect(layout).toHaveClass(/workspace-layout--sidebar-open/);
  const closeOnboarding = onboarding.getByRole("button", { name: /关闭新手引导|Close onboarding/i });
  const nextStep = onboarding.getByRole("button", { name: /下一步|Next/i });
  await expect(nextStep).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeOnboarding).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(nextStep).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(onboarding).toBeHidden();
  await expect(layout).not.toHaveClass(/workspace-layout--sidebar-open/);
  await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();

  await page.reload();
  await expect(onboarding).toHaveCount(0);
  await page.getByRole("button", { name: /打开导航|Open navigation/i }).click();
  await expect(layout).toHaveClass(/workspace-layout--sidebar-open/);
  expect(browserIssues).toEqual([]);
});

test("restores modal triggers after closing search, contact invite, and CLI creation", async ({ page }) => {
  const browserIssues: string[] = [];
  page.on("pageerror", (error) => browserIssues.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserIssues.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) browserIssues.push(`${response.status()} ${response.url()}`);
  });

  const session = await openSeededWorkspacePage(page, "/im");
  const searchTrigger = page.getByRole("button", { name: /打开(?:全局)?搜索|Open (?:global )?search/i }).filter({ visible: true });
  await searchTrigger.click();
  const searchDialog = page.getByRole("dialog", { name: /全局搜索|Global search/i });
  await expect(searchDialog).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("textbox", { name: /搜索工作区内容|Search workspace content/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(searchDialog).toBeHidden();
  await expect(searchTrigger).toBeFocused();

  await page.goto(`/w/${session.workspaceSlug}/contacts`);
  const addContactTrigger = page.getByRole("button", { name: /添加真人联系人|Add person/i }).filter({ visible: true });
  await addContactTrigger.click();
  const contactDialog = page.getByRole("dialog", { name: /添加真人联系人|Add human contact/i });
  await expect(contactDialog).toHaveAttribute("aria-modal", "true");
  await expect(contactDialog.getByRole("button", { name: /关闭添加真人联系人|Close add human contact/i })).toBeVisible();
  await expect(contactDialog.getByRole("textbox", { name: /外部联系人邮箱|External contact email/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(contactDialog).toBeHidden();
  await expect(addContactTrigger).toBeFocused();

  await page.goto(`/w/${session.workspaceSlug}/market`);
  const addCliTrigger = page.getByRole("button", { name: /添加 CLI|Add CLI/i }).filter({ visible: true });
  await addCliTrigger.click();
  const cliDialog = page.getByRole("dialog", { name: /添加工作区私有 CLI|Add workspace-private CLI/i });
  await expect(cliDialog).toHaveAttribute("aria-modal", "true");
  await expect(cliDialog.getByRole("textbox", { name: /显示名称|Display name/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(cliDialog).toBeHidden();
  await expect(addCliTrigger).toBeFocused();

  expect(browserIssues).toEqual([]);
});

test("keeps chat attachment and channel action menus keyboard accessible", async ({ page }) => {
  const browserIssues: string[] = [];
  page.on("pageerror", (error) => browserIssues.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserIssues.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) browserIssues.push(`${response.status()} ${response.url()}`);
  });

  await openSeededWorkspacePage(page, "/im");
  const attachmentTrigger = page.getByRole("button", {
    name: /打开附件与快捷内容菜单|Open attachments and quick content menu/i,
  });
  await attachmentTrigger.click();
  const attachmentMenu = page.getByRole("menu", { name: /附件与快捷内容|Attachments and quick content/i });
  await expect(attachmentMenu.getByRole("menuitem", {
    name: /引用成员、文件或技能|Reference people, files, or skills/i,
  })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(attachmentMenu.getByRole("menuitem", { name: /图片\/视频|Images \/ Videos/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(attachmentMenu).toBeHidden();
  await expect(attachmentTrigger).toBeFocused();

  const moreTrigger = page.getByRole("button", { name: /更多|More/i }).filter({ visible: true });
  await moreTrigger.click();
  await expect(moreTrigger).toHaveAttribute("aria-expanded", "true");
  const actionsMenu = page.getByRole("menu", { name: /更多操作|More actions/i });
  await expect(actionsMenu.getByRole("menuitem", { name: /添加群公告|Add announcement/i })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(actionsMenu.getByRole("menuitem", { name: /添加标签页|Add tab page/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actionsMenu).toBeHidden();
  await expect(moreTrigger).toBeFocused();

  expect(browserIssues).toEqual([]);
});

test("preserves the IM composer draft across workbench module switches", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/im");
  const draft = `draft-${Date.now().toString(36)}`;

  const composer = page
    .getByPlaceholder(new RegExp(`发送到 ${escapeRegExp(session.channelName)}|Send to ${escapeRegExp(session.channelName)}`, "i"))
    .filter({ visible: true });
  await expect(composer).toBeVisible();
  await composer.fill(draft);

  await page.getByRole("link", { name: /打开任务|Open tasks/i }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  await expect(page.getByRole("button", { name: /按状态|By Status/i })).toBeVisible();

  await page.getByRole("link", { name: /消息|Messages/i }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  await expect(composer).toHaveValue(draft);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  await expect(composer).toHaveValue(draft);
});

test("keeps message bubbles and hover actions inside the thread at desktop and mobile widths", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/im");
  const thread = page.locator(".contacts-chat-thread, .inbox-chat-thread");
  const row = page.locator(".inbox-bubble-row:visible").first();

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/w/${session.workspaceSlug}/im`);
    await expect(thread).toBeVisible();
    await expect(row).toBeVisible();
    await row.hover();

    const metrics = await page.evaluate(() => {
      const threadElement = document.querySelector<HTMLElement>(".contacts-chat-thread, .inbox-chat-thread");
      const rowElement = document.querySelector<HTMLElement>(".inbox-bubble-row:has(.inbox-bubble)");
      const bubbleElement = rowElement?.querySelector<HTMLElement>(".inbox-bubble");
      const actionsElement = rowElement?.querySelector<HTMLElement>(".inbox-message-actions");
      if (!threadElement || !rowElement || !bubbleElement) return null;
      const rect = (element: HTMLElement) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      return {
        thread: rect(threadElement),
        bubble: rect(bubbleElement),
        actions: actionsElement && getComputedStyle(actionsElement).visibility === "visible"
          ? rect(actionsElement)
          : null,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.documentOverflow).toBeLessThanOrEqual(1);
    expect(metrics!.bubble.left).toBeGreaterThanOrEqual(metrics!.thread.left - 1);
    expect(metrics!.bubble.right).toBeLessThanOrEqual(metrics!.thread.right + 1);
    if (metrics!.actions) {
      expect(metrics!.actions.left).toBeGreaterThanOrEqual(metrics!.thread.left - 1);
      expect(metrics!.actions.right).toBeLessThanOrEqual(metrics!.thread.right + 1);
    }
  }
});

test("links the add-members tooltip to its button and closes it when the dialog opens", async ({ page }) => {
  await openSeededWorkspacePage(page, "/im");
  const addMembersButton = page.getByRole("button", { name: /添加群成员|Add members/i });
  await expect(addMembersButton).toBeVisible();
  await addMembersButton.hover();

  const tooltip = page.getByRole("tooltip", { name: /添加群成员|Add members/i });
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toBeVisible();
  await expect(addMembersButton).toHaveAttribute("aria-describedby", await tooltip.getAttribute("id") ?? "");
  const tooltipBounds = await tooltip.boundingBox();
  const viewport = page.viewportSize();
  expect(tooltipBounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(tooltipBounds!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(viewport!.width);

  await addMembersButton.click();
  await expect(page.getByRole("dialog", { name: /添加群成员|Add members/i })).toBeVisible();
  await expect(tooltip).toBeHidden();
});

test("restores the selected IM conversation after refresh", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/im");

  await page.getByRole("button", { name: session.privateChannelName }).click();
  await expect(page).toHaveURL(new RegExp(
    `/w/${escapeRegExp(session.workspaceSlug)}/im\\?focus=channel%3A${escapeRegExp(encodeURIComponent(session.privateChannelName))}`,
  ));
  await expect(page.getByRole("heading", { name: session.privateChannelName })).toBeVisible();

  await page.reload();

  await expect(page).toHaveURL(new RegExp(
    `/w/${escapeRegExp(session.workspaceSlug)}/im\\?focus=channel%3A${escapeRegExp(encodeURIComponent(session.privateChannelName))}`,
  ));
  await expect(page.getByRole("heading", { name: session.privateChannelName })).toBeVisible();
});

test("keeps runtime management destination and active content through navigation and refresh", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/agents?mode=container");
  const runtimePath = runtimeMode === "remote" ? "/runtimes" : "/agents?mode=container";
  const runtimeHeading = runtimeMode === "remote"
    ? /执行能力管理|Execution capacity/i
    : /在线执行引擎|Online execution engines/i;

  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}${escapeRegExp(runtimePath)}$`));
  await expect(page.getByRole("heading", { name: runtimeHeading })).toBeVisible();

  await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/agents\\?mode=agent$`));
  await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}${escapeRegExp(runtimePath)}$`));
  await expect(page.getByRole("heading", { name: runtimeHeading })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}${escapeRegExp(runtimePath)}$`));
  await expect(page.getByRole("heading", { name: runtimeHeading })).toBeVisible();
});

test("opens the deployment-appropriate execution engine management experience", async ({ page }) => {
  const clientErrors: string[] = [];
  page.on("pageerror", (error) => clientErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") clientErrors.push(message.text());
  });

  const session = await openSeededWorkspacePage(page, "/agents?mode=agent");
  const runtimeLink = page.getByRole("link", { name: /执行引擎管理|Execution Engine Management/i });
  const expectedPath = runtimeMode === "remote" ? "/runtimes" : "/agents?mode=container";
  await expect(runtimeLink).toHaveAttribute("href", `/w/${session.workspaceSlug}${expectedPath}`);
  await runtimeLink.click();

  if (runtimeMode === "remote") {
    await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/runtimes$`));
    await expect(
      page.getByRole("heading", { name: /执行能力管理|Execution capacity/i }),
      `Client errors: ${clientErrors.join("\n") || "none"}`,
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /新增执行引擎|Add runtime/i })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: /配置执行能力|Configure execution capacity/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /接入服务器|Connect server/i })).toHaveCount(0);
  } else {
    await page.locator("button.agents-pane__container-button").click();
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: /接入服务器|Connect server/i }),
      `Client errors: ${clientErrors.join("\n") || "none"}`,
    ).toBeVisible();
  }
});

test("explains when the runtime model catalog is unavailable", async ({ page }) => {
  test.skip(runtimeMode !== "remote", "Managed runtime creation is only available in remote mode.");

  const browserIssues: string[] = [];
  page.on("pageerror", (error) => browserIssues.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserIssues.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) browserIssues.push(`${response.status()} ${response.url()}`);
  });
  await openSeededWorkspacePage(page, "/runtimes");
  await page.getByRole("button", { name: /下一步|Continue/i }).click();

  const modelTrigger = page.getByRole("button", { name: /默认模型|Default model/i });
  await expect(page.getByText(/当前工作区尚未绑定 SSO Runtime|This workspace is not bound to an SSO Runtime/i)).toBeVisible();
  await expect(modelTrigger).toBeDisabled();
  await expect(page.getByText(/正在加载模型|Loading models/i)).toHaveCount(0);
  expect(browserIssues).toEqual([]);
});

test("keeps managed runtime settings reachable in a constrained viewport", async ({ page }) => {
  test.skip(runtimeMode !== "remote", "Managed runtime details are only available in remote mode.");
  await page.setViewportSize({ width: 1280, height: 560 });
  const session = await openSeededWorkspacePage(page, "/runtimes");
  const task = createRuntimeProvisioningTaskSync({
    workspaceId: session.workspaceId,
    requestedByUserId: session.userId,
    idempotencyKey: `e2e-runtime-detail-${Date.now()}`,
    runtimeType: "claude",
    protocols: ["anthropic"],
    requestedName: "Compact Runtime",
    requestedModel: "glm-5.2",
  });
  const runtime = createManagedAgentRuntimeSync({
    id: `runtime-detail-${Date.now()}`,
    workspaceId: session.workspaceId,
    provider: "claude",
    name: "Compact Runtime",
    protocols: ["anthropic"],
    defaultModel: "glm-5.2",
    managedCredentialId: `runtime-credential-${Date.now()}`,
    provisioningTaskId: task.id,
  });
  await page.goto(`/w/${session.workspaceSlug}/runtimes/runtime/${runtime.id}`);

  const detail = page.locator(".runtime-detail");
  await expect(detail).toHaveCSS("overflow-y", "auto");
  await expect(detail).toHaveCSS("flex-basis", "0px");
  const dimensions = await detail.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  const sharingHeading = page.getByRole("heading", { name: /允许分配给 AI 员工|Allow assignment to AI employees/i });
  await sharingHeading.scrollIntoViewIfNeeded();
  await expect(sharingHeading).toBeInViewport();
  expect(await detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 720 });
  const layout = page.locator(".workspace-layout");
  const sidebarOverlay = page.locator(".workspace-sidebar-overlay");
  if (await layout.evaluate((element) => element.classList.contains("workspace-layout--sidebar-open"))) {
    await sidebarOverlay.click();
  }
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  await sharingHeading.scrollIntoViewIfNeeded();
  await expect(sharingHeading).toBeInViewport();
});

test("keeps the final active module after rapid desktop switching", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/inbox");

  await page.getByRole("link", { name: /通知|Feed/i }).click();
  await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();
  await page.getByRole("link", { name: /知识页|Knowledge/i }).click();
  await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();

  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/agents\\?mode=agent$`));
  await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /员工管理|Agent Management/i })).toHaveClass(/workspace-sidebar__section-link--active/);
});

test("removes the message page from layout after navigating to employee management", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/im");

  await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
  await page.getByRole("link", { name: /员工管理|Agent Management/i }).click();

  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/agents\\?mode=agent$`));
  await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();
  await expect(page.locator(".workspace-module-stage__preserved[hidden]")).toBeHidden();
});

test("keeps workspace chrome mounted during client module switches", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/im");
  await page.locator("[data-testid='workspace-layout']").evaluate((element) => {
    const key = "__dofeAgentWorkspaceChrome";
    const record = {
      layout: element,
      main: document.querySelector("[data-testid='workspace-main']"),
      sidebar: document.querySelector("[data-testid='workspace-sidebar']"),
    };
    (window as typeof window & Record<string, unknown>)[key] = record;
  });

  await page.getByRole("link", { name: /打开任务|Open tasks/i }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  await expect(page.getByRole("button", { name: /按状态|By Status/i })).toBeVisible();

  await page.getByRole("link", { name: /消息|Messages/i }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();

  await expect.poll(async () =>
    page.evaluate(() => {
      const record = (window as typeof window & {
        __dofeAgentWorkspaceChrome?: {
          layout: Element | null;
          main: Element | null;
          sidebar: Element | null;
        };
      }).__dofeAgentWorkspaceChrome;
      return Boolean(
        record?.layout?.isConnected
          && record.main?.isConnected
          && record.sidebar?.isConnected
          && record.layout === document.querySelector("[data-testid='workspace-layout']")
          && record.main === document.querySelector("[data-testid='workspace-main']")
          && record.sidebar === document.querySelector("[data-testid='workspace-sidebar']"),
      );
    }),
  ).toBe(true);
});

test("restores settings preferences after refresh", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/settings/preferences");

  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/preferences(?:\\?.*)?$`));
  await expect(settingsSectionLabel(page, /偏好设置|Preferences/i)).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/preferences(?:\\?.*)?$`));
  await expect(settingsSectionLabel(page, /偏好设置|Preferences/i)).toBeVisible();
});

test("switches settings sections through the client workbench", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/settings/preferences");
  let securityApiHits = 0;

  await page.route("**/api/workspaces/**/modules/settings**", async (route) => {
    const url = new URL(route.request().url());
    const section = url.searchParams.get("section");
    if (section !== "security") {
      await route.fallback();
      return;
    }

    securityApiHits += 1;

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          moduleId: "settings",
          data: {
            currentMembershipRole: "owner",
            currentUserDisplayName: session.userDisplayName,
            currentUserId: session.userId,
            currentWorkspaceSlug: session.workspaceSlug,
            initialSection: section,
            sessions: [],
          },
        },
      }),
    });
  });

  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/preferences(?:\\?.*)?$`));
  await expect(settingsSectionLabel(page, /偏好设置|Preferences/i)).toBeVisible();
  await expect(page.locator(".settings-page[data-hydrated='true']")).toBeVisible();

  await page.getByRole("link", { name: /安全与会话|Security/i }).click();
  await expect.poll(() => securityApiHits).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/settings/security(?:\\?.*)?$`));
  await expect(settingsSectionLabel(page, /安全与会话|Security & sessions/i)).toBeVisible();
});

test("closes the mobile sidebar after module navigation and restores with back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await openSeededWorkspacePage(page, "/im");
  const layout = page.locator(".workspace-layout");

  await expect(layout).not.toHaveClass(/workspace-layout--sidebar-open/);
  await page.getByRole("button", { name: /打开导航|Open navigation/i }).click();
  await expect(layout).toHaveClass(/workspace-layout--sidebar-open/);

  await page.getByRole("link", { name: /打开任务|Open tasks/i }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/task/board(?:\\?.*)?$`));
  await expect(layout).not.toHaveClass(/workspace-layout--sidebar-open/);
  await expect(page.getByRole("button", { name: /按状态|By Status/i })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/w/${escapeRegExp(session.workspaceSlug)}/im(?:\\?.*)?$`));
  await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
});

test("keeps channel-scoped guests inside authorized IM data", async ({ page }) => {
  const session = await seedChannelScopedGuestSession(page);

  await page.goto(`/w/${session.workspaceSlug}/im`);
  await expect(page.locator(".workspace-layout")).toBeVisible();
  await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
  await expect(page.getByText(session.privateChannelName, { exact: true })).toHaveCount(0);

  const imResponse = await page.request.get(`/api/workspaces/${encodeURIComponent(session.workspaceSlug)}/modules/im`);
  expect(imResponse.status()).toBe(200);
  const imPayload = await imResponse.json() as {
    data: {
      moduleId: "im";
      data: {
        channels: Array<{ name: string; channelName?: string }>;
        threads: Array<{ channelName: string }>;
      };
    };
  };
  const channelNames = imPayload.data.data.channels.map((channel) => channel.channelName ?? channel.name);
  expect(channelNames).toContain(session.channelName);
  expect(channelNames).not.toContain(session.privateChannelName);
  expect(imPayload.data.data.threads.map((thread) => thread.channelName)).not.toContain(session.privateChannelName);

  const taskBoardResponse = await page.request.get(`/api/workspaces/${encodeURIComponent(session.workspaceSlug)}/modules/task-board`);
  expect(taskBoardResponse.status()).toBe(403);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function settingsSectionLabel(page: Page, name: RegExp) {
  return page.locator(".settings-group__eyebrow").filter({ hasText: name, visible: true });
}
