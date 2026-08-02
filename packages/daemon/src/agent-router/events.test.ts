import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeEventMapperState, createCodexEventMapperState, createNarrationDedupEmitter, mapClaudeNativeEvent, mapCodexNativeEvent } from "./events.ts";

test("mapClaudeNativeEvent expands assistant text and tool_use blocks into separate events", () => {
  const state = createClaudeEventMapperState();
  const mapped = mapClaudeNativeEvent(
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "我先搜索相关代码。" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "grep -n seedance -r src" } },
          { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "src/a.ts" } },
        ],
      },
    },
    state,
  );

  assert.deepEqual(mapped, [
    { type: "narration_delta", text: "我先搜索相关代码。" },
    { type: "tool_started", tool: "Bash", title: "Bash", input: { command: "grep -n seedance -r src" }, toolUseId: "toolu_1" },
    { type: "tool_started", tool: "Read", title: "Read", input: { file_path: "src/a.ts" }, toolUseId: "toolu_2" },
  ]);
  assert.equal(state.toolNameByUseId.get("toolu_1"), "Bash");
  assert.equal(state.toolNameByUseId.get("toolu_2"), "Read");
});

test("mapClaudeNativeEvent attributes user tool_result blocks to the original tool", () => {
  const state = createClaudeEventMapperState();
  state.toolNameByUseId.set("toolu_1", "Bash");

  const mapped = mapClaudeNativeEvent(
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "src/a.ts:3:seedance" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "unknown tool output", is_error: true },
        ],
      },
    },
    state,
  );

  assert.deepEqual(mapped, [
    { type: "tool_output", tool: "Bash", output: "src/a.ts:3:seedance", toolUseId: "toolu_1" },
    { type: "tool_finished", tool: "Bash", status: "completed", toolUseId: "toolu_1" },
    { type: "tool_output", tool: "tool", output: "unknown tool output", toolUseId: "toolu_2" },
    { type: "tool_finished", tool: "tool", status: "failed", toolUseId: "toolu_2" },
  ]);
});

test("mapClaudeNativeEvent surfaces thinking blocks as thought deltas", () => {
  const mapped = mapClaudeNativeEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "先确认日期时区" }],
    },
  });

  assert.deepEqual(mapped, [{ type: "thought_delta", text: "先确认日期时区" }]);
});

test("mapClaudeNativeEvent keeps the legacy assistant text fallback for non-array content", () => {
  const mapped = mapClaudeNativeEvent({
    type: "assistant",
    message: { role: "assistant", content: "plain text reply" },
  });

  assert.deepEqual(mapped, [{ type: "narration_delta", text: "plain text reply" }]);
});

test("mapCodexNativeEvent maps non-final agent_message items to narration and final ones to text", () => {
  const narration = mapCodexNativeEvent({
    type: "item.completed",
    item: { id: "am-1", type: "agent_message", text: "先确认日期时区。" },
  });
  assert.deepEqual(narration, [{ type: "narration_delta", text: "先确认日期时区。" }]);

  const finalAnswer = mapCodexNativeEvent({
    type: "item.completed",
    item: { id: "am-2", type: "agent_message", text: "最终答复", phase: "final_answer" },
  });
  assert.deepEqual(finalAnswer, [{ type: "text_delta", text: "最终答复" }]);
});

test("createNarrationDedupEmitter holds narration and drops a duplicated final answer", () => {
  const emitted: Array<{ type: string; text?: string }> = [];
  const emitter = createNarrationDedupEmitter((event) => {
    emitted.push(event as { type: string; text?: string });
  });

  emitter.emit({ type: "narration_delta", text: "第一段旁白" });
  emitter.emit({ type: "tool_started", tool: "Bash" });
  emitter.emit({ type: "narration_delta", text: "最终答复" });
  emitter.emit({ type: "text_delta", text: "最终答复" });
  emitter.flush();

  assert.deepEqual(emitted, [
    { type: "narration_delta", text: "第一段旁白" },
    { type: "tool_started", tool: "Bash" },
    { type: "text_delta", text: "最终答复" },
  ]);
});

test("createNarrationDedupEmitter flushes held narration when nothing duplicates it", () => {
  const emitted: Array<{ type: string; text?: string }> = [];
  const emitter = createNarrationDedupEmitter((event) => {
    emitted.push(event as { type: string; text?: string });
  });

  emitter.emit({ type: "narration_delta", text: "旁白" });
  emitter.flush("完全不同的最终答复");

  assert.deepEqual(emitted, [{ type: "narration_delta", text: "旁白" }]);
});

