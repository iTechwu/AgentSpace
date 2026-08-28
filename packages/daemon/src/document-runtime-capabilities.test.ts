import assert from "node:assert/strict";
import test from "node:test";
import { buildDocumentRuntimeToolCapabilities } from "./document-runtime-capabilities.ts";

test("document runtime capabilities expose scoped Feishu lark-cli grants", () => {
  const capabilities = buildDocumentRuntimeToolCapabilities([], {
    feishuLarkCliResourceGrants: [{
      providerResourceType: "sheet",
      providerResourceToken: "shtcnABC123",
      allowedOperations: ["read"],
    }],
  });
  const feishuCapability = capabilities.find((capability) => capability.id === "document-permission:feishu-lark-cli");
  const patterns = capabilities.flatMap((capability) => capability.allowedShellPatterns);

  assert.ok(feishuCapability);
  assert.equal(feishuCapability.command, "lark-cli");
  assert.ok(feishuCapability.allowedShellPatterns.includes("lark-cli --version"));
  assert.ok(feishuCapability.allowedShellPatterns.includes("lark-cli sheets +csv-get *shtcnABC123*"));
  assert.equal(feishuCapability.allowedShellPatterns.some((pattern) => pattern.includes("+csv-put")), false);
  assert.equal(patterns.includes("dofe-agent output feishu data-operation-approval *"), false);
});

test("document runtime capabilities expose Feishu approval output only for writable grants", () => {
  const capabilities = buildDocumentRuntimeToolCapabilities([], {
    feishuLarkCliResourceGrants: [{
      providerResourceType: "sheet",
      providerResourceToken: "shtcnABC123",
      allowedOperations: ["read", "write"],
    }],
  });
  const patterns = capabilities.flatMap((capability) => capability.allowedShellPatterns);

  assert.ok(patterns.includes("dofe-agent output feishu data-operation-approval *"));
  assert.equal(patterns.some((pattern) => pattern.includes("+csv-put")), false);
});
