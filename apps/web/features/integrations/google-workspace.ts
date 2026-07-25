// Compatibility guard for removed Google Workspace actions. New integrations use Feishu resource bindings.
export class GoogleWorkspaceApiError extends Error {
  readonly code = "google_workspace.removed";
  readonly status = 410;
}

function removed(): never {
  throw new Error("Google Workspace integration has been removed. Use a Feishu resource binding instead.");
}

export async function createGoogleWorkspaceDoc(_input: unknown): Promise<never> {
  return removed();
}

export async function createGoogleWorkspaceSheet(_input: unknown): Promise<never> {
  return removed();
}

export async function getGoogleWorkspaceAccessTokenForUser(_input: unknown): Promise<never> {
  return removed();
}

export async function getGoogleWorkspaceAccessTokenForAgent(_input: unknown): Promise<never> {
  return removed();
}

export async function readGoogleDriveFileMetadata(_input: unknown): Promise<never> {
  return removed();
}

export function readGoogleWorkspaceOAuthConfig(): never {
  return removed();
}
