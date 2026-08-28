/**
 * 把上传的二进制文件解析成 Markdown 文本，供知识库 / 文档页统一沉淀使用。
 *
 * 设计原则：
 * 1. 上层调用只依赖 `parseFileToMarkdown(bytes, fileName, mediaType?)`，
 *    不知道底层用了哪个解析库。
 * 2. 解析库（pdf-parse / mammoth / xlsx / pptx2json）通过动态 `import()` 引入，
 *    避免在 monorepo 其它路径上因为未安装依赖而无法启动。
 * 3. 不可解析 / 受密码保护 / 内容为空时返回 `markdown: ""` 并写入 `warnings`，
 *    仍然创建 attachment，让用户能下载源文件并手动处理。
 */

export type SupportedDocumentKind =
  | "markdown"
  | "plaintext"
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx";

export interface ParseResult {
  /** 解析后的 Markdown 文本；空字符串代表解析失败但仍保留附件。 */
  markdown: string;
  /** 解析过程中可恢复的告警（缺图、密码保护、表格截断等），不阻塞任务完成。 */
  warnings: string[];
  /** 实际命中的解析器种类；用于上游记录。 */
  detectedKind: SupportedDocumentKind;
  /** 实际命中的媒体类型；用于审计。 */
  detectedMediaType: string;
}

export interface ParseFailure extends Error {
  code: "unsupported_media_type" | "empty_file" | "parser_unavailable" | "parser_error";
  detectedKind?: SupportedDocumentKind;
  detectedMediaType?: string;
}

const MARKDOWN_MEDIA_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
]);

const PLAINTEXT_MEDIA_TYPES = new Set([
  "text/plain",
]);

const PDF_MEDIA_TYPES = new Set([
  "application/pdf",
]);

const DOCX_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const PPTX_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const XLSX_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const EXTENSION_KIND_MAP: Record<string, SupportedDocumentKind> = {
  md: "markdown",
  markdown: "markdown",
  txt: "plaintext",
  log: "plaintext",
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
};

export function detectDocumentKind(
  fileName: string,
  declaredMediaType?: string,
): SupportedDocumentKind | null {
  const mediaType = declaredMediaType?.toLowerCase().trim();
  if (mediaType) {
    if (MARKDOWN_MEDIA_TYPES.has(mediaType)) return "markdown";
    if (PLAINTEXT_MEDIA_TYPES.has(mediaType)) return "plaintext";
    if (PDF_MEDIA_TYPES.has(mediaType)) return "pdf";
    if (DOCX_MEDIA_TYPES.has(mediaType)) return "docx";
    if (PPTX_MEDIA_TYPES.has(mediaType)) return "pptx";
    if (XLSX_MEDIA_TYPES.has(mediaType)) return "xlsx";
  }
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_KIND_MAP[extension] ?? null;
}

export async function parseFileToMarkdown(
  bytes: Uint8Array,
  fileName: string,
  declaredMediaType?: string,
): Promise<ParseResult> {
  if (bytes.byteLength === 0) {
    const error: ParseFailure = Object.assign(
      new Error(`File "${fileName}" is empty.`),
      { code: "empty_file" as const },
    );
    throw error;
  }

  const kind = detectDocumentKind(fileName, declaredMediaType);
  if (!kind) {
    const error: ParseFailure = Object.assign(
      new Error(
        `Unsupported file type for "${fileName}" (mediaType=${declaredMediaType ?? "unknown"}). ` +
          `Supported: markdown, txt, pdf, docx, pptx, xlsx.`,
      ),
      {
        code: "unsupported_media_type" as const,
        detectedMediaType: declaredMediaType ?? "unknown",
      },
    );
    throw error;
  }

  switch (kind) {
    case "markdown":
      return {
        markdown: new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim(),
        warnings: [],
        detectedKind: kind,
        detectedMediaType: declaredMediaType ?? "text/markdown",
      };
    case "plaintext":
      return {
        markdown: new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim(),
        warnings: [],
        detectedKind: kind,
        detectedMediaType: declaredMediaType ?? "text/plain",
      };
    case "pdf":
      return parsePdf(bytes, fileName);
    case "docx":
      return parseDocx(bytes, fileName);
    case "pptx":
      return parsePptx(bytes, fileName);
    case "xlsx":
      return parseXlsx(bytes, fileName);
  }
}

