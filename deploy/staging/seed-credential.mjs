#!/usr/bin/env node
// Seed a RuntimeCredential against the real models.dofe.ai internal API and
// validate the AgentSpace→models wiring (HMAC bearer, service-name allowlist,
// envelope contract). Prints the resulting credential id + a STAGING_* env
// fragment for run-gates.sh / .env.staging.
//
// What this validates: MODELS_BASE_URL reachability, MODELS_SERVICE_NAME +
// MODELS_INTERNAL_API_SECRET accepted by models' InternalAuthGuard, and the
// create-credential contract shape. If this succeeds, the control-plane half of
// Phase 3 staging is wired correctly.
//
// What this does NOT do: create the models tenant/team/billing account. There
// is no internal API for that — it is a models-admin prerequisite (see README).
// Pass an existing tenantId/teamId with billing balance.
//
// Usage:
//   node --env-file=deploy/staging/.env.staging deploy/staging/seed-credential.mjs \
//     --runtime-id runtime-staging-1 --provider codex --model gpt-5
import { createHmac, randomUUID } from "node:crypto";
import { argv, env, exit } from "node:process";

function required(name) {
  const v = (env[name] ?? "").trim();
  if (!v || /^replace_with|changeme|xxx|example\.(com|org)/i.test(v)) {
    console.error(`!! Missing or placeholder env: ${name}`);
    exit(1);
  }
  return v;
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, "");
    out[k] = args[i + 1];
  }
  return out;
}

// Mirrors packages/services/src/models/client.ts buildModelsInternalAuthorization.
function bearer(secret, serviceName) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", secret).update(`${ts}:${serviceName}`).digest("hex");
  return `Bearer ${ts}:${sig}:${serviceName}`;
}

async function callModels(base, secret, serviceName, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: bearer(secret, serviceName),
      "x-service-name": serviceName,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`non-JSON response (${res.status}) from ${path}: ${text.slice(0, 200)}`); }
  // Envelope: { code, msg, data }. Success = HTTP 200 AND code 0|200.
  if (!res.ok || (json.code !== 0 && json.code !== 200)) {
    throw new Error(`${method} ${path} failed: HTTP ${res.status}, code=${json.code}, msg=${json.msg}`);
  }
  return json.data;
}

const args = parseArgs(argv.slice(2));
const base = required("MODELS_BASE_URL").replace(/\/$/, "");
const serviceName = env.MODELS_SERVICE_NAME?.trim() || required("SSO_SERVICE_NAME");
const secret = env.MODELS_INTERNAL_API_SECRET?.trim() || env.INTERNAL_API_SECRET?.trim() || required("MODELS_INTERNAL_API_SECRET");
const tenantId = required("STAGING_MODELS_TENANT_ID");
const teamId = required("STAGING_MODELS_TEAM_ID");
const runtimeId = args["runtime-id"] || `runtime-staging-${randomUUID().slice(0, 8)}`;
const provider = args.provider || "codex";
const defaultModel = args.model;

const protocols = provider === "claude" ? ["anthropic"] : provider === "gemini" ? ["gemini"] : ["openai"];

console.log(`==> Validating wiring against ${base} (service=${serviceName}, tenant=${tenantId}, team=${teamId})`);

// 1. Billing preflight — proves balance gate + HMAC work.
const preflight = await callModels(base, secret, serviceName, "POST", "/internal/billing/preflight", {
  teamId,
  estimatedCharge: Number(env.MANAGED_RUNTIME_PREFLIGHT_CHARGE_USD || 0.01),
});
console.log("    preflight allowed:", preflight?.allowed, preflight?.availableBalance != null ? `(balance ${preflight.availableBalance} ${preflight.currency ?? ""})`.trim() : "");
if (!preflight?.allowed) {
  console.error("!! Billing preflight rejected. Ensure the models team has balance.");
  exit(1);
}

// 2. Create (or idempotently reuse) a RuntimeCredential.
const created = await callModels(base, secret, serviceName, "POST", "/internal/runtime-credentials", {
  tenantId,
  teamId,
  runtimeId,
  runtimeType: provider,
  protocols,
  defaultModel,
  idempotencyKey: `staging-seed:${tenantId}:${teamId}:${runtimeId}`,
});
const credentialId = created?.credential?.id;
const secretIssued = created?.secretIssued === true;
if (!credentialId) throw new Error(`create returned no credential id: ${JSON.stringify(created)}`);
console.log(`    credential ${credentialId} (${created?.credential?.status ?? "?"}, secretIssued=${secretIssued})`);

// 3. List models allowed for the credential (validates protocol-filtered catalog).
const models = await callModels(base, secret, serviceName, "GET", `/internal/runtime-credentials/${encodeURIComponent(credentialId)}/models?tenantId=${tenantId}&teamId=${teamId}`);
console.log(`    allowed models: ${models?.total ?? 0}`);

console.log("\n# ---- append to deploy/staging/.env.staging ----");
console.log(`STAGING_RUNTIME_CREDENTIAL_ID=${credentialId}`);
console.log(`STAGING_RUNTIME_ID=${runtimeId}`);
console.log(`STAGING_EXPECTED_MODEL=${defaultModel ?? models?.list?.[0]?.alias ?? ""}`);
console.log("# STAGING_EMPLOYEE_ID / STAGING_CONVERSATION_ID / STAGING_GATEWAY_REQUEST_ID");
console.log("# come from a real chat run through this runtime (see README step 5).");
