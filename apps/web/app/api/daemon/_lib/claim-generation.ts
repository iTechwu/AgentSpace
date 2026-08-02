export type ClaimGenerationParseResult =
  | { ok: true; value: number }
  | { ok: false; response: Response };

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response };

export async function parseClaimGenerationBody(request: Request): Promise<ClaimGenerationParseResult> {
  const body = await parseJsonObjectBody(request);
  if (!body.ok) {
    return body;
  }
  return parseClaimGenerationValue(body.value.claimGeneration);
}

export async function parseJsonObjectBody(request: Request): Promise<JsonObjectParseResult> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonObject("Request body must be valid JSON.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidJsonObject("Request body must be a JSON object.");
  }
  return { ok: true, value: body as Record<string, unknown> };
}

export function parseClaimGenerationQuery(request: Request): ClaimGenerationParseResult {
  const raw = new URL(request.url).searchParams.get("claimGeneration");
  if (!raw || !/^[1-9]\d*$/.test(raw)) {
    return invalidClaimGeneration();
  }
  return parseClaimGenerationValue(Number(raw));
}

export function parseClaimGenerationValue(value: unknown): ClaimGenerationParseResult {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return invalidClaimGeneration();
  }
  return { ok: true, value: Number(value) };
}

function invalidClaimGeneration(message = "claimGeneration must be a positive integer."): ClaimGenerationParseResult {
  return { ok: false, response: Response.json({ error: message }, { status: 400 }) };
}

function invalidJsonObject(message: string): JsonObjectParseResult {
  return { ok: false, response: Response.json({ error: message }, { status: 400 }) };
}
