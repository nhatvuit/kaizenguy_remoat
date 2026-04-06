import { TelegramChannel } from "../services/cdpBridgeManager";

export function channelKey(ch: TelegramChannel): string {
  return `${ch.chatId}:${ch.threadId || "0"}`;
}

export function stripHtmlForFile(html: string): string {
  let text = html;
  text = text.replace(
    /<pre><code\s+class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/gi,
    "```$1\n$2\n```"
  );
  text = text.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, "```\n$1\n```");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p>/gi, "");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<b>(.*?)<\/b>/gi, "**$1**");
  text = text.replace(/<strong>(.*?)<\/strong>/gi, "**$1**");
  text = text.replace(/<i>(.*?)<\/i>/gi, "*$1*");
  text = text.replace(/<em>(.*?)<\/em>/gi, "*$1*");
  text = text.replace(/<u>(.*?)<\/u>/gi, "__$1__");
  text = text.replace(/<s>(.*?)<\/s>/gi, "~~$1~~");
  text = text.replace(/<blockquote expandable>([\s\S]*?)<\/blockquote>/gi, "> Thinking...\n> $1");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
  return text.trim();
}
