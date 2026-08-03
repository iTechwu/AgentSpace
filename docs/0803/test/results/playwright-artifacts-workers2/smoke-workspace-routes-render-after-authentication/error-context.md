# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> workspace routes render after authentication
- Location: e2e/smoke.spec.ts:4:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.goto: Test timeout of 30000ms exceeded.
Call log:
  - navigating to "https://agentspace.local.dofe.ai/w/sso-team-e2e-msdcpbhr-klswhg/im", waiting until "load"

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - button "关闭侧边导航" [ref=e3]
  - complementary "工作区导航" [ref=e4]:
    - generic [ref=e5]:
      - button "切换团队工作区" [ref=e7]:
        - img [ref=e9]:
          - generic [ref=e16]: EW
        - text: E2E Workspace msdcpbhr-klswhg
      - button "收起侧边导航" [expanded] [ref=e19]
      - button "关闭侧边导航" [ref=e22]
    - button "打开全局搜索" [ref=e25]: 搜索消息、任务、知识与文档⌘K
    - generic [ref=e30]:
      - heading "待处理" [level=2] [ref=e31]
      - list [ref=e32]:
        - listitem [ref=e33]:
          - link [ref=e34] [cursor=pointer]:
            - /url: /w/sso-team-e2e-msdcpbhr-klswhg/task/board
            - generic [ref=e39]:
              - text: 打开任务
              - strong [ref=e40]: "1"
        - listitem [ref=e41]:
          - link "待审批" [ref=e42] [cursor=pointer]:
            - /url: /w/sso-team-e2e-msdcpbhr-klswhg/approvals
        - listitem [ref=e48]:
          - link "知识页" [ref=e49] [cursor=pointer]:
            - /url: /w/sso-team-e2e-msdcpbhr-klswhg/knowledge
    - generic [ref=e55]:
      - heading "协作" [level=2] [ref=e56]
      - link "通知" [ref=e58] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/inbox
      - link [ref=e65] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/im
        - generic [ref=e66]: 消息
        - text: "3"
      - link [ref=e73] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/contacts
        - generic [ref=e74]: 联系人
        - text: "1"
      - heading "数字员工" [level=2] [ref=e79]
      - link [ref=e81] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/agents?mode=agent
        - generic [ref=e82]: 员工管理
        - text: "1"
      - link [ref=e89] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/agents?mode=showcase
        - generic [ref=e90]: 数字员工展板
        - text: "1"
      - link "执行引擎管理" [ref=e97] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/runtimes
      - heading "能力资源" [level=2] [ref=e103]
      - link [ref=e105] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/skills
        - generic [ref=e106]: 技能库
        - text: "6"
      - link "知识库" [ref=e111] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/knowledge
      - link "应用市场" [ref=e118] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/market
      - link "审计日志" [ref=e125] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/audit
    - generic [ref=e132]:
      - link "打开设置" [ref=e133] [cursor=pointer]:
        - /url: /w/sso-team-e2e-msdcpbhr-klswhg/settings
        - img [ref=e135]:
          - generic [ref=e140]: EO
        - generic [ref=e141]:
          - strong [ref=e142]: E2E Owner msdcpbhr-klswhg
          - text: 超级管理员
      - button "退出登录" [ref=e144]
  - main [ref=e148]:
    - generic [ref=e149]:
      - button "打开导航" [ref=e150]
      - generic [ref=e153]:
        - strong [ref=e154]: 消息
        - text: E2E Owner msdcpbhr-klswhg
      - button "打开搜索" [ref=e155]
    - generic [ref=e162]:
      - complementary [ref=e163]:
        - generic [ref=e164]:
          - generic [ref=e166]:
            - heading "消息" [level=2] [ref=e167]
            - text: "3"
          - generic [ref=e169]:
            - tablist "消息类型" [ref=e170]:
              - tab "会话" [disabled] [selected] [ref=e171]
              - tab "数字联系人" [ref=e172]
            - button "创建群组" [ref=e173]
        - generic [ref=e176]:
          - button [ref=e177]:
            - img [ref=e179]:
              - generic [ref=e184]: E
            - generic [ref=e185]:
              - generic [ref=e186]:
                - strong [ref=e187]: e2e-general-msdcpbhr-klswhg
                - text: 22:55
              - paragraph [ref=e188]: "E2E Owner msdcpbhr-klswhg: Seeded conversation for workspace navigation smoke."
          - button [ref=e189]:
            - img [ref=e191]:
              - generic [ref=e196]: E
            - generic [ref=e197]:
              - generic [ref=e198]:
                - strong [ref=e199]: e2e-private-msdcpbhr-klswhg
                - text: 22:55
              - paragraph [ref=e200]: "E2E Owner msdcpbhr-klswhg: Private seeded conversation for access boundary coverage."
          - button [ref=e201]:
            - img [ref=e203]:
              - generic [ref=e211]: AM
            - generic [ref=e212]:
              - strong [ref=e214]: Atlas msdcpbhr-klswhg
              - paragraph [ref=e215]: 还没有消息
      - separator "调整会话列表宽度"
      - generic [ref=e216]:
        - generic [ref=e217]:
          - generic [ref=e218]:
            - generic [ref=e219]:
              - img [ref=e221]:
                - generic [ref=e226]: E
              - generic [ref=e228]:
                - heading "e2e-general-msdcpbhr-klswhg" [level=2] [ref=e229]
                - button "修改群名" [ref=e231]
                - generic [ref=e233]: "2"
                - text: 全员
            - generic [ref=e238]:
              - button "搜索" [ref=e239]
              - button "视频会议（暂不可用）" [disabled] [ref=e242]
              - button "添加群成员" [ref=e246]
              - button "日历" [ref=e249]
              - button "更多" [ref=e252]
          - generic [ref=e256]:
            - button "消息" [ref=e257]
            - button "文件" [ref=e261]
            - button "云文档" [ref=e265]
            - button "新建内容" [ref=e271]
        - article [ref=e276]:
          - generic [ref=e277]:
            - strong [ref=e278]: 你
            - text: 22:55
          - paragraph [ref=e279]: Seeded conversation for workspace navigation smoke.
          - generic [ref=e280]:
            - button "回复" [ref=e281]
            - button "复制" [ref=e284]
            - button "置顶" [ref=e288]
            - button "OK，标记已读" [ref=e291]
        - generic [ref=e295]:
          - textbox "发送到 e2e-general-msdcpbhr-klswhg" [ref=e296]
          - generic [ref=e297]:
            - generic [ref=e298]:
              - button "插入 @ 提及" [ref=e299]
              - button "剪贴内容（暂未启用）" [disabled] [ref=e303]
              - button "打开附件与快捷内容菜单" [ref=e309]
            - button "发送消息" [disabled] [ref=e312]
```

# Test source

```ts
  108 |     {
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
> 208 |   await page.goto(`/w/${session.workspaceSlug}${path.startsWith("/") ? path : `/${path}`}`);
      |              ^ Error: page.goto: Test timeout of 30000ms exceeded.
  209 |   await expect(page.locator(".workspace-layout")).toBeVisible();
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