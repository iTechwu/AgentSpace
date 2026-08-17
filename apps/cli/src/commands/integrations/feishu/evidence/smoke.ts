// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：smoke。
import { readFileSync } from "node:fs";
import { FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS, FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS, FEISHU_OPENAPI_REQUIRED_REQUEST_STEPS } from "@dofe-agent/services/integrations";
import { uniqueStrings } from "../cli-shared.ts";
import { buildFeishuSmokeHarnessSummary } from "../smoke-env.ts";
import type { FeishuBotAddedPayloadEvidenceVerification, FeishuEvidenceRemediationStep, FeishuExpectedBotAddedPayloadChatReferenceProof, FeishuExpectedBotAddedPayloadIdentityProof, FeishuExpectedCallbackRouteProof, FeishuExpectedTodo120NativeSecondAgentAppProof, FeishuOpenApiSmokeEvidenceVerification } from "../types.ts";
import { hasFeishuPayloadHashEvidence, hasFeishuSha256HashEvidence, matchFeishuExpectedIdentityProof, readFeishuMatchedIdentityIntegrationId, hasNonEmptyString } from "./core.ts";
import { isRedactedFeishuOpenApiSmokeRequestPath, containsFeishuSecretLikeEvidence, containsRawFeishuOpenApiEvidenceIdentifier, containsDofeAgentCallbackUrlOpenApiEvidence, hasValidFeishuCallbackRouteProof, matchesFeishuCallbackRouteProof, isRecord, readNumber, readFeishuSmokeEvidenceGeneratedAtState } from "./proofs.ts";
import { doFeishuSafeReferencesMatch } from "./satisfaction.ts";

