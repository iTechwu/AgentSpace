import { createHmac } from "node:crypto";
import {
  persistReleaseEvidence,
  requiredEnv,
  validateBillingUsageLog,
} from "./managed-runtime-release-gates.mjs";

let evidence = { passed: false };
let exitCode = 2;
try {
  const required = requiredEnv(process.env, [
    "MODELS_BASE_URL",
    "STAGING_MODELS_TENANT_ID",
    "STAGING_RUNTIME_CREDENTIAL_ID",
    "STAGING_RUNTIME_ID",
    "STAGING_EMPLOYEE_ID",
    "STAGING_CONVERSATION_ID",
    "STAGING_GATEWAY_REQUEST_ID",
    "STAGING_EXPECTED_MODEL",
    "STAGING_BILLING_START_DATE",
  ]);
  const serviceName = process.env.MODELS_SERVICE_NAME?.trim() || process.env.SSO_SERVICE_NAME?.trim();
  const secret = process.env.MODELS_INTERNAL_API_SECRET?.trim() || process.env.INTERNAL_API_SECRET?.trim();
  if (!serviceName || !secret) {
    throw new Error("missing_required_environment:MODELS_SERVICE_NAME|SSO_SERVICE_NAME,MODELS_INTERNAL_API_SECRET|INTERNAL_API_SECRET");
  }
  const expected = {
    runtimeCredentialId: required.STAGING_RUNTIME_CREDENTIAL_ID,
    runtimeId: required.STAGING_RUNTIME_ID,
    employeeId: required.STAGING_EMPLOYEE_ID,
    conversationId: required.STAGING_CONVERSATION_ID,
    requestId: required.STAGING_GATEWAY_REQUEST_ID,
    model: required.STAGING_EXPECTED_MODEL,
  };
  const usageLog = await findUsageLog({
    baseUrl: required.MODELS_BASE_URL,
    tenantId: required.STAGING_MODELS_TENANT_ID,
    runtimeCredentialId: required.STAGING_RUNTIME_CREDENTIAL_ID,
    startDate: required.STAGING_BILLING_START_DATE,
    requestId: required.STAGING_GATEWAY_REQUEST_ID,
    serviceName,
    secret,
  });
  evidence = {
    passed: true,
    tenantId: required.STAGING_MODELS_TENANT_ID,
    billing: validateBillingUsageLog(usageLog, expected),
  };
  exitCode = 0;
} catch (error) {
  evidence = {
    ...evidence,
    error: error instanceof Error ? error.message : String(error),
  };
}

try {
  const stored = persistReleaseEvidence("managed-runtime-billing", evidence);
  console.log(JSON.stringify({ ...stored.payload, evidenceFile: stored.filePath }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 2;
}
process.exit(exitCode);

async function findUsageLog(input) {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  for (let page = 1; page <= 20; page += 1) {
    const query = new URLSearchParams({
      runtimeCredentialId: input.runtimeCredentialId,
      startDate: input.startDate,
      page: String(page),
      limit: "500",
    });
    const response = await fetch(
      `${baseUrl}/internal/usage/tenant/${encodeURIComponent(input.tenantId)}/logs?${query}`,
      {
        headers: {
          authorization: buildAuthorization(input.serviceName, input.secret),
          "x-service-name": input.serviceName,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`models_usage_query_failed:${response.status}`);
    const envelope = await response.json();
    const data = envelope?.data ?? envelope;
    const list = Array.isArray(data?.list) ? data.list : [];
    const match = list.find((entry) => entry?.requestId === input.requestId);
    if (match) return match;
    if (list.length < 500 || page * 500 >= Number(data?.total ?? 0)) break;
  }
  throw new Error(`billing_request_not_found:${input.requestId}`);
}

function buildAuthorization(serviceName, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}:${serviceName}`)
    .digest("hex");
  return `Bearer ${timestamp}:${signature}:${serviceName}`;
}
