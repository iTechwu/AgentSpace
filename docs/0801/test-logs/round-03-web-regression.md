# Round 03 - Web full regression

- Completed: 2026-08-01 01:50:43 +0800
- Scope: all Web Vitest suites with at most two workers
- Command: `pnpm --filter @dofe-agent/web exec vitest run --maxWorkers=2`

## Result

- Test files: 93 total, 78 passed, 15 failed
- Tests: 688 total, 579 passed, 109 failed
- Product/test regressions found in Round 01: 28
- Product/test regressions remaining: 0

All 109 remaining failures are caused by the execution sandbox rejecting PostgreSQL connections to `127.0.0.1:5432` with `EPERM`. They are limited to the database-backed suites below:

- `features/agents/direct-channel-cleanup.test.ts`
- `features/auth/server-workspace.test.ts`
- `features/auth/sso-workspaces.test.ts`
- `features/dashboard/core-storage-reconciliation.test.ts`
- `features/dashboard/data.test.ts`
- `features/dashboard/workspace-state-versioning.test.ts`
- `app/api/daemon/client.integration.test.ts`
- `app/api/daemon/routes.test.ts`
- `app/api/search/route.test.ts`
- `app/api/workspace-context/route.test.ts`
- `app/api/attachments/[attachmentId]/route.test.ts`

## Verification conclusion

The 28 non-database failures observed in Round 01 are fixed. No new application-level failure was found in the full Web regression. The remaining database-backed cases require an execution environment that permits access to the local PostgreSQL service; they are not being marked as product passes.
