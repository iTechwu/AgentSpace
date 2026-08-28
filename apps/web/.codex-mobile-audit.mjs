import { chromium } from "@playwright/test";

const origin = "https://agentspace.local.dofe.ai";
const workspace = "/w/yootun-all-%E4%BC%98%E6%83%A0%E8%B1%9A-%E5%85%A8%E4%BD%93-87e967";
const issues = [];

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    issues.push({ kind: `console.${message.type()}`, url: page.url(), detail: message.text() });
  }
});
page.on("pageerror", (error) => {
  issues.push({ kind: "pageerror", url: page.url(), detail: error.message });
});
page.on("requestfailed", (request) => {
  issues.push({ kind: "requestfailed", url: request.url(), detail: request.failure()?.errorText ?? "unknown" });
});
page.on("response", (response) => {
  if (response.status() >= 400) {
    issues.push({ kind: `http.${response.status()}`, url: response.url(), detail: response.statusText() });
  }
});

await page.goto(origin, { waitUntil: "domcontentloaded" });
await page.getByRole("link", { name: "使用 Dofe SSO 登录" }).click();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2_000);
for (let attempt = 1; attempt <= 2 && page.url().includes("sso.ixicai.cn"); attempt += 1) {
  await page.locator("input[type=tel], input[name=phone], input[placeholder*=手机]").first().fill("13800138000");
  await page.locator("input[type=password]").fill("!QAZxdr5");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => url.hostname === "agentspace.local.dofe.ai", { timeout: 20_000 }).catch(() => {});
}
if (page.url().includes("sso.ixicai.cn")) {
  throw new Error(`SSO login did not return to AgentSpace: ${await page.locator("body").innerText()}`);
}
await page.waitForTimeout(2_000);
await page.setViewportSize({ width: 390, height: 844 });

const client = await context.newCDPSession(page);
const routes = ["im", "inbox", "task-board", "agents", "runtimes", "skills", "knowledge", "market", "templates", "tables", "automations", "calendar", "performance", "settings/preferences"];

for (const route of routes) {
  await page.goto(`${origin}${workspace}/${route}`, { waitUntil: "networkidle" });
  const skip = page.getByRole("button", { name: /跳过|关闭新手引导/ }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(1_500);
  }

  const layout = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const outOfViewport = [...document.querySelectorAll("main *")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, text: (element.textContent ?? "").trim().slice(0, 60), left: Math.round(rect.left), right: Math.round(rect.right) };
      })
      .filter((item) => item.left < -2 || item.right > innerWidth + 2)
      .slice(0, 5);
    return {
      h1: document.querySelector("h1")?.textContent?.trim() ?? "",
      path: location.pathname,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      outOfViewport,
    };
  });
  const tree = await client.send("Accessibility.getFullAXTree");
  const unnamedControls = tree.nodes
    .filter((node) => !node.ignored && ["button", "link", "textbox", "combobox"].includes(node.role?.value) && !node.name?.value)
    .map((node) => ({ role: node.role?.value, backendDOMNodeId: node.backendDOMNodeId }));
  console.log(JSON.stringify({ route, layout, unnamedControls }));

  if (["im", "agents", "templates", "settings/preferences"].includes(route)) {
    await page.screenshot({ path: `/tmp/agentspace-mobile-${route.replaceAll("/", "-")}.png`, fullPage: true });
  }
}

await page.goto(`${origin}${workspace}/im`, { waitUntil: "networkidle" });
const buttonNames = await client.send("Accessibility.getFullAXTree").then((tree) => tree.nodes
  .filter((node) => !node.ignored && node.role?.value === "button")
  .map((node) => node.name?.value ?? "")
  .filter(Boolean));
const menuButton = page.getByRole("button", { name: /菜单|导航/ }).first();
let menuCheck = { candidates: buttonNames.filter((name) => /菜单|导航/.test(name)), opened: false, visibleLinks: 0 };
if (await menuButton.isVisible().catch(() => false)) {
  await menuButton.click();
  await page.waitForTimeout(300);
  menuCheck = { ...menuCheck, opened: true, visibleLinks: await page.getByRole("link").filter({ visible: true }).count() };
}
console.log(JSON.stringify({ menuCheck }));
console.log(JSON.stringify({ issues }));

await browser.close();
