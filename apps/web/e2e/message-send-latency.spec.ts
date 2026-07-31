import { expect, test } from "@playwright/test";
import { openSeededWorkspacePage } from "./helpers";

test("clears the composer promptly after sending a channel message", async ({ page }) => {
  await openSeededWorkspacePage(page, "/im");
  const composer = page.locator("textarea.contacts-composer__textarea:visible").first();
  const content = `message-send-latency-${Date.now().toString(36)}`;
  let releaseAction: (() => void) | undefined;
  let markActionStarted: (() => void) | undefined;
  const releaseGate = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  const actionStarted = new Promise<void>((resolve) => {
    markActionStarted = resolve;
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      markActionStarted?.();
      await releaseGate;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await expect(composer).toBeVisible();
  await composer.fill(content);

  const startedAt = Date.now();
  await composer.press("Enter");
  await actionStarted;
  await expect(composer).toHaveValue("", { timeout: 500 });

  test.info().annotations.push({
    type: "send-latency-ms",
    description: String(Date.now() - startedAt),
  });

  releaseAction?.();
  await expect(composer).toHaveValue(content);
});
