import assert from "node:assert/strict";
import test from "node:test";
import {
  readFeishuChatMemberSnapshot,
  type FeishuApiClient,
} from "../index.ts";

test("readFeishuChatMemberSnapshot reads Feishu user and bot counts with paginated member names", async () => {
  const requests: Array<{ path: string; pageToken?: string | number | boolean }> = [];
  const client: FeishuApiClient = {
    async request(input) {
      requests.push({ path: input.path, pageToken: input.query?.page_token });
      if (input.path === "/open-apis/im/v1/chats/oc_group") {
        return {
          code: 0,
          data: {
            name: "Launch Room",
            user_count: "2",
            bot_count: "3",
          },
        };
      }
      if (input.query?.page_token === "next-page") {
        return {
          code: 0,
          data: {
            has_more: false,
            items: [
              { member_id: "ou_2", name: "Mina" },
            ],
          },
        };
      }
      return {
        code: 0,
        data: {
          has_more: true,
          page_token: "next-page",
          items: [
            { member_id: "ou_1", name: "Tech" },
            { member_id: "ou_1", name: "Tech" },
          ],
        },
      };
    },
  };

  const snapshot = await readFeishuChatMemberSnapshot({
    appId: "cli_test",
    appSecret: "secret",
    chatId: "oc_group",
    fetchImpl: (async () => new Response(JSON.stringify({
      code: 0,
      tenant_access_token: "tenant-token",
    }), { status: 200 })) as typeof fetch,
    clientFactory: (tenantAccessToken) => {
      assert.equal(tenantAccessToken, "tenant-token");
      return client;
    },
  });

  assert.deepEqual(snapshot, {
    chatName: "Launch Room",
    userCount: 2,
    botCount: 3,
    members: [
      { displayName: "Tech" },
      { displayName: "Mina" },
    ],
  });
  assert.deepEqual(requests, [
    { path: "/open-apis/im/v1/chats/oc_group", pageToken: undefined },
    { path: "/open-apis/im/v1/chats/oc_group/members", pageToken: undefined },
    { path: "/open-apis/im/v1/chats/oc_group/members", pageToken: "next-page" },
  ]);
});

test("readFeishuChatMemberSnapshot rejects incomplete Feishu member responses", async () => {
  const client: FeishuApiClient = {
    async request() {
      return {
        code: 0,
        data: {
          user_count: 1,
        },
      };
    },
  };

  await assert.rejects(
    readFeishuChatMemberSnapshot({
      appId: "cli_test",
      appSecret: "secret",
      chatId: "oc_group",
      fetchImpl: (async () => new Response(JSON.stringify({
        code: 0,
        tenant_access_token: "tenant-token",
      }), { status: 200 })) as typeof fetch,
      clientFactory: () => client,
    }),
    /member counts/,
  );
});
