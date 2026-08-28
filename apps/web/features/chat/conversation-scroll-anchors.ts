// 会话线程滚动锚点：跨会话切换/往返时恢复每线程的滚动位置
// （从 conversation-shell.tsx 拆出，3.4-2）。sessionStorage 持久化 + LRU 剪枝。

export interface ConversationScrollAnchor {
  messageId?: string;
  messageOffsetTop?: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  stickToBottom: boolean;
  updatedAt: number;
}

const CONVERSATION_SCROLL_ANCHOR_LIMIT = 40;

export function buildConversationScrollAnchor(
  viewport: HTMLDivElement,
  stickToBottom: boolean,
): ConversationScrollAnchor {
  const firstVisibleMessage = findFirstVisibleConversationMessage(viewport);
  return {
    messageId: firstVisibleMessage?.messageId,
    messageOffsetTop: firstVisibleMessage?.offsetTop,
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    distanceFromBottom: Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
    stickToBottom,
    updatedAt: Date.now(),
  };
}

export function restoreConversationScrollAnchor(
  viewport: HTMLDivElement,
  anchor: ConversationScrollAnchor | undefined,
): boolean {
  if (!anchor) {
    return false;
  }

  if (anchor.stickToBottom) {
    viewport.scrollTop = viewport.scrollHeight;
    return true;
  }

  if (anchor.messageId && typeof anchor.messageOffsetTop === "number") {
    const anchoredMessage = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-conversation-message-id]"),
    ).find((element) => element.dataset.conversationMessageId === anchor.messageId);
    if (
      anchoredMessage &&
      (anchoredMessage.offsetTop > 0 || anchoredMessage.offsetHeight > 0)
    ) {
      viewport.scrollTop = Math.max(0, anchoredMessage.offsetTop - anchor.messageOffsetTop);
      return true;
    }
  }

  if (viewport.scrollHeight > viewport.clientHeight) {
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - anchor.distanceFromBottom);
    return true;
  }

  viewport.scrollTop = anchor.scrollTop;
  return true;
}

function findFirstVisibleConversationMessage(
  viewport: HTMLDivElement,
): { messageId: string; offsetTop: number } | null {
  for (const element of viewport.querySelectorAll<HTMLElement>("[data-conversation-message-id]")) {
    if (element.offsetTop === 0 && element.offsetHeight === 0) {
      continue;
    }
    if (element.offsetTop + element.offsetHeight >= viewport.scrollTop) {
      return {
        messageId: element.dataset.conversationMessageId ?? "",
        offsetTop: element.offsetTop - viewport.scrollTop,
      };
    }
  }
  return null;
}

export function readConversationScrollAnchors(storageKey?: string): Record<string, ConversationScrollAnchor> {
  if (!storageKey || typeof window === "undefined") {
    return {};
  }
  const raw = window.sessionStorage.getItem(storageKey);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const anchors: Record<string, ConversationScrollAnchor> = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (isConversationScrollAnchor(value)) {
        anchors[threadId] = value;
      }
    }
    return pruneConversationScrollAnchors(anchors);
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return {};
  }
}

export function writeConversationScrollAnchors(
  storageKey: string,
  anchors: Record<string, ConversationScrollAnchor>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  if (Object.keys(anchors).length === 0) {
    window.sessionStorage.removeItem(storageKey);
    return;
  }
  window.sessionStorage.setItem(storageKey, JSON.stringify(anchors));
}

export function pruneConversationScrollAnchors(
  anchors: Record<string, ConversationScrollAnchor>,
): Record<string, ConversationScrollAnchor> {
  const entries = Object.entries(anchors)
    .filter(([, anchor]) => isConversationScrollAnchor(anchor))
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, CONVERSATION_SCROLL_ANCHOR_LIMIT);
  return Object.fromEntries(entries);
}

function isConversationScrollAnchor(value: unknown): value is ConversationScrollAnchor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ConversationScrollAnchor>;
  return (
    typeof candidate.scrollTop === "number" &&
    typeof candidate.scrollHeight === "number" &&
    typeof candidate.clientHeight === "number" &&
    typeof candidate.distanceFromBottom === "number" &&
    typeof candidate.stickToBottom === "boolean" &&
    typeof candidate.updatedAt === "number"
  );
}
