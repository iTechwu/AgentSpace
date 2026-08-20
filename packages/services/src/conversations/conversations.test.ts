import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationSummary } from "./conversations.ts";

test("buildConversationSummary 去掉 Markdown 标题/列表/换行并截断到 60 字", () => {
  assert.equal(buildConversationSummary("## 优化视频脚本\n\n下面是详细步骤"), "优化视频脚本");
  assert.equal(buildConversationSummary("- 排查模型流式响应中断"), "排查模型流式响应中断");
  assert.equal(buildConversationSummary("整理季度销售数据并输出趋势"), "整理季度销售数据并输出趋势");
  assert.equal(buildConversationSummary("   "), "新会话");
  assert.ok(buildConversationSummary("长".repeat(100)).length <= 60);
  assert.ok(buildConversationSummary("长".repeat(100)).endsWith("..."));
});
