export type OutputFormat = "text" | "json";

export function parseFormat(args: string[]): {
  format: OutputFormat;
  rest: string[];
} {
  const rest: string[] = [];
  let format: OutputFormat = "text";

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      format = "json";
      continue;
    }
    if (token === "--format") {
      const nextValue = args[index + 1];
      if (nextValue === "json" || nextValue === "text") {
        format = nextValue;
        index += 1;
        continue;
      }
    }
    rest.push(token);
  }

  return { format, rest };
}

export function writeData(format: OutputFormat, value: unknown): void {
  if (format === "json") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (Array.isArray(value)) {
    console.log(renderTable(value));
    return;
  }

  if (value && typeof value === "object") {
    console.log(renderObject(value as Record<string, unknown>));
    return;
  }

  console.log(String(value));
}

function renderObject(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}: ${String(entry)}`)
    .join("\n");
}

function renderTable(rows: unknown[]): string {
  if (rows.length === 0) {
    return "No rows.";
  }

  const normalizedRows = rows.map((row) => normalizeRow(row));
  const headers = Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row))));
  const widths = headers.map((header) =>
    Math.max(header.length, ...normalizedRows.map((row) => String(row[header] ?? "").length)),
  );

  const head = headers.map((header, index) => header.padEnd(widths[index])).join("  ");
  const rule = widths.map((width) => "-".repeat(width)).join("  ");
  const body = normalizedRows.map((row) =>
    headers.map((header, index) => String(row[header] ?? "").padEnd(widths[index])).join("  "),
  );

  return [head, rule, ...body].join("\n");
}

function normalizeRow(row: unknown): Record<string, unknown> {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    return row as Record<string, unknown>;
  }

  return { value: row };
}

