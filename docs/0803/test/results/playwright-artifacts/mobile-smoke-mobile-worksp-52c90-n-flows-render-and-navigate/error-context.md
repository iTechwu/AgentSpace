# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-smoke.spec.ts >> mobile workspace drill-down flows render and navigate
- Location: e2e/mobile-smoke.spec.ts:8:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('textbox', { name: /编辑文件内容|Edit file content/i })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('textbox', { name: /编辑文件内容|Edit file content/i })

```

```yaml
- button "关闭侧边导航"
- complementary "工作区导航":
  - button "切换团队工作区": E2E Workspace msdcvovd-em1hq3
  - button "关闭侧边导航"
  - button "打开全局搜索": 搜索消息、任务、知识与文档 ⌘K
  - heading "待处理" [level=2]
  - list:
    - listitem:
      - link "打开任务 1":
        - /url: /w/sso-team-e2e-msdcvovd-em1hq3/task/board
        - text: 打开任务
        - strong: "1"
    - listitem:
      - link "待审批":
        - /url: /w/sso-team-e2e-msdcvovd-em1hq3/approvals
    - listitem:
      - link "知识页":
        - /url: /w/sso-team-e2e-msdcvovd-em1hq3/knowledge
  - heading "协作" [level=2]
  - link "通知":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/inbox
  - link "消息 3":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/im
  - link "联系人 1":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/contacts
  - heading "数字员工" [level=2]
  - link "员工管理 1":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/agents?mode=agent
  - link "数字员工展板 1":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/agents?mode=showcase
  - link "执行引擎管理":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/runtimes
  - heading "能力资源" [level=2]
  - link "技能库 6":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/skills
  - link "知识库":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/knowledge
  - link "应用市场":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/market
  - link "审计日志":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/audit
  - link "打开设置":
    - /url: /w/sso-team-e2e-msdcvovd-em1hq3/settings
    - strong: E2E Owner msdcvovd-em1hq3
    - text: 超级管理员
  - button "退出登录"
- main:
  - button "打开导航"
  - strong: 技能库
  - text: E2E Owner msdcvovd-em1hq3
  - button "打开搜索"
  - heading "数据保护 SLO 看板" [level=3]
  - button "刷新"
  - text: Workspace head age
  - strong: —
  - text: 恢复时长 RTO
  - strong: —
  - text: Digest 校验失败
  - strong: "0"
  - text: 绑定代际冲突
  - strong: "0"
  - text: 提交对账积压
  - strong: "0"
  - text: 数据容量
  - strong: 0 B
  - text: 超配额员工
  - strong: "0"
  - text: 活跃 legal hold
  - strong: "0"
  - paragraph: 当前无告警
  - paragraph: "检查时间: 8/3/2026, 11:00:22 PM"
  - button "返回技能列表"
  - strong: return-output-files
  - text: Skill 内容 ✦
  - textbox "Skill name" [disabled]: return-output-files
  - text: SKILL.md
  - button "只读预览" [disabled]
  - button "保存 Skill" [disabled]
  - text: Skill 元数据 名称
  - code: return-output-files
  - text: 描述 通过 dofe-agent output attach/text 将生成的文件返回到 DofeAgent。适用于任务需要交付图片、markdown、PDF 等文件而非纯文本回复的场景。
  - heading "返回输出文件" [level=1]
  - paragraph: 当你需要在最终回复中包含生成的文件（而非仅有纯文本）时，使用此技能。
  - heading "适用场景" [level=2]
  - list:
    - listitem: 用户明确要求获取文件、图片、PDF、markdown 笔记或可下载的成果物
    - listitem: 结果以文件形式交付比在聊天中粘贴更易于使用
    - listitem: 你在当前 workDir 中生成了图表、报告、草稿、导出文件或其他可交付物
  - heading "约定" [level=2]
  - list:
    - listitem:
      - text: 在当前
      - code: workDir
      - text: 中写入输出文件
    - listitem:
      - text: 将生成的文件放在
      - code: runtime-output/artifacts/
      - text: 目录下
    - listitem: 不要引用绝对路径
    - listitem:
      - text: 不要引用
      - code: workDir
      - text: 之外的文件
    - listitem: 不要仅在纯文本中回复文件路径
  - heading "命令" [level=2]
  - code: dofe-agent output text "可选的摘要信息，显示在聊天消息中。" dofe-agent output attach runtime-output/artifacts/chart.png --name chart.png --media-type image/png --text "图表已生成。" dofe-agent output validate
  - heading "规则" [level=2]
  - list:
    - listitem:
      - text: 传递给
      - code: dofe-agent output attach
      - text: 的每个文件必须已存在且非空
    - listitem:
      - text: 将
      - code: text
      - text: 作为在聊天中显示的可读摘要
    - listitem:
      - text: 仅在需要不同展示名称时使用
      - code: name
    - listitem:
      - text: 当文件类型无法从扩展名中明显判断时，使用
      - code: mediaType
    - listitem:
      - text: 如果不需要返回文件，使用普通文本回复或
      - code: dofe-agent output text
  - heading "示例" [level=2]
  - list:
    - listitem:
      - text: "PNG:"
      - code: runtime-output/artifacts/preview.png
    - listitem:
      - text: "Markdown:"
      - code: runtime-output/artifacts/summary.md
    - listitem:
      - text: "PDF:"
      - code: runtime-output/artifacts/report.pdf
  - paragraph: 已绑定 AI员工
  - strong: 0 个 AI员工 正在使用这份 skill
  - text: 还没有 AI员工 绑定
  - heading "Runtime 安装" [level=4]
  - button "保存草稿"
  - button "安装到 Runtime"
  - status: 该 Skill 尚未安装到任何 Runtime。