export function verifyFeishuOpenApiSmokeEvidence(input: {
  evidencePath?: string;
  evidence?: unknown;
  expectedCallbackRouteProofs?: readonly FeishuExpectedCallbackRouteProof[];
  expectedIdentityProofs?: readonly FeishuExpectedBotAddedPayloadIdentityProof[];
  expectedSecondAgentAppProofs?: readonly FeishuExpectedTodo120NativeSecondAgentAppProof[];
  remediationContext?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuOpenApiSmokeEvidenceVerification {
  if (!input.evidencePath && input.evidence === undefined) {
    const issues = ["openapi_evidence_missing"];
    return {
      present: false,
      valid: false,
      issues,
      remediationSteps: buildFeishuOpenApiEvidenceRemediationSteps({
        issues,
        context: input.remediationContext,
      }),
    };
  }

  let evidence = input.evidence;
  if (evidence === undefined && input.evidencePath) {
    try {
      evidence = JSON.parse(readFileSync(input.evidencePath, "utf8")) as unknown;
    } catch {
      const issues = ["openapi_evidence_unreadable"];
      return {
        evidencePath: input.evidencePath,
        present: false,
        valid: false,
        issues,
        remediationSteps: buildFeishuOpenApiEvidenceRemediationSteps({
          issues,
          context: input.remediationContext,
        }),
      };
    }
  }

  const issues: string[] = [];
  const output = isRecord(evidence) ? evidence : undefined;
  const summary = isRecord(output?.summary) ? output.summary : undefined;
  const appIdentity = isRecord(output?.appIdentity) ? output.appIdentity : undefined;
  const todo120NativeSmoke = isRecord(output?.todo120NativeSmoke) ? output.todo120NativeSmoke : undefined;
  const steps = Array.isArray(output?.steps) ? output.steps : [];
  let appMatchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;
  let matchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;

  if (!output) {
    issues.push("openapi_evidence_not_object");
  }
  const generatedAtState = readFeishuSmokeEvidenceGeneratedAtState(output?.generatedAt);
  if (!generatedAtState.present) {
    issues.push("openapi_evidence_generated_at_missing");
  } else if (!generatedAtState.valid) {
    issues.push("openapi_evidence_generated_at_invalid");
  } else if (!generatedAtState.fresh) {
    issues.push("openapi_evidence_stale");
  }
  if (output?.live !== true) {
    issues.push("openapi_not_live_run");
  }
  if (output?.strictLive !== true) {
    issues.push("openapi_not_strict_live_run");
  }
  if (summary?.strictLiveSatisfied !== true) {
    issues.push("openapi_strict_live_not_satisfied");
  }
  if (readNumber(summary?.liveSkipped) !== 0) {
    issues.push("openapi_live_steps_skipped");
  }
  if (readNumber(summary?.liveFailed) !== 0) {
    issues.push("openapi_live_steps_failed");
  }
  if (Array.isArray(summary?.missingEnv) && summary.missingEnv.length > 0) {
    issues.push("openapi_missing_live_env");
  }
  if (!appIdentity) {
    issues.push("openapi_app_identity_missing");
  } else if (!hasFeishuSha256HashEvidence(appIdentity.appIdHash)) {
    issues.push("openapi_app_identity_app_id_hash_missing");
  } else if (input.expectedIdentityProofs && input.expectedIdentityProofs.length === 0) {
    issues.push("openapi_app_identity_active_integration_missing");
  } else if ((input.expectedIdentityProofs?.length ?? 0) > 0) {
    const identityMatch = matchFeishuExpectedIdentityProof(input.expectedIdentityProofs ?? [], appIdentity);
    appMatchedIdentityProof = identityMatch.appMatchedProof;
    matchedIdentityProof = identityMatch.fullMatchedProof;
    if (!appMatchedIdentityProof) {
      issues.push("openapi_app_identity_app_id_mismatch");
    } else if (identityMatch.tenantIssue) {
      issues.push(`openapi_app_identity_${identityMatch.tenantIssue}`);
    }
  }
  if (!todo120NativeSmoke) {
    issues.push("openapi_todo120_native_smoke_missing");
  } else {
    if (todo120NativeSmoke.requiredForCommand !== true) {
      issues.push("openapi_todo120_native_smoke_not_required");
    }
    if (todo120NativeSmoke.ready !== true) {
      issues.push("openapi_todo120_native_smoke_not_ready");
    }
    if (readNumber(todo120NativeSmoke.required) < 2) {
      issues.push("openapi_todo120_native_smoke_requirement_incomplete");
    }
    if (readNumber(todo120NativeSmoke.configured) < readNumber(todo120NativeSmoke.required)) {
      issues.push("openapi_todo120_native_smoke_env_incomplete");
    }
    if (!hasFeishuSha256HashEvidence(todo120NativeSmoke.secondAgentAppIdHash)) {
      issues.push("openapi_todo120_native_smoke_second_app_id_hash_missing");
    } else if (input.expectedSecondAgentAppProofs && matchedIdentityProof) {
      const expectedSecondAgentAppProofs = input.expectedSecondAgentAppProofs.filter((proof) =>
        proof.anchorIntegrationId === matchedIdentityProof.integrationId
      );
      if (expectedSecondAgentAppProofs.length === 0) {
        issues.push("openapi_todo120_native_smoke_second_app_local_evidence_missing");
      } else if (!expectedSecondAgentAppProofs.some((proof) =>
        proof.appIdHash === todo120NativeSmoke.secondAgentAppIdHash
      )) {
        issues.push("openapi_todo120_native_smoke_second_app_mismatch");
      }
    }
  }
  if (readNumber(summary?.liveChecks) < FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS.length) {
    issues.push("openapi_live_check_summary_incomplete");
  }
  if (readNumber(summary?.livePassed) < FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS.length) {
    issues.push("openapi_live_passed_summary_incomplete");
  }

  for (const stepName of FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS) {
    const step = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, stepName));
    if (!step) {
      issues.push(`openapi_required_step_missing:${stepName}`);
      continue;
    }
    if (step.status !== "pass") {
      issues.push(`openapi_required_step_not_passed:${stepName}`);
    }
    if (step.liveCheck !== true) {
      issues.push(`openapi_required_step_not_marked_live:${stepName}`);
    }
  }

  const callbackStep = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "DofeAgent callback URL verification"));
  if (!hasValidFeishuCallbackRouteProof(callbackStep)) {
    issues.push("openapi_callback_route_proof_missing");
  } else if (input.expectedCallbackRouteProofs) {
    const expectedCallbackRouteProofs = matchedIdentityProof
      ? input.expectedCallbackRouteProofs.filter((proof) => proof.integrationId === matchedIdentityProof.integrationId)
      : input.expectedCallbackRouteProofs;
    if (expectedCallbackRouteProofs.length === 0) {
      issues.push("openapi_callback_route_active_integration_missing");
    } else if (!expectedCallbackRouteProofs.some((proof) => matchesFeishuCallbackRouteProof(callbackStep, proof))) {
      issues.push("openapi_callback_route_proof_mismatch");
    }
  }

  for (const stepName of FEISHU_OPENAPI_REQUIRED_REQUEST_STEPS) {
    const step = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, stepName));
    if (!step) {
      continue;
    }
    if (!hasFeishuOpenApiSmokeRequestSummary(step)) {
      issues.push(`openapi_required_request_summary_missing:${stepName}`);
    }
  }

  const sheetWrite = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "Sheets write values"));
  const docAppend = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "Docs docx append blocks"));
  const baseUpdate = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "Base update record"));
  if (docAppend?.destructive !== true) {
    issues.push("openapi_doc_append_not_marked_destructive");
  }
  if (sheetWrite?.destructive !== true) {
    issues.push("openapi_sheet_write_not_marked_destructive");
  }
  if (baseUpdate?.destructive !== true) {
    issues.push("openapi_base_update_not_marked_destructive");
  }
  if (readNumber(summary?.destructiveLiveChecks) < FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS.length) {
    issues.push("openapi_destructive_live_checks_missing");
  }

  for (const step of steps) {
    if (!isFeishuOpenApiSmokeStep(step)) {
      continue;
    }
    if (isRecord(step.request) && !hasFeishuOpenApiSmokeRequestSummary(step)) {
      issues.push(`openapi_request_summary_malformed:${step.name}`);
    } else if (hasFeishuOpenApiSmokeRequestSummary(step) && !isRedactedFeishuOpenApiSmokeRequestPath(step.request.path)) {
      issues.push(`openapi_request_path_not_redacted:${step.name}`);
    }
    if (typeof step.detail === "string" && containsRawFeishuOpenApiEvidenceIdentifier(step.detail)) {
      issues.push(`openapi_raw_feishu_identifier_in_detail:${step.name}`);
    }
    if (typeof step.detail === "string" && containsDofeAgentCallbackUrlOpenApiEvidence(step.detail)) {
      issues.push(`openapi_callback_url_in_detail:${step.name}`);
    }
  }
  if (containsFeishuSecretLikeEvidence(JSON.stringify(evidence))) {
    issues.push("openapi_secret_like_value_in_evidence");
  }
  if (containsRawFeishuOpenApiEvidenceIdentifier(JSON.stringify(evidence))) {
    issues.push("openapi_raw_feishu_identifier_in_evidence");
  }
  if (containsDofeAgentCallbackUrlOpenApiEvidence(JSON.stringify(evidence))) {
    issues.push("openapi_callback_url_in_evidence");
  }

  return {
    ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
    present: true,
    valid: issues.length === 0,
    issues,
    remediationSteps: buildFeishuOpenApiEvidenceRemediationSteps({
      issues,
      context: input.remediationContext,
    }),
    summary: {
      live: output?.live === true,
      strictLive: output?.strictLive === true,
      strictLiveSatisfied: summary?.strictLiveSatisfied === true,
      liveChecks: readNumber(summary?.liveChecks),
      livePassed: readNumber(summary?.livePassed),
      liveSkipped: readNumber(summary?.liveSkipped),
      liveFailed: readNumber(summary?.liveFailed),
      destructiveLiveChecks: readNumber(summary?.destructiveLiveChecks),
      requiredLiveSteps: FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS.length,
      generatedAtPresent: generatedAtState.present,
      generatedAtFresh: generatedAtState.fresh,
      appIdentityPresent: Boolean(appIdentity),
      appIdHashPresent: hasFeishuSha256HashEvidence(appIdentity?.appIdHash),
      appIdentityMatched: Boolean(appMatchedIdentityProof),
      ...(readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, appIdentity)
        ? { matchedIntegrationId: readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, appIdentity) }
        : {}),
      tenantKeyHashPresent: hasFeishuSha256HashEvidence(appIdentity?.tenantKeyHash),
      tenantKeyMatched: Boolean(
        matchedIdentityProof &&
          (matchedIdentityProof.tenantKeyHash
            ? appIdentity?.tenantKeyHash === matchedIdentityProof.tenantKeyHash
            : appIdentity?.tenantKeyPresent !== true && !hasFeishuSha256HashEvidence(appIdentity?.tenantKeyHash)),
      ),
      todo120NativeSmokeReady: todo120NativeSmoke?.ready === true,
      todo120NativeSmokeRequiredForCommand: todo120NativeSmoke?.requiredForCommand === true,
      todo120NativeSmokeRequired: readNumber(todo120NativeSmoke?.required),
      todo120NativeSmokeConfigured: readNumber(todo120NativeSmoke?.configured),
      todo120NativeSmokeSecondAgentAppIdHashPresent: hasFeishuSha256HashEvidence(
        todo120NativeSmoke?.secondAgentAppIdHash,
      ),
    },
  };
}

