# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-navigation.spec.ts >> restores settings preferences after refresh
- Location: e2e/workspace-navigation.spec.ts:236:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.workspace-layout')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('.workspace-layout')

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
  109 |       id: `message-${suffix}`,
  110 |       channel: channelName,
  111 |       speaker: user.displayName,
  112 |       speakerUserId: user.id,
  113 |       role: "human",
  114 |       time: new Date().toISOString(),
  115 |       summary: "Seeded conversation for workspace navigation smoke.",
  116 |       status: "completed",
  117 |       kind: "message",
  118 |     },
  119 |     {
  120 |       id: `private-message-${suffix}`,
  121 |       channel: privateChannelName,
  122 |       speaker: user.displayName,
  123 |       speakerUserId: user.id,
  124 |       role: "human",
  125 |       time: new Date().toISOString(),
  126 |       summary: "Private seeded conversation for access boundary coverage.",
  127 |       status: "completed",
  128 |       kind: "message",
  129 |     },
  130 |   ];
  131 |   state.tasks = [
  132 |     {
  133 |       id: `task-${suffix}`,
  134 |       title: "E2E workspace navigation task",
  135 |       channel: channelName,
  136 |       assignee: agentName,
  137 |       priority: "medium",
  138 |       status: "todo",
  139 |     },
  140 |   ];
  141 |   writeWorkspaceStateSync(state, workspace.id, { skipVersionCheck: true });
  142 |
  143 |   const token = `sess-${randomBytes(24).toString("hex")}`;
  144 |   const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  145 |   createSessionSync({
  146 |     userId: user.id,
  147 |     tokenHash: createHash("sha256").update(token).digest("hex"),
  148 |     expiresAt: expiresAt.toISOString(),
  149 |   });
  150 |
  151 |   const cookieUrl = resolveCookieUrl();
  152 |   const expires = Math.floor(expiresAt.getTime() / 1000);
  153 |   await page.context().addCookies([
  154 |     {
  155 |       name: AUTH_COOKIE_NAME,
  156 |       value: token,
  157 |       url: cookieUrl,
  158 |       httpOnly: true,
  159 |       sameSite: "Lax",
  160 |       expires,
  161 |     },
  162 |     {
  163 |       name: WORKSPACE_SELECTION_COOKIE,
  164 |       value: workspace.slug,
  165 |       url: cookieUrl,
  166 |       httpOnly: true,
  167 |       sameSite: "Lax",
  168 |       expires,
  169 |     },
  170 |     {
  171 |       name: WORKSPACE_RECENT_SELECTION_COOKIE,
  172 |       value: workspace.slug,
  173 |       url: cookieUrl,
  174 |       httpOnly: true,
  175 |       sameSite: "Lax",
  176 |       expires,
  177 |     },
  178 |   ]);
  179 |
  180 |   return {
  181 |     agentName,
  182 |     channelName,
  183 |     privateChannelName,
  184 |     userDisplayName: user.displayName,
  185 |     userId: user.id,
  186 |     workspaceId: workspace.id,
  187 |     workspaceSlug: workspace.slug,
  188 |   };
  189 | }
  190 |
  191 | export async function seedChannelScopedGuestSession(page: Page): Promise<SeededWorkspaceSession> {
  192 |   const session = await seedWorkspaceSession(page);
  193 |   removeWorkspaceMembershipSync(session.workspaceId, session.userId);
  194 |   createChannelParticipantSync({
  195 |     workspaceId: session.workspaceId,
  196 |     channelName: session.channelName,
  197 |     userId: session.userId,
  198 |     addedBy: session.userId,
  199 |   });
  200 |   return session;
  201 | }
  202 |
  203 | export async function openSeededWorkspacePage(
  204 |   page: Page,
  205 |   path: string,
  206 | ): Promise<SeededWorkspaceSession> {
  207 |   const session = await seedWorkspaceSession(page);
  208 |   await page.goto(`/w/${session.workspaceSlug}${path.startsWith("/") ? path : `/${path}`}`);
> 209 |   await expect(page.locator(".workspace-layout")).toBeVisible();
      |                                                   ^ Error: expect(locator).toBeVisible() failed
  210 |   await dismissWorkspaceChromeOverlays(page);
  211 |   return session;
  212 | }
  213 |
  214 | function resolveCookieUrl(): string {
  215 |   return process.env.PLAYWRIGHT_BASE_URL?.trim()
  216 |     || `http://127.0.0.1:${process.env.PORT ?? 3000}/`;
  217 | }
  218 |
```