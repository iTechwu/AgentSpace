// Compatibility guard for removed Google Workspace actions. New integrations use Feishu resource bindings.
export async function syncGoogleSheetDocumentDrivePermissions(_input: unknown): Promise<never> {
  throw new Error("Google Workspace integration has been removed. Use a Feishu resource binding instead.");
}
