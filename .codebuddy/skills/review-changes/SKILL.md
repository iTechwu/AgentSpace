---
name: review-changes
description: 使用变更检测和影响分析进行结构化代码审查
---

## 审查变更

使用知识图谱执行全面的、风险感知的代码审查。

### 步骤

1. 运行 `detect_changes_tool` 获取带风险评分的变更分析。
2. 运行 `get_affected_flows_tool` 查找受影响的执行路径。
3. 对每个高风险函数，运行 `query_graph_tool`，pattern="tests_for" 检查测试覆盖。
4. 运行 `get_impact_radius_tool` 了解影响范围。
5. 对任何未经测试的变更，建议具体的测试用例。

### 输出格式

按风险级别（高/中/低）分组提供审查结果，包含：
- 变更内容及其影响
- 测试覆盖状态
- 改进建议
- 整体合并建议

## Token 效率规则
- 在使用任何其他图谱工具之前，始终先执行 `get_minimal_context(task="<你的任务>")`。
- 所有调用使用 `detail_level="minimal"`。仅当 minimal 不足时升级为 "standard"。
- 目标：在 ≤5 次工具调用且 ≤800 总输出 token 内完成任何 review/debug/refactor 任务。
