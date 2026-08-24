import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createSessionSync, deleteMcpCatalogItemSync, deleteSessionByTokenHashSync, getDatabase } from "@dofe-agent/db";
import { deleteEmployeeSync } from "@dofe-agent/services/employees";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const enabled = process.env.DOFE_AGENT_LIVE_GEO_MCP === "1";
const workspaceId = process.env.DOFE_AGENT_LIVE_WORKSPACE_ID ?? "sso-team-c8c8d97ffcb845311387e967";
const endpoint = process.env.DOFE_AGENT_LIVE_GEOFLOW_ENDPOINT ?? "http://127.0.0.1:18080/mcp";
const mcpToken = process.env.DOFE_AGENT_LIVE_GEOFLOW_TOKEN ?? "";
const evidenceDir = resolve(process.cwd(), "../../docs/0821/opz/evidence");
const employeeFixturePattern = /^GEO Manager mt[a-z0-9]+$/;
const catalogFixturePattern = /^GEOFlow Docker Live mt[a-z0-9]+$/;
let liveSessionTokenHash: string | null = null;

test.afterEach(() => {
  if (!liveSessionTokenHash) return;
  const tokenHash = liveSessionTokenHash;
  liveSessionTokenHash = null;
  expect(deleteSessionByTokenHashSync(tokenHash)).toBe(true);
});

function pruneHistoricalGeoFixtures(db: ReturnType<typeof getDatabase>) {
  const employees = (db.prepare(
    "SELECT name FROM workspace_employee WHERE workspace_id = ? AND name LIKE ?",
  ).all(workspaceId, "GEO Manager mt%") as Array<{ name: string }>)
    .filter((row) => employeeFixturePattern.test(row.name));
  for (const employee of employees) {
    deleteEmployeeSync(employee.name, workspaceId);
  }

  const catalogItems = (db.prepare(
    "SELECT id, display_name AS name FROM mcp_catalog_item WHERE workspace_id = ? AND display_name LIKE ?",
  ).all(workspaceId, "GEOFlow Docker Live mt%") as Array<{ id: string; name: string }>)
    .filter((row) => catalogFixturePattern.test(row.name));
  for (const catalogItem of catalogItems) {
    deleteMcpCatalogItemSync(catalogItem.id, workspaceId);
  }

  return { employees: employees.length, catalogItems: catalogItems.length };
}

type PageQuality = {
  cls: number;
  lcpMs: number;
  inpMs: number;
  maxLongTaskMs: number;
  supportedMetrics: string[];
  interactiveWithoutName: string[];
  headingsWithoutName: string[];
  documentLanguage: string;
};

async function installPerformanceObservers(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const supportedMetrics = PerformanceObserver.supportedEntryTypes;
    const quality = { cls: 0, lcpMs: 0, interactionDurations: [] as number[], longTasks: [] as number[], supportedMetrics };
    Object.defineProperty(window, "__geoLiveQuality", { value: quality });

    if (supportedMetrics.includes("layout-shift")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
          if (!shift.hadRecentInput) quality.cls += Number(shift.value ?? 0);
        }
      }).observe({ type: "layout-shift", buffered: true });
    }
    if (supportedMetrics.includes("largest-contentful-paint")) {
      new PerformanceObserver((list) => {
        quality.lcpMs = Math.max(quality.lcpMs, ...list.getEntries().map((entry) => entry.startTime));
      }).observe({ type: "largest-contentful-paint", buffered: true });
    }
    if (supportedMetrics.includes("event")) {
      new PerformanceObserver((list) => {
        quality.interactionDurations.push(...list.getEntries()
          .filter((entry) => Number((entry as PerformanceEventTiming).interactionId ?? 0) > 0)
          .map((entry) => entry.duration));
      }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit & { durationThreshold: number });
    }
    if (supportedMetrics.includes("longtask")) {
      new PerformanceObserver((list) => {
        quality.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ type: "longtask", buffered: true });
    }
  });
}