export function buildFeishuOpenApiEvidenceRemediationSteps(input: {
  issues: readonly string[];
  context?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuEvidenceRemediationStep[] {
  if (input.issues.length === 0) {
    return [];
  }
  const harness = input.context
    ? buildFeishuSmokeHarnessSummary(input.context)
    : undefined;
  return [{
    stepId: "run_openapi_live_smoke_harness",
    title: "Live smoke: run isolated Feishu callback and OpenAPI harness",
    detail: "Regenerate the strict live OpenAPI evidence artifact after check-env passes; the artifact must include the current callback fingerprint, all required IM/Docs/Sheets/Base live checks, destructive write checks, and redacted request summaries.",
    issues: uniqueStrings([...input.issues]),
    command: harness
      ? `${harness.strictLiveCommand}\n${harness.verifyEvidenceCommand}`
    : "pnpm run smoke:feishu -- --env-file scripts/feishu/.env --live --strict-live --evidence runtime-output/feishu-smoke/live.json --json --require-todo120-native\npnpm run smoke:feishu -- --verify-evidence runtime-output/feishu-smoke/live.json --json",
  }];
}

export function verifyFeishuBotAddedPayloadEvidence(input: {
  evidencePath?: string;
  evidence?: unknown;
  expectedIdentityProofs?: readonly FeishuExpectedBotAddedPayloadIdentityProof[];
  expectedChatReferences?: readonly FeishuExpectedBotAddedPayloadChatReferenceProof[];
  remediationContext?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuBotAddedPayloadEvidenceVerification {
  if (!input.evidencePath && input.evidence === undefined) {
    const issues = ["bot_added_payload_evidence_missing"];
    return {
      present: false,
      valid: false,
      issues,
      remediationSteps: buildFeishuBotAddedPayloadEvidenceRemediationSteps({
        issues,
        context: input.remediationContext,
      }),
    };
  }

  let evidence = input.evidence;
  if (evidence === undefined && input.evidencePath) {
    try {
      evidence = JSON.parse(readFileSync(input.evidencePath, "utf8")) as unknown;
    } catch {
      const issues = ["bot_added_payload_evidence_unreadable"];
      return {
        evidencePath: input.evidencePath,
        present: false,
        valid: false,
        issues,
        remediationSteps: buildFeishuBotAddedPayloadEvidenceRemediationSteps({
          issues,
          context: input.remediationContext,
        }),
      };
    }
  }

  const issues: string[] = [];
  const output = isRecord(evidence) ? evidence : undefined;
  const summary = isRecord(output?.summary) ? output.summary : undefined;
  let appMatchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;
  let matchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;

  if (!output) {
    issues.push("bot_added_payload_evidence_not_object");
  }
  const generatedAtState = readFeishuSmokeEvidenceGeneratedAtState(output?.generatedAt);
  if (!generatedAtState.present) {
    issues.push("bot_added_payload_evidence_generated_at_missing");
  } else if (!generatedAtState.valid) {
    issues.push("bot_added_payload_evidence_generated_at_invalid");
  } else if (!generatedAtState.fresh) {
    issues.push("bot_added_payload_evidence_stale");
  }
  if (output?.valid !== true) {
    issues.push("bot_added_payload_evidence_not_valid");
  }
  if (Array.isArray(output?.issues) && output.issues.length > 0) {
    issues.push("bot_added_payload_evidence_has_issues");
  }
  if (!summary) {
    issues.push("bot_added_payload_summary_missing");
  } else {
    if (!hasFeishuSha256HashEvidence(summary.appIdHash)) {
      issues.push("bot_added_payload_app_id_hash_missing");
    } else if (input.expectedIdentityProofs && input.expectedIdentityProofs.length === 0) {
      issues.push("bot_added_payload_active_integration_missing");
    } else if ((input.expectedIdentityProofs?.length ?? 0) > 0) {
      const identityMatch = matchFeishuExpectedIdentityProof(input.expectedIdentityProofs ?? [], summary);
      appMatchedIdentityProof = identityMatch.appMatchedProof;
      matchedIdentityProof = identityMatch.fullMatchedProof;
      if (!appMatchedIdentityProof) {
        issues.push("bot_added_payload_app_id_mismatch");
      } else if (identityMatch.tenantIssue) {
        issues.push(`bot_added_payload_${identityMatch.tenantIssue}`);
      }
    }
    if (summary.botAddedEvent !== true) {
      issues.push("bot_added_payload_not_bot_added");
    }
    if (summary.chatDescriptorPresent !== true) {
      issues.push("bot_added_payload_chat_descriptor_missing");
    }
    if (summary.chatIdRedacted !== true) {
      issues.push("bot_added_payload_chat_id_not_redacted");
    }
    if (!hasNonEmptyString(summary.chatIdSource)) {
      issues.push("bot_added_payload_chat_id_source_missing");
    }
    if (!isSafeFeishuBotAddedReference(summary.chatReference, "chat")) {
      issues.push("bot_added_payload_chat_reference_missing");
    } else if (input.expectedChatReferences && input.expectedChatReferences.length === 0) {
      issues.push("bot_added_payload_chat_reference_local_evidence_missing");
    } else if ((input.expectedChatReferences?.length ?? 0) > 0) {
      const identityProof = matchedIdentityProof;
      const expectedChatReferences = identityProof
        ? input.expectedChatReferences?.filter((proof) => proof.integrationId === identityProof.integrationId)
        : input.expectedChatReferences;
      if (!expectedChatReferences || expectedChatReferences.length === 0) {
        issues.push("bot_added_payload_chat_reference_local_evidence_missing");
      } else if (!expectedChatReferences.some((proof) =>
        doFeishuSafeReferencesMatch(summary.chatReference, proof.chatReference)
      )) {
        issues.push("bot_added_payload_chat_reference_mismatch");
      }
    }
    if (summary.externalEventIdRedacted !== true) {
      issues.push("bot_added_payload_event_id_not_redacted");
    }
    if (summary.eventCreateTimePresent !== true) {
      issues.push("bot_added_payload_event_create_time_missing");
    } else if (summary.eventCreateTimeFresh !== true) {
      issues.push("bot_added_payload_event_create_time_stale");
    }
    if (!isSafeFeishuBotAddedReference(summary.externalEventReference, "event")) {
      issues.push("bot_added_payload_event_reference_missing");
    }
    if (!hasFeishuPayloadHashEvidence(summary.payloadHash)) {
      issues.push("bot_added_payload_hash_missing");
    }
    if (summary.rawPayloadStored !== false) {
      issues.push("bot_added_payload_raw_payload_stored");
    }
  }

  const serialized = JSON.stringify(evidence);
  if (containsFeishuSecretLikeEvidence(serialized)) {
    issues.push("bot_added_payload_secret_like_value");
  }
  if (containsRawFeishuOpenApiEvidenceIdentifier(serialized)) {
    issues.push("bot_added_payload_raw_feishu_identifier");
  }
  if (containsDofeAgentCallbackUrlOpenApiEvidence(serialized)) {
    issues.push("bot_added_payload_callback_url");
  }

  return {
    ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
    present: true,
    valid: issues.length === 0,
    issues,
    remediationSteps: buildFeishuBotAddedPayloadEvidenceRemediationSteps({
      issues,
      context: input.remediationContext,
    }),
    ...(summary
      ? {
        summary: {
          eventType: typeof summary.eventType === "string" ? summary.eventType : "",
          botAddedEvent: summary.botAddedEvent === true,
          appIdPresent: summary.appIdPresent === true,
          appIdHashPresent: hasFeishuSha256HashEvidence(summary.appIdHash),
          appIdentityMatched: Boolean(appMatchedIdentityProof),
          ...(readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, summary)
            ? { matchedIntegrationId: readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, summary) }
            : {}),
          tenantKeyPresent: summary.tenantKeyPresent === true,
          tenantKeyHashPresent: hasFeishuSha256HashEvidence(summary.tenantKeyHash),
          tenantKeyMatched: Boolean(
            matchedIdentityProof &&
              (matchedIdentityProof.tenantKeyHash
                ? summary.tenantKeyHash === matchedIdentityProof.tenantKeyHash
                : summary.tenantKeyPresent !== true && !hasFeishuSha256HashEvidence(summary.tenantKeyHash)),
          ),
          chatDescriptorPresent: summary.chatDescriptorPresent === true,
          ...(hasNonEmptyString(summary.chatIdSource) ? { chatIdSource: summary.chatIdSource } : {}),
          ...(isSafeFeishuBotAddedReference(summary.chatReference, "chat")
            ? { chatReference: summary.chatReference }
            : {}),
          chatIdRedacted: summary.chatIdRedacted === true,
          ...(hasNonEmptyString(summary.chatType) ? { chatType: summary.chatType } : {}),
          chatNamePresent: summary.chatNamePresent === true,
          ...(isSafeFeishuBotAddedReference(summary.externalEventReference, "event")
            ? { externalEventReference: summary.externalEventReference }
            : {}),
          externalEventIdRedacted: summary.externalEventIdRedacted === true,
          eventCreateTimePresent: summary.eventCreateTimePresent === true,
          eventCreateTimeFresh: summary.eventCreateTimeFresh === true,
          payloadHashPresent: hasFeishuPayloadHashEvidence(summary.payloadHash),
          rawPayloadStored: summary.rawPayloadStored === true,
          generatedAtPresent: generatedAtState.present,
          generatedAtFresh: generatedAtState.fresh,
        },
      }
      : {}),
  };
}

export function buildFeishuBotAddedPayloadEvidenceRemediationSteps(input: {
  issues: readonly string[];
  context?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuEvidenceRemediationStep[] {
  if (input.issues.length === 0) {
    return [];
  }
  const harness = input.context
    ? buildFeishuSmokeHarnessSummary(input.context)
    : undefined;
  return [{
    stepId: "verify_real_bot_added_payload_sample",
    title: "Live smoke: verify captured Feishu bot-added callback payload",
    detail: "Save one raw im.chat.member.bot.added_v1 callback JSON from the disposable Feishu tenant/app, then regenerate the safe bot-added payload evidence artifact without raw chat ids, user ids, event ids, group names, secrets, or callback URLs.",
    issues: uniqueStrings([...input.issues]),
    command: harness
      ? harness.verifyBotAddedPayloadCommand
      : "pnpm run smoke:feishu -- --verify-bot-added-payload runtime-output/feishu-smoke/bot-added-callback.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --json",
  }];
}

export function isSafeFeishuBotAddedReference(value: unknown, prefix: "chat" | "event"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix} [a-f0-9]{16}$`).test(value);
}

export function isFeishuOpenApiSmokeStepNamed(value: unknown, name: string): value is Record<string, unknown> {
  return isFeishuOpenApiSmokeStep(value) && value.name === name;
}

export function isFeishuOpenApiSmokeStep(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.name === "string";
}

export function hasFeishuOpenApiSmokeRequestSummary(
  step: Record<string, unknown>,
): step is Record<string, unknown> & { request: { method: string; path: string } } {
  if (!isRecord(step.request)) {
    return false;
  }
  return typeof step.request.method === "string" &&
    typeof step.request.path === "string" &&
    step.request.path.trim().length > 0;
}
