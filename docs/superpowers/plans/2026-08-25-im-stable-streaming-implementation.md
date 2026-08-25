# IM 稳定流式输出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 Harness 输出完整和最终回复正确的前提下，将 IM 增量读取改为可见标签页每帧最多一次提交，并稳定展开状态、长输出提示和阅读位置。

**Architecture:** 保留现有 SSE `channel.thread.changed` + `afterSeq` 增量读取。新增通用 frame batcher 和纯 task-stream patch reducer，将网络恢复与 React 状态提交解耦；现有 `TaskExecutionTimelineRow` 继续以稳定 id 渲染，只补充错误默认展开、完整度提示、低干扰运行态和 24px follow mode。

**Tech Stack:** React 19、TypeScript、EventSource、requestAnimationFrame、Vitest、Testing Library、Playwright、Chrome DevTools Protocol。

---

## File Structure

- Create: `apps/web/shared/lib/frame-batcher.ts` — 可见标签页 rAF、后台定时刷新、销毁与立即补齐。
- Create: `apps/web/shared/lib/frame-batcher.test.ts` — 调度、合并、后台和 dispose 测试。
- Create: `apps/web/features/channels/channel-task-stream-patch.ts` — 纯增量合并与结构共享。
- Create: `apps/web/features/channels/channel-task-stream-patch.test.ts` — seq 去重、消息更新、跨 task 批量合并测试。
- Modify: `apps/web/features/channels/channels-page-client.tsx` — 请求去重、patch 入队、单帧一次 setState。
- Modify: `apps/web/features/channels/channels-page-client.test.tsx` — 同帧事件合并、缺口回退、最终回复测试。
- Modify: `apps/web/features/chat/chat-primitives.tsx` — 错误默认展开、长输出完整度、稳定流式 caret。
- Modify: `apps/web/features/chat/chat-primitives.test.tsx` — disclosure、完整度、增量不改变用户状态。
- Modify: `apps/web/features/chat/conversation-shell.tsx` — 24px follow threshold 和“有新输出”状态。
- Modify: `apps/web/features/chat/conversation-shell.test.tsx` — 底部跟随、上滚保护、展开不抢滚动。
- Modify: `apps/web/app/globals.css` — 2.6s sweep、caret、详情尺寸和 reduced-motion。
- Modify: `apps/web/e2e/workspace-navigation.spec.ts` — IM 横向溢出、展开收起和新输出按钮回归。
- Modify: `docs/0825/im-uiux/05-全站间距与稳定流式反馈.md` — 流式验证证据。
- Modify: `../new-agents.dofe.ai/docs/0825/im-uiux/README.md` — 同步本轮设计决策和 Agent 项目映射状态，不覆盖该仓库现有实施记录。

### Task 1: 实现可见性感知的帧批处理器

**Files:**
- Create: `apps/web/shared/lib/frame-batcher.ts`
- Create: `apps/web/shared/lib/frame-batcher.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { createFrameBatcher } from "@/shared/lib/frame-batcher";

describe("createFrameBatcher", () => {
  it("flushes all visible updates once in the next frame", () => {
    const flush = vi.fn();
    let callback: FrameRequestCallback | undefined;
    const batcher = createFrameBatcher<number>({
      flush,
      isHidden: () => false,
      requestFrame: (next) => { callback = next; return 1; },
      cancelFrame: vi.fn(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    });
    batcher.enqueue(1);
    batcher.enqueue(2);
    expect(flush).not.toHaveBeenCalled();
    callback?.(16);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });

  it("uses one background timer and flushes immediately when visible again", () => {
    let hidden = true;
    const flush = vi.fn();
    let timer: (() => void) | undefined;
    const batcher = createFrameBatcher<number>({
      flush,
      isHidden: () => hidden,
      requestFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      setTimer: (next) => { timer = next; return 2; },
      clearTimer: vi.fn(),
    });
    batcher.enqueue(1);
    batcher.enqueue(2);
    expect(timer).toBeDefined();
    hidden = false;
    batcher.notifyVisibilityChanged();
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });

  it("cancels queued work on dispose", () => {
    const flush = vi.fn();
    let callback: FrameRequestCallback | undefined;
    const cancelFrame = vi.fn();
    const batcher = createFrameBatcher<number>({
      flush,
      isHidden: () => false,
      requestFrame: (next) => { callback = next; return 7; },
      cancelFrame,
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    });
    batcher.enqueue(1);
    batcher.dispose();
    callback?.(16);
    batcher.enqueue(2);
    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(flush).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run shared/lib/frame-batcher.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现批处理器**

```ts
interface FrameBatcherOptions<T> {
  flush: (items: readonly T[]) => void;
  isHidden: () => boolean;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
  backgroundDelayMs?: number;
}

