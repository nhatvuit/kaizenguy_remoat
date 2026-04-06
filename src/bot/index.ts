// @ts-nocheck
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import Database from "better-sqlite3";

import { t } from "../utils/i18n";
import { logger } from "../utils/logger";
import type { LogLevel } from "../utils/logger";
import { loadConfig, resolveResponseDeliveryMode } from "../utils/config";
import { ConfigLoader } from "../utils/configLoader";
import { parseMessageContent } from "../commands/messageParser";
import { SlashCommandHandler } from "../commands/slashCommandHandler";
import {
  CleanupCommandHandler,
  CLEANUP_ARCHIVE_BTN,
  CLEANUP_DELETE_BTN,
  CLEANUP_CANCEL_BTN,
} from "../commands/cleanupCommandHandler";

import {
  ModeService,
  AVAILABLE_MODES,
  MODE_DISPLAY_NAMES,
  MODE_DESCRIPTIONS,
  MODE_UI_NAMES,
} from "../services/modeService";
import { ModelService } from "../services/modelService";
import { TemplateRepository } from "../database/templateRepository";
import { WorkspaceBindingRepository } from "../database/workspaceBindingRepository";
import { ChatSessionRepository, ChatSessionRecord } from "../database/chatSessionRepository";
import { WorkspaceService } from "../services/workspaceService";
import { TelegramTopicManager } from "../services/telegramTopicManager";
import { TitleGeneratorService } from "../services/titleGeneratorService";

import { CdpService } from "../services/cdpService";
import { ChatSessionService } from "../services/chatSessionService";
import {
  ResponseMonitor,
  RESPONSE_SELECTORS,
} from "../services/responseMonitor";
import { ensureAntigravityRunning } from "../services/antigravityLauncher";
import { getAntigravityCdpHint } from "../utils/pathUtils";
import { AutoAcceptService } from "../services/autoAcceptService";
import { PromptDispatcher } from "../services/promptDispatcher";
import {
  CdpBridge,
  TelegramChannel,
  ensureApprovalDetector,
  ensureErrorPopupDetector,
  ensurePlanningDetector,
  getCurrentCdp,
  initCdpBridge,
  registerApprovalSessionChannel,
  registerApprovalWorkspaceChannel,
  parseApprovalCustomId,
  parseErrorPopupCustomId,
  parsePlanningCustomId,
} from "../services/cdpBridgeManager";
import {
  classifyAssistantSegments,
  extractAssistantSegmentsPayloadScript,
} from "../services/assistantDomExtractor";
import {
  buildModeModelLines,
  splitForEmbedDescription,
} from "../utils/streamMessageFormatter";
import {
  formatForTelegram,
  splitOutputAndLogs,
  escapeHtml,
  splitTelegramHtml,
} from "../utils/telegramFormatter";
// ProcessLogBuffer no longer used — progress display uses ordered event stream
import {
  buildPromptWithAttachmentUrls,

  downloadTelegramImages,
  InboundImageAttachment,
  isImageAttachment,
  toTelegramInputFile,
} from "../utils/imageHandler";
import {
  checkWhisperAvailability,
  downloadTelegramVoice,
  transcribeVoice,
} from "../utils/voiceHandler";
import { buildModeUI, sendModeUI } from "../ui/modeUi";
import { buildModelsUI, sendModelsUI } from "../ui/modelsUi";
import {
  sendTemplateUI,
  TEMPLATE_BTN_PREFIX,
  parseTemplateButtonId,
} from "../ui/templateUi";
import {
  sendAutoAcceptUI,
  AUTOACCEPT_BTN_ON,
  AUTOACCEPT_BTN_OFF,
  AUTOACCEPT_BTN_REFRESH,
} from "../ui/autoAcceptUi";
import { handleScreenshot } from "../ui/screenshotUi";
import { startNotificationService } from "../services/notificationService";
import { ScheduleRepository } from "../database/scheduleRepository";
import { ScheduleService } from "../services/scheduleService";
import {
  buildProjectListUI,
  PROJECT_SELECT_ID,
  PROJECT_PAGE_PREFIX,
  parseProjectPageId,
} from "../ui/projectListUi";
import {
  buildSessionPickerUI,
  SESSION_SELECT_ID,
  isSessionSelectId,
} from "../ui/sessionPickerUi";
import {
  PLAN_VIEW_BTN,
  PLAN_PROCEED_BTN,
  PLAN_EDIT_BTN,
  PLAN_REFRESH_BTN,
  PLAN_PAGE_PREFIX,
  buildPlanNotificationUI,
  buildPlanContentUI,
  paginatePlanContent,
} from "../ui/planUi";
import { channelKey } from "./helpers";

const PHASE_ICONS = {
  sending: "📡",
  thinking: "🧠",
  generating: "✍️",
  complete: "✅",
  timeout: "⏰",
  error: "❌",
} as const;

const MAX_OUTBOUND_GENERATED_IMAGES = 4;
const TELEGRAM_MSG_LIMIT = 4096;
const MAX_INLINE_CHUNKS = 5;

/** Convert Telegram HTML back to readable Markdown for .md file attachment */
function stripHtmlForFile(html: string): string {
  let text = html;
  // Code blocks: <pre><code class="language-X">...</code></pre> → ```X\n...\n```
  text = text.replace(
    /<pre>\s*<code\s+class="language-([^"]*)">([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, lang, content) => `\n\`\`\`${lang}\n${content}\n\`\`\`\n`,
  );
  // Code blocks: <pre>...</pre> → ```\n...\n```
  text = text.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_m, content) => `\n\`\`\`\n${content}\n\`\`\`\n`,
  );
  // Inline code
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  // Bold
  text = text.replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**");
  // Italic
  text = text.replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*");
  // Strikethrough
  text = text.replace(/<s>([\s\S]*?)<\/s>/gi, "~~$1~~");
  // Links
  text = text.replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi, "[$2]($1)");
  // Blockquotes
  text = text.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_m, content) =>
      content
        .split("\n")
        .map((l: string) => `> ${l}`)
        .join("\n"),
  );
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  // Collapse excessive newlines
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

const userStopRequestedChannels = new Set<string>();

/** Channels where the user is expected to type plan edit instructions */
const planEditPendingChannels = new Map<string, { projectName: string }>();
/** Cached plan content pages per channel */
const planContentCache = new Map<string, string[]>();



function createSerialTaskQueue(
  queueName: string,
  traceId: string,
): (task: () => Promise<void>, label?: string) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  let taskSeq = 0;

  return (
    task: () => Promise<void>,
    label: string = "queue-task",
  ): Promise<void> => {
    taskSeq += 1;
    const seq = taskSeq;

    queue = queue.then(async () => {
      try {
        await task();
      } catch (err: any) {
        logger.error(
          `[sendQueue:${traceId}:${queueName}] error #${seq} label=${label}:`,
          err?.message || err,
        );
      }
    });

    return queue;
  };
}