async function collectPageQuality(page: import("@playwright/test").Page): Promise<PageQuality> {
  return page.evaluate(() => {
    const quality = (window as unknown as {
      __geoLiveQuality?: { cls: number; lcpMs: number; interactionDurations: number[]; longTasks: number[]; supportedMetrics: string[] };
    }).__geoLiveQuality ?? { cls: 0, lcpMs: 0, interactionDurations: [], longTasks: [], supportedMetrics: [] };
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const accessibleName = (element: Element) => {
      const labelledBy = element.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ") ?? "";
      const labels = element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement
        ? Array.from(element.labels ?? []).map((label) => label.textContent?.trim() ?? "").filter(Boolean).join(" ")
        : "";
      return [
        element.getAttribute("aria-label"),
        labelledBy,
        labels,
        element.getAttribute("alt"),
        element.getAttribute("title"),
        element.textContent,
      ].find((value) => value?.trim())?.trim() ?? "";
    };
    const selector = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]';
    const interactiveWithoutName = Array.from(document.querySelectorAll(selector))
      .filter((element) => isVisible(element) && element.getAttribute("aria-hidden") !== "true" && accessibleName(element) === "")
      .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`);
    const headingsWithoutName = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .filter((element) => isVisible(element) && accessibleName(element) === "")
      .map((element) => element.tagName.toLowerCase());

    return {
      cls: Number(quality.cls.toFixed(4)),
      lcpMs: Math.round(quality.lcpMs),
      inpMs: Math.round(Math.max(0, ...quality.interactionDurations)),
      maxLongTaskMs: Math.round(Math.max(0, ...quality.longTasks)),
      supportedMetrics: quality.supportedMetrics,
      interactiveWithoutName,
      headingsWithoutName,
      documentLanguage: document.documentElement.lang,
    };
  });
}

test.skip(!enabled, "Set DOFE_AGENT_LIVE_GEO_MCP=1 to run the Docker-backed GEOFlow regression.");

test("creates a GEO employee and connects its runtime to Docker GEOFlow MCP", async ({ page }) => {
  // Real managed-runtime verification can involve a remote daemon heartbeat;
  // keep this end-to-end budget separate from the default 30s UI test budget.
  test.setTimeout(120_000);
  test.skip(!mcpToken, "DOFE_AGENT_LIVE_GEOFLOW_TOKEN is required.");
  mkdirSync(evidenceDir, { recursive: true });

  const db = getDatabase();
  const workspace = db.prepare("SELECT slug FROM workspace WHERE id = ?").get(workspaceId) as { slug?: string } | undefined;
  const owner = db.prepare(
    `SELECT user_id AS "userId"
       FROM workspace_membership
      WHERE workspace_id = ? AND status = 'active' AND role IN ('owner', 'admin')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END
      LIMIT 1`,
  ).get(workspaceId) as { userId?: string } | undefined
    ?? db.prepare(
      `SELECT id AS "userId"
         FROM users
        WHERE is_admin = 1
        ORDER BY CASE WHEN primary_email LIKE '%@users.dofe.invalid' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1`,
    ).get() as { userId?: string } | undefined;
  expect(workspace?.slug).toBeTruthy();
  expect(owner?.userId).toBeTruthy();
  const prunedFixtures = pruneHistoricalGeoFixtures(db);
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_employee WHERE workspace_id = ? AND name LIKE ?",
  ).get(workspaceId, "GEO Manager mt%")).toMatchObject({ count: 0 });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM mcp_catalog_item WHERE workspace_id = ? AND display_name LIKE ?",
  ).get(workspaceId, "GEOFlow Docker Live mt%")).toMatchObject({ count: 0 });

  const token = `live-${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  createSessionSync({
    userId: owner!.userId!,
    tokenHash,
    expiresAt: expiresAt.toISOString(),
  });
  liveSessionTokenHash = tokenHash;
  await page.context().addCookies([
    { name: "dofe_agent_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax", expires: Math.floor(expiresAt.getTime() / 1000) },
    { name: "dofe_agent_workspace", value: workspace!.slug!, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax", expires: Math.floor(expiresAt.getTime() / 1000) },
  ]);
  await installPerformanceObservers(page);

  const browserIssues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserIssues.push(`console:${message.type()}:${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    browserIssues.push(`requestfailed:${request.method()}:${url.origin}${url.pathname}:${request.failure()?.errorText ?? "unknown"}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    browserIssues.push(`response:${response.status()}:${response.request().method()}:${url.origin}${url.pathname}`);
  });

  const suffix = Date.now().toString(36);
  const serviceName = `GEOFlow Docker Live ${suffix}`;
  const employeeName = `GEO Manager ${suffix}`;
  const employeeDisplayName = `GEO 管理员工 ${suffix}`;
  await page.goto(`/w/${workspace!.slug}/market?tab=mcp`, { waitUntil: "networkidle" });
  const closeOnboarding = page.getByRole("button", { name: /关闭新手引导|Close onboarding/i });
  if (await closeOnboarding.isVisible().catch(() => false)) await closeOnboarding.click();
  await expect(page.getByRole("heading", { name: /MCP 服务|MCP services/i })).toBeVisible();

  await page.getByRole("button", { name: /添加 MCP 服务|Add MCP service/i }).click();
  const catalogDialog = page.getByRole("dialog", { name: /添加 MCP 服务|Add MCP service/i });
  await catalogDialog.getByLabel(/服务名称|Service name/i).fill(serviceName);
  await catalogDialog.getByLabel("Endpoint (HTTPS or approved local address)").fill(endpoint);
  await catalogDialog.getByLabel(/密钥字段|Secret fields/i).fill("Authorization");
  await catalogDialog.getByLabel(/数据域|Data domains/i).fill("enterprise-knowledge, geo");

  const tools = [
    ["geoflow.enterprise_knowledge.list", "List tenant enterprise knowledge project metadata", "low"],
    ["geoflow.enterprise_knowledge.create", "Create an enterprise knowledge project", "medium"],
    ["geoflow.enterprise_knowledge.status", "Read project generation status", "low"],
    ["geoflow.enterprise_knowledge.autosave", "Save the generated draft", "medium"],
    ["geoflow.enterprise_knowledge.validate", "Validate the generated draft", "medium"],
    ["geoflow.enterprise_knowledge.publish", "Publish the approved knowledge base", "high"],
    ["geoflow.enterprise_knowledge.delete", "Delete a confirmed enterprise knowledge project", "high"],
  ] as const;
  for (let index = 1; index < tools.length; index += 1) {
    await catalogDialog.getByRole("button", { name: /添加工具|Add tool/i }).click();
  }
  const toolRows = catalogDialog.locator(".mcp-catalog-tool-draft");
  for (let index = 0; index < tools.length; index += 1) {
    const row = toolRows.nth(index);
    await row.locator("input").nth(0).fill(tools[index]![0]);
    await row.locator("input").nth(1).fill(tools[index]![1]);
    await row.locator("select").selectOption(tools[index]![2]);
    await row.locator('input[type="checkbox"]').check();
  }
  await catalogDialog.getByRole("button", { name: /发布到目录|Publish to catalog/i }).click();
  await expect(catalogDialog).toBeHidden();
  await expect(page.getByText(/MCP 服务已添加到目录|MCP service added to the catalog/i)).toBeVisible();

  await page.getByRole("textbox", { name: /搜索 MCP 服务|Search MCP services/i }).fill(serviceName);
  await page.getByRole("button", { name: new RegExp(serviceName) }).click();
  const detail = page.getByRole("complementary", { name: /MCP 详情|MCP details/i });
  const toolScope = detail.locator(".mcp-tool-scope");
  if (await toolScope.getAttribute("open") === null) await toolScope.locator("summary").click();
  await expect(toolScope.locator("summary")).toContainText(/7\/7 (个工具已选择|tools selected)/i);
  const riskLabels = { low: /低风险|Low risk/i, medium: /中风险|Medium risk/i, high: /高风险|High risk/i } as const;
  const publishedToolRows = toolScope.locator(".mcp-tool-row");
  await expect(publishedToolRows).toHaveCount(tools.length);
  for (let index = 0; index < tools.length; index += 1) {
    const row = publishedToolRows.nth(index);
    await expect(row.getByText(tools[index]![0], { exact: true })).toBeVisible();
    await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    await expect(row.locator(".status-chip")).toHaveText(riskLabels[tools[index]![2]]);
  }
  await page.screenshot({ path: resolve(evidenceDir, "geo-mcp-live-catalog.png"), fullPage: true });
  const runtimeSelect = detail.getByLabel(/目标 Runtime|Target runtime/i);
  await expect(runtimeSelect).toBeEnabled();
  const codexOption = runtimeSelect.locator("option").filter({ hasText: /codex/i }).last();
  const codexRuntimeId = await codexOption.getAttribute("value") ?? "";
  await runtimeSelect.selectOption(codexRuntimeId);
  await expect(runtimeSelect).toHaveValue(codexRuntimeId);
  await page.waitForTimeout(500);
  const authorization = detail.getByLabel("Authorization");
  await authorization.fill(`Bearer ${mcpToken}`);
  await expect(authorization).toHaveValue(`Bearer ${mcpToken}`);
  const riskConfirmation = detail.locator('.market-confirm-risk input[type="checkbox"]');
  await riskConfirmation.check();
  await expect(riskConfirmation).toBeChecked();
  const connectButton = detail.locator('.primary-button[data-next-action="configure_credentials"], .primary-button[data-next-action="connect"]');
  await expect(connectButton).toBeEnabled();
  await connectButton.click();
  await expect(page.getByText(/MCP 连接已创建，正在验证|MCP connection created; verifying/i)).toBeVisible();
  await expect.poll(() => {
    const row = db.prepare(
      "SELECT c.status FROM runtime_mcp_connection c JOIN mcp_catalog_item i ON i.id = c.catalog_item_id WHERE c.workspace_id = ? AND i.display_name = ? ORDER BY c.created_at DESC LIMIT 1",
    ).get(workspaceId, serviceName) as { status?: string } | undefined;
    return row?.status;
  }, { timeout: 60_000, intervals: [1_000, 2_000, 3_000] }).toBe("ready");

  // The agents page keeps a live runtime/status stream open, so networkidle is
  // not a stable readiness signal. The dialog assertion below is the actual
  // flow gate and avoids a false timeout after MCP verification succeeds.
  await page.goto(`/w/${workspace!.slug}/agents?mode=agent&create=agent`, { waitUntil: "domcontentloaded" });
  const employeeDialog = page.getByRole("dialog", { name: /创建 AI员工|Create AI employee/i });
  await employeeDialog.getByRole("tab", { name: /空白自定义|Blank custom/i }).click();
  await employeeDialog.getByLabel(/名称|Name/i).fill(employeeName);
  await employeeDialog.getByLabel(/备注名|Display name/i).fill(employeeDisplayName);
  await employeeDialog.getByLabel(/简介|Description/i).fill("通过 GEOFlow MCP 管理企业知识并完成发布闭环");
  await employeeDialog.getByLabel(/工作说明|Instructions/i).fill("使用已连接的 GEOFlow MCP 创建、检查、保存、校验并发布企业知识。发布前必须显式确认。不得跨租户访问数据。");
  const engineTrigger = employeeDialog.getByRole("button", { name: /执行引擎|Execution Engine/i });
  await engineTrigger.click();
  const employeeCodexOption = employeeDialog.getByRole("option").filter({ hasText: /codex/i }).last();
  await expect(employeeCodexOption).toBeEnabled();
  await employeeCodexOption.click();
  await expect(engineTrigger).toContainText(/codex/i);
  await employeeDialog.getByRole("button", { name: /^创建$|^Create$/i }).click();
  await expect(employeeDialog).toBeHidden();
  const creationAnnouncement = page.getByText(/AI员工 已创建|AI employee created/i).last();
  await expect(creationAnnouncement).toBeVisible({ timeout: 60_000 });
  await expect(creationAnnouncement.locator('xpath=ancestor-or-self::*[@role="status" or @role="alert" or @aria-live][1]')).toHaveCount(1);
  const createdEmployeeButton = page.getByRole("button", { name: new RegExp(employeeDisplayName) });
  await expect(createdEmployeeButton).toBeVisible({ timeout: 60_000 });
  await createdEmployeeButton.click();
  await expect(page.locator(".agents-detail-pane").getByText(employeeDisplayName, { exact: true })).toBeVisible({ timeout: 60_000 });
  const employee = db.prepare(
    `SELECT e.name, e.remark_name AS "remarkName", b.runtime_id AS "runtimeId"
       FROM workspace_employee e
       LEFT JOIN employee_runtime_binding b
         ON b.workspace_id = e.workspace_id AND b.employee_id = e.id
      WHERE e.workspace_id = ? AND e.name = ?
      LIMIT 1`,
  ).get(workspaceId, employeeName) as { name?: string; remarkName?: string; runtimeId?: string } | undefined;
  expect(employee).toMatchObject({ name: employeeName, remarkName: employeeDisplayName, runtimeId: codexRuntimeId });

  await page.screenshot({ path: resolve(evidenceDir, "geo-mcp-live-desktop.png"), fullPage: true });
  const navigation = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry ? { domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd), loadMs: Math.round(entry.loadEventEnd), transferBytes: entry.transferSize } : null;
  });
  expect(navigation).not.toBeNull();
  const desktopQuality = await collectPageQuality(page);
  expect(desktopQuality.documentLanguage).toMatch(/^(zh|en)/i);
  expect(desktopQuality.interactiveWithoutName).toEqual([]);
  expect(desktopQuality.headingsWithoutName).toEqual([]);
  expect(desktopQuality.supportedMetrics).toEqual(expect.arrayContaining(["event", "largest-contentful-paint", "layout-shift", "longtask"]));
  expect(desktopQuality.cls).toBeLessThanOrEqual(0.1);
  expect(desktopQuality.lcpMs).toBeGreaterThan(0);
  expect(desktopQuality.lcpMs).toBeLessThanOrEqual(2_500);
  expect(desktopQuality.inpMs).toBeGreaterThan(0);
  expect(desktopQuality.inpMs).toBeLessThanOrEqual(200);
  expect(desktopQuality.maxLongTaskMs).toBeLessThanOrEqual(200);
  const desktopAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  expect(desktopAccessibility.violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByText(employeeDisplayName, { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Tab");
  const hasKeyboardFocus = await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null);
  expect(hasKeyboardFocus).toBe(true);
  const mobileQuality = await collectPageQuality(page);
  expect(mobileQuality.documentLanguage).toMatch(/^(zh|en)/i);
  expect(mobileQuality.interactiveWithoutName).toEqual([]);
  expect(mobileQuality.headingsWithoutName).toEqual([]);
  expect(mobileQuality.supportedMetrics).toEqual(expect.arrayContaining(["event", "largest-contentful-paint", "layout-shift", "longtask"]));
  expect(mobileQuality.cls).toBeLessThanOrEqual(0.1);
  expect(mobileQuality.lcpMs).toBeGreaterThan(0);
  expect(mobileQuality.lcpMs).toBeLessThanOrEqual(2_500);
  expect(mobileQuality.maxLongTaskMs).toBeLessThanOrEqual(200);
  const mobileControlContrast = await page.locator(".workspace-mobile-bar__button").evaluateAll((buttons) => {
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      if (channels.length !== 3) return 0;
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    return buttons.map((button) => {
      const style = getComputedStyle(button);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return Number(((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toFixed(2));
    });
  });
  expect(mobileControlContrast).toHaveLength(2);
  expect(Math.min(...mobileControlContrast)).toBeGreaterThanOrEqual(3);
  const mobileAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  expect(mobileAccessibility.violations).toEqual([]);
  await page.screenshot({ path: resolve(evidenceDir, "geo-mcp-live-mobile.png"), fullPage: true });
  expect(browserIssues).toEqual([]);
  console.log(JSON.stringify({ serviceName, employeeName, employeeDisplayName, prunedFixtures, navigation, desktopQuality, mobileQuality }));
});