export interface FrameBatcher<T> {
  enqueue: (item: T) => void;
  notifyVisibilityChanged: () => void;
  dispose: () => void;
}

export function createFrameBatcher<T>(options: FrameBatcherOptions<T>): FrameBatcher<T> {
  const queue: T[] = [];
  let frameId: number | null = null;
  let timerId: number | null = null;
  let disposed = false;
  const flush = () => {
    frameId = null;
    timerId = null;
    if (disposed || queue.length === 0) return;
    options.flush(queue.splice(0));
  };
  const schedule = () => {
    if (disposed || frameId !== null || timerId !== null) return;
    if (options.isHidden()) {
      timerId = options.setTimer(flush, options.backgroundDelayMs ?? 250);
    } else {
      frameId = options.requestFrame(flush);
    }
  };
  return {
    enqueue(item) { queue.push(item); schedule(); },
    notifyVisibilityChanged() {
      if (disposed || options.isHidden() || queue.length === 0) return;
      if (timerId !== null) options.clearTimer(timerId);
      if (frameId !== null) options.cancelFrame(frameId);
      timerId = null;
      frameId = null;
      flush();
    },
    dispose() {
      disposed = true;
      if (frameId !== null) options.cancelFrame(frameId);
      if (timerId !== null) options.clearTimer(timerId);
      queue.length = 0;
    },
  };
}
```

- [ ] **Step 4: 运行包含 dispose 场景的完整测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run shared/lib/frame-batcher.test.ts`

Expected: 3 tests PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "新增流式更新帧批处理器"
```

### Task 2: 提取 task stream 纯增量合并

**Files:**
- Create: `apps/web/features/channels/channel-task-stream-patch.ts`
- Create: `apps/web/features/channels/channel-task-stream-patch.test.ts`

- [ ] **Step 1: 写 seq 去重与消息替换失败测试**

```ts
import { describe, expect, it } from "vitest";
import { applyChannelTaskStreamPatches } from "@/features/channels/channel-task-stream-patch";

