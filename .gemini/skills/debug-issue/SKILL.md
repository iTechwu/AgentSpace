---
name: debug-issue
description: 使用知识图谱驱动的代码导航系统性调试问题
---

## 调试问题

使用知识图谱系统性追踪和调试问题。

### 步骤

1. 使用 `semantic_search_nodes_tool` 查找与问题相关的代码。
2. 使用 `query_graph_tool` 的 `callers_of` 和 `callees_of` 追踪调用链。
3. 使用 `get_flow` 查看经过可疑区域的完整执行路径。
4. 运行 `detect_changes_tool` 检查最近的变更是否导致了该问题。
5. 对可疑文件使用 `get_impact_radius_tool` 查看还有哪些地方受影响。

### 技巧

- 同时检查调用方和被调用方以理解完整上下文。
- 查看受影响的流程，找到触发 bug 的入口点。
- 最近的变更是新问题最常见的来源。

## Token 效率规则
- 在使用任何其他图谱工具之前，始终先执行 `get_minimal_context(task="<你的任务>")`。
- 所有调用使用 `detail_level="minimal"`。仅当 minimal 不足时升级为 "standard"。
- 目标：在 ≤5 次工具调用且 ≤800 总输出 token 内完成任何 review/debug/refactor 任务。
