<!-- code-review-graph MCP tools -->
## Git 提交约定

每次完成修改（实现、修复、重构、文档更新等）后，立即实施 git 提交。

- 提交时机：一个可独立交付的改动完成并验证后即提交，不要攒多个任务一起提交。
- commit message 必须使用中文，简洁描述本次改动做了什么。
- 提交前先 `git add -A` 纳入所有相关改动，不要遗漏新文件。
- 不要随意 push，除非用户明确要求。

## Test Resource Limits

For pnpm, Turbo, and Jest monorepos, the root `test` script must use `turbo run test --concurrency=2`, and the API package `test` script must use `jest --passWithNoTests --maxWorkers=2`.

- Do not run an unconstrained `pnpm test` command; prefer the smallest relevant test.
- For a single API Jest file, use `pnpm --filter @repo/api exec jest path/to/file.spec.ts --runInBand`.
- A full test run must pass `--maxWorkers=2`, for example `pnpm test -- --maxWorkers=2`.

## Shared Deployment Infrastructure

- In every deployment change, Dockerfiles and Docker Compose files must not create, run, or embed PostgreSQL, Redis, or RabbitMQ services.
- Do not add service definitions, images, containers, initialization jobs, or persistent volumes for these dependencies.
- PostgreSQL, Redis, and RabbitMQ are centrally managed by `../docker-helm.dofe.ai`; application deployments must connect to those externally managed services through configuration.

## Local Jenkins Prohibition

On this workstation, Jenkins is not a deployment path for `models.dofe.ai` or `AgentSpace`.

- Never start a local Jenkins server or Jenkins container for either project.
- Never trigger a local or remote Jenkins job for either project from this workstation.
- Do not attempt to satisfy test-environment deployment requirements by installing, starting, or configuring Jenkins locally.
- Local work stops after implementation, validation, and any explicitly requested commit/push. Report deployment as not performed unless the user supplies a separate, non-Jenkins deployment workflow.

This section takes precedence over the test-environment deployment workflow below when operating on this workstation.

## Test Environment Deployment

The following workflow applies only when operating in the designated CI/test environment. It does not authorize Jenkins use from this workstation.

For every test-environment defect fix deployed from that designated environment, use this order:

1. Make and validate the change locally in `../agentspace.dofe.ai`.
2. Commit the validated change and push it to the intended branch.
3. Trigger the matching CI Jenkins deployment from that pushed commit.
4. Monitor the Jenkins build and deployed service health until they reach a conclusive success or failure state.

Do not deploy uncommitted local work or bypass the CI Jenkins deployment path for test-environment fixes.

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.

## Test Administrator Account

Use this account only for local or test-environment UI verification. Never use it against production or unrelated external systems.

- Mobile: `13800138000`
- Password: `!QAZxdr5`
