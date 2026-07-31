---
name: explore-codebase
description: 使用知识图谱导航和理解代码库结构
---

## 探索代码库

使用 code-review-graph MCP 工具探索和理解代码库。

### 步骤

1. 运行 `list_graph_stats` 查看代码库整体指标。
2. 运行 `get_architecture_overview_tool` 获取高层级社区结构。
3. 使用 `list_communities_tool` 查找主要模块，然后用 `get_community` 查看详情。
4. 使用 `semantic_search_nodes_tool` 查找特定的函数或类。
5. 使用 `query_graph_tool` 的 `callers_of`、`callees_of`、`imports_of` 等模式追踪关系。
6. 使用 `list_flows` 和 `get_flow` 理解执行路径。

### 技巧

- 从宏观入手（统计信息、架构），然后聚焦到具体区域。
- 对文件使用 `children_of` 查看其所有函数和类。
- 使用 `find_large_functions` 识别复杂代码。

## Token 效率规则
- 在使用任何其他图谱工具之前，始终先执行 `get_minimal_context(task="<你的任务>")`。
- 所有调用使用 `detail_level="minimal"`。仅当 minimal 不足时升级为 "standard"。
- 目标：在 ≤5 次工具调用且 ≤800 总输出 token 内完成任何 review/debug/refactor 任务。
