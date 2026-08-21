import { expect, test } from "@playwright/test";
import { ensureWorkspaceSession } from "./helpers";

test("workspace routes render after authentication", async ({ page }) => {
  const session = await ensureWorkspaceSession(page);

  await page.goto("/im");
  await expect(page).toHaveURL(/\/im(?:\?.*)?$/);
  await expect(page.getByRole("link", { name: /^(消息|Messages)(?:\s+\d+)?$/i })).toBeVisible();

  await page.goto("/skills");
  await expect(page).toHaveURL(/\/skills(?:\?.*)?$/);
  await expect(page.getByRole("heading", { name: /技能库|Skill Library/i })).toBeVisible();

  await page.goto("/agents");
  await expect(page).toHaveURL(/\/agents(?:\?.*)?$/);
  await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();

  await page.goto("/approvals");
  await expect(page).toHaveURL(/\/approvals(?:\?.*)?$/);
  await expect(page.getByRole("button", { name: /全部|All/i })).toBeVisible();

  await page.goto(`/w/${session.workspaceSlug}/contacts?view=digital`);
  await expect(page.getByRole("heading", { name: /联系人|Contacts/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /新建数字员工|New digital employee/i })).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
});
