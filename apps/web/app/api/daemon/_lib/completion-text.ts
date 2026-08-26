export function resolveTaskCompletionText(streamedText: string, finalOutputText: string): string | undefined {
  if (!streamedText) {
    return finalOutputText || undefined;
  }
  if (!finalOutputText.startsWith(streamedText)) {
    return undefined;
  }
  return finalOutputText.slice(streamedText.length) || undefined;
}
