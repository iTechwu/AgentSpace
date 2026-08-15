export interface PrismaColumnContract {
  fieldName: string;
  columnName: string;
  prismaType: string;
  required: boolean;
  hasDefault: boolean;
  primary: boolean;
}

export interface PrismaModelContract {
  name: string;
  tableName: string;
  columns: PrismaColumnContract[];
}

export interface PrismaSchemaContract {
  models: PrismaModelContract[];
}

export interface PostgresSchemaSnapshot {
  columns: Array<{
    tableName: string;
    columnName: string;
    dataType: string;
    nullable: boolean;
    hasDefault: boolean;
  }>;
  primaryKeys: Map<string, string[]>;
}

const SCALAR_TYPES = new Set([
  "BigInt",
  "Boolean",
  "Bytes",
  "DateTime",
  "Decimal",
  "Float",
  "Int",
  "Json",
  "String",
]);

export function parsePrismaSchemaContract(source: string): PrismaSchemaContract {
  const lines = source.split(/\r?\n/);
  const modelNames = new Set(lines.flatMap((line) => {
    const match = line.trim().match(/^model\s+(\w+)\s*\{$/);
    return match?.[1] ? [match[1]] : [];
  }));
  const models: PrismaModelContract[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index]!.trim().match(/^model\s+(\w+)\s*\{$/);
    if (!start?.[1]) continue;
    const name = start[1];
    const block: string[] = [];
    for (index += 1; index < lines.length && lines[index]!.trim() !== "}"; index += 1) {
      block.push(lines[index]!);
    }
    models.push(parseModel(name, block, modelNames));
  }
  return { models };
}

function parseModel(
  name: string,
  lines: string[],
  modelNames: Set<string>,
): PrismaModelContract {
  const tableName = lines
    .map((line) => line.trim().match(/^@@map\("([^"]+)"\)/)?.[1])
    .find((value): value is string => Boolean(value)) ?? name;
  const compositePrimaryFields = new Set(lines.flatMap((line) => {
    const match = line.trim().match(/^@@id\(\[([^\]]+)\]\)/);
    return match?.[1]
      ? match[1].split(",").map((value) => value.trim()).filter(Boolean)
      : [];
  }));
  const columns: PrismaColumnContract[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const match = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
    if (!match?.[1] || !match[2]) continue;
    const [fieldName, prismaType, modifier = "", attributes = ""] = match.slice(1);
    if (modifier === "[]" || modelNames.has(prismaType) || !SCALAR_TYPES.has(prismaType)) continue;
    const mappedName = attributes.match(/@map\("([^"]+)"\)/)?.[1];
    columns.push({
      fieldName,
      columnName: mappedName ?? fieldName,
      prismaType,
      required: modifier !== "?",
      hasDefault: attributes.includes("@default("),
      primary: attributes.includes("@id") || compositePrimaryFields.has(fieldName),
    });
  }
  return { name, tableName, columns };
}

export function comparePrismaSchemaContract(
  contract: PrismaSchemaContract,
  snapshot: PostgresSchemaSnapshot,
): string[] {
  const actualByColumn = new Map(snapshot.columns.map((column) => [
    `${column.tableName}.${column.columnName}`,
    column,
  ]));
  const drift: string[] = [];
  for (const model of contract.models) {
    for (const expected of model.columns) {
      const key = `${model.tableName}.${expected.columnName}`;
      const actual = actualByColumn.get(key);
      if (!actual) {
        drift.push(`${key}: missing database column`);
        continue;
      }
      const expectedType = postgresTypeForPrisma(expected.prismaType);
      if (expectedType && actual.dataType !== expectedType) {
        drift.push(`${key}: expected ${expectedType}, received ${actual.dataType}`);
      }
      if (expected.required && actual.nullable) {
        drift.push(`${key}: expected NOT NULL`);
      } else if (!expected.required && !actual.nullable) {
        drift.push(`${key}: expected nullable`);
      }
      if (expected.hasDefault && !actual.hasDefault) {
        drift.push(`${key}: expected a database default`);
      } else if (!expected.hasDefault && actual.hasDefault) {
        drift.push(`${key}: unexpected database default`);
      }
    }
    const expectedPrimary = model.columns.filter((column) => column.primary).map((column) => column.columnName);
    const actualPrimary = snapshot.primaryKeys.get(model.tableName) ?? [];
    if (expectedPrimary.join("\0") !== actualPrimary.join("\0")) {
      drift.push(`${model.tableName}: expected primary key (${expectedPrimary.join(", ")}), received (${actualPrimary.join(", ")})`);
    }
  }
  return drift;
}

function postgresTypeForPrisma(prismaType: string): string | undefined {
  switch (prismaType) {
    case "String": return "text";
    case "Int": return "integer";
    case "BigInt": return "bigint";
    case "Boolean": return "boolean";
    case "DateTime": return "timestamp with time zone";
    case "Json": return "jsonb";
    case "Float": return "double precision";
    case "Decimal": return "numeric";
    case "Bytes": return "bytea";
    default: return undefined;
  }
}
