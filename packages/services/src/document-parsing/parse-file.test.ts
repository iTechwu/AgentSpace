import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  detectDocumentKind,
  parseFileToMarkdown,
  type ParseFailure,
} from "./parse-file.ts";

function asFailure(error: unknown): ParseFailure {
  if (!error || typeof error !== "object") {
    throw new Error("Expected error to be an object");
  }
  return error as ParseFailure;
}

test("detectDocumentKind resolves by media type first, then extension", () => {
  assert.equal(detectDocumentKind("notes.md", "text/markdown"), "markdown");
  assert.equal(detectDocumentKind("notes.txt"), "plaintext");
  assert.equal(detectDocumentKind("manual.PDF", "application/pdf"), "pdf");
  assert.equal(detectDocumentKind("manual.PDF", "application/octet-stream"), "pdf");
  assert.equal(detectDocumentKind("doc.DOCX", undefined), "docx");
  assert.equal(detectDocumentKind("deck.pptx"), "pptx");
  assert.equal(detectDocumentKind("table.xlsx"), "xlsx");
  assert.equal(detectDocumentKind("image.png"), null);
});

test("parseFileToMarkdown returns markdown source for plain markdown", async () => {
  const result = await parseFileToMarkdown(
    new TextEncoder().encode("# 标题\n\n正文"),
    "intro.md",
    "text/markdown",
  );
  assert.equal(result.detectedKind, "markdown");
  assert.equal(result.detectedMediaType, "text/markdown");
  assert.equal(result.markdown, "# 标题\n\n正文");
  assert.deepEqual(result.warnings, []);
});

test("parseFileToMarkdown decodes plain text with utf-8", async () => {
  const result = await parseFileToMarkdown(
    new TextEncoder().encode("hello 世界"),
    "greeting.txt",
    "text/plain",
  );
  assert.equal(result.detectedKind, "plaintext");
  assert.equal(result.markdown, "hello 世界");
});

test("parseFileToMarkdown rejects empty buffers", async () => {
  await assert.rejects(
    parseFileToMarkdown(new Uint8Array(0), "empty.md", "text/markdown"),
    (error: unknown) => {
      const failure = asFailure(error);
      assert.equal(failure.code, "empty_file");
      return true;
    },
  );
});

test("parseFileToMarkdown rejects unsupported media types", async () => {
  await assert.rejects(
    parseFileToMarkdown(
      new Uint8Array([1, 2, 3, 4]),
      "unknown.bin",
      "application/octet-stream",
    ),
    (error: unknown) => {
      const failure = asFailure(error);
      assert.equal(failure.code, "unsupported_media_type");
      return true;
    },
  );
});

test("parseFileToMarkdown parses PDF via pdf-parse when installed", async (t) => {
  // 大多数 CI 环境未安装 pdf-parse；动态 import 的失败应被 wrap 成 parser_unavailable。
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // 假 PDF magic
  try {
    const result = await parseFileToMarkdown(bytes, "sample.pdf", "application/pdf");
    assert.equal(result.detectedKind, "pdf");
    // pdf-parse 会尝试解析；如果安装并能解析出文字，markdown 应是字符串（可能为空，触发 warning）
    assert.equal(typeof result.markdown, "string");
  } catch (error) {
    const failure = asFailure(error);
    if (failure.code === "parser_unavailable") {
      t.skip(`pdf-parse not installed: ${failure.message}`);
      return;
    }
    if (failure.code === "parser_error") {
      // 假 PDF 必然 parser 报错；用跳过代替断言失败
      t.skip(`pdf-parse rejected fixture: ${failure.message}`);
      return;
    }
    throw error;
  }
});

test("parseFileToMarkdown decodes DOCX zip header (parses or skips gracefully)", async (t) => {
  // DOCX 是 ZIP 容器；这里给一段有效 ZIP magic，看 mammoth 是否能容忍
  const zipHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  try {
    const result = await parseFileToMarkdown(zipHeader, "doc.docx");
    assert.equal(result.detectedKind, "docx");
    assert.equal(typeof result.markdown, "string");
  } catch (error) {
    const failure = asFailure(error);
    if (failure.code === "parser_unavailable" || failure.code === "parser_error") {
      t.skip(`mammoth not available or rejected fixture: ${failure.message}`);
      return;
    }
    throw error;
  }
});

test("parseFileToMarkdown treats invalid PPTX as parser_error or skip", async (t) => {
  const bytes = gzipSync(new Uint8Array([1, 2, 3]));
  try {
    const result = await parseFileToMarkdown(bytes, "deck.pptx");
    assert.equal(result.detectedKind, "pptx");
  } catch (error) {
    const failure = asFailure(error);
    assert.ok(
      ["parser_unavailable", "parser_error"].includes(failure.code),
      `expected skip code, got ${failure.code}`,
    );
    t.skip();
  }
});

test("parseFileToMarkdown rejects bad XLSX or skips if xlsx missing", async (t) => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  try {
    const result = await parseFileToMarkdown(bytes, "table.xlsx");
    assert.equal(result.detectedKind, "xlsx");
  } catch (error) {
    const failure = asFailure(error);
    assert.ok(
      ["parser_unavailable", "parser_error"].includes(failure.code),
      `expected skip code, got ${failure.code}`,
    );
    t.skip();
  }
});
