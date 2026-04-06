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
import { CommandDeps } from "./types";
import { channelKey, stripHtmlForFile } from "./helpers";

export async function registerMediaHandlers(bot: Bot, deps: CommandDeps) {
  let {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels
  } = deps;

const mediaGroupBuffer = new Map<string, {
    photos: Array<{ file_id: string; file_size?: number }>;
    caption: string;
    channel: TelegramChannel;
    timer: ReturnType<typeof setTimeout>;
  }>();

  async function processPhotoGroup(
    ch: TelegramChannel,
    photos: Array<{ file_id: string; file_size?: number }>,
    caption: string,
  ): Promise<void> {
    const resolved = await resolveWorkspaceAndCdp(ch);
    if (!resolved) return;

    const inboundImages = await downloadTelegramImages(
      bot.api,
      config.telegramBotToken,
      photos,
      String(Date.now()),
    );

    if (inboundImages.length === 0) return;

    // Append local paths to prompt so Antigravity knows where files are
    const pathLines = inboundImages.map((img, i) =>
      `${i + 1}. ${img.name} → ${img.localPath}`
    ).join("\n");
    const fullPrompt = `${caption}\n\n[Local image files]\n${pathLines}`;

    await promptDispatcher.send({
      channel: ch,
      prompt: fullPrompt,
      cdp: resolved.cdp,
      inboundImages,
      options: {
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
      },
    });
    // [KaizenGuy] Do NOT cleanup — keep images in ~/.remoat/images/ for local access
  }

  // Photo message handler
  bot.on("message:photo", async (ctx) => {
    const ch = getChannel(ctx);
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;

    const largest = photos[photos.length - 1];
    const caption =
      ctx.message.caption?.trim() ||
      "Please review the attached images and respond accordingly.";

    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId) {
      // Album mode — buffer photos with same media_group_id
      const existing = mediaGroupBuffer.get(mediaGroupId);
      if (existing) {
        existing.photos.push(largest);
        if (caption !== "Please review the attached images and respond accordingly.") {
          existing.caption = caption; // Use caption from whichever message has one
        }
        clearTimeout(existing.timer);
        existing.timer = setTimeout(async () => {
          mediaGroupBuffer.delete(mediaGroupId);
          try {
            await processPhotoGroup(existing.channel, existing.photos, existing.caption);
          } catch (e: any) {
            logger.error("[PhotoGroup] Error processing album:", e?.message);
          }
        }, 1000);
      } else {
        const entry = {
          photos: [largest],
          caption,
          channel: ch,
          timer: setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            try {
              await processPhotoGroup(entry.channel, entry.photos, entry.caption);
            } catch (e: any) {
              logger.error("[PhotoGroup] Error processing album:", e?.message);
            }
          }, 1000),
        };
        mediaGroupBuffer.set(mediaGroupId, entry);
      }
    } else {
      // Single photo — process immediately
      const resolved = await resolveWorkspaceAndCdp(ch);
      if (!resolved) {
        await ctx.reply("No project configured. Use /project first.");
        return;
      }
      await processPhotoGroup(ch, [largest], caption);
    }
  });

  // Voice message handler (voice-to-prompt via local Whisper transcription)
  bot.on("message:voice", async (ctx) => {
    const ch = getChannel(ctx);

    const whisperIssue = checkWhisperAvailability();
    if (whisperIssue) {
      await ctx.reply(whisperIssue);
      const keyTemp = channelKey(ch);
      const bindingTemp = workspaceBindingRepo.findByChannelId(keyTemp);

      if (!bindingTemp) {
        if (config.forumGroupId && ch.threadId && ch.chatId === config.forumGroupId) {
          // ... forum fallback
        }
        await ctx.reply("No project is configured for this chat. Use /project to select one.");
        return;
      }

      const resolved = await resolveWorkspaceAndCdp(ch);
      if (!resolved) {
        const wp = workspaceService.getWorkspacePath(bindingTemp.workspacePath);
        await ctx.reply(`⚠️ <b>CDP Connection Failed</b>\n\nFailed to connect to configured project: <code>${wp}</code>\n\nPlease ensure you have this project currently open in Antigravity IDE (VS Code).`, { parse_mode: "HTML" });
        return;
      }
      return;
    }

    const resolved = await resolveWorkspaceAndCdp(ch);
    if (!resolved) {
      await ctx.reply("No project configured. Use /project first.");
      return;
    }

    await ctx.reply("🎙️ Transcribing voice message...");

    let voicePath: string;
    try {
      voicePath = await downloadTelegramVoice(
        bot.api,
        config.telegramBotToken,
        ctx.message.voice,
      );
    } catch (error: any) {
      logger.error("[Voice] Download failed:", error?.message || error);
      await ctx.reply("❌ Could not download voice message. Please try again.");
      return;
    }

    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await ctx.reply(
        "❌ Could not transcribe voice message. Please try again or type your prompt.",
      );
      return;
    }

    // Check if transcription is a slash command
    const parsed = parseMessageContent(transcript);
    if (parsed.isCommand && parsed.commandName) {
      const result = await slashCommandHandler.handleCommand(
        parsed.commandName,
        parsed.args || [],
      );
      await ctx.reply(`🎙️ "${transcript}"\n\n${result.message}`);

      if (result.prompt) {
        const cdp = getCurrentCdp(bridge);
        if (cdp) {
          await promptDispatcher.send({
            channel: ch,
            prompt: result.prompt,
            cdp,
            inboundImages: [],
            options: {
              chatSessionService,
              chatSessionRepo,
              topicManager,
              titleGenerator,
            },
          });
        }
      }
      return;
    }

    await ctx.reply(`📝 "${transcript}"`);

    const userMsgDetector = bridge.pool.getUserMessageDetector?.(
      resolved.projectName,
    );
    if (userMsgDetector) userMsgDetector.addEchoHash(transcript);

    await promptDispatcher.send({
      channel: ch,
      prompt: transcript,
      cdp: resolved.cdp,
      inboundImages: [],
      options: {
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
      },
    });
  });

  logger.info("Starting Remoat Telegram bot...");

  // Graceful shutdown: close database on exit
  const closeDb = () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  };
  process.on("exit", closeDb);
  process.on("SIGINT", () => {
    closeDb();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeDb();
    process.exit(0);
  });

  bot.catch((err) => {
    logger.error("Bot error:", err);
  });

  // =========================================================================
  // [KaizenGuy] HTTP API — cho phép agent khác (ví dụ ZeroClaw) gửi message
  // vào Antigravity qua Remoat mà không cần Telegram.
  // POST http://localhost:9999/send  { "msg": "nội dung" }
  // Auth: Bearer <telegramBotToken>
  // =========================================================================
  
}
