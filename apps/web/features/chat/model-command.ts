/**
 * Parse a `/model <modelId>` slash command from the start of a chat message.
 * Returns the model id (undefined means "clear") and the remaining text.
 */
export interface ParsedModelCommand {
  modelId?: string;
  remainingContent: string;
}

export function parseModelCommand(content: string): ParsedModelCommand | null {
  const trimmed = content.trim();
  const match = /^\/model(?:\s+(?<modelId>\S+))?/.exec(trimmed);
  if (!match) {
    return null;
  }
  const modelId = match.groups?.modelId?.trim();
  const remainingContent = trimmed.slice(match[0].length).trimStart();
  if (modelId?.toLowerCase() === "clear" || modelId?.toLowerCase() === "reset") {
    return { modelId: undefined, remainingContent };
  }
  return { modelId, remainingContent };
}
