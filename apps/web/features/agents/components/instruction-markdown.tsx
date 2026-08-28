import type { ReactNode } from "react";

type MarkdownBlock =
  | { type: "heading"; level: number; content: string }
  | { type: "paragraph"; content: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "quote"; content: string }
  | { type: "code"; content: string };

/** A deliberately small, safe renderer for the role definition's Markdown. */
export function InstructionMarkdown({
  content,
  emptyLabel = "尚未编写工作说明。",
}: {
  content: string;
  emptyLabel?: string;
}) {
  const blocks = parseMarkdown(content);
  if (blocks.length === 0) {
    return <p className="agent-instructions__empty">{emptyLabel}</p>;
  }

  return (
    <div className="agent-instructions__markdown">
      {blocks.map((block, index) => <MarkdownBlockView block={block} key={`${block.type}-${index}`} />)}
    </div>
  );
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  if (block.type === "heading") {
    const Heading = block.level <= 1 ? "h2" : block.level === 2 ? "h3" : "h4";
    return <Heading>{renderInlineMarkdown(block.content)}</Heading>;
  }
  if (block.type === "paragraph") {
    return <p>{renderInlineMarkdown(block.content)}</p>;
  }
  if (block.type === "unordered-list") {
    return <ul>{block.items.map((item, index) => <li key={index}>{renderInlineMarkdown(item)}</li>)}</ul>;
  }
  if (block.type === "ordered-list") {
    return <ol>{block.items.map((item, index) => <li key={index}>{renderInlineMarkdown(item)}</li>)}</ol>;
  }
  if (block.type === "quote") {
    return <blockquote>{renderInlineMarkdown(block.content)}</blockquote>;
  }
  return <pre><code>{block.content}</code></pre>;
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!.trim();
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith("```")) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", content: codeLines.join("\n") });
      continue;
    }

    const markdownHeading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (markdownHeading) {
      blocks.push({ type: "heading", level: markdownHeading[1]!.length, content: markdownHeading[2]! });
      index += 1;
      continue;
    }

    if (isPlainSectionHeading(line, lines[index + 1])) {
      blocks.push({ type: "heading", level: 2, content: line });
      index += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index]!.trim())) {
        items.push(lines[index]!.trim().replace(/^[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index]!.trim())) {
        items.push(lines[index]!.trim().replace(/^\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    if (line.startsWith(">")) {
      blocks.push({ type: "quote", content: line.replace(/^>\s?/, "") });
      index += 1;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!.trim();
      if (!next || next.startsWith("```") || /^(#{1,4})\s+|^[-*+]\s+|^\d+[.)]\s+|^>/.test(next) || isPlainSectionHeading(next, lines[index + 1])) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ type: "paragraph", content: paragraph.join(" ") });
  }

  return blocks;
}

function isPlainSectionHeading(value: string, nextLine: string | undefined): boolean {
  const next = nextLine?.trim() ?? "";
  return value.length <= 18
    && !/[。！？；：:,.!?]$/.test(value)
    && Boolean(next)
    && !/^[-*+]\s+|^\d+[.)]\s+/.test(value);
}

function renderInlineMarkdown(value: string): ReactNode[] {
  const parts = value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}
