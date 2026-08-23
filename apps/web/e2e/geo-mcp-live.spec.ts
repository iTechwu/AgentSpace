import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createSessionSync, getDatabase } from "@dofe-agent/db";
import { expect, test } from "@playwright/test";

const enabled = process.env.DOFE_AGENT_LIVE_GEO_MCP === "1";
const workspaceId = process.env.DOFE_AGENT_LIVE_WORKSPACE_ID ?? "sso-team-c8c8d97ffcb845311387e967";
const endpoint = process.env.DOFE_AGENT_LIVE_GEOFLOW_ENDPOINT ?? "http://127.0.0.1:18080/mcp";
const mcpToken = process.env.DOFE_AGENT_LIVE_GEOFLOW_TOKEN ?? "";
const evidenceDir = resolve(process.cwd(), "../../docs/0821/opz/evidence");

test.skip(!enabled, "Set DOFE_AGENT_LIVE_GEO_MCP=1 to run the Docker-backed GEOFlow regression.");

test("creates a GEO employee and connects its runtime to Docker GEOFlow MCP", async ({ page }) => {
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

  const token = `live-${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  createSessionSync({
    userId: owner!.userId!,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: expiresAt.toISOString(),
  });
  await page.context().addCookies([
    { name: "dofe_agent_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax", expires: Math.floor(expiresAt.getTime() / 1000) },
    { name: "dofe_agent_workspace", value: workspace!.slug!, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax", expires: Math.floor(expiresAt.getTime() / 1000) },
  ]);

  const browserIssues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserIssues.push(`console:${message.type()}:${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    browserIssues.push(`requestfailed:${request.method()}:${url.origin}${url.pathname}:${request.failure()?.errorText ?? "unknown"}`);
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
    ["geoflow.enterprise_knowledge.create", "Create an enterprise knowledge project"],
    ["geoflow.enterprise_knowledge.status", "Read project generation status"],
    ["geoflow.enterprise_knowledge.autosave", "Save the generated draft"],
    ["geoflow.enterprise_knowledge.validate", "Validate the generated draft"],
    ["geoflow.enterprise_knowledge.publish", "Publish the approved knowledge base"],
  ] as const;
  for (let index = 1; index < tools.length; index += 1) {
    await catalogDialog.getByRole("button", { name: /添加工具|Add tool/i }).click();
  }
  const toolRows = catalogDialog.locator(".mcp-catalog-tool-draft");
  for (let index = 0; index < tools.length; index += 1) {
    const row = toolRows.nth(index);
    await row.locator("input").nth(0).fill(tools[index]![0]);
    await row.locator("input").nth(1).fill(tools[index]![1]);
    await row.locator("select").selectOption(index === tools.length - 1 ? "high" : "medium");
    await row.locator('input[type="checkbox"]').check();
  }
  await catalogDialog.getByRole("button", { name: /发布到目录|Publish to catalog/i }).click();
  await expect(catalogDialog).toBeHidden();
  await expect(page.getByText(/MCP 服务已添加到目录|MCP service added to the catalog/i)).toBeVisible();

  await page.getByRole("textbox", { name: /搜索 MCP 服务|Search MCP services/i }).fill(serviceName);
  await page.getByRole("button", { name: new RegExp(serviceName) }).click();
  const detail = page.getByRole("complementary", { name: /MCP 详情|MCP details/i });
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

  await page.goto(`/w/${workspace!.slug}/agents?mode=agent&create=agent`, { waitUntil: "networkidle" });
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
  await expect(page.getByText(employeeDisplayName, { exact: true }).first()).toBeVisible();
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByText(employeeDisplayName, { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDir, "geo-mcp-live-mobile.png"), fullPage: true });
  expect(browserIssues).toEqual([]);
  console.log(JSON.stringify({ serviceName, employeeName, employeeDisplayName, navigation }));
});
