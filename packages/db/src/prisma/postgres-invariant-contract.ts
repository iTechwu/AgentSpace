export interface PostgresInvariantContract {
  indexes: string[];
  functions: string[];
  triggers: string[];
  checkConstraints: string[];
  indexPredicates: Record<string, string>;
  checkDefinitions: Record<string, string>;
  enumLabels: Record<string, string[]>;
  views: Record<string, string>;
  functionBodies: Record<string, string>;
}

export interface PostgresInvariantSnapshot extends PostgresInvariantContract {}

/** Extracts named PostgreSQL objects and definition-level invariants from SQL source. */
export function extractPostgresInvariantContract(statements: readonly string[]): PostgresInvariantContract {
  const source = stripSqlComments(statements.join("\n"));
  const indexPredicates: Record<string, string> = {};
  for (const statement of statements.map(stripSqlComments)) {
    const match = statement.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)([\s\S]*)/i);
    const predicate = match?.[2]?.match(/\bWHERE\s+([\s\S]*?)(?:;|$)/i);
    if (match?.[1] && predicate?.[1]) indexPredicates[match[1]] = normalizeSql(predicate[1]);
  }
  const checkDefinitions: Record<string, string> = {};
  for (const match of source.matchAll(/(?:ADD\s+CONSTRAINT|CONSTRAINT)\s+([a-zA-Z0-9_]+)\s+CHECK\s*\(([^\n;]*)\)/gi)) {
    if (match[1] && match[2]) checkDefinitions[match[1]] = normalizeSql(match[2]);
  }
  const enumLabels: Record<string, string[]> = {};
  for (const match of source.matchAll(/CREATE\s+TYPE\s+([a-zA-Z0-9_]+)\s+AS\s+ENUM\s*\(([^)]*)\)/gi)) {
    if (match[1] && match[2]) enumLabels[match[1]] = parseSqlLiterals(match[2]);
  }
  const views: Record<string, string> = {};
  for (const match of source.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-zA-Z0-9_]+)\s+AS\s+([\s\S]*?)(?:;|$)/gi)) {
    if (match[1] && match[2]) views[match[1]] = normalizeSql(match[2]);
  }
  const functionBodies: Record<string, string> = {};
  for (const statement of statements.map(stripSqlComments)) {
    const header = statement.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z0-9_]+)/i);
    const body = statement.match(/\bAS\s+\$[^$]*\$([\s\S]*?)\$[^$]*\$/i);
    if (header?.[1] && body?.[1]) functionBodies[header[1]] = normalizeSql(body[1]);
  }
  return {
    indexes: uniqueMatches(source, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi),
    functions: uniqueMatches(source, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z0-9_]+)/gi),
    triggers: uniqueMatches(source, /CREATE\s+TRIGGER\s+([a-zA-Z0-9_]+)/gi),
    checkConstraints: uniqueMatches(source, /(?:ADD\s+CONSTRAINT|CONSTRAINT)\s+([a-zA-Z0-9_]+)\s+CHECK/gi),
    indexPredicates,
    checkDefinitions,
    enumLabels,
    views,
    functionBodies,
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
    ...compareDefinitions("index predicate", contract.indexPredicates, snapshot.indexPredicates),
    ...compareDefinitions("check definition", contract.checkDefinitions, snapshot.checkDefinitions),
    ...compareEnumLabels(contract.enumLabels, snapshot.enumLabels),
    ...compareDefinitions("view definition", contract.views, snapshot.views),
    ...compareDefinitions("function body", contract.functionBodies, snapshot.functionBodies),
  ];
}

function missingObjects(kind: string, expected: string[], actual: string[]): string[] {
  const actualNames = new Set(actual);
  return expected.filter((name) => !actualNames.has(name)).map((name) => `missing ${kind}: ${name}`);
}

function compareDefinitions(kind: string, expected: Record<string, string>, actual: Record<string, string>): string[] {
  return Object.entries(expected).flatMap(([name, definition]) => {
    if (!(name in actual)) return [`missing ${kind}: ${name}`];
    const actualDefinition = kind === "check definition" ? actual[name]!.replace(/^check\s*/i, "") : actual[name]!;
    return normalizeSql(actualDefinition) === normalizeSql(definition) ? [] : [`drifted ${kind}: ${name}`];
  });
}

function compareEnumLabels(expected: Record<string, string[]>, actual: Record<string, string[]>): string[] {
  return Object.entries(expected).flatMap(([name, labels]) => {
    if (!(name in actual)) return [`missing enum: ${name}`];
    return JSON.stringify(actual[name]) === JSON.stringify(labels) ? [] : [`drifted enum labels: ${name}`];
  });
}

function uniqueMatches(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]).filter((name): name is string => Boolean(name)))].sort();
}

function parseSqlLiterals(source: string): string[] {
  return [...source.matchAll(/'((?:''|[^'])*)'/g)].map((match) => (match[1] ?? "").replace(/''/g, "'"));
}

export function normalizeSql(source: string): string {
  let normalized = source
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/::[a-z_][a-z0-9_]*/gi, "")
    .replace(/=\s*any\s*\(\s*array\s*\[([\s\S]*?)\]\s*\)/gi, "in ($1)")
    .replace(/<>\s*all\s*\(\s*array\s*\[([\s\S]*?)\]\s*\)/gi, "not in ($1)")
    .replace(/\s*(->>|<>|<=|>=|=)\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  while (normalized.startsWith("(") && normalized.endsWith(")") && hasBalancedOuterParens(normalized)) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/\((?!\s*select\b)([^()]+(?:=|<>|\bis\s+(?:not\s+)?null\b)[^()]*)\)/gi, "$1");
  normalized = normalized.replace(/\(([^()]*->>[^()]*)\)/gi, "$1");
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized;
}

function hasBalancedOuterParens(source: string): boolean {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0 && index < source.length - 1) return false;
  }
  return depth === 0;
}

function stripSqlComments(source: string): string {
  return source.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
