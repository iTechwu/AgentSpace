import assert from "node:assert/strict";
import test from "node:test";
import {
  createPinnedAddressLookup,
  downloadSkillArtifactFile,
  SkillArtifactDownloadError,
  type SkillArtifactHttpsRequest,
} from "./secure-artifact-download.ts";

function response(input: {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
}) {
  return {
    statusCode: input.statusCode ?? 200,
    headers: input.headers ?? {},
    body: (async function* () {
      for (const chunk of input.chunks ?? []) yield chunk;
    })(),
    destroy: () => {},
  };
}

const publicLookup = async () => [{ family: "ipv4" as const, address: "8.8.8.8" }];

test("pinned lookup supports Node HTTPS all-address and legacy single-address callbacks", async () => {
  const lookup = createPinnedAddressLookup([
    { family: "ipv4", address: "8.8.8.8" },
    { family: "ipv6", address: "2001:4860:4860::8888" },
  ]);
  const allResult = await new Promise<unknown[]>((resolve) => {
    lookup("objects.example.com", { all: true }, (...args) => resolve(args));
  });
  const singleResult = await new Promise<unknown[]>((resolve) => {
    lookup("objects.example.com", { all: false }, (...args) => resolve(args));
  });

  assert.deepEqual(allResult, [null, [
    { address: "8.8.8.8", family: 4 },
    { address: "2001:4860:4860::8888", family: 6 },
  ]]);
  assert.deepEqual(singleResult, [null, "8.8.8.8", 4]);
});

test("secure artifact download streams the exact declared bytes through a pinned address", async () => {
  const seen: unknown[] = [];
  const request: SkillArtifactHttpsRequest = async (url, addresses) => {
    seen.push({ url: url.href, addresses });
    return response({
      headers: { "content-length": "4" },
      chunks: [Buffer.from("ab"), Buffer.from("cd")],
    });
  };
  const bytes = await downloadSkillArtifactFile({
    url: "https://objects.example.com/blob?signature=x",
    expectedSize: 4,
    lookupHost: publicLookup,
    request,
  });
  assert.equal(Buffer.from(bytes).toString("utf8"), "abcd");
  assert.deepEqual(seen, [{
    url: "https://objects.example.com/blob?signature=x",
    addresses: [{ family: "ipv4", address: "8.8.8.8" }],
  }]);
});

test("secure artifact download rejects HTTP and private targets by default", async () => {
  await assert.rejects(
    downloadSkillArtifactFile({ url: "http://objects.example.com/blob", expectedSize: 1, lookupHost: publicLookup }),
    (error: unknown) => error instanceof SkillArtifactDownloadError
      && error.code === "skill_installation.download_https_required",
  );
  await assert.rejects(
    downloadSkillArtifactFile({
      url: "https://objects.internal/blob",
      expectedSize: 1,
      lookupHost: async () => [{ family: "ipv4", address: "10.0.0.8" }],
    }),
    (error: unknown) => error instanceof SkillArtifactDownloadError
      && error.code === "skill_installation.download_private_address_forbidden",
  );
});

test("private storage requires an explicit exact origin opt-in", async () => {
  const bytes = await downloadSkillArtifactFile({
    url: "https://objects.internal/blob",
    expectedSize: 2,
    lookupHost: async () => [{ family: "ipv4", address: "10.0.0.8" }],
    allowedPrivateOrigins: ["https://objects.internal"],
    request: async () => response({ chunks: [Buffer.from("ok")] }),
  });
  assert.equal(Buffer.from(bytes).toString("utf8"), "ok");
});

test("every redirect is resolved and policy-checked", async () => {
  const resolved: string[] = [];
  const request: SkillArtifactHttpsRequest = async (url) => url.hostname === "objects.example.com"
    ? response({ statusCode: 302, headers: { location: "https://redirect.internal/blob" } })
    : response({ chunks: [Buffer.from("x")] });
  await assert.rejects(
    downloadSkillArtifactFile({
      url: "https://objects.example.com/blob",
      expectedSize: 1,
      lookupHost: async (hostname) => {
        resolved.push(hostname);
        return hostname === "redirect.internal"
          ? [{ family: "ipv4", address: "127.0.0.1" }]
          : [{ family: "ipv4", address: "8.8.8.8" }];
      },
      request,
    }),
    /download_private_address_forbidden/,
  );
  assert.deepEqual(resolved, ["objects.example.com", "redirect.internal"]);
});

test("streaming download aborts as soon as the declared size is exceeded", async () => {
  let destroyed = false;
  await assert.rejects(
    downloadSkillArtifactFile({
      url: "https://objects.example.com/blob",
      expectedSize: 3,
      lookupHost: publicLookup,
      request: async () => ({
        ...response({ chunks: [Buffer.from("ab"), Buffer.from("cd"), Buffer.alloc(1024)] }),
        destroy: () => { destroyed = true; },
      }),
    }),
    (error: unknown) => error instanceof SkillArtifactDownloadError
      && error.code === "skill_installation.download_size_exceeded",
  );
  assert.equal(destroyed, true);
});

test("configured public origin allow-list rejects an unexpected signed URL host", async () => {
  await assert.rejects(
    downloadSkillArtifactFile({
      url: "https://evil.example/blob",
      expectedSize: 1,
      allowedOrigins: ["https://objects.example.com"],
      lookupHost: publicLookup,
    }),
    (error: unknown) => error instanceof SkillArtifactDownloadError
      && error.code === "skill_installation.download_origin_forbidden",
  );
});
