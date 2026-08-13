import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { resolveAttachmentRuntimeConfig } from "../config/deployment.ts";
import {
  type AttachmentStorageClient,
  ContentAddressedBlobIntegrityError,
  createAttachmentStorageClient,
  sha256Hex,
} from "./storage.ts";

// 真实 TOS 集成测试：全部对象传输走预签名 URL（curl 同步 + fetch 异步 + curl 管道流式），
// TosClient 仅在本地做 HMAC 预签名（零网络调用），不存在 tos-sdk/axios 的网络路径。
// 这些用例是「以自实现 V4 预签名替换 tos-sdk」决策的回归基线——替换前必须先保证本文件全绿。
// 运行方式：pnpm --filter @dofe-agent/services test:tos（或直接
//   node --env-file-if-exists=../../.env --experimental-strip-types --test --test-concurrency=1 <this file>）
// 缺少 TOS 配置时全部用例跳过，不影响无网络/无凭据环境的测试运行；因此本文件不纳入
// 默认 test 门禁，仅在具备 TOS 凭据的独立 CI 门禁中执行。

function resolveTosClient(): AttachmentStorageClient | null {
  let config: ReturnType<typeof resolveAttachmentRuntimeConfig>;
  try {
    config = resolveAttachmentRuntimeConfig();
  } catch {
    return null;
  }
  if (config.provider !== "tos") {
    return null;
  }
  return createAttachmentStorageClient(config);
}

const storage = resolveTosClient();
const runId = `tos-it-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const workspaceId = `tos-integration-${runId}`;

function trackKey(storageKey: string): string {
  pendingCleanup.push(storageKey);
  return storageKey;
}

const pendingCleanup: string[] = [];

test.after(() => {
  if (!storage) {
    return;
  }
  for (const storageKey of pendingCleanup.splice(0)) {
    try {
      storage.deleteObjectSync({ storageKey, storedPath: `tos://cleanup/${storageKey}` });
    } catch {
      // 清理失败不掩盖用例结果；孤儿对象带 tos-integration 前缀，可人工排查。
    }
  }
});

test("TOS sync 路径：curl 预签名上传→预签名 HEAD→curl 下载→预签名 URL→删除", async (t) => {
  if (!storage) {
    t.skip("缺少 TOS 环境配置（TOS_BUCKET/TOS_REGION/TOS_ACCESS_KEY/TOS_SECRET_KEY/TOS_ENDPOINT）");
    return;
  }
  const contentBytes = new TextEncoder().encode(`dofe tos integration ${runId} 你好`);
  const stored = storage.putObjectSync({
    workspaceId,
    attachmentId: `att-${runId}`,
    fileName: "round-trip 报告.txt",
    contentBytes,
    mediaType: "text/plain; charset=utf-8",
  });
  trackKey(stored.key!);

  assert.equal(stored.provider, "tos");
  assert.equal(stored.sizeBytes, contentBytes.byteLength);
  assert.equal(stored.sha256, sha256Hex(contentBytes));
  assert.ok(stored.key!.includes(`workspaces/tos-integration-${runId}/attachments/`));

  const metadata = await storage.headObject({ storageKey: stored.key, storedPath: stored.storedPath });
  assert.ok(metadata, "headObject 应返回已上传对象的元数据");
  assert.equal(metadata.sizeBytes, contentBytes.byteLength);

  const downloaded = storage.getObjectSync({ storageKey: stored.key, storedPath: stored.storedPath });
  assert.deepEqual(downloaded, contentBytes);

  const readUrl = await storage.createReadUrl({ storageKey: stored.key, storedPath: stored.storedPath });
  assert.ok(readUrl, "createReadUrl 应返回预签名 URL");
  const response = await fetch(readUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), contentBytes);

  storage.deleteObjectSync({ storageKey: stored.key, storedPath: stored.storedPath });
  const afterDelete = await storage.headObject({ storageKey: stored.key, storedPath: stored.storedPath });
  assert.equal(afterDelete, null, "删除后 headObject 应返回 null");
});