async function parsePdf(bytes: Uint8Array, fileName: string): Promise<ParseResult> {
  // pdf-parse v2 改为命名导出 `PDFParse` 类：`new PDFParse({ data }).getText()`，
  // 不再是 v1 的默认导出函数 `pdfParse(buffer)`。
  const { PDFParse } = await loadOptionalDependency<{
    PDFParse: new (options: { data: Buffer | Uint8Array }) => {
      getText: () => Promise<{ text?: string }>;
      destroy: () => Promise<void>;
    };
  }>("pdf-parse", "PDF 解析");
  const parser = new PDFParse({ data: Buffer.from(bytes) });
  let markdown = "";
  try {
    const parsed = await parser.getText();
    markdown = (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
  } catch (error) {
    throw wrapParserError("pdf-parse", fileName, error);
  } finally {
    await parser.destroy().catch(() => {
      /* 销毁失败不阻塞已完成的解析结果 */
    });
  }
  return {
    markdown,
    warnings:
      markdown.length === 0
        ? [`PDF "${fileName}" 解析后无可用文字，可能为扫描件或受密码保护。`]
        : [],
    detectedKind: "pdf",
    detectedMediaType: "application/pdf",
  };
}

async function parseDocx(bytes: Uint8Array, fileName: string): Promise<ParseResult> {
  const { default: mammoth } = await loadOptionalDependency<{
    default: {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
      convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
    };
  }>("mammoth", "DOCX 解析");
  const buffer = Buffer.from(bytes);
  // 优先用 convertToMarkdown；mammoth 未直接暴露此方法，回退到 extractRawText 后做最小 Markdown 包装。
  const converter = (mammoth as unknown as { convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }> }).convertToMarkdown;
  let markdown = "";
  const warnings: string[] = [];
  if (typeof converter === "function") {
    const result = await converter({ buffer }).catch((error: unknown) => {
      throw wrapParserError("mammoth", fileName, error);
    });
    markdown = (result.value ?? "").trim();
    collectWarnings(result.messages, warnings);
  } else {
    const result = await mammoth.extractRawText({ buffer }).catch((error: unknown) => {
      throw wrapParserError("mammoth", fileName, error);
    });
    markdown = (result.value ?? "").trim();
    collectWarnings(result.messages, warnings);
  }
  return {
    markdown,
    warnings: markdown.length === 0
      ? [...warnings, `DOCX "${fileName}" 解析后无可用文字。`]
      : warnings,
    detectedKind: "docx",
    detectedMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

async function parsePptx(bytes: Uint8Array, fileName: string): Promise<ParseResult> {
  const pptxModule = await loadOptionalDependency<{
    default: (input: { name: string; data: Uint8Array | Buffer }) => Promise<unknown> | unknown;
  }>("pptx2json", "PPTX 解析");
  const data = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  let slideTree: unknown;
  try {
    slideTree = await pptxModule.default({ name: fileName, data });
  } catch (error) {
    throw wrapParserError("pptx2json", fileName, error);
  }

  const slides = Array.isArray((slideTree as { slides?: unknown[] }).slides)
    ? (slideTree as { slides: Array<Record<string, unknown>> }).slides
    : [];
  const warnings: string[] = [];
  const sections: string[] = [];
  slides.forEach((slide, index) => {
    const heading = `# Slide ${index + 1}`;
    const text = flattenPptxNode(slide).trim();
    if (text.length === 0) {
      warnings.push(`PPTX "${fileName}" 第 ${index + 1} 张幻灯片无可用文字。`);
      return;
    }
    sections.push(`${heading}\n\n${text}`);
  });
  const markdown = sections.join("\n\n---\n\n").trim();
  return {
    markdown,
    warnings,
    detectedKind: "pptx",
    detectedMediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
}

async function parseXlsx(bytes: Uint8Array, fileName: string): Promise<ParseResult> {
  const xlsxModule = await loadOptionalDependency<{
    read: (data: ArrayBuffer | Uint8Array, options?: { type?: "array" | "buffer" | "base64" }) => unknown;
    utils: {
      sheet_to_csv: (sheet: unknown) => string;
      sheet_to_json: (sheet: unknown, options?: { header?: number }) => unknown[][];
    };
  }>("xlsx", "XLSX 解析");
  let workbook: unknown;
  try {
    workbook = xlsxModule.read(bytes, { type: "buffer" });
  } catch (error) {
    throw wrapParserError("xlsx", fileName, error);
  }
  const sheetNames = (workbook as { SheetNames: string[] }).SheetNames ?? [];
  const warnings: string[] = [];
  const sections: string[] = [];
  for (const sheetName of sheetNames) {
    const sheet = (workbook as { Sheets: Record<string, unknown> }).Sheets[sheetName];
    if (!sheet) {
      warnings.push(`XLSX "${fileName}" 工作表 "${sheetName}" 缺失。`);
      continue;
    }
    let csv = "";
    try {
      csv = xlsxModule.utils.sheet_to_csv(sheet);
    } catch (error) {
      warnings.push(`XLSX "${fileName}" 工作表 "${sheetName}" 解析失败：${(error as Error).message}`);
      continue;
    }
    if (csv.trim().length === 0) {
      warnings.push(`XLSX "${fileName}" 工作表 "${sheetName}" 为空。`);
      continue;
    }
    const table = csvToMarkdownTable(csv);
    sections.push(`## Sheet: ${sheetName}\n\n${table}`);
  }
  const markdown = sections.join("\n\n").trim();
  return {
    markdown,
    warnings,
    detectedKind: "xlsx",
    detectedMediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

function flattenPptxNode(node: unknown, depth = 0): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((entry) => flattenPptxNode(entry, depth + 1)).join("\n");
  }
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    const ownText = typeof record.text === "string" ? record.text : "";
    const childText = flattenPptxNode(record.children ?? record.contents, depth + 1);
    const merged = [ownText, childText].filter((part) => part.length > 0).join("\n");
    return merged.replace(/\n{3,}/g, "\n\n");
  }
  return "";
}

function csvToMarkdownTable(csv: string): string {
  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "").trim()))
    .filter((cells) => cells.some((cell) => cell.length > 0));
  if (rows.length === 0) return "";
  const header = rows[0]!;
  const body = rows.slice(1);
  const headRow = `| ${header.map((cell) => cell || " ").join(" | ")} |`;
  const sepRow = `| ${header.map(() => "---").join(" | ")} |`;
  const bodyRows = body.map((cells) => {
    const padded = cells.length < header.length
      ? [...cells, ...Array(header.length - cells.length).fill("")]
      : cells;
    return `| ${padded.map((cell) => cell || " ").join(" | ")} |`;
  });
  return [headRow, sepRow, ...bodyRows].join("\n");
}

function collectWarnings(
  messages: ReadonlyArray<{ type: string; message: string }> | undefined,
  warnings: string[],
): void {
  if (!messages) return;
  for (const message of messages) {
    if (message.type === "warning") {
      warnings.push(message.message);
    }
  }
}

function wrapParserError(
  library: string,
  fileName: string,
  cause: unknown,
): ParseFailure {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const error: ParseFailure = Object.assign(
    new Error(`${library} failed on "${fileName}": ${reason}`),
    { code: "parser_error" as const },
  );
  return error;
}

async function loadOptionalDependency<T>(specifier: string, label: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failure: ParseFailure = Object.assign(
      new Error(
        `${label} 依赖 ${specifier} 未安装。请在 packages/services 执行 pnpm install 后重试：${reason}`,
      ),
      { code: "parser_unavailable" as const },
    );
    throw failure;
  }
}
