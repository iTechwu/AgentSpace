// TOS V4 预签名 golden vector 测试。
// 固定时钟 + 固定输入 → 断言 createTosPresignedUrl 输出与 tos-sdk@2.9.1
// TosClient.getPreSignedUrl 逐字符相等（向量在 tos-signer-parity.test.ts 过渡期
// 差分验证通过后固化）。无需 TOS 凭据、零网络，纳入默认 test 门禁。
import assert from "node:assert/strict";
import test from "node:test";
import { createTosPresignedUrl, type TosPresignInput } from "./tos-signer.ts";

const NOW = new Date(Date.UTC(2026, 7, 14, 12, 34, 56)); // 20260814T123456Z
const BASE = {
  accessKeyId: "AKTESTACCESSKEYID",
  secretAccessKey: "secretTestKeyValue0123456789",
  endpoint: "tos-cn-beijing.volces.com",
  expires: 300,
  now: NOW,
} satisfies Partial<TosPresignInput>;

const cases: Array<{ name: string; input: TosPresignInput; expected: string }> = [
  {
    name: "configured 自定义域（alternativeEndpoint + isCustomDomain）",
    input: { ...BASE, bucket: "my-bucket", key: "workspaces/ws1/att1/报告.bin", method: "GET", alternativeEndpoint: "cdn.example.com", isCustomDomain: true },
    expected: "https://cdn.example.com/workspaces/ws1/att1/%E6%8A%A5%E5%91%8A.bin?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD&X-Tos-Credential=AKTESTACCESSKEYID%2F20260814%2Ftos-cn-beijing.volces.com%2Ftos%2Frequest&X-Tos-Date=20260814T123456Z&X-Tos-Expires=300&X-Tos-SignedHeaders=host&X-Tos-Signature=690e006dbc69d4607ea2503569853a7a754d5372d570ccfab8a5c9e5e3ffd475",
  },
  {
    name: "cross-bucket 虚拟主机形式",
    input: { ...BASE, bucket: "legacy-bucket", key: "workspaces/ws1/att1/file.bin", method: "GET" },
    expected: "https://legacy-bucket.tos-cn-beijing.volces.com/workspaces/ws1/att1/file.bin?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD&X-Tos-Credential=AKTESTACCESSKEYID%2F20260814%2Ftos-cn-beijing.volces.com%2Ftos%2Frequest&X-Tos-Date=20260814T123456Z&X-Tos-Expires=300&X-Tos-SignedHeaders=host&X-Tos-Signature=8c8f3551b5460698de07de9ff1176bdd764d0456f695972ec1842a4dd181f331",
  },
  {
    name: "isCustomDomain 无 alternativeEndpoint（host=base endpoint）",
    input: { ...BASE, bucket: "my-bucket", key: "a/b/c.txt", method: "HEAD", isCustomDomain: true },
    expected: "https://tos-cn-beijing.volces.com/a/b/c.txt?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD&X-Tos-Credential=AKTESTACCESSKEYID%2F20260814%2Ftos-cn-beijing.volces.com%2Ftos%2Frequest&X-Tos-Date=20260814T123456Z&X-Tos-Expires=300&X-Tos-SignedHeaders=host&X-Tos-Signature=d4b2f94735beff7792a4bbecc5b748a5f143cf8cb01805b2a0f5939abdb6e58f",
  },
  {
    name: "alternativeEndpoint 无 isCustomDomain",
    input: { ...BASE, bucket: "my-bucket", key: "x/y.json", method: "PUT", alternativeEndpoint: "mirror.example.com" },
    expected: "https://mirror.example.com/x/y.json?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD&X-Tos-Credential=AKTESTACCESSKEYID%2F20260814%2Ftos-cn-beijing.volces.com%2Ftos%2Frequest&X-Tos-Date=20260814T123456Z&X-Tos-Expires=300&X-Tos-SignedHeaders=host&X-Tos-Signature=6bc2ef44f681e471384a8df7b0431cfb937c1e3bee28afbc6981ae6dad7d0410",
  },
  {
    name: "含 ()!*' 特殊字符的 key（URL 路径保留字面量，规范路径编码）",
    input: { ...BASE, bucket: "my-bucket", key: "workspaces/ws1/file (1)!*'name.txt", method: "GET" },
    expected: "https://my-bucket.tos-cn-beijing.volces.com/workspaces/ws1/file%20(1)!*'name.txt?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD&X-Tos-Credential=AKTESTACCESSKEYID%2F20260814%2Ftos-cn-beijing.volces.com%2Ftos%2Frequest&X-Tos-Date=20260814T123456Z&X-Tos-Expires=300&X-Tos-SignedHeaders=host&X-Tos-Signature=5ce44ee74482fbfa6ea3ad819a1db310c8076a941aebdcdd3273fb1ac1d236db",
  },
  {
    name: "DELETE 方法",
    input: { ...BASE, bucket: "legacy-bucket", key: "p/q.bin", method: "DELETE" },
    expected: "https://legacy-bucket.tos-cn-beijing.volces.com/p/q.bin?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD&X-Tos-Credential=AKTESTACCESSKEYID%2F20260814%2Ftos-cn-beijing.volces.com%2Ftos%2Frequest&X-Tos-Date=20260814T123456Z&X-Tos-Expires=300&X-Tos-SignedHeaders=host&X-Tos-Signature=9d428462d12321e02e31d5ae870e63f84066e1bf82cf384bc4cc23bdc005cf76",
  },
];

for (const c of cases) {
  test(`createTosPresignedUrl golden vector: ${c.name}`, () => {
    assert.equal(createTosPresignedUrl(c.input), c.expected);
  });
}

test("createTosPresignedUrl: scope region 始终用 base endpoint（不被 alternativeEndpoint 覆盖）", () => {
  const url = createTosPresignedUrl({
    ...BASE,
    bucket: "my-bucket",
    key: "k.txt",
    method: "GET",
    alternativeEndpoint: "cdn.example.com",
  });
  // host 走 alternativeEndpoint，但 credential scope 的 region 位仍是 base endpoint。
  assert.ok(url.startsWith("https://cdn.example.com/k.txt?"), "host 应为 alternativeEndpoint");
  assert.ok(
    url.includes("X-Tos-Credential=AKTESTACCESSKEYID%2F20260814%2Ftos-cn-beijing.volces.com%2Ftos%2Frequest"),
    "credential scope 的 region 位应为 base endpoint（tos-cn-beijing.volces.com）",
  );
});

test("createTosPresignedUrl: 默认 now 为当前时刻（无注入时仍可生成有效 URL）", () => {
  const url = createTosPresignedUrl({
    accessKeyId: "AK",
    secretAccessKey: "SK",
    endpoint: "tos-cn-beijing.volces.com",
    bucket: "b",
    key: "k",
    method: "GET",
    expires: 60,
  });
  assert.match(url, /X-Tos-Date=\d{8}T\d{6}Z/);
  assert.match(url, /X-Tos-Signature=[0-9a-f]{64}/);
});
