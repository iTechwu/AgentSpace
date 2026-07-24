import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";

test("resolvePostgresDatabaseUrl falls back to repository .env", () => {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-postgres-config-"));

  try {
    writeFileSync(join(tempRoot, "Target.md"), "# test\n");
    writeFileSync(
      join(tempRoot, ".env"),
      "AGENT_SPACE_PG_URL=postgres://from-dotenv:secret@127.0.0.1:5432/agent_space_test\n",
      "utf8",
    );

    process.chdir(tempRoot);

    assert.equal(
      resolvePostgresDatabaseUrl({ env: {} }),
      "postgres://from-dotenv:secret@127.0.0.1:5432/agent_space_test",
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolvePostgresDatabaseUrl prefers explicit env over repository .env", () => {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-postgres-config-"));

  try {
    writeFileSync(join(tempRoot, "Target.md"), "# test\n");
    writeFileSync(
      join(tempRoot, ".env"),
      "DATABASE_URL=postgres://from-dotenv:secret@127.0.0.1:5432/agent_space_test\n",
      "utf8",
    );

    process.chdir(tempRoot);

    assert.equal(
      resolvePostgresDatabaseUrl({
        env: {
          AGENT_SPACE_PG_URL: "postgres://from-env:secret@127.0.0.1:5432/agent_space_test",
        },
      }),
      "postgres://from-env:secret@127.0.0.1:5432/agent_space_test",
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolvePostgresDatabaseUrl uses the configured PostgreSQL database URL", () => {
  const url = resolvePostgresDatabaseUrl({
    env: {
      SELF_HOSTED_DATABASE_URL: "postgres://self-hosted:secret@127.0.0.1:5432/agent_space_test",
    },
  });

  assert.equal(url, "postgres://self-hosted:secret@127.0.0.1:5432/agent_space_test");
});

test("resolvePostgresDatabaseUrl prefers the explicit test database URL", () => {
  const url = resolvePostgresDatabaseUrl({
    env: {
      NODE_TEST_CONTEXT: "child-v8",
      AGENT_SPACE_TEST_DATABASE_URL: "postgres://localhost/agent_space_test",
      AGENT_SPACE_PG_URL: "postgres://localhost/agent_space",
    },
  });

  assert.equal(url, "postgres://localhost/agent_space_test");
});

test("resolvePostgresDatabaseUrl refuses non-test databases during tests", () => {
  assert.throws(
    () =>
      resolvePostgresDatabaseUrl({
        env: {
          NODE_TEST_CONTEXT: "child-v8",
          AGENT_SPACE_PG_URL: "postgres://localhost/agent_space",
        },
      }),
    /Refusing to use a non-test PostgreSQL database while running tests/,
  );
});

test("resolvePostgresDatabaseUrl allows an explicit production-test override", () => {
  const url = resolvePostgresDatabaseUrl({
    env: {
      NODE_TEST_CONTEXT: "child-v8",
      AGENT_SPACE_ALLOW_PRODUCTION_TEST_DB: "1",
      AGENT_SPACE_PG_URL: "postgres://localhost/agent_space",
    },
  });

  assert.equal(url, "postgres://localhost/agent_space");
});
