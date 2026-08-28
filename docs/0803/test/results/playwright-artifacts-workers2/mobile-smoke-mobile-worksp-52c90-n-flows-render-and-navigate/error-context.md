# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-smoke.spec.ts >> mobile workspace drill-down flows render and navigate
- Location: e2e/mobile-smoke.spec.ts:8:1

# Error details

```
Error: PostgreSQL schema migration lock is busy after 9000ms. Another DofeAgent process may be initializing schema version 100; wait for it to finish or stop the stale process before rerunning the command.
```

# Test source

```ts
  695 | export function readMetadataValue(db: PostgresSyncDatabase, key: string): string | undefined {
  696 |   const row = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key) as { value: string } | undefined;
  697 |   return row?.value;
  698 | }
  699 |
  700 | export function randomLikeId(): string {
  701 |   return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  702 | }
  703 |
  704 | export function resolveRepositoryRoot(): string {
  705 |   const candidates = [
  706 |     process.env.DOFE_AGENT_REPOSITORY_ROOT,
  707 |     /*turbopackIgnore: true*/ process.cwd(),
  708 |     join(/*turbopackIgnore: true*/ process.cwd(), ".."),
  709 |     join(/*turbopackIgnore: true*/ process.cwd(), "..", ".."),
  710 |   ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  711 |
  712 |   for (const candidate of candidates) {
  713 |     const resolved = resolve(candidate);
  714 |     if (existsSync(/*turbopackIgnore: true*/ join(resolved, "Target.md"))) {
  715 |       return resolved;
  716 |     }
  717 |   }
  718 |
  719 |   return /*turbopackIgnore: true*/ process.cwd();
  720 | }
  721 |
  722 | function ensureRuntimeSchema(db: PostgresSyncDatabase): void {
  723 |   const currentUrl = databaseUrl;
  724 |   if (!currentUrl || schemaEnsuredForUrl === currentUrl) {
  725 |     return;
  726 |   }
  727 |
  728 |   let transactionStarted = false;
  729 |   acquireRuntimeSchemaLock(db);
  730 |   try {
  731 |     if (schemaEnsuredForUrl === currentUrl || isRuntimeSchemaCurrent(db)) {
  732 |       schemaEnsuredForUrl = currentUrl;
  733 |       return;
  734 |     }
  735 |     db.exec("BEGIN");
  736 |     transactionStarted = true;
  737 |     for (const statement of getPostgresSchemaStatements()) {
  738 |       db.exec(statement);
  739 |     }
  740 |     db.prepare(
  741 |       `INSERT INTO app_metadata (key, value)
  742 |        VALUES (?, ?)
  743 |        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
  744 |     ).run("schema_version", POSTGRES_SCHEMA_VERSION);
  745 |     seedDefaultWorkspace(db);
  746 |     db.exec("COMMIT");
  747 |     transactionStarted = false;
  748 |     schemaEnsuredForUrl = currentUrl;
  749 |   } catch (error) {
  750 |     if (transactionStarted) {
  751 |       db.exec("ROLLBACK");
  752 |     }
  753 |     throw error;
  754 |   } finally {
  755 |     db.prepare("SELECT pg_advisory_unlock(?)").get(POSTGRES_SCHEMA_VERSION);
  756 |   }
  757 | }
  758 |
  759 | interface RuntimeSchemaLockOptions {
  760 |   timeoutMs?: number;
  761 |   retryMs?: number;
  762 |   now?: () => number;
  763 |   sleep?: (durationMs: number) => void;
  764 | }
  765 |
  766 | export function acquireRuntimeSchemaLockForTests(
  767 |   db: Pick<PostgresSyncDatabase, "prepare">,
  768 |   options: RuntimeSchemaLockOptions = {},
  769 | ): { attempts: number } {
  770 |   return acquireRuntimeSchemaLock(db, options);
  771 | }
  772 |
  773 | function acquireRuntimeSchemaLock(
  774 |   db: Pick<PostgresSyncDatabase, "prepare">,
  775 |   options: RuntimeSchemaLockOptions = {},
  776 | ): { attempts: number } {
  777 |   const timeoutMs = options.timeoutMs ?? POSTGRES_SCHEMA_LOCK_TIMEOUT_MS;
  778 |   const retryMs = options.retryMs ?? POSTGRES_SCHEMA_LOCK_RETRY_MS;
  779 |   const now = options.now ?? Date.now;
  780 |   const sleep = options.sleep ?? sleepSync;
  781 |   const startedAt = now();
  782 |   let attempts = 0;
  783 |
  784 |   while (true) {
  785 |     attempts += 1;
  786 |     const row = db.prepare("SELECT pg_try_advisory_lock(?) AS acquired").get(POSTGRES_SCHEMA_VERSION) as
  787 |       | { acquired?: boolean }
  788 |       | undefined;
  789 |     if (row?.acquired === true) {
  790 |       return { attempts };
  791 |     }
  792 |
  793 |     const elapsedMs = Math.max(0, now() - startedAt);
  794 |     if (elapsedMs >= timeoutMs) {
> 795 |       throw new Error(
      |             ^ Error: PostgreSQL schema migration lock is busy after 9000ms. Another DofeAgent process may be initializing schema version 100; wait for it to finish or stop the stale process before rerunning the command.
  796 |         `PostgreSQL schema migration lock is busy after ${timeoutMs}ms. `
  797 |         + `Another DofeAgent process may be initializing schema version ${POSTGRES_SCHEMA_VERSION}; `
  798 |         + "wait for it to finish or stop the stale process before rerunning the command.",
  799 |       );
  800 |     }
  801 |
  802 |     sleep(Math.min(retryMs, timeoutMs - elapsedMs));
  803 |   }
  804 | }
  805 |
  806 | function sleepSync(durationMs: number): void {
  807 |   if (durationMs <= 0) {
  808 |     return;
  809 |   }
  810 |   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
  811 | }
  812 |
  813 | function isRuntimeSchemaCurrent(db: PostgresSyncDatabase): boolean {
  814 |   const table = db.prepare(
  815 |     "SELECT to_regclass('public.app_metadata') AS table_name",
  816 |   ).get() as { tableName?: string } | undefined;
  817 |   if (table?.tableName !== "app_metadata") {
  818 |     return false;
  819 |   }
  820 |   if (readMetadataValue(db, "schema_version") !== POSTGRES_SCHEMA_VERSION) {
  821 |     return false;
  822 |   }
  823 |   // Sentinel: if a known recently-added column is missing, the schema version
  824 |   // row was bumped without running the full migration. Force re-application.
  825 |   const sentinel = db.prepare(
  826 |     `SELECT 1
  827 |      FROM information_schema.columns
  828 |      WHERE table_schema = 'public'
  829 |        AND table_name = 'agent_task_queue'
  830 |        AND column_name = 'binding_generation'`,
  831 |   ).get() as { "1"?: number } | undefined;
  832 |   return sentinel?.["1"] === 1;
  833 | }
  834 |
  835 | function seedDefaultWorkspace(db: PostgresSyncDatabase): void {
  836 |   const existingWorkspace = db.prepare("SELECT 1 FROM workspace WHERE id = ? LIMIT 1").get(DEFAULT_WORKSPACE_ID);
  837 |   if (existingWorkspace) {
  838 |     return;
  839 |   }
  840 |
  841 |   const now = new Date().toISOString();
  842 |   db.prepare(
  843 |     `INSERT INTO workspace (
  844 |        id, slug, name, created_by, created_at, updated_at, archived_at
  845 |      )
  846 |      VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  847 |   ).run(DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, "Dofe Agent", "", now, now);
  848 | }
  849 |
  850 | function createPostgresSyncDatabase(currentDatabaseUrl: string): PostgresSyncDatabase {
  851 |   ensureWorker();
  852 |
  853 |   return {
  854 |     exec(sql: string): void {
  855 |       void callWorker({
  856 |         action: "exec",
  857 |         databaseUrl: currentDatabaseUrl,
  858 |         sql,
  859 |       });
  860 |     },
  861 |     prepare(sql: string): PreparedStatementLike {
  862 |       const convertedSql = convertSqliteParameters(sql);
  863 |       const execute = (params: unknown[]): WorkerSuccessPayload => callWorker({
  864 |         action: "query",
  865 |         databaseUrl: currentDatabaseUrl,
  866 |         sql: convertedSql,
  867 |         params,
  868 |       });
  869 |       return {
  870 |         all(...params: unknown[]): Array<Record<string, unknown>> {
  871 |           const result = execute(params);
  872 |           return result.rows ?? [];
  873 |         },
  874 |         get(...params: unknown[]): Record<string, unknown> | undefined {
  875 |           const result = execute(params);
  876 |           return result.rows?.[0];
  877 |         },
  878 |         run(...params: unknown[]): PreparedStatementResult {
  879 |           const result = execute(params);
  880 |           return {
  881 |             changes: result.rowCount ?? 0,
  882 |           };
  883 |         },
  884 |       };
  885 |     },
  886 |     close(): void {
  887 |       closeDatabase();
  888 |     },
  889 |   };
  890 | }
  891 |
  892 | function closeDatabase(): void {
  893 |   database = null;
  894 |   databaseUrl = null;
  895 |   schemaEnsuredForUrl = null;
```