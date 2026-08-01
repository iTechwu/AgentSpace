# Round 04 - Full non-Web checks, build, and environment validation

- Completed: 2026-08-01 02:07:53 +0800
- Scope: Node test inventory, production build, type checks, lint, and E2E/UI prerequisites

## Automated results

- Node test inventory: 136 files, 1,122 tests; 691 passed, 69 skipped, 362 failed.
- The failures are dominated by the sandbox rejecting local PostgreSQL connections (`connect EPERM 127.0.0.1:5432`). Attachment persistence assertions are secondary symptoms of that same missing database access.
- Four live Feishu smoke tests fail because the sandbox rejects local listener creation (`listen EPERM 127.0.0.1`).
- A runtime-health file was included in the raw Node inventory even though it imports Vitest; it must be run by the Web/Vitest command, not directly by Node.
- Hermes/Antigravity router tests mutate process-global environment variables and are order-sensitive when collected together. The Hermes diagnostics test passes when run by name in isolation; no product code change was made for this test-harness issue.

## Build and static checks

- `pnpm run build`: passed. This included dependency type builds, daemon build, and Next production build.
- `pnpm run typecheck`: passed for domain, db, services, sandbox, Web, CLI, and daemon.
- `pnpm run lint:web`: passed with zero warnings.
- `git diff --check`: passed.

## Browser/E2E availability

- Playwright configuration refused to start without `DOFE_AGENT_TEST_DATABASE_URL` or `DOFE_AGENT_PG_TEST_URL`.
- Starting the local Web server on port 1455 was rejected by the execution sandbox with `listen EPERM`.
- The local hostnames `agentspace.local.dofe.ai` and `model.local.dofe.ai` were unreachable during baseline checks, and Docker socket access was denied. Jenkins was not started or triggered, per workstation policy.

## Conclusion

All application-level Web regressions found in Round 01 are fixed and the production build is green. Further login/page traversal requires a permitted local service environment with PostgreSQL, a reachable AgentSpace instance, and a configured E2E database URL. The environment restrictions prevent a truthful UI sign-in test in this run; this is recorded as an execution blocker rather than a pass.
