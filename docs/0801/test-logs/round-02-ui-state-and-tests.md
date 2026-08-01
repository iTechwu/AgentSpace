# Round 02 - UI State and Test Alignment

- Started: 2026-08-01 01:36 +08:00
- Completed: 2026-08-01 01:46:46 +08:00
- Scope: 28 non-database failures from Round 01.

## Root causes and changes

1. AI employee detail tabs were controlled only by URL state. Added immediate local tab state while preserving URL synchronization, so tab content changes without waiting for route-state hydration.
2. Feishu Bot App ID blur validation temporarily disabled the entire form and dropped the first App Secret character. Availability checks now run in the background without locking the form; final submission remains protected by pending state.
3. The shared dialog focus fallback could override an asynchronously mounted `autoFocus` input. It now leaves focus alone when an element inside the dialog already owns it.
4. Workspace settings route tests did not mock the newly consumed runtime-mode resolver. Added the local-mode mock.
5. Skill tests expected the previous always-editing UI and English preset label. Updated assertions to the intentional preview-first UI and current localized preset catalog.
6. Feishu Bot tests did not mock the new binding-availability check. Added the `available` response and transfer field assertion.

## Verification

| Target | Result |
| --- | --- |
| Employee management page | 54/54 passed |
| Settings route and skill page focused suite | Passed |
| Chat model selector and shared dialog regressions | 18/18 passed |

## Remaining work

Rerun the complete Web suite. Database-backed tests remain subject to the sandbox PostgreSQL restriction.
