<!-- code-review-graph MCP tools -->
## Test Resource Limits

For pnpm, Turbo, and Jest monorepos, the root `test` script must use `turbo run test --concurrency=2`, and the API package `test` script must use `jest --passWithNoTests --maxWorkers=2`.

- Do not run an unconstrained `pnpm test` command; prefer the smallest relevant test.
- For a single API Jest file, use `pnpm --filter @repo/api exec jest path/to/file.spec.ts --runInBand`.
- A full test run must pass `--maxWorkers=2`, for example `pnpm test -- --maxWorkers=2`.

## Test Environment Deployment

For every test-environment defect fix in this repository, use this order:

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