test("TOS async 路径：预签名 fetch 上传→下载→删除→404", async (t) => {
  if (!storage) {
    t.skip("缺少 TOS 环境配置");
    return;
  }
  const contentBytes = randomBytes(4096);
  const stored = await storage.putObject({
    workspaceId,
    attachmentId: `att-async-${runId}`,
    fileName: "sdk-round-trip.bin",
    contentBytes,
    mediaType: "application/octet-stream",
  });
  trackKey(stored.key!);

  const downloaded = await storage.getObject({ storageKey: stored.key, storedPath: stored.storedPath });
  assert.deepEqual(downloaded, new Uint8Array(contentBytes));

  await storage.deleteObject({ storageKey: stored.key, storedPath: stored.storedPath });
  await assert.rejects(
    () => storage.getObject({ storageKey: stored.key, storedPath: stored.storedPath }),
    "删除后预签名 fetch getObject 应抛错（404）",
  );
});

test("TOS 内容寻址 blob：上传→存在性→读取→删除→不存在", (t) => {
  if (!storage) {
    t.skip("缺少 TOS 环境配置");
    return;
  }
  const contentBytes = new TextEncoder().encode(`content-addressed ${runId}`);
  const sha256 = sha256Hex(contentBytes);
  const blobRead = { workspaceId, sha256 };

  storage.deleteContentAddressedBlobSync(blobRead);
  assert.equal(storage.contentAddressedBlobExistsSync(blobRead), false, "上传前 blob 不应存在");

  const ref = storage.putContentAddressedBlobSync({
    workspaceId,
    sha256,
    contentBytes,
    mediaType: "text/plain",
  });
  trackKey(ref.storageKey);
  assert.equal(ref.storageProvider, "tos");
  assert.equal(ref.sizeBytes, contentBytes.byteLength);

  assert.equal(storage.contentAddressedBlobExistsSync(blobRead), true);
  assert.deepEqual(storage.getContentAddressedBlobSync(blobRead), contentBytes);

  storage.deleteContentAddressedBlobSync(blobRead);
  assert.equal(storage.contentAddressedBlobExistsSync(blobRead), false, "删除后 blob 不应存在");
});

test("TOS 流式上传：curl 管道上传→读取一致→完整性失败清理孤儿对象", async (t) => {
  if (!storage) {
    t.skip("缺少 TOS 环境配置");
    return;
  }
  const contentBytes = randomBytes(256 * 1024);
  const sha256 = sha256Hex(contentBytes);
  const blobRead = { workspaceId, sha256 };

  storage.deleteContentAddressedBlobSync(blobRead);
  const ref = await storage.putContentAddressedBlobStream!({
    workspaceId,
    sha256,
    content: Readable.from(contentBytes),
    sizeBytes: contentBytes.byteLength,
    mediaType: "application/octet-stream",
  });
  trackKey(ref.storageKey);
  assert.deepEqual(storage.getContentAddressedBlobSync(blobRead), new Uint8Array(contentBytes));

  // 完整性失败：声明错误的 sha256，应抛 ContentAddressedBlobIntegrityError，
  // 且服务端不得残留按错误 sha 寻址的截断/损坏对象。
  const wrongSha = "0".repeat(64);
  const wrongRead = { workspaceId, sha256: wrongSha };
  storage.deleteContentAddressedBlobSync(wrongRead);
  await assert.rejects(
    () => storage.putContentAddressedBlobStream!({
      workspaceId,
      sha256: wrongSha,
      content: Readable.from(contentBytes),
      sizeBytes: contentBytes.byteLength,
    }),
    (error: unknown) => error instanceof ContentAddressedBlobIntegrityError,
  );
  assert.equal(
    storage.contentAddressedBlobExistsSync(wrongRead),
    false,
    "完整性失败后服务端不得残留坏对象",
  );

  storage.deleteContentAddressedBlobSync(blobRead);
});

test("TOS 错误路径：读取缺失对象抛错，删除缺失对象按幂等成功处理", async (t) => {
  if (!storage) {
    t.skip("缺少 TOS 环境配置");
    return;
  }
  const missingKey = `workspaces/${workspaceId}/attachments/2026/08/att-missing/never-uploaded.bin`;

  assert.throws(
    () => storage.getObjectSync({ storageKey: missingKey, storedPath: `tos://x/${missingKey}` }),
    /TOS read failed/,
    "curl 读取缺失对象应抛出带上下文的错误",
  );
  assert.equal(
    await storage.headObject({ storageKey: missingKey, storedPath: `tos://x/${missingKey}` }),
    null,
    "预签名 HEAD 缺失对象应返回 null 而非抛错",
  );
  assert.doesNotThrow(
    () => storage.deleteObjectSync({ storageKey: missingKey, storedPath: `tos://x/${missingKey}` }),
    "删除缺失对象应幂等成功（404 视为已删除）",
  );
});
