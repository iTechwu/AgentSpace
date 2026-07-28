import { expect, test } from "@playwright/test";
import { ensureWorkspaceSession } from "./helpers";

test("workspace routes render after authentication", async ({ page }) => {
  await ensureWorkspaceSession(page);

  await page.goto("/im");
  await expect(page).toHaveURL(/\/im(?:\?.*)?$/);
  await expect(page.getByRole("heading", { name: /消息|Messages/i })).toBeVisible();

  await page.goto("/skills");
  await expect(page).toHaveURL(/\/skills(?:\?.*)?$/);
  await expect(page.getByRole("heading", { name: /技能库|Skill Library/i })).toBeVisible();

  await page.goto("/agents");
  await expect(page).toHaveURL(/\/agents(?:\?.*)?$/);
  await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();

  await page.goto("/approvals");
  await expect(page).toHaveURL(/\/approvals(?:\?.*)?$/);
  await expect(page.getByRole("button", { name: /全部|All/i })).toBeVisible();
});
