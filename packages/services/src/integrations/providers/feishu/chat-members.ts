import {
  createFeishuApiClient,
  fetchFeishuTenantAccessToken,
  type FeishuApiClient,
} from "./client.ts";

const FEISHU_CHAT_MEMBERS_PAGE_SIZE = 100;
const FEISHU_CHAT_MEMBERS_MAX_PAGES = 10;

export interface FeishuChatMemberSnapshot {
  chatName?: string;
  userCount: number;
  botCount: number;
  members: Array<{
    displayName: string;
  }>;
}

export async function readFeishuChatMemberSnapshot(input: {
  appId: string;
  appSecret: string;
  chatId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clientFactory?: (tenantAccessToken: string) => FeishuApiClient;
}): Promise<FeishuChatMemberSnapshot> {
  const chatId = input.chatId.trim();
  if (!chatId) {
    throw new Error("Feishu chat id is required.");
  }

  const token = await fetchFeishuTenantAccessToken({
    appId: input.appId,
    appSecret: input.appSecret,
    baseUrl: input.baseUrl,
    fetchImpl: input.fetchImpl,
  });
  const client = input.clientFactory
    ? input.clientFactory(token.tenantAccessToken)
    : createFeishuApiClient({
      credentials: {
        appId: input.appId,
        appSecret: input.appSecret,
        tenantAccessToken: token.tenantAccessToken,
      },
      baseUrl: input.baseUrl,
      fetchImpl: input.fetchImpl,
    });
  const encodedChatId = encodeURIComponent(chatId);
  const chat = await readFeishuChat(client, encodedChatId);
  const members = await readFeishuChatMembers(client, encodedChatId);

  return {
    chatName: chat.chatName,
    userCount: chat.userCount,
    botCount: chat.botCount,
    members,
  };
}

async function readFeishuChat(client: FeishuApiClient, encodedChatId: string): Promise<{
  chatName?: string;
  userCount: number;
  botCount: number;
}> {
  const response = await client.request<Record<string, unknown>>({
    method: "GET",
    path: `/open-apis/im/v1/chats/${encodedChatId}`,
  });
  assertFeishuSuccess(response);
  const data = asRecord(response.data);
  const userCount = asNonNegativeInteger(data?.user_count);
  const botCount = asNonNegativeInteger(data?.bot_count);
  if (userCount === undefined || botCount === undefined) {
    throw new Error("Feishu chat response did not include member counts.");
  }
  return {
    chatName: asString(data?.name),
    userCount,
    botCount,
  };
}

async function readFeishuChatMembers(client: FeishuApiClient, encodedChatId: string): Promise<FeishuChatMemberSnapshot["members"]> {
  const memberKeys = new Set<string>();
  const members: FeishuChatMemberSnapshot["members"] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < FEISHU_CHAT_MEMBERS_MAX_PAGES; page += 1) {
    const response = await client.request<Record<string, unknown>>({
      method: "GET",
      path: `/open-apis/im/v1/chats/${encodedChatId}/members`,
      query: {
        page_size: FEISHU_CHAT_MEMBERS_PAGE_SIZE,
        page_token: pageToken,
      },
    });
    assertFeishuSuccess(response);
    const data = asRecord(response.data);
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const member = asRecord(item);
      const memberKey = asString(member?.member_id) ?? asString(member?.open_id) ?? asString(member?.user_id);
      const displayName = asString(member?.name);
      if (!memberKey || !displayName || memberKeys.has(memberKey)) {
        continue;
      }
      memberKeys.add(memberKey);
      members.push({ displayName });
    }

    if (!data?.has_more) {
      return members;
    }
    pageToken = asString(data.page_token);
    if (!pageToken) {
      throw new Error("Feishu chat member response was missing the next page token.");
    }
  }

  throw new Error("Feishu chat member list exceeded the page limit.");
}

function assertFeishuSuccess(response: Record<string, unknown>): void {
  if (typeof response.code === "number" && response.code !== 0) {
    throw new Error(typeof response.msg === "string" ? response.msg : "Feishu rejected the chat member request.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}
