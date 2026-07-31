import { expect, test } from "@playwright/test";
import { openSeededWorkspacePage } from "./helpers";

test("clears the composer promptly after sending a channel message", async ({ page }) => {
  await openSeededWorkspacePage(page, "/im");
  const composer = page.locator("textarea.contacts-composer__textarea:visible").first();
  const content = `message-send-latency-${Date.now().toString(36)}`;

  await expect(composer).toBeVisible();
  await composer.fill(content);

  const startedAt = Date.now();
  await composer.press("Enter");
  await expect(composer).toHaveValue("", { timeout: 2_000 });

  test.info().annotations.push({
    type: "send-latency-ms",
    description: String(Date.now() - startedAt),
  });
});
