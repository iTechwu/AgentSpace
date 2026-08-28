---
name: refactor-safely
description: 使用依赖分析规划和执行安全重构
---

## 安全重构

使用知识图谱自信地规划和执行重构。

### 步骤

1. 使用 `refactor_tool`，mode="suggest" 获取社区驱动的重构建议。
2. 使用 `refactor_tool`，mode="dead_code" 查找未被引用的代码。
3. 对于重命名，使用 `refactor_tool`，mode="rename" 预览所有受影响的位置。
4. 使用 `apply_refactor_tool` 并传入 refactor_id 来应用重命名。
5. 变更后，运行 `detect_changes_tool` 验证重构影响。

### 安全检查

- 应用前始终预览（rename 模式会给出编辑列表）。
- 重大重构前检查 `get_impact_radius_tool`。
- 使用 `get_affected_flows_tool` 确保没有关键路径被破坏。
- 运行 `find_large_functions` 识别可分解的目标。

## Token 效率规则
- 在使用任何其他图谱工具之前，始终先执行 `get_minimal_context(task="<你的任务>")`。
- 所有调用使用 `detail_level="minimal"`。仅当 minimal 不足时升级为 "standard"。
- 目标：在 ≤5 次工具调用且 ≤800 总输出 token 内完成任何 review/debug/refactor 任务。
