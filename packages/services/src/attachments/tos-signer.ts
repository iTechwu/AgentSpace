// TOS (火山引擎对象存储) SigV4 风格预签名 URL 生成器。
//
// 本文件以纯 node:crypto 实现预签名（HMAC-SHA256 V4），替换 @volcengine/tos-sdk。
// 算法逐字节提取自 tos-sdk@2.9.1（dist/tos.cjs.development.js）的 getPreSignedUrl →
// getSignatureQuery → SignersV4 链路，并由 packages/services/src/attachments/
// tos-signer.test.ts 的 golden vector + storage-tos.integration.test.ts 的真实 TOS
// 回归共同保证字节级一致。零第三方依赖、零网络调用。
//
// 复刻自 SDK 的两个反直觉点（改了就签名不匹配）：
//   1. SigV4 credential scope 的 "region" 位填的是 endpoint HOST，不是 region。
//      credential scope = `<date8>/<endpointHost>/tos/request`。
//   2. secret key 无任何前缀。直接 HMAC(secret, date)，没有 AWS SigV4 的 "AWS4"/"TOS4"。
import { createHash, createHmac } from "node:crypto";

export interface TosPresignInput {
  accessKeyId: string;
  secretAccessKey: string;
  /** endpoint 主机名（无 scheme），如 tos-cn-beijing.volces.com 或自定义域。 */
  endpoint: string;
  bucket: string;
  key: string;
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  /** 预签名有效期（秒）。 */
  expires: number;
  /** 自定义域/CDN 主机；提供后 subdomain=false，bucket 仅出现在签名里。 */
  alternativeEndpoint?: string;
  /** 命中自定义域映射（bucket 与 endpoint 一一对应）；subdomain=false。 */
  isCustomDomain?: boolean;
  /** 可注入时钟，用于确定性测试；默认 new Date()。 */
  now?: Date;
}

const hmacBuffer = (key: Buffer | string, message: string): Buffer =>
  createHmac("sha256", key).update(message, "utf8").digest();
const hmacHex = (key: Buffer | string, message: string): string =>
  createHmac("sha256", key).update(message, "utf8").digest("hex");
const sha256Hex = (message: string): string =>
  createHash("sha256").update(message, "utf8").digest("hex");

// encodeURIComponent 不编码 ()!*'，而 SDK 的 getEncodePath 会对它们再 percent-encode。
// 最终 URL 路径保留 ()!*' 字面量，规范（签名）路径则替换为 %28/%29/%21/%2A/%27。
const encodePathSegment = (segment: string): string => encodeURIComponent(segment);
const encodeSignedExtra = (value: string): string =>
  value
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27");

function formatTosDateTime(now: Date): string {
  // 等价于 SDK 的 new Date(now.toUTCString()).toISOString().replace(/\..+/, '')
  //   .replace(/-/g, '').replace(/:/g, '') + 'Z'  →  YYYYMMDDTHHMMSSZ
  return (
    now
      .toISOString()
      .replace(/\..+/, "")
      .replace(/-/g, "")
      .replace(/:/g, "") + "Z"
  );
}

/**
 * 生成 TOS 预签名 URL，行为与 @volcengine/tos-sdk@2.9.1 的 TosClient.getPreSignedUrl
 * 逐字符一致。host/urlPath/query 的构造逻辑：
 *   - endpoint = alternativeEndpoint ?? endpoint
 *   - subdomain = (alternativeEndpoint || isCustomDomain) ? false : true
 *   - host = subdomain ? `${bucket}.${endpoint}` : endpoint（URL 主机 == 签名 host 值）
 */
export function createTosPresignedUrl(input: TosPresignInput): string {
  const {
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket,
    key,
    method,
    expires,
    alternativeEndpoint,
    isCustomDomain,
    now = new Date(),
  } = input;

  const effectiveEndpoint = alternativeEndpoint ?? endpoint;
  const subdomain = alternativeEndpoint || isCustomDomain ? false : true;
  const host = subdomain ? `${bucket}.${effectiveEndpoint}` : effectiveEndpoint;

  // 最终 URL 路径：每段单独 encodeURIComponent，斜杠保留（SDK newPath）。
  const urlPath = `/${key.split("/").map(encodePathSegment).join("/")}`;
  // 规范（签名）路径：在 URL 路径基础上把 ()!*' 再编码（SDK getEncodePath, encodeAll=true）。
  const canonicalPath = encodeSignedExtra(urlPath);

  const datetime = formatTosDateTime(now);
  const date8 = datetime.slice(0, 8);

  // GOTCHA #1：credential scope 的 region 位是 endpoint HOST（客户端构造时传入的 base
  // endpoint = tos-sdk 的 this.opts.endpoint），而不是 effectiveEndpoint——后者可能被
  // alternativeEndpoint（自定义域）覆盖，但 scope region 始终用 base endpoint。
  const scopeRegion = endpoint;
  const credentialScope = `${date8}/${scopeRegion}/tos/request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // 查询参数（插入序决定最终 URL；签名计算用排序后的规范串）。
  const query: Record<string, string> = {
    "X-Tos-Algorithm": "TOS4-HMAC-SHA256",
    "X-Tos-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Tos-Credential": credential,
    "X-Tos-Date": datetime,
    "X-Tos-Expires": String(expires),
    "X-Tos-SignedHeaders": "host",
  };

  // 规范查询：键排序、encodeURIComponent、& 连接，再应用 ()!*' 编码（SDK getEncodePath, encodeAll=false）。
  // 不含 X-Tos-Signature（签名在规范串之后计算）。
  const canonicalQuery = encodeSignedExtra(
    Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join("&"),
  );

  // 规范请求：六段，\n 连接。canonicalHeaders 行（"host:<host>"）后自带 \n，与 join 的 \n
  // 叠加形成 header 与 signedHeaders 之间的空行。
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "TOS4-HMAC-SHA256",
    datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // GOTCHA #2：secret 无前缀；kRegion 的 message 是 scopeRegion（= endpoint host）。
  const kDate = hmacBuffer(secretAccessKey, date8);
  const kRegion = hmacBuffer(kDate, scopeRegion);
  const kService = hmacBuffer(kRegion, "tos");
  const kSigning = hmacBuffer(kService, "request");
  const signature = hmacHex(kSigning, stringToSign);

  query["X-Tos-Signature"] = signature;

  // 最终 URL 查询：插入序（非排序），签名最后，仅 encodeURIComponent（不再 ()!*' 编码）。
  const queryString = Object.keys(query)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");

  return `https://${host}${urlPath}?${queryString}`;
}
