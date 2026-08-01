# Round 05 - macOS path portability correction

- Completed: 2026-08-01 02:11:48 +0800
- Scope: non-database failures that remained after the Node inventory

## Finding and change

Two storage-path test files compared paths built from the `/var` spelling returned by `tmpdir()` with implementation paths normalized by `resolve()` to `/private/var` on macOS. The paths refer to the same directory, but strict string comparisons failed. The tests now use `realpathSync(tempRoot)` for expected paths:

- `packages/db/src/storage-paths.test.ts`
- `packages/services/src/shared/conversation-execution-workspaces.test.ts`

No runtime behavior changed.

## Verification

- Storage-path tests: 2/2 passed.
- Conversation execution workspace tests: 5/5 passed.
- Local sandbox stdin test: 1/1 passed.

The remaining Node-inventory failures are database/listener environment failures or test-runner global-environment races (Hermes/Antigravity tests). They are documented in Round 04.