async function sendPromptToAntigravity(
  bridge: CdpBridge,
  channel: TelegramChannel,
  prompt: string,
  cdp: CdpService,
  modeService: ModeService,
  modelService: ModelService,
  inboundImages: InboundImageAttachment[] = [],
  options?: {
    chatSessionService: ChatSessionService;
    chatSessionRepo: ChatSessionRepository;
    topicManager: TelegramTopicManager;
    titleGenerator: TitleGeneratorService;
  },
): Promise<void> {
  const api = bridge.botApi!;
  const monitorTraceId = channelKey(channel);
  const enqueueGeneral = createSerialTaskQueue("general", monitorTraceId);
  const enqueueResponse = createSerialTaskQueue("response", monitorTraceId);
  const enqueueActivity = createSerialTaskQueue("activity", monitorTraceId);

  const sendMsg = async (text: string): Promise<number | null> => {
    try {
      const truncated =
        text.length > TELEGRAM_MSG_LIMIT
          ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + "\n...(truncated)"
          : text;
      const msg = await api.sendMessage(channel.chatId, truncated, {
        parse_mode: "HTML",
        message_thread_id: channel.threadId,
      });
      return msg.message_id;
    } catch (e: any) {
      // [KaizenGuy] Fallback: if HTML parse fails, retry with plain text
      const desc = e?.description || e?.message || "";
      if (
        desc.includes("can't parse entities") ||
        desc.includes("parse entities")
      ) {
        logger.warn("[sendMsg] HTML parse failed, retrying as plain text");
        try {
          const plain = text
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"');
          const truncated =
            plain.length > TELEGRAM_MSG_LIMIT
              ? plain.slice(0, TELEGRAM_MSG_LIMIT - 20) + "\n...(truncated)"
              : plain;
          const msg = await api.sendMessage(channel.chatId, truncated, {
            message_thread_id: channel.threadId,
          });
          return msg.message_id;
        } catch (e2) {
          logger.error("[sendMsg] Plain text fallback also failed:", e2);
          return null;
        }
      }
      logger.error("[sendMsg] Failed:", e);
      return null;
    }
  };

  const editMsg = async (msgId: number, text: string): Promise<void> => {
    try {
      const truncated =
        text.length > TELEGRAM_MSG_LIMIT
          ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + "\n...(truncated)"
          : text;
      await api.editMessageText(channel.chatId, msgId, truncated, {
        parse_mode: "HTML",
      });
    } catch (e: any) {
      const desc = e?.description || e?.message || "";
      if (!desc.includes("message is not modified")) {
        logger.error("[editMsg] Failed:", desc);
      }
    }
  };

  const sendEmbed = (title: string, description: string): Promise<void> =>
    enqueueGeneral(async () => {
      const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(description)}`;
      await sendMsg(text);
    }, "send-embed");

  /** Send a potentially long response, splitting into chunks and attaching a .md file if needed. */
  const sendChunkedResponse = async (
    title: string,
    footer: string,
    rawBody: string,
    isAlreadyHtml: boolean,
  ): Promise<void> => {
    const formattedBody = isAlreadyHtml ? rawBody : formatForTelegram(rawBody);
    const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : "";
    const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : "";
    const fullMsg = `${titleLine}${formattedBody}${footerLine}`;

    if (fullMsg.length <= TELEGRAM_MSG_LIMIT) {
      await upsertLiveResponse(title, rawBody, footer, {
        expectedVersion: liveResponseUpdateVersion,
        isAlreadyHtml,
        skipTruncation: true,
      });
      return;
    }

    const bodyChunks = splitTelegramHtml(
      formattedBody,
      TELEGRAM_MSG_LIMIT - 200,
    );
    const inlineCount = Math.min(bodyChunks.length, MAX_INLINE_CHUNKS);
    const hasFile = bodyChunks.length > MAX_INLINE_CHUNKS;
    const total = hasFile ? inlineCount : bodyChunks.length;

    for (let pi = 0; pi < inlineCount; pi++) {
      const partLabel = hasFile
        ? `(${pi + 1}/${inlineCount}+file)`
        : `(${pi + 1}/${total})`;
      if (pi === 0) {
        const firstTitle = title ? `${title} ${partLabel}` : partLabel;
        await upsertLiveResponse(firstTitle, bodyChunks[pi], footer, {
          expectedVersion: liveResponseUpdateVersion,
          isAlreadyHtml: true,
          skipTruncation: true,
        });
      } else {
        const partFooter = footer
          ? `${escapeHtml(footer)} ${partLabel}`
          : partLabel;
        await sendMsg(`${bodyChunks[pi]}\n\n<i>${partFooter}</i>`);
      }
    }

    if (hasFile) {
      try {
        const fileContent = stripHtmlForFile(formattedBody);
        const buf = Buffer.from(fileContent, "utf-8");
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);
        await api.sendDocument(
          channel.chatId,
          new InputFile(buf, `response-${timestamp}.md`),
          {
            caption: `📄 Full response (${rawBody.length} chars)`,
            message_thread_id: channel.threadId,
          },
        );
      } catch (e) {
        logger.error("[sendPrompt] Failed to send response file:", e);
      }
    }
  };

  if (!cdp.isConnected()) {
    await sendEmbed(
      `${PHASE_ICONS.error} Connection Error`,
      `Not connected to Antigravity.\nStart with \`${getAntigravityCdpHint(9223)}\`, then send a message to auto-connect.`,
    );
    return;
  }

  const localMode = modeService.getCurrentMode();
  const modeName = MODE_UI_NAMES[localMode] || localMode;
  const currentModel =
    (await cdp.getCurrentModel()) || modelService.getCurrentModel();
  const modelLabel = `${currentModel}`;

  // [KaizenGuy] Read disableProgressLog config
  const appConfig = loadConfig();
  const skipProgress = appConfig.disableProgressLog;

  // Initialize live progress message (replaces separate "Sending" embed)
  let liveActivityMsgId: number | null = null;
  if (!skipProgress) {
    try {
      const sendingText = `<b>${PHASE_ICONS.sending} ${escapeHtml(modeName)} · ${escapeHtml(modelLabel)}</b>\n\n<i>Sending...</i>`;
      const sendingMsg = await api.sendMessage(channel.chatId, sendingText, {
        parse_mode: "HTML",
        message_thread_id: channel.threadId,
      });
      liveActivityMsgId = sendingMsg.message_id;
    } catch (e) {
      logger.error("[sendPrompt] Failed to send initial status:", e);
    }
  }

  let isFinalized = false;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let lastProgressText = "";
  const LIVE_RESPONSE_MAX_LEN = 3800;
  const MAX_PROGRESS_BODY = 3500;
  const MAX_PROGRESS_ENTRIES = 60;
  let liveResponseMsgId: number | null = null;
  let lastLiveResponseKey = "";
  let lastLiveActivityKey = "";
  let liveResponseUpdateVersion = 0;
  let liveActivityUpdateVersion = 0;

  // --- Ordered progress event stream ---
  interface ProgressEntry {
    kind: "thought" | "thought-content" | "activity";
    text: string;
  }
  const progressLog: ProgressEntry[] = [];
  let thinkingActive = false;
  const thinkingContentParts: string[] = [];
  let lastThoughtLabel = "";

  /** Check if text is junk (numbers, very short, not meaningful) */
  const isJunkEntry = (text: string): boolean => {
    const t = text.trim();
    if (t.length < 5) return true;
    if (/^\d+$/.test(t)) return true;
    // Single word under 8 chars without context (e.g. "Analyzed" alone)
    if (!/\s/.test(t) && t.length < 8) return true;
    return false;
  };

  /** Format a single activity line — collapse multi-line text into one line */
  const formatActivityLine = (raw: string): string => {
    // Collapse newlines into spaces so file references after verbs aren't lost
    // e.g. "Analyzed\npackage.json#L1-75" → "Analyzed package.json#L1-75"
    const collapsed = (raw || "")
      .replace(/\n+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!collapsed || isJunkEntry(collapsed)) return "";
    return escapeHtml(collapsed.slice(0, 120));
  };

  /** Trim progress log to stay within size limits */
  const trimProgressLog = (): void => {
    while (progressLog.length > MAX_PROGRESS_ENTRIES) progressLog.shift();
  };

  /** Build the progress message body from the ordered event stream */
  const buildProgressBody = (): string => {
    const lines: string[] = [];
    for (const e of progressLog) {
      switch (e.kind) {
        case "thought":
          lines.push(`💭 <i>${escapeHtml(e.text)}</i>`);
          break;
        case "thought-content":
          lines.push(`<i>${escapeHtml(e.text)}</i>`);
          break;
        case "activity":
          lines.push(e.text); // already HTML-escaped
          break;
      }
    }
    if (thinkingActive) {
      lines.push("💭 <i>Thinking...</i>");
    }
    // Use \n\n for spacing between entries (like Antigravity's line gap)
    let body = lines.join("\n\n");
    // Trim from beginning if too long, keeping most recent events
    if (body.length > MAX_PROGRESS_BODY) {
      body = "...\n\n" + body.slice(-MAX_PROGRESS_BODY + 5);
    }
    return body || "<i>Generating...</i>";
  };

  /** Build full progress message with title + body + footer */
  const buildProgressMessage = (title: string, footer: string): string => {
    const body = buildProgressBody();
    const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : "";
    return `<b>${escapeHtml(title)}</b>\n\n${body}${footerLine}`;
  };

  const buildLiveResponseText = (
    title: string,
    rawText: string,
    footer: string,
    isAlreadyHtml = false,
    skipTruncation = false,
  ): string => {
    const normalized = (rawText || "").trim();
    const body = normalized
      ? isAlreadyHtml
        ? normalized
        : formatForTelegram(normalized)
      : t("Generating...");
    const truncated =
      !skipTruncation && body.length > LIVE_RESPONSE_MAX_LEN
        ? "...(beginning truncated)\n" + body.slice(-LIVE_RESPONSE_MAX_LEN + 30)
        : body;
    const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : "";
    const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : "";
    return `${titleLine}${truncated}${footerLine}`;
  };

  const upsertLiveResponse = (
    title: string,
    rawText: string,
    footer: string,
    opts?: {
      expectedVersion?: number;
      skipWhenFinalized?: boolean;
      isAlreadyHtml?: boolean;
      skipTruncation?: boolean;
    },
  ): Promise<void> =>
    enqueueResponse(async () => {
      if (opts?.skipWhenFinalized && isFinalized) return;
      if (
        opts?.expectedVersion !== undefined &&
        opts.expectedVersion !== liveResponseUpdateVersion
      )
        return;
      const text = buildLiveResponseText(
        title,
        rawText,
        footer,
        opts?.isAlreadyHtml,
        opts?.skipTruncation,
      );
      const renderKey = `${title}|${rawText.slice(0, 200)}|${footer}`;
      if (renderKey === lastLiveResponseKey && liveResponseMsgId) return;
      lastLiveResponseKey = renderKey;

      if (liveResponseMsgId) {
        await editMsg(liveResponseMsgId, text);
      } else {
        liveResponseMsgId = await sendMsg(text);
      }
    }, "upsert-response");

  /** Refresh progress message using the ordered event stream */
  const refreshProgress = (
    title: string,
    footer: string,
    opts?: { expectedVersion?: number; skipWhenFinalized?: boolean },
  ): Promise<void> =>
    enqueueActivity(async () => {
      if (opts?.skipWhenFinalized && isFinalized) return;
      if (
        opts?.expectedVersion !== undefined &&
        opts.expectedVersion !== liveActivityUpdateVersion
      )
        return;
      const text = buildProgressMessage(title, footer);
      // Use progress body hash for dedup
      const bodySnap =
        progressLog.length + "|" + thinkingActive + "|" + title + "|" + footer;
      if (bodySnap === lastLiveActivityKey && liveActivityMsgId) return;
      lastLiveActivityKey = bodySnap;

      if (liveActivityMsgId) {
        await editMsg(liveActivityMsgId, text);
      } else {
        liveActivityMsgId = await sendMsg(text);
      }
    }, "upsert-activity");

  /** Direct message update for special cases (completion, quota, timeout) */
  const setProgressMessage = (
    htmlContent: string,
    opts?: { expectedVersion?: number },
  ): Promise<void> =>
    enqueueActivity(async () => {
      if (
        opts?.expectedVersion !== undefined &&
        opts.expectedVersion !== liveActivityUpdateVersion
      )
        return;
      lastLiveActivityKey = htmlContent.slice(0, 200);
      if (liveActivityMsgId) {
        await editMsg(liveActivityMsgId, htmlContent);
      } else {
        liveActivityMsgId = await sendMsg(htmlContent);
      }
    }, "upsert-activity");

  const sendGeneratedImages = async (responseText: string): Promise<void> => {
    const imageIntentPattern =
      /(image|images|png|jpg|jpeg|gif|webp|illustration|diagram|render)/i;
    const imageUrlPattern = /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp)/i;
    if (
      !imageIntentPattern.test(prompt) &&
      !responseText.includes("![") &&
      !imageUrlPattern.test(responseText)
    )
      return;

    const extracted = await cdp.extractLatestResponseImages(
      MAX_OUTBOUND_GENERATED_IMAGES,
    );
    if (extracted.length === 0) return;

    for (let i = 0; i < extracted.length; i++) {
      const file = await toTelegramInputFile(extracted[i], i);
      if (file) {
        try {
          await api.sendPhoto(
            channel.chatId,
            new InputFile(file.buffer, file.name),
            {
              caption: `🖼️ Generated image (${i + 1}/${extracted.length})`,
              message_thread_id: channel.threadId,
            },
          );
        } catch (e) {
          logger.error("[sendGeneratedImages] Failed:", e);
        }
      }
    }
  };

  const tryEmergencyExtractText = async (): Promise<string> => {
    try {
      const contextId = cdp.getPrimaryContextId();
      const expression = `(() => {
                const panel = document.querySelector('.antigravity-agent-side-panel');
                const scope = panel || document;
                const candidateSelectors = ['.rendered-markdown', '.leading-relaxed.select-text', '.flex.flex-col.gap-y-3', '[data-message-author-role="assistant"]', '[data-message-role="assistant"]', '[class*="assistant-message"]', '[class*="message-content"]', '[class*="markdown-body"]', '.prose'];
                const looksLikeActivity = (text) => { const n = (text || '').trim().toLowerCase(); if (!n) return true; return /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|analyzed|read|wrote|ran)/i.test(n) && n.length <= 220; };
                const clean = (text) => (text || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
                const candidates = []; const seen = new Set();
                for (const selector of candidateSelectors) { const nodes = scope.querySelectorAll(selector); for (const node of nodes) { if (!node || seen.has(node)) continue; seen.add(node); candidates.push(node); } }
                for (let i = candidates.length - 1; i >= 0; i--) { const node = candidates[i]; const text = clean(node.innerText || node.textContent || ''); if (!text || text.length < 20) continue; if (looksLikeActivity(text)) continue; if (/^(good|bad)$/i.test(text)) continue; return text; }
                return '';
            })()`;
      const callParams: Record<string, unknown> = {
        expression,
        returnByValue: true,
        awaitPromise: true,
      };
      if (contextId !== null) callParams.contextId = contextId;
      const res = await cdp.call("Runtime.evaluate", callParams);
      const value = res?.result?.value;
      return typeof value === "string" ? value.trim() : "";
    } catch {
      return "";
    }
  };

  let monitor: ResponseMonitor | null = null;

  try {
    // [KaizenGuy] Forum Topic: switch to correct conversation INSIDE the lock
    // This ensures no concurrent switch while another prompt is being processed.
    if (channel.threadId && options?.chatSessionRepo) {
      const topicSession = options.chatSessionRepo.findByTopicId(channel.threadId);
      if (topicSession?.displayName && options.chatSessionService) {
        const switchResult = await options.chatSessionService.activateSessionByTitle(
          cdp, topicSession.displayName,
        );
        if (!switchResult.ok) {
          logger.warn(`[sendPrompt] Forum topic switch failed for "${topicSession.displayName}": ${switchResult.error}`);
          await sendEmbed(
            `⚠️ Switch Failed`,
            `Could not switch to "${topicSession.displayName}": ${switchResult.error}`,
          );
          isFinalized = true;
          return;
        }
        logger.info(`[sendPrompt] Switched to conversation "${topicSession.displayName}" for topic ${channel.threadId}`);
      }
    }

    // [KaizenGuy] Append Telegram delivery hint so the agent knows output
    // will be displayed on Telegram and can format response accordingly.
    // We pass chat_id and topic_id if available, so agent can route notifications properly.
    let TELEGRAM_HINT = `\n\n[remoat:telegram]`;
    if (channel.threadId && channel.chatId === loadConfig().forumGroupId) {
      TELEGRAM_HINT = `\n\n[remoat:telegram:chat=${channel.chatId}:topic=${channel.threadId}]`;
    }

    const hintedPrompt = loadConfig().enableTelegramHint
      ? prompt + TELEGRAM_HINT
      : prompt;

    let injectResult;
    if (inboundImages.length > 0) {
      injectResult = await cdp.injectMessageWithImageFiles(
        hintedPrompt,
        inboundImages.map((i) => i.localPath),
      );
      if (!injectResult.ok) {
        await sendEmbed(
          t("🖼️ Attached image fallback"),
          t("Failed to attach image directly, resending via URL reference."),
        );
        injectResult = await cdp.injectMessage(
          buildPromptWithAttachmentUrls(hintedPrompt, inboundImages),
        );
      }
    } else {
      injectResult = await cdp.injectMessage(hintedPrompt);
    }

    if (!injectResult.ok) {
      isFinalized = true;
      await sendEmbed(
        `${PHASE_ICONS.error} Message Injection Failed`,
        `Failed to send message: ${injectResult.error}`,
      );
      return;
    }

    const startTime = Date.now();
    const progressTitle = () => `${PHASE_ICONS.thinking} ${modelLabel}`;
    const progressFooter = () =>
      `⏱️ ${Math.round((Date.now() - startTime) / 1000)}s`;

    /** Trigger a progress message refresh */
    const triggerProgressRefresh = (): void => {
      liveActivityUpdateVersion += 1;
      const v = liveActivityUpdateVersion;
      refreshProgress(progressTitle(), progressFooter(), {
        expectedVersion: v,
        skipWhenFinalized: true,
      }).catch(() => {});
    };

    await (skipProgress
      ? Promise.resolve()
      : refreshProgress(progressTitle(), progressFooter()));

    // [KaizenGuy] Event-Driven Architecture bypass:
    // Instead of waiting for DOM via ResponseMonitor, we wait 4s and release immediately.
    // The Agent is entirely responsible for calling /notify.
    if (!loadConfig().useTopics || channel.chatId === loadConfig().forumGroupId) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      isFinalized = true;
      userStopRequestedChannels.delete(channelKey(channel));
      // Xóa tin nhắn "Thinking..." do mình chèn lúc nãy đi để sạch giao diện Tele
      if (liveActivityMsgId) {
        try {
          await api.deleteMessage(channel.chatId, liveActivityMsgId);
        } catch (e) {}
      }
      return;
    }

    await new Promise<void>((resolve) => {
      let isResolved = false;
      const finish = () => {
        if (!isResolved) {
          isResolved = true;
          resolve();
        }
      };

      monitor = new ResponseMonitor({
        cdpService: cdp,
        pollIntervalMs: 2000,
      maxDurationMs: 1800000,
      stopGoneConfirmCount: 3,
      onPhaseChange: () => {},
      onProcessLog: (logText) => {
        if (isFinalized || skipProgress) return;
        const trimmed = (logText || "").trim();
        if (!trimmed || isJunkEntry(trimmed)) return;
        const formatted = formatActivityLine(trimmed);
        if (formatted) {
          progressLog.push({ kind: "activity", text: formatted });
          trimProgressLog();
          triggerProgressRefresh();
        }
      },
      onThinkingLog: (thinkingText) => {
        if (isFinalized || skipProgress) return;
        const trimmed = (thinkingText || "").trim();
        if (!trimmed) return;
        logger.debug("[Bot] onThinkingLog received:", trimmed.slice(0, 100));

        const stripped = trimmed.replace(/^[^a-zA-Z]+/, "");

        if (/^thinking\.{0,3}$/i.test(stripped)) {
          // Transient "Thinking..." — just set flag, don't add entry
          thinkingActive = true;
        } else if (/^thought for\s/i.test(stripped)) {
          // Completed thinking cycle: "Thought for 1s"
          thinkingActive = false;
          lastThoughtLabel = trimmed;
          progressLog.push({ kind: "thought", text: trimmed });
          trimProgressLog();
        } else {
          // Thinking content — merge as summary with most recent 'thought' entry
          thinkingContentParts.push(trimmed);
          const firstLine = trimmed.split("\n")[0].trim();
          const heading =
            firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
          // Find most recent thought entry that doesn't yet have content attached
          let merged = false;
          for (let i = progressLog.length - 1; i >= 0; i--) {
            if (progressLog[i].kind === "thought") {
              // Only merge if no content heading attached yet (no " — ")
              if (!progressLog[i].text.includes(" — ")) {
                progressLog[i].text += ` — ${heading}`;
                merged = true;
              }
              break;
            }
          }
          if (!merged && heading.length > 10) {
            // No thought label to merge into — show as standalone content
            progressLog.push({ kind: "thought-content", text: heading });
            trimProgressLog();
          }
        }
        triggerProgressRefresh();
      },
      onProgress: (text) => {
        if (isFinalized) return;
        const isStructured =
          monitor?.getLastExtractionSource() === "structured";
        const separated = isStructured
          ? { output: text, logs: "" }
          : splitOutputAndLogs(text);
        if (separated.output && separated.output.trim().length > 0)
          lastProgressText = separated.output;
      },
      onComplete: async (finalText, meta) => {
        if (isFinalized) return; // Guard: prevent duplicate completion
        isFinalized = true;
        if (elapsedTimer) {
          clearInterval(elapsedTimer);
          elapsedTimer = null;
        }
        const wasStoppedByUser = userStopRequestedChannels.delete(
          channelKey(channel),
        );
        if (wasStoppedByUser) {
          logger.info(`[sendPrompt:${monitorTraceId}] Stopped by user`);
          await sendMsg("⏹️ Generation stopped.");
          finish();
          return;
        }

        try {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const isQuotaError =
            monitor!.getPhase() === "quotaReached" ||
            monitor!.getQuotaDetected();

          if (isQuotaError) {
            liveActivityUpdateVersion += 1;
            thinkingActive = false;
            await setProgressMessage(
              `<b>⚠️ ${escapeHtml(modelLabel)} · Quota Reached</b>\n\n${buildProgressBody()}\n\n<i>⏱️ ${elapsed}s</i>`,
              { expectedVersion: liveActivityUpdateVersion },
            );
            liveResponseUpdateVersion += 1;
            await upsertLiveResponse(
              "⚠️ Quota Reached",
              "Model quota limit reached. Please wait or switch to a different model.",
              `⏱️ ${elapsed}s`,
              { expectedVersion: liveResponseUpdateVersion },
            );

            try {
              const payload = await buildModelsUI(cdp, () =>
                bridge.quota.fetchQuota(),
              );
              if (payload) {
                await api.sendMessage(channel.chatId, payload.text, {
                  parse_mode: "HTML",
                  message_thread_id: channel.threadId,
                  reply_markup: payload.keyboard,
                });
              }
            } catch (e) {
              logger.error("[Quota] Failed to send model selection UI:", e);
            }
            return;
          }

          // Fresh DOM re-extraction at completion time to ensure we get the
          // complete response — polling may have captured partial/stale text.
          let freshText = "";
          let freshIsHtml = false;
          try {
            const contextId = cdp.getPrimaryContextId();
            const evalParams: Record<string, unknown> = {
              expression: extractAssistantSegmentsPayloadScript(),
              returnByValue: true,
              awaitPromise: true,
            };
            if (contextId !== null && contextId !== undefined)
              evalParams.contextId = contextId;
            const freshResult = await cdp.call("Runtime.evaluate", evalParams);
            const freshClassified = classifyAssistantSegments(
              freshResult?.result?.value,
            );
            if (
              freshClassified.diagnostics.source === "dom-structured" &&
              freshClassified.finalOutputText.trim()
            ) {
              freshText = freshClassified.finalOutputText.trim();
              freshIsHtml = true;
            }
          } catch (e) {
            logger.debug("[onComplete] Fresh structured extraction failed:", e);
          }

          // Pick the best text: fresh extraction > polled finalText > lastProgressText > emergency
          const polledText =
            finalText && finalText.trim().length > 0
              ? finalText
              : lastProgressText;
          const bestPolled =
            polledText && polledText.trim().length > 0 ? polledText : "";
          // Prefer the fresh extraction if it's at least as long (more complete)
          let finalResponseText: string;
          let isAlreadyHtml: boolean;
          if (freshText && freshText.length >= bestPolled.length) {
            finalResponseText = freshText;
            isAlreadyHtml = freshIsHtml;
          } else if (bestPolled) {
            finalResponseText = bestPolled;
            isAlreadyHtml = meta?.source === "structured";
          } else {
            const emergencyText = await tryEmergencyExtractText();
            finalResponseText = emergencyText;
            isAlreadyHtml = false;
          }
          const separated = isAlreadyHtml
            ? { output: finalResponseText, logs: "" }
            : splitOutputAndLogs(finalResponseText);
          const finalOutputText = separated.output || finalResponseText;

          // Send collapsible thinking block as a separate message before the response.
          // Extract both label and content directly from DOM at completion time,
          // so we don't depend on polling (2s interval) having captured thinking events.
          if (!skipProgress) {
            try {
              const thinkExtract = await cdp.call("Runtime.evaluate", {
                expression: `(function() {
                                var panel = document.querySelector('.antigravity-agent-side-panel');
                                var scope = panel || document;
                                var details = scope.querySelectorAll('details');
                                var blocks = [];
                                for (var i = 0; i < details.length; i++) {
                                    var d = details[i];
                                    var summary = d.querySelector('summary');
                                    if (!summary) continue;
                                    var rawLabel = (summary.textContent || '').trim();
                                    var stripped = rawLabel.replace(/^[^a-zA-Z]+/, '');
                                    if (!/^(?:thought for|thinking)\\b/i.test(stripped)) continue;
                                    var wasOpen = d.open;
                                    if (!wasOpen) d.open = true;
                                    // Try children first, then fall back to full textContent minus summary
                                    var children = d.children;
                                    var parts = [];
                                    for (var c = 0; c < children.length; c++) {
                                        if (children[c].tagName === 'SUMMARY' || children[c].tagName === 'STYLE') continue;
                                        var t = (children[c].innerText || children[c].textContent || '').trim();
                                        if (t && t.length >= 5) parts.push(t);
                                    }
                                    // Fallback: use detail's full text minus the summary text
                                    if (parts.length === 0) {
                                        var fullText = (d.innerText || d.textContent || '').trim();
                                        var bodyText = fullText.replace(rawLabel, '').trim();
                                        if (bodyText && bodyText.length >= 5) parts.push(bodyText);
                                    }
                                    if (!wasOpen) d.open = false;
                                    blocks.push({ label: rawLabel, body: parts.join('\\n\\n') });
                                }
                                return blocks;
                            })()`,
                returnByValue: true,
              });
              const thinkBlocks: Array<{ label: string; body: string }> =
                Array.isArray(thinkExtract?.result?.value)
                  ? thinkExtract.result.value
                  : [];
              if (thinkBlocks.length > 0) {
                // Also incorporate poll-accumulated content if available
                const accumulatedBody = thinkingContentParts.join("\n\n");
                // Build combined thinking message — merge all blocks
                const sections: string[] = [];
                for (const block of thinkBlocks) {
                  const label = block.label || lastThoughtLabel || "Thinking";
                  const body = block.body || accumulatedBody || "";
                  if (body) {
                    sections.push(
                      `  💭 <b>${escapeHtml(label)}</b>\n\n<i>${escapeHtml(body)}</i>`,
                    );
                  } else {
                    sections.push(`  💭 <b>${escapeHtml(label)}</b>`);
                  }
                }
                const combined = sections.join("\n\n");
                const maxThinkLen = TELEGRAM_MSG_LIMIT - 100;
                const trimmed =
                  combined.length > maxThinkLen
                    ? combined.slice(0, maxThinkLen) + "..."
                    : combined;
                const thinkMsg = `<blockquote expandable>${trimmed}</blockquote>`;
                logger.info(
                  `[Bot] Sending thinking block: ${thinkBlocks.length} block(s), ${combined.length} chars`,
                );
                await sendMsg(thinkMsg);
              } else {
                logger.info(
                  "[Bot] No thinking blocks found in DOM at completion time",
                );
              }
            } catch (e) {
              logger.error("[Bot] Failed to send thinking block:", e);
            }
          } // end if (!skipProgress) — thinking block

          if (finalOutputText && finalOutputText.trim().length > 0) {
            logger.divider(`Output (${finalOutputText.length} chars)`);
            console.info(finalOutputText);
          }
          logger.divider();

          // Compact progress message: show completed title + event log
          if (!skipProgress) {
            liveActivityUpdateVersion += 1;
            thinkingActive = false;
            const completedBody = buildProgressBody();
            await setProgressMessage(
              `<b>${PHASE_ICONS.complete} ${escapeHtml(modelLabel)} · ${elapsed}s</b>\n\n${completedBody}`,
              { expectedVersion: liveActivityUpdateVersion },
            );
          }

          liveResponseUpdateVersion += 1;
          if (finalOutputText && finalOutputText.trim().length > 0) {
            const footer = `⏱️ ${elapsed}s`;
            await sendChunkedResponse(
              "",
              footer,
              finalOutputText,
              isAlreadyHtml,
            );
          } else {
            await upsertLiveResponse(
              `${PHASE_ICONS.complete} Complete`,
              t("Failed to extract response. Use /screenshot to verify."),
              `⏱️ ${elapsed}s`,
              { expectedVersion: liveResponseUpdateVersion },
            );
          }

          if (options) {
            try {
              const sessionInfo =
                await options.chatSessionService.getCurrentSessionInfo(cdp);
              if (
                sessionInfo &&
                sessionInfo.hasActiveChat &&
                sessionInfo.title &&
                sessionInfo.title !== t("(Untitled)")
              ) {
                const session = options.chatSessionRepo.findByChannelId(
                  channelKey(channel),
                );
                const projectName = session
                  ? bridge.pool.extractProjectName(session.workspacePath)
                  : cdp.getCurrentWorkspaceName();
                if (projectName) {
                  registerApprovalSessionChannel(
                    bridge,
                    projectName,
                    sessionInfo.title,
                    channel,
                  );
                }

                if (session && session.displayName !== sessionInfo.title) {
                  // [KaizenGuy] Skip rename for forum topics — onComplete may read
                  // title of a DIFFERENT conversation if another topic has already
                  // switched the active conversation. Rename is handled by /chat_sync.
                  const isForumChannel = session.channelId.includes(":") && loadConfig().forumGroupId;
                  if (!isForumChannel) {
                    const newName = options.titleGenerator.sanitizeForChannelName(
                      sessionInfo.title,
                    );
                    const formattedName = `${session.sessionNumber}-${newName}`;
                    const threadId = session.channelId.includes(":")
                      ? Number(session.channelId.split(":")[1])
                      : undefined;
                    if (threadId) {
                      try {
                        options.topicManager.setChatId(
                          Number(session.channelId.split(":")[0]),
                        );
                        await options.topicManager.renameTopic(
                          threadId,
                          formattedName,
                        );
                      } catch {
                        /* topic rename optional */
                      }
                    }
                  }
                  options.chatSessionRepo.updateDisplayName(
                    channelKey(channel),
                    sessionInfo.title,
                  );
                }
              }
            } catch (e) {
              logger.error("[Rename] Failed:", e);
            }
          }

          // [KaizenGuy] Skip image extraction when user attached images — DOM shows
          // the attached images and they'd be sent back as "Generated image"
          if (inboundImages.length === 0) {
            await sendGeneratedImages(finalOutputText || "");
          }
        } catch (error) {
          logger.error(
            `[sendPrompt:${monitorTraceId}] onComplete failed:`,
            error,
          );
        } finally {
          finish();
        }
      },
      onTimeout: async (lastText) => {
        isFinalized = true;
        if (elapsedTimer) {
          clearInterval(elapsedTimer);
          elapsedTimer = null;
        }
        userStopRequestedChannels.delete(channelKey(channel));
        try {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const timeoutText =
            lastText && lastText.trim().length > 0
              ? lastText
              : lastProgressText;
          const timeoutIsHtml =
            monitor!.getLastExtractionSource() === "structured";
          const separated = timeoutIsHtml
            ? { output: timeoutText || "", logs: "" }
            : splitOutputAndLogs(timeoutText || "");
          const payload =
            separated.output && separated.output.trim().length > 0
              ? `${separated.output}\n\n[Monitor Ended] Timeout after 30 minutes.`
              : "Monitor ended after 30 minutes. No text was retrieved.";

          liveResponseUpdateVersion += 1;
          await sendChunkedResponse(
            `${PHASE_ICONS.timeout} Timeout`,
            `⏱️ ${elapsed}s`,
            payload,
            timeoutIsHtml,
          );
          liveActivityUpdateVersion += 1;
          thinkingActive = false;
          await setProgressMessage(
            `<b>${PHASE_ICONS.timeout} ${escapeHtml(modelLabel)} · ${elapsed}s</b>\n\n${buildProgressBody()}`,
            { expectedVersion: liveActivityUpdateVersion },
          );
        } catch (error) {
          logger.error(
            `[sendPrompt:${monitorTraceId}] onTimeout failed:`,
            error,
          );
        } finally {
          finish();
        }
      },
    });

    monitor.start().catch((err) => {
      logger.error(`[sendPrompt:${monitorTraceId}] start failed:`, err);
      finish();
    });

    elapsedTimer = setInterval(() => {
      if (isFinalized) {
        clearInterval(elapsedTimer!);
        finish();
        return;
      }
      if (!skipProgress) triggerProgressRefresh();
      // [KaizenGuy] Send typing indicator so user knows bot is working
      if (skipProgress) {
        api
          .sendChatAction(channel.chatId, "typing", {
            message_thread_id: channel.threadId,
          })
          .catch(() => {});
      }
    }, 5000);
  });
  } catch (e: any) {
    isFinalized = true;
    userStopRequestedChannels.delete(channelKey(channel));
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
    }
    if (monitor) {
      await (monitor as any).stop().catch(() => {});
    }
    await sendEmbed(
      `${PHASE_ICONS.error} Error`,
      t(`Error occurred during processing: ${e.message}`),
    );
  }
}

