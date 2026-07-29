import {
  buildManagedCredentialBundleDocument,
  getRuntimeCredentialVault,
} from "@dofe-agent/services";
import { readWorkspaceSsoBindingSync } from "@dofe-agent/db";
import { readRuntimeForDaemon, requireDaemonAuth, requireRemoteManagedRuntimeMode } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runtimeId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }
  const modeError = requireRemoteManagedRuntimeMode();
  if (modeError) {
    return modeError;
  }

  const { runtimeId } = await context.params;
  const runtime = readRuntimeForDaemon(runtimeId, auth);
  if (runtime instanceof Response) {
    return runtime;
  }

  if (!runtime.managedCredentialId) {
    return Response.json({ error: "Runtime has no managed credential." }, { status: 400 });
  }
  if (!runtime.credentialSecretRef) {
    return Response.json({ error: "Credential secret reference is missing." }, { status: 404 });
  }

  const binding = readWorkspaceSsoBindingSync(runtime.workspaceId);
  if (!binding?.teamId) {
    return Response.json({ error: "Runtime credential scope is missing." }, { status: 404 });
  }

  const vault = getRuntimeCredentialVault();
  const plaintext = vault.retrieve(runtime.credentialSecretRef, {
    tenantId: binding.tenantId,
    teamId: binding.teamId,
    runtimeId: runtime.id,
  });
  if (!plaintext) {
    return Response.json({ error: "Credential secret not found or already rotated." }, { status: 404 });
  }

  const bundle = buildManagedCredentialBundleDocument(runtime, plaintext);
  // Defensive: ensure the plaintext key never leaves this response in any form.
  bundle.environment = Object.fromEntries(
    Object.entries(bundle.environment).map(([key, value]) => [key, value]),
  );

  return Response.json(bundle);
}
