export interface MentionCandidate {
  agentId: string;
  label: string;
  aliases: string[];
  inChannel: boolean;
}

export interface ParsedMention {
  agentId: string;
  label: string;
  token: string;
  mentionType: "agent";
  inChannel: boolean;
}

export interface MentionParseResult {
  mentions: ParsedMention[];
  unknownMentions: string[];
}

export interface MentionQueryMatch {
  query: string;
  start: number;
  end: number;
}

const MENTION_SEPARATOR = /[\s#，。,.!！？?;；:：、()[\]{}<>《》「」『』"'`~]/;

export function parseAgentMentions(input: string, candidates: MentionCandidate[]): MentionParseResult {
  if (!input.includes("@")) {
    return { mentions: [], unknownMentions: [] };
  }

  const aliases = buildAliasDirectory(candidates);
  const mentions: ParsedMention[] = [];
  const unknownMentions: string[] = [];
  const seenAgentIds = new Set<string>();

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "@") {
      continue;
    }
    if (!isBoundary(input, index - 1)) {
      continue;
    }

    const matchedAlias = aliases.find((alias) => aliasMatchesAt(input, index + 1, alias.alias));
    if (matchedAlias) {
      if (!seenAgentIds.has(matchedAlias.agentId)) {
        mentions.push({
          agentId: matchedAlias.agentId,
          label: matchedAlias.label,
          token: matchedAlias.alias,
          mentionType: "agent",
          inChannel: matchedAlias.inChannel,
        });
        seenAgentIds.add(matchedAlias.agentId);
      }
      index += matchedAlias.alias.length;
      continue;
    }

    const token = readMentionToken(input, index + 1);
    if (token.length > 0 && !unknownMentions.some((value) => sameText(value, token))) {
      unknownMentions.push(token);
      index += token.length;
    }
  }

  return { mentions, unknownMentions };
}

export function findDraftMentionQuery(input: string, caretIndex: number): MentionQueryMatch | null {
  const safeCaretIndex = Math.max(0, Math.min(input.length, caretIndex));
  const prefix = input.slice(0, safeCaretIndex);
  const match = /(^|[\s#，。,!！？?;；:：、()[\]{}<>《》「」『』"'`~])@([^\s@#，。,!！？?;；:：、()[\]{}<>《》「」『』"'`~]*)$/.exec(prefix);
  if (!match) {
    return null;
  }

  return {
    query: match[2] ?? "",
    start: safeCaretIndex - (match[2]?.length ?? 0) - 1,
    end: safeCaretIndex,
  };
}

export function applyMentionSelection(
  input: string,
  caretIndex: number,
  label: string,
): { value: string; caretIndex: number } {
  const activeQuery = findDraftMentionQuery(input, caretIndex);
  const mentionText = `@${label} `;

  if (!activeQuery) {
    const nextValue = `${input.slice(0, caretIndex)}${mentionText}${input.slice(caretIndex)}`;
    return {
      value: nextValue,
      caretIndex: caretIndex + mentionText.length,
    };
  }

  const suffix = input.slice(activeQuery.end);
  const nextValue = `${input.slice(0, activeQuery.start)}${mentionText}${suffix.startsWith(" ") ? suffix.slice(1) : suffix}`;
  return {
    value: nextValue,
    caretIndex: activeQuery.start + mentionText.length,
  };
}

function buildAliasDirectory(
  candidates: MentionCandidate[],
): Array<{ agentId: string; label: string; alias: string; inChannel: boolean }> {
  const rows: Array<{ agentId: string; label: string; alias: string; inChannel: boolean }> = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const aliasValues = uniqueStrings([candidate.label, ...candidate.aliases]);
    for (const alias of aliasValues) {
      const key = `${candidate.agentId}::${alias.toLocaleLowerCase("zh-CN")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        agentId: candidate.agentId,
        label: candidate.label,
        alias,
        inChannel: candidate.inChannel,
      });
    }
  }

  return rows.sort((left, right) => right.alias.length - left.alias.length);
}

function aliasMatchesAt(input: string, startIndex: number, alias: string): boolean {
  const candidate = input.slice(startIndex, startIndex + alias.length);
  if (!sameText(candidate, alias)) {
    return false;
  }

  return isBoundary(input, startIndex + alias.length);
}

function readMentionToken(input: string, startIndex: number): string {
  let endIndex = startIndex;
  while (endIndex < input.length && !isBoundary(input, endIndex) && input[endIndex] !== "@") {
    endIndex += 1;
  }
  return input.slice(startIndex, endIndex).trim();
}

function isBoundary(input: string, index: number): boolean {
  if (index < 0 || index >= input.length) {
    return true;
  }
  return MENTION_SEPARATOR.test(input[index]);
}

function sameText(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (result.some((existing) => sameText(existing, trimmed))) {
      continue;
    }
    result.push(trimmed);
  }

  return result;
}
