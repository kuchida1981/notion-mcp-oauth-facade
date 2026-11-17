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
