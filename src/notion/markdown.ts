export interface NotionRichText {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: unknown;
}

export function richTextToMarkdown(richTexts: NotionRichText[] | undefined): string {
  if (!Array.isArray(richTexts) || richTexts.length === 0) return "";
  return richTexts
    .map((rt) => {
      let text = rt.plain_text ?? "";
      if (!text) return "";
      const ann = rt.annotations;
      if (ann?.code) text = `\`${text}\``;
      if (ann?.bold) text = `**${text}**`;
      if (ann?.italic) text = `*${text}*`;
      if (ann?.strikethrough) text = `~~${text}~~`;
      if (rt.href) text = `[${text}](${rt.href})`;
      return text;
    })
    .join("");
}

function getBlockRichText(block: NotionBlock, type: string): NotionRichText[] | undefined {
  const payload = block[type] as { rich_text?: NotionRichText[] } | undefined;
  return payload?.rich_text;
}

export function blocksToMarkdown(blocks: NotionBlock[], depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const block of blocks) {
    const t = block.type;
    const text = richTextToMarkdown(getBlockRichText(block, t));

    switch (t) {
      case "heading_1":
        lines.push(`${indent}# ${text}`);
        break;
      case "heading_2":
        lines.push(`${indent}## ${text}`);
        break;
      case "heading_3":
        lines.push(`${indent}### ${text}`);
        break;
      case "paragraph":
        lines.push(text ? `${indent}${text}` : "");
        break;
      case "bulleted_list_item":
      case "toggle":
        lines.push(`${indent}- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${text}`);
        break;
      case "to_do": {
        const payload = block.to_do as { checked?: boolean } | undefined;
        const mark = payload?.checked ? "x" : " ";
        lines.push(`${indent}- [${mark}] ${text}`);
        break;
      }
      case "code": {
        const payload = block.code as { language?: string } | undefined;
        const lang = payload?.language && payload.language !== "plain text" ? payload.language : "";
        lines.push(`${indent}\`\`\`${lang}`);
        lines.push(text);
        lines.push(`${indent}\`\`\``);
        break;
      }
      case "quote":
      case "callout":
        lines.push(`${indent}> ${text}`);
        break;
      case "divider":
        lines.push(`${indent}---`);
        break;
      default:
        if (text) {
          lines.push(`${indent}${text}`);
        } else {
          lines.push(`${indent}[${t}]`);
        }
        break;
    }

    if (Array.isArray(block.children) && block.children.length > 0) {
      lines.push(blocksToMarkdown(block.children, depth + 1));
    }
  }

  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return depth === 0 ? joined.trim() : joined;
}

function richText(content: string) {
  // Notion API の 1 text ブロック上限 (2000 文字) に配慮して分割
  const chunks: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < content.length; i += 2000) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + 2000) } });
  }
  return chunks.length > 0 ? chunks : [{ type: "text", text: { content: "" } }];
}

/** 基本的な Markdown テキストを Notion ブロック配列へ変換する */
export function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<Record<string, unknown>> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim() || "plain text";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // closing ```
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: richText(codeLines.join("\n")), language: lang },
      });
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: richText(trimmed.slice(4)) },
      });
      i++;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText(trimmed.slice(3)) },
      });
      i++;
      continue;
    }

    if (trimmed.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: richText(trimmed.slice(2)) },
      });
      i++;
      continue;
    }

    const todoMatch = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(trimmed);
    if (todoMatch) {
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          checked: todoMatch[1]!.toLowerCase() === "x",
          rich_text: richText(todoMatch[2]!),
        },
      });
      i++;
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(trimmed.slice(2)) },
      });
      i++;
      continue;
    }

    const numMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numMatch) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: richText(numMatch[1]!) },
      });
      i++;
      continue;
    }

    if (trimmed.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: richText(trimmed.slice(2)) },
      });
      i++;
      continue;
    }

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(line) },
    });
    i++;
  }

  return blocks;
}
