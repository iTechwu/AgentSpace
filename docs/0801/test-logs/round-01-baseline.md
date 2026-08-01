# Round 01 - Baseline

- Started: 2026-08-01 01:30 +08:00
- Recorded: 2026-08-01 01:35:32 +08:00
- Scope: AgentSpace type checking, lint, and the complete Web Vitest suite.
- Constraints: maximum 2 Vitest workers; no Jenkins; Docker socket unavailable in the current sandbox.

## Results

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| ESLint baseline | Failed with 3 unused imports/variables |
| ESLint after cleanup | Passed |
| Web Vitest | 78/93 files passed; 551/688 tests passed |

## Changes

Removed three unused bindings from the employee action implementation and tests. These were lint-only blockers and did not change behavior.

## Failure classification

- Environment-blocked: 11 files and 109 tests could not connect to PostgreSQL because the sandbox rejected `127.0.0.1:5432` with `EPERM`.
- Product/test regressions: 28 tests across the employee page, workspace settings route, skill editor, and chat model search.
- SDK noise: `@dofe/models-sdk@0.5.3` publishes source maps whose source files are absent. This is noisy but did not fail tests.

## Next round

Run the four non-database failing files independently, fix shared root causes, then rerun them before returning to the full suite.