it("deduplicates task rows by seq and keeps them ordered", () => {
  const next = applyChannelTaskStreamPatches(seedDetailMap(), [{
    channelName: "tour visit",
    conversationId: "conversation-1",
    taskId: "task-1",
    messages: [{ ...seedReply, summary: "最终回复" }],
    taskExecutions: [row(2, "第二段"), row(2, "第二段"), row(3, "第三段")],
  }]);
  expect(next.get("tour visit")?.threads[0].taskExecutions?.["task-1"].map((item) => item.seq)).toEqual([1, 2, 3]);
  expect(next.get("tour visit")?.threads[0].messages.find((item) => item.id === seedReply.id)?.summary).toBe("最终回复");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/channels/channel-task-stream-patch.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 patch 类型和合并函数**

```ts
import type { ChannelsPageData } from "@/features/dashboard/data";
import type { ChannelDetailData } from "@/features/channels/channels-page-shared";

type ThreadMessage = ChannelsPageData["threads"][number]["messages"][number];
type TaskExecution = NonNullable<ChannelsPageData["threads"][number]["taskExecutions"]>[string][number];

export interface ChannelTaskStreamPatch {
  channelName: string;
  conversationId: string;
  taskId: string;
  messages: ThreadMessage[];
  taskExecutions: TaskExecution[];
}

export function applyChannelTaskStreamPatches(
  current: Map<string, ChannelDetailData>,
  patches: readonly ChannelTaskStreamPatch[],
): Map<string, ChannelDetailData> {
  let next = current;
  for (const patch of patches) {
    const detail = next.get(patch.channelName);
    if (!detail) continue;
    const threadIndex = detail.threads.findIndex((thread) => thread.channelName === patch.channelName);
    if (threadIndex < 0) continue;
    const thread = detail.threads[threadIndex];
    const normalizedIncoming = patch.messages.map((message) => ({
      ...message,
      conversationId: message.conversationId ?? patch.conversationId,
    }));
    const incomingById = new Map(normalizedIncoming.map((message) => [message.id, message]));
    const messages = thread.messages.map((message) => {
      const incoming = incomingById.get(message.id);
      if (!incoming) return message;
      incomingById.delete(message.id);
      return { ...message, ...incoming };
    });
    messages.push(...incomingById.values());
    const rows = new Map((thread.taskExecutions?.[patch.taskId] ?? []).map((row) => [row.seq, row]));
    for (const row of patch.taskExecutions) rows.set(row.seq, row);
    const threads = detail.threads.slice();
    threads[threadIndex] = {
      ...thread,
      messages,
      taskExecutions: { ...thread.taskExecutions, [patch.taskId]: [...rows.values()].sort((a, b) => a.seq - b.seq) },
    };
    if (next === current) next = new Map(current);
    next.set(patch.channelName, { ...detail, threads });
  }
  return next;
}
```

- [ ] **Step 4: 增加同一帧两个 task、空 patch 和未知频道测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/channels/channel-task-stream-patch.test.ts`

Expected: 所有测试 PASS；未知频道返回原 Map 引用，多个 patch 只生成最终一次 Map。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "提取会话流式增量合并逻辑"
```

### Task 3: 将 SSE 恢复结果按帧提交

**Files:**
- Modify: `apps/web/features/channels/channels-page-client.tsx:224-305,777-886`
- Modify: `apps/web/features/channels/channels-page-client.test.tsx:1080-1158`

- [ ] **Step 1: 写同帧合并失败测试**

在现有 `channel.thread.changed` 增量测试中加入以下核心调度断言；fetch mock 按 `afterSeq` 返回第二、第三段：

```ts
const frames: FrameRequestCallback[] = [];
vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
  frames.push(callback);
  return frames.length;
});
eventSources.at(-1)?.emit("channel.thread.changed", { channelName: "tour visit", conversationId: "conversation-stream", taskId: "task-stream", lastSeq: 2 });
eventSources.at(-1)?.emit("channel.thread.changed", { channelName: "tour visit", conversationId: "conversation-stream", taskId: "task-stream", lastSeq: 3 });
await waitFor(() => expect(fetchMock).toHaveBeenCalled());
expect(screen.getByText("第一段")).toBeInTheDocument();
act(() => frames.splice(0).forEach((callback) => callback(16)));
expect(await screen.findByText("第一段第二段第三段")).toBeInTheDocument();
expect(routerRefreshMock).not.toHaveBeenCalled();
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/channels/channels-page-client.test.tsx -t "batches task stream updates into one animation frame"`

Expected: FAIL，当前每次 fetch 完成后立即 `setDetailDataByChannelName`。

- [ ] **Step 3: 集成 batcher 与纯 reducer**

在客户端建立 `streamPatchBatcherRef` 和 `requestedLastSeqByTaskRef`。batcher 的 `flush` 只调用一次：

```ts
setDetailDataByChannelName((current) => applyChannelTaskStreamPatches(current, patches));
```

`recoverChangedTask` 校验响应后不再直接复制 thread/map，而是 enqueue `ChannelTaskStreamPatch`。请求开始时记录 `${conversationId}:${taskId} -> lastSeq`，相同或更小目标 seq 直接视为已处理；请求失败或缺口时删除记录并返回 `false`，让既有 full refresh 回退接管。

- [ ] **Step 4: 绑定可见性和清理**

组件挂载时使用浏览器 `requestAnimationFrame`、`setTimeout` 和 `document.visibilityState` 创建 batcher；监听 `visibilitychange` 调用 `notifyVisibilityChanged()`；卸载时移除监听并 `dispose()`。

- [ ] **Step 5: 运行增量、缺口和轮询测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/channels/channels-page-client.test.tsx -t "task stream|thread change|poll"`

Expected: 增量更新、缺口 full refresh、轮询补偿全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "按动画帧合并会话流式更新"
```

### Task 4: 完善 disclosure、长输出完整度和状态播报

**Files:**
- Modify: `apps/web/features/chat/chat-primitives.tsx:144-289,479-545`
- Modify: `apps/web/features/chat/chat-primitives.test.tsx:22-112`

- [ ] **Step 1: 写错误默认展开和完整度测试**

```tsx
expect(screen.getByText("执行失败").closest("details")).toHaveAttribute("open");
expect(screen.getByText("已显示 16000 / 17000 字符")).toBeInTheDocument();
```

再用 `rerender` 更新同一 id 的 detail，验证用户主动收起后仍保持收起；普通 tool 默认仍折叠。任务级 live region 只包含“执行中/失败/完成”，不得包含 detail 或 token 文本：

```tsx
expect(screen.getByRole("status")).toHaveTextContent("任务正在执行");
expect(screen.getByRole("status")).not.toHaveTextContent("第一行");
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/chat/chat-primitives.test.tsx -t "TaskExecutionTimeline"`

Expected: error 没有默认 open，详情没有完整度文字。

- [ ] **Step 3: 实现默认状态和完整度**

将 row 初始状态改为：

```tsx
const [expanded, setExpanded] = useState(item.kind === "error");
```

`ExecutionDetailSection` 在内容超过 chunk 时显示：

```tsx
<span className="execution-timeline__completeness">
  {tx(`已显示 ${Math.min(visibleCharacters, content.length)} / ${content.length} 字符`,
      `Showing ${Math.min(visibleCharacters, content.length)} / ${content.length} characters`)}
</span>
```

为 `ExecutionDetailSection` 增加 `tx: (zh: string, en: string) => string` 参数，并在三个调用点传入当前 `useLanguage()` 返回的 `tx`；不得把原始 payload 放进 aria-live。

`TaskExecutionTimeline` 使用一次任务级播报：

```tsx
const { tx } = useLanguage();
const announcement = running
  ? tx("任务正在执行", "Task in progress")
  : items.some((item) => item.status === "error")
    ? tx("任务执行失败", "Task failed")
    : tx("任务已完成", "Task completed");

<span aria-live="polite" className="sr-only" role="status">{announcement}</span>
```

时间线 row、detail、completeness 和每次正文增量均不添加 `aria-live`。

- [ ] **Step 4: 将运行中正文改为稳定 caret**

为 execution reply 增加 `data-streaming={message.executionRunning || undefined}`，并在 `ChatMessageContent` 后渲染固定节点：

```tsx
{message.executionRunning ? <span aria-hidden="true" className="execution-stream-caret" /> : null}
```

删除会引起宽度变化的正文尾部三点 loading；CSS 为 caret 设置固定 `0.5rem` 宽度，不改变正文容器尺寸。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/chat/chat-primitives.test.tsx`

Expected: 全文件 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "完善执行节点展开与长输出提示"
```

### Task 5: 收敛滚动跟随和低干扰动效

**Files:**
- Modify: `apps/web/features/chat/conversation-shell.tsx:425-486,595-622,1169-1207`
- Modify: `apps/web/features/chat/conversation-shell.test.tsx:355-477`
- Modify: `apps/web/app/globals.css:1638-1670,5951-6205`

- [ ] **Step 1: 写 24px 边界测试**

构造 `scrollHeight=1200`、`clientHeight=300`：`scrollTop=877` 时距底部 23px，应跟随；`scrollTop=875` 时距底部 25px，应保持位置并显示“有新输出”。同时验证点击按钮后恢复 follow mode。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/chat/conversation-shell.test.tsx -t "24px|new output|reading position"`

Expected: 25px 场景因当前 64px 阈值仍自动跟随而 FAIL。

- [ ] **Step 3: 统一 follow threshold 和文案**

在 `conversation-shell.tsx` 定义：

```ts
const CONVERSATION_FOLLOW_THRESHOLD_PX = 24;
```

保存锚点、scroll handler 和消息变化判断均使用该常量。按钮文案从“有新消息”改为“有新输出”，aria-label 同步为“有新输出，回到最新内容”。点击使用 `scrollTo({ top: scrollHeight, behavior: reducedMotion ? "auto" : "smooth" })`，测试环境没有 `scrollTo` 时保留直接赋值回退。

- [ ] **Step 4: 调整动效与尺寸**

将 running row sweep 调整为 `2.6s ease-in-out infinite`，移除 spinner rotation，使用静态 running dot；detail 保持 `max-height: 16rem; overflow: auto`，completeness 和 load-more 固定在 detail 下方。添加：

```css
@media (prefers-reduced-motion: reduce) {
  .execution-timeline--running .execution-timeline__item[data-state="running"] > summary::after,
  .execution-stream-caret {
    animation: none;
  }
}
```

- [ ] **Step 5: 运行 chat 回归**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/chat/conversation-shell.test.tsx features/chat/chat-primitives.test.tsx features/chat/task-execution-timeline.test.ts`

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "优化流式输出滚动与运行反馈"
```

### Task 6: 浏览器回归正确回复和 DSH 风格展示

**Files:**
- Modify: `apps/web/e2e/workspace-navigation.spec.ts`
- Modify: `docs/0825/im-uiux/05-全站间距与稳定流式反馈.md`

- [ ] **Step 1: 补充自动化浏览器断言**

在现有 IM 浏览器测试中增加：执行轨迹行可通过 summary 展开/收起；正文与过程节点处于同一 reading unit；390px 和 1440px 无横向溢出；离开底部后新增内容出现“有新输出”且不改变 `scrollTop`。

- [ ] **Step 2: 运行窄范围 E2E**

Run: `pnpm --filter @dofe-agent/web exec playwright test e2e/workspace-navigation.spec.ts --workers=1 -g "message bubbles|execution timeline|new output"`

Expected: 相关场景 PASS；缺少测试数据库时记录环境限制。

- [ ] **Step 3: 使用 `browser-testing-with-devtools` 做真实账户回归**

登录优惠豚本地/测试账户，进入 IM 后发送一个要求分阶段执行且会产生 reasoning、Bash/tool 和最终明确短语的请求。验证：

- 最终回复内容正确，不被可恢复错误替换；
- reasoning/tool/status 与最终正文层级和顺序与 DSH 展示一致；
- 连续流式期间节点位置稳定，展开/收起不被重置；
- 向上阅读时不抢滚动，点击“有新输出”后恢复；
- 控制台无 runtime error，增量请求无异常 4xx/5xx，SSE 断线后能通过 polling/full refresh 收敛；
- 390px、768px、1440px 下无横向滚动、输入区遮挡或长文本溢出。

- [ ] **Step 4: 遇到问题时执行失败测试—修复—回归闭环**

每个浏览器问题先落为 Vitest 或 Playwright 失败断言，再修改最小相关模块，运行该测试和 Task 5 的 chat 回归；一个独立修复验证后立即中文提交。

- [ ] **Step 5: 更新证据并提交**

```bash
git add -A
git commit -m "补充即时通信流式体验回归证据"
```

### Task 7: 同步 Agent 项目统计目录

**Files:**
- Modify: `../new-agents.dofe.ai/docs/0825/im-uiux/README.md`

- [ ] **Step 1: 重新检查目标仓库状态**

Run: `git -C ../new-agents.dofe.ai status --short`

Expected: 识别并保留目标仓库现有用户改动；只编辑和暂存本任务拥有的 IM 文档。

- [ ] **Step 2: 追加本轮同步记录**

在现有“2026-08-25 前端视觉与移动端体验优化”之后增加 agentspace 对应提交、24/16/12/8 页面节奏、稳定帧批处理、24px follow threshold、浏览器验证结论和仍由两项目分别承担的边界。不得覆盖该仓库已记录的 React Query/WebSocket 或自身 `ux-refresh.css` 实现。

- [ ] **Step 3: 检查差异并提交目标仓库**

Run: `git -C ../new-agents.dofe.ai diff --check -- docs/0825/im-uiux/README.md`

Expected: 无 whitespace 错误。

```bash
git -C ../new-agents.dofe.ai add docs/0825/im-uiux/README.md
git -C ../new-agents.dofe.ai commit -m "同步全站间距与流式输出优化记录"
```

目标仓库存在其他未提交文件时，不把它们加入本次提交。是否 push 以用户对本轮任务的明确授权和目标仓库规则为准，不借同步文档发布其他人的改动。

- [ ] **Step 4: 最终验证当前仓库状态**

Run: `git status --short && git log -8 --oneline`

Expected: 当前仓库无本任务未提交改动；提交历史按独立交付项拆分且均为中文。