// =============================================================================
// Bot main entry point
// =============================================================================


import { CommandDeps } from "./types";


export const startBot = async (cliLogLevel?: LogLevel) => {
  const config = loadConfig();
  logger.setLogLevel(cliLogLevel ?? config.logLevel);

  const dbPath =
    process.env.NODE_ENV === "test"
      ? ":memory:"
      : ConfigLoader.getDefaultDbPath();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const modeService = new ModeService();
  const modelService = new ModelService();
  const templateRepo = new TemplateRepository(db);
  const workspaceBindingRepo = new WorkspaceBindingRepository(db);
  const chatSessionRepo = new ChatSessionRepository(db);
  const workspaceService = new WorkspaceService(config.workspaceBaseDir);

  await ensureAntigravityRunning();

  const bridge = initCdpBridge(config.autoApproveFileEdits);
  bridge.botToken = config.telegramBotToken;

  const chatSessionService = new ChatSessionService();
  const titleGenerator = new TitleGeneratorService();
  const promptDispatcher = new PromptDispatcher({
    bridge,
    modeService,
    modelService,
    sendPromptImpl: sendPromptToAntigravity,
  });

  const slashCommandHandler = new SlashCommandHandler(templateRepo);
  const cleanupHandler = new CleanupCommandHandler(
    chatSessionRepo,
    workspaceBindingRepo,
  );

  const bot = new Bot(config.telegramBotToken);
  bridge.botApi = bot.api;

  // [KaizenGuy] Start push notification HTTP endpoint
  startNotificationService(bot.api, config.allowedUserIds.map(Number));

  // [KaizenGuy] Schedule Service — cron jobs gửi prompt tự động cho Antigravity
  const scheduleRepo = new ScheduleRepository(db);
  const scheduleService = new ScheduleService(scheduleRepo);
  const restoredCount = scheduleService.restoreAll(async (schedule) => {
    try {
      logger.info(`[Schedule] Firing job #${schedule.id}: ${schedule.prompt.substring(0, 80)}...`);
      const cdp = await bridge.pool.getOrConnect(schedule.workspacePath);
      const projectName = bridge.pool.extractProjectName(schedule.workspacePath);
      bridge.lastActiveWorkspace = projectName;

      // [KaizenGuy] Switch model nếu schedule có chỉ định model riêng
      let previousModel: string | null = null;
      if (schedule.model) {
        try {
          previousModel = await cdp.getCurrentModel();
          const modelResult = await cdp.setUiModel(schedule.model);
          if (modelResult.ok) {
            logger.info(`[Schedule] Switched to model: ${schedule.model} (was: ${previousModel})`);
          } else {
            logger.warn(`[Schedule] Failed to switch model to ${schedule.model}: ${modelResult.error}. Using current model.`);
          }
        } catch (modelErr: any) {
          logger.warn(`[Schedule] Model switch error: ${modelErr.message}. Using current model.`);
        }
      }

      // [KaizenGuy] Activate existing chat or create new one
      if (schedule.chatTitle) {
        const activateResult = await chatSessionService.activateSessionByTitle(cdp, schedule.chatTitle);
        if (activateResult.ok) {
          logger.info(`[Schedule] Activated chat "${schedule.chatTitle}" for job #${schedule.id}`);
        } else {
          logger.warn(`[Schedule] Could not activate chat "${schedule.chatTitle}" for job #${schedule.id}: ${activateResult.error}. Falling back to new chat.`);
          const newChatResult = await chatSessionService.startNewChat(cdp);
          if (newChatResult.ok) {
            logger.info(`[Schedule] Fallback: new chat created for job #${schedule.id}`);
          } else {
            logger.warn(`[Schedule] Fallback new chat also failed: ${newChatResult.error}. Proceeding with current chat.`);
          }
        }
      } else {
        const newChatResult = await chatSessionService.startNewChat(cdp);
        if (newChatResult.ok) {
          logger.info(`[Schedule] New chat created for job #${schedule.id}`);
        } else {
          logger.warn(`[Schedule] Could not create new chat for job #${schedule.id}: ${newChatResult.error}. Proceeding with current chat.`);
        }
      }

      // Dùng forum group làm đích nếu có, route theo topic đã map với chat_title
      let scheduleCh: TelegramChannel;
      if (config.forumGroupId) {
          let tId: number | undefined;
          if (schedule.chatTitle) {
              const s = chatSessionRepo.findByDisplayName(schedule.workspacePath, schedule.chatTitle);
              if (s?.topicId) tId = s.topicId;
          }
          scheduleCh = { chatId: config.forumGroupId, threadId: tId };
      } else {
          const defaultChatId = config.allowedUserIds[0] ? Number(config.allowedUserIds[0]) : 0;
          scheduleCh = { chatId: defaultChatId, threadId: undefined };
      }
      bridge.lastActiveChannel = scheduleCh;

      try {
        await promptDispatcher.send({
          channel: scheduleCh,
          prompt: schedule.prompt,
          cdp,
          inboundImages: [],
          options: {
            chatSessionService,
            chatSessionRepo,
            topicManager,
            titleGenerator,
          },
        });
      } finally {
        // [KaizenGuy] Restore model cũ sau khi xong
        if (previousModel && schedule.model) {
          try {
            await cdp.setUiModel(previousModel);
            logger.info(`[Schedule] Restored model to: ${previousModel}`);
          } catch (restoreErr: any) {
            logger.warn(`[Schedule] Failed to restore model: ${restoreErr.message}`);
          }
        }
      }
    } catch (e: any) {
      logger.error(`[Schedule] Job #${schedule.id} failed:`, e.message);
      // Gửi thông báo lỗi qua Telegram
      const defaultChatId = config.allowedUserIds[0] ? Number(config.allowedUserIds[0]) : 0;
      if (defaultChatId && bot.api) {
        bot.api.sendMessage(defaultChatId, `⚠️ Schedule job #${schedule.id} failed: ${e.message}`).catch(() => {});
      }
    }
  });
  logger.info(`[Schedule] Restored ${restoredCount} scheduled job(s)`);

  // Notify user on WebSocket connection lifecycle events
  bridge.pool.on("workspace:disconnected", (projectName: string) => {
    const channel = bridge.lastActiveChannel;
    if (!channel || !bridge.botApi) return;
    bridge.botApi
      .sendMessage(
        channel.chatId,
        `⚠️ <b>${escapeHtml(projectName)}</b>: Connection lost. Reconnecting…`,
        {
          parse_mode: "HTML",
          message_thread_id: channel.threadId,
        },
      )
      .catch((err) =>
        logger.error("[Bot] Failed to send disconnect notification:", err),
      );
  });

  bridge.pool.on("workspace:reconnected", (projectName: string) => {
    const channel = bridge.lastActiveChannel;
    if (!channel || !bridge.botApi) return;
    bridge.botApi
      .sendMessage(
        channel.chatId,
        `✅ <b>${escapeHtml(projectName)}</b>: Reconnected.`,
        {
          parse_mode: "HTML",
          message_thread_id: channel.threadId,
        },
      )
      .catch((err) =>
        logger.error("[Bot] Failed to send reconnect notification:", err),
      );
  });

  bridge.pool.on("workspace:reconnectFailed", (projectName: string) => {
    const channel = bridge.lastActiveChannel;
    if (!channel || !bridge.botApi) return;
    bridge.botApi
      .sendMessage(
        channel.chatId,
        `❌ <b>${escapeHtml(projectName)}</b>: Reconnection failed. Send a message to retry.`,
        {
          parse_mode: "HTML",
          message_thread_id: channel.threadId,
        },
      )
      .catch((err) =>
        logger.error(
          "[Bot] Failed to send reconnect-failed notification:",
          err,
        ),
      );
  });

  const topicManager = new TelegramTopicManager(bot.api, 0);

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = String(ctx.from?.id ?? "");
    if (!config.allowedUserIds.includes(userId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "You do not have permission." });
      }
      return;
    }
    await next();
  });

  // Helper to build TelegramChannel from context
  const getChannel = (ctx: Context): TelegramChannel => ({
    chatId: ctx.chat!.id,
    threadId: ctx.message?.message_thread_id ?? undefined,
  });

  const getChannelFromCb = (ctx: Context): TelegramChannel => ({
    chatId: ctx.chat!.id,
    threadId: ctx.callbackQuery?.message?.message_thread_id ?? undefined,
  });

  const resolveWorkspaceAndCdp = async (
    ch: TelegramChannel,
  ): Promise<{
    cdp: CdpService;
    projectName: string;
    workspacePath: string;
  } | null> => {
    const key = channelKey(ch);
    const binding = workspaceBindingRepo.findByChannelId(key);
    if (!binding) return null;
    const workspacePath = workspaceService.getWorkspacePath(
      binding.workspacePath,
    );
    try {
      const cdp = await bridge.pool.getOrConnect(workspacePath);
      const projectName = bridge.pool.extractProjectName(workspacePath);
      bridge.lastActiveWorkspace = projectName;
      bridge.lastActiveChannel = ch;
      registerApprovalWorkspaceChannel(bridge, projectName, ch);
      ensureApprovalDetector(bridge, cdp, projectName);
      ensureErrorPopupDetector(bridge, cdp, projectName);
      ensurePlanningDetector(bridge, cdp, projectName);
      return { cdp, projectName, workspacePath };
    } catch (e) {
      logger.error(`[resolveWorkspaceAndCdp] Connection failed:`, e);
      return null;
    }
  };

  const replyHtml = async (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ) => {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  };

  // /start command
  
  const deps = {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, api: bot.api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels
  };

  const { registerCommands } = await import("./commandHandlers");
  await registerCommands(bot, deps as any);

  const { registerCallbackHandler } = await import("./callbackHandler");
  await registerCallbackHandler(bot, deps as any);

  const { registerMessageHandler } = await import("./messageHandler");
  await registerMessageHandler(bot, deps as any);

  const { registerMediaHandlers } = await import("./mediaHandler");
  await registerMediaHandlers(bot, deps as any);

  const { startHttpServer } = await import("./httpServer");
  await startHttpServer(bot, deps as any);

await bot.start({
    onStart: async (botInfo) => {
      logger.info(
        `Bot started as @${botInfo.username} | extractionMode=${config.extractionMode}`,
      );
      try {
        await bot.api.setMyCommands([
          { command: "chat", description: "Current session info" },
          { command: "new", description: "Start a new chat session" },
          { command: "model", description: "Change LLM model" },
          { command: "stop", description: "Interrupt active generation" },
          { command: "project", description: "Select a project" },
          { command: "mode", description: "Change execution mode" },
          { command: "screenshot", description: "Capture Antigravity screen" },
          { command: "autoaccept", description: "Toggle auto-approve mode" },
          { command: "ping", description: "Check latency" },
        ]);
        logger.info("Telegram command menu registered successfully");
      } catch (err) {
        logger.error("Failed to register command menu:", err);
      }
    },
  });
};