- alert
```

# Test source

```ts
  1  | import { devices, expect, test } from "@playwright/test";
  2  | import { ensureWorkspaceSession } from "./helpers";
  3  |
  4  | test.use({
  5  |   ...devices["iPhone 13"],
  6  | });
  7  |
  8  | test("mobile workspace drill-down flows render and navigate", async ({ page }) => {
  9  |   const session = await ensureWorkspaceSession(page);
  10 |
  11 |   await page.goto("/skills");
  12 |   await expect(page.getByRole("button", { name: /打开导航|Open navigation/i })).toBeVisible();
  13 |   await page.getByRole("button", { name: /打开导航|Open navigation/i }).click();
  14 |   await expect(
  15 |     page.getByTestId("workspace-sidebar").getByRole("button", { name: /关闭侧边导航|Close sidebar/i }),
  16 |   ).toBeVisible();
  17 |
  18 |   await page.goto("/im");
  19 |   await expect(page.getByRole("heading", { name: session.channelName })).toBeVisible();
  20 |
  21 |   await page.goto("/skills");
  22 |   const firstSkill = page.locator(".skills-studio__skill-row").first();
  23 |   await expect(firstSkill).toBeVisible();
  24 |   await firstSkill.click();
  25 |   await expect(page.getByRole("button", { name: /返回技能列表|Back to skills/i })).toBeVisible();
  26 |   await expect(page.getByRole("textbox", { name: /Skill name/i })).toBeVisible();
> 27 |   await expect(page.getByRole("textbox", { name: /编辑文件内容|Edit file content/i })).toBeVisible();
     |                                                                                  ^ Error: expect(locator).toBeVisible() failed
  28 |
  29 |   await page.goto("/approvals");
  30 |   await expect(page.getByRole("button", { name: /全部|All/i })).toBeVisible();
  31 |
  32 |   await page.goto("/agents");
  33 |   await expect(page.getByRole("heading", { name: /全部 AI员工|All AI employees/i })).toBeVisible();
  34 | });
  35 |
```