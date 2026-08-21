// 内联双语一致性静态扫描（P2 治理，见 docs/optimization-suggestions.md「i18n 无 key」）。
// `tx(zh, en)` 为内联双语文案函数：无字典可校验，TS 只能保证 arity。
// 本测试静态扫描 apps/web 下全部 tx() 调用点，兜底两类贴错文案的语义错误：
//   A. en 槽位整体是中文（复制粘贴漏改：无 ASCII 字母的纯 CJK 字符串）
//   B. zh 槽位无任何 CJK 且与 en 不同（两参写反/zh 槽放了英文）
// 动态参数（变量/表达式）无法静态判定，跳过；有意混排（如 en 中夹中文产品名）含 ASCII 字母，不受影响。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCAN_ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".turbo"]);
const CJK = /[㐀-䶿一-鿿\u3000-〿！-～]/;
const ASCII_LETTER = /[A-Za-z]/;
const LOCALE_CODE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)+$/; // zh-CN / en-US 等语言代码

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** 从 `tx(` 的 `(` 偏移做词法级括号配平，返回参数的源码文本数组；遇到语法不闭合返回 null。 */
function extractCallArgs(source: string, openParenIndex: number): string[] | null {
  const args: string[] = [];
  let current = "";
  // 深度语义：0=调用括号外，1=tx() 参数层，≥2=模板插值 ${} 内。
  // 注意 `}` 只在 quote 模式下且 depth>1 时视为插值闭合；模板正文里的字面 `}` 不会被误减。
  let depth = 1; // 调用括号本身不计入 current
  let i = openParenIndex + 1;
  let quote: '"' | "'" | "`" | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        if (i + 1 < source.length) current += source[i + 1];
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && source[i + 1] === "{") {
        depth += 1; // 进入模板插值表达式
        current += "{";
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "}" && depth > 1) {
        depth -= 1; // 插值表达式闭合
      } else if (ch === quote && depth === 1) {
        quote = null;
      } else if (quote !== "`" && ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
    }
    if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  return null;
}

/** 把参数源码还原成「可读文本」：字符串字面量去引号并反转义，模板字面量保留 ${} 占位符；非字面量返回 null。 */
function literalText(arg: string): string | null {
  const trimmed = arg.trim();
  const m = /^(`|"|')((?:.|\n)*)\1$/s.exec(trimmed);
  if (!m) return null;
  const [, q, raw] = m;
  if (q === "`") return raw; // 模板：保留 ${...} 占位符原样
  return raw.replace(/\\(.)/g, "$1");
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

interface Violation {
  file: string;
  line: number;
  rule: "A" | "B";
  zh: string;
  en: string;
}

function scanSource(relative: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const callRe = /(?<![.\w$])tx\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(source)) !== null) {
    const args = extractCallArgs(source, match.index + match[0].length - 1);
    if (!args || args.length < 2) continue;
    const zh = literalText(args[0]);
    const en = literalText(args[1]);
    if (zh === null || en === null) continue; // 动态参数，静态无法判定
    const line = lineOfIndex(source, match.index);
    if (CJK.test(en) && !ASCII_LETTER.test(en)) {
      violations.push({ file: relative, line, rule: "A", zh, en });
      continue;
    }
    // B 的三类合法豁免（现有代码中的正当模式，非贴错）：
    //  1) zh 含模板占位符 ${...}：数字/分页类文案（"x-y / z" vs "x-y of z"）本就无 CJK
    //  2) zh 与 en 忽略大小写相同：无需翻译的面板标签（"Bot Readiness"/"Bot readiness"）
    //  3) 语言代码标签（zh-CN / en-US）
    const exemptB =
      zh.includes("${")
      || zh.toLowerCase() === en.toLowerCase()
      || (LOCALE_CODE.test(zh) && LOCALE_CODE.test(en));
    if (!exemptB && !CJK.test(zh) && zh !== en) {
      violations.push({ file: relative, line, rule: "B", zh, en });
    }
  }
  return violations;
}

function countCallSites(source: string): number {
  const callRe = /(?<![.\w$])tx\s*\(/g;
  return (source.match(callRe) ?? []).length;
}

function scanFile(fullPath: string): Violation[] {
  const source = readFileSync(fullPath, "utf8");
  const relative = fullPath.slice(SCAN_ROOT.length + 1);
  return scanSource(relative, source);
}

describe("内联双语 tx(zh, en) 一致性扫描", () => {
  it("规则引擎自测：能命中贴错样本、放行合法样本", () => {
    const probe = `import { tx } from "@/features/i18n/language-provider";
const a = tx("保存", "保存");           // A：en 槽纯中文
const b = tx("Save changes", "Delete item"); // B：zh 槽无 CJK 且与 en 内容不符
const c = tx("保存更改", "Save changes"); // 合法
const d = tx("飞书集成", "Feishu (飞书) integration"); // 合法：en 混排含 ASCII
const e = tx(\`共 \${n} 条\`, \`\${n} items\`); // 合法：模板占位符
const f = tx(label, labelEn);        // 合法：动态参数
const g = prisma.tx("x", "y");       // 合法：成员调用不匹配
`;
    // 探针源码直接走单文件扫描逻辑（借 SCAN_ROOT 相对化前的原始输出）
    const hits = scanSource("probe.tsx", probe);
    expect(hits.map((v) => v.rule).sort()).toEqual(["A", "B"]);
  });

  it("apps/web 全量 tx() 调用点无贴错文案（A：en 槽纯中文 / B：zh 槽无中文且异于 en）", () => {
    const files = listSourceFiles(SCAN_ROOT).filter(
      (f) => !/inline-bilingual-consistency\.test\.ts$/.test(f),
    );
    let callSites = 0;
    const violations: Violation[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      callSites += countCallSites(source);
      violations.push(...scanFile(file));
    }
    // 扫描量下限：防「扫不到任何调用点」的空转绿灯（当前基线约 4200+）
    expect(callSites, "扫描到的 tx() 调用点数量异常偏低，疑似扫描器失效").toBeGreaterThan(3000);
    const rendered = violations
      .map((v) => `  [规则${v.rule}] ${v.file}:${v.line} zh=${JSON.stringify(v.zh)} en=${JSON.stringify(v.en)}`)
      .join("\n");
    expect(
      violations,
      `发现 ${violations.length} 处疑似贴错的双语文案：\n${rendered}`,
    ).toEqual([]);
  });
});