test("mapCodexNativeEvent maps web_search items to tool events with the query", () => {
  const started = mapCodexNativeEvent({
    type: "item.started",
    item: { id: "ws-1", type: "web_search", query: "GitHub Trending" },
  });
  assert.deepEqual(started, [
    {
      type: "tool_started",
      tool: "web_search",
      title: "web search: GitHub Trending",
      input: { query: "GitHub Trending" },
      toolUseId: "ws-1",
    },
  ]);

  const completed = mapCodexNativeEvent({
    type: "item.completed",
    item: { id: "ws-1", type: "web_search", query: "GitHub Trending" },
  });
  assert.deepEqual(completed, [
    { type: "tool_output", tool: "web_search", output: "GitHub Trending", toolUseId: "ws-1" },
    { type: "tool_finished", tool: "web_search", status: "completed", toolUseId: "ws-1" },
  ]);
});

test("mapCodexNativeEvent synthesizes the start event for completion-only items when stateful", () => {
  const state = createCodexEventMapperState();
  const completed = mapCodexNativeEvent(
    { type: "item.completed", item: { id: "ws-9", type: "web_search", query: "Product Hunt" } },
    state,
  );
  assert.deepEqual(completed, [
    {
      type: "tool_started",
      tool: "web_search",
      title: "web search: Product Hunt",
      input: { query: "Product Hunt" },
      toolUseId: "ws-9",
    },
    { type: "tool_output", tool: "web_search", output: "Product Hunt", toolUseId: "ws-9" },
    { type: "tool_finished", tool: "web_search", status: "completed", toolUseId: "ws-9" },
  ]);

  // A completion for an item whose start was seen must NOT synthesize another start.
  mapCodexNativeEvent({ type: "item.started", item: { id: "ws-8", type: "web_search", query: "x" } }, state);
  const completedSeen = mapCodexNativeEvent(
    { type: "item.completed", item: { id: "ws-8", type: "web_search", query: "x" } },
    state,
  );
  assert.deepEqual(completedSeen, [
    { type: "tool_output", tool: "web_search", output: "x", toolUseId: "ws-8" },
    { type: "tool_finished", tool: "web_search", status: "completed", toolUseId: "ws-8" },
  ]);
});

test("mapCodexNativeEvent surfaces unknown completed items with text as narration", () => {
  const mapped = mapCodexNativeEvent({
    type: "item.completed",
    item: { id: "x-1", type: "future_item_type", text: "某种未来事件的内容" },
  });
  assert.deepEqual(mapped, [{ type: "narration_delta", text: "某种未来事件的内容" }]);
});

test("mapCodexNativeEvent maps mcp_tool_call items with server and tool name", () => {
  const started = mapCodexNativeEvent({
    type: "item.started",
    item: { id: "mcp-1", type: "mcp_tool_call", server_label: "fetch", tool: "fetch_url", arguments: { url: "https://example.com" } },
  });
  assert.deepEqual(started, [
    {
      type: "tool_started",
      tool: "fetch.fetch_url",
      title: "fetch.fetch_url",
      input: { url: "https://example.com" },
      toolUseId: "mcp-1",
    },
  ]);

  const completed = mapCodexNativeEvent({
    type: "item.completed",
    item: { id: "mcp-1", type: "mcp_tool_call", server_label: "fetch", tool: "fetch_url", result: { content: "ok" } },
  });
  assert.deepEqual(completed, [
    { type: "tool_output", tool: "fetch.fetch_url", output: "{\"content\":\"ok\"}", toolUseId: "mcp-1" },
    { type: "tool_finished", tool: "fetch.fetch_url", status: "completed", toolUseId: "mcp-1" },
  ]);

  const failed = mapCodexNativeEvent({
    type: "item.completed",
    item: { id: "mcp-2", type: "mcp_tool_call", server_label: "fetch", tool: "fetch_url", error: { message: "403 Forbidden" } },
  });
  assert.deepEqual(failed, [
    { type: "tool_output", tool: "fetch.fetch_url", output: "403 Forbidden", toolUseId: "mcp-2" },
    { type: "tool_finished", tool: "fetch.fetch_url", status: "failed", toolUseId: "mcp-2" },
  ]);
});

test("mapCodexNativeEvent maps completed reasoning items to thought deltas", () => {
  const completed = mapCodexNativeEvent({
    type: "item.completed",
    item: { id: "r-1", type: "reasoning", text: ["先确认日期时区", "然后并行检索"] },
  });
  assert.deepEqual(completed, [{ type: "thought_delta", text: "先确认日期时区\n然后并行检索" }]);

  const started = mapCodexNativeEvent({
    type: "item.started",
    item: { id: "r-1", type: "reasoning", text: [] },
  });
  assert.deepEqual(started, []);
});

test("mapCodexNativeEvent accepts camelCase item type aliases", () => {
  const started = mapCodexNativeEvent({
    type: "item.started",
    item: { id: "ws-2", type: "webSearch", query: "Product Hunt" },
  });
  assert.equal(started[0]?.type, "tool_started");
  assert.equal(started[0]?.type === "tool_started" ? started[0].tool : undefined, "web_search");
});
