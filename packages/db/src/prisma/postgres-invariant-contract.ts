export interface PostgresInvariantContract {
  indexes: string[];
  functions: string[];
  triggers: string[];
  checkConstraints: string[];
}

export interface PostgresInvariantSnapshot {
  indexes: string[];
  functions: string[];
  triggers: string[];
  checkConstraints: string[];
}

/** Extracts named PostgreSQL objects from the versioned SQL schema source. */
export function extractPostgresInvariantContract(statements: readonly string[]): PostgresInvariantContract {
  const source = stripSqlComments(statements.join("\n"));
  return {
    indexes: uniqueMatches(
      source,
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi,
    ),
    functions: uniqueMatches(source, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z0-9_]+)/gi),
    triggers: uniqueMatches(source, /CREATE\s+TRIGGER\s+([a-zA-Z0-9_]+)/gi),
    checkConstraints: uniqueMatches(source, /(?:ADD\s+CONSTRAINT|CONSTRAINT)\s+([a-zA-Z0-9_]+)\s+CHECK/gi),
  };
}

export function comparePostgresInvariantContract(
  contract: PostgresInvariantContract,
  snapshot: PostgresInvariantSnapshot,
): string[] {
  return [
    ...missingObjects("index", contract.indexes, snapshot.indexes),
    ...missingObjects("function", contract.functions, snapshot.functions),
    ...missingObjects("trigger", contract.triggers, snapshot.triggers),
    ...missingObjects("check constraint", contract.checkConstraints, snapshot.checkConstraints),
  ];
}

function missingObjects(kind: string, expected: string[], actual: string[]): string[] {
  const actualNames = new Set(actual);
  return expected
    .filter((name) => !actualNames.has(name))
    .map((name) => `missing ${kind}: ${name}`);
}

function uniqueMatches(source: string, pattern: RegExp): string[] {
  const names = [...source.matchAll(pattern)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)].sort();
}

function stripSqlComments(source: string): string {
  return source.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
