# 2026-08-03 全系统测试结果

本目录记录基于 `docs/0803/test` 的本地/测试环境执行结果。测试使用仓库约定的测试管理员账号，报告和证据不包含密码、Cookie、Token 或 Secret。

## 结果索引

| 文件 | 内容 |
| --- | --- |
| [2026-08-03-全系统测试报告.md](./2026-08-03-全系统测试报告.md) | 环境、覆盖、自动化结果、阻塞项和准出结论 |
| [2026-08-03-用例执行结果.md](./2026-08-03-用例执行结果.md) | 按 160 条测试矩阵统计直接关闭与阻塞范围 |
| [2026-08-03-缺陷清单.md](./2026-08-03-缺陷清单.md) | 本轮发现的问题、等级、复现和证据 |
| [playwright-results.json](./playwright-results.json) | Playwright 单 worker 结构化结果 |
| [playwright-results-workers2.json](./playwright-results-workers2.json) | Playwright 两 worker 结构化结果 |
| [evidence](./evidence/) | 已脱敏的真实账号与页面截图 |
| [playwright-artifacts](./playwright-artifacts/) | 单 worker 失败截图和 error context |

所有浏览器 trace 均已删除，因为 trace 可能包含表单值、Cookie 或其他会话元数据。结果目录只保留结构化结果、失败上下文和脱敏截图。
