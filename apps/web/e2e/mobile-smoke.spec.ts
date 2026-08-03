import { devices, expect, test } from "@playwright/test";
import { ensureWorkspaceSession } from "./helpers";

test.use({
  ...devices["iPhone 13"],
});

test("mobile workspace drill-down flows render and navigate", async ({ page }) => {
  const session = await ensureWorkspaceSession(page);

  await page.goto("/skills");
  await expect(page.getByRole("button", { name: /打开导航|Open navigation/i })).toBeVisible();
  await page.getByRole("button", { name: /打开导航|Open navigation/i }).click();
  await expect(
    page.getByTestId("workspace-sidebar").getByRole("button", { name: /关闭侧边导航|Close sidebar/i }),
  ).toBeVisible();

  await page.goto("/im");
  await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();

  await page.goto("/skills");
  const firstSkill = page.locator(".skills-studio__skill-row").first();
  await expect(firstSkill).toBeVisible();
  await firstSkill.click();
  await expect(page.getByRole("button", { name: /返回技能列表|Back to skills/i })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Skill name/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /只读预览|Read-only preview/i })).toBeVisible();
  await expect(page.locator(".skills-editor__md-preview:visible")).toBeVisible();

  await page.goto("/approvals");
  await expect(page.getByRole("button", { name: /全部|All/i })).toBeVisible();

  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();
});
