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

export async function registerMessageHandler(bot: Bot, deps: CommandDeps) {
  let {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels
  } = deps;

bot.on("message:text", async (ctx) => {
    const ch = getChannel(ctx);
    const key = channelKey(ch);
    const text = ctx.message.text.trim();

    if (!text) return;

    // [KaizenGuy] Khi đã cấu hình forum group, bỏ qua tin nhắn từ chat 1-1
    // để tránh response bị gửi nhầm kênh
    if (config.forumGroupId && ctx.chat?.type === "private") {
      await ctx.reply("⚠️ Chat 1-1 đã tắt. Dùng Forum Group để chat.");
      return;
    }

    // Plan edit interception
    const pendingPlanEdit = planEditPendingChannels.get(key);
    if (pendingPlanEdit) {
      if (text === "/cancel") {
        planEditPendingChannels.delete(key);
        await ctx.reply("Plan edit cancelled.");
        return;
      }

      planEditPendingChannels.delete(key);
      const editPrompt = `Please revise the plan based on the following feedback:\n\n${text}`;
      const resolved = await resolveWorkspaceAndCdp(ch);
      const cdp = resolved?.cdp ?? getCurrentCdp(bridge);
      if (!cdp) {
        await ctx.reply("Not connected to CDP.");
        return;
      }
      await ctx.reply("Sending plan edit...");
      await promptDispatcher.send({
        channel: ch,
        prompt: editPrompt,
        cdp,
        inboundImages: [],
        options: {
          chatSessionService,
          chatSessionRepo,
          topicManager,
          titleGenerator,
        },
      });
      return;
    }

    // Check if it looks like a text command
    const parsed = parseMessageContent(text);
    if (parsed.isCommand && parsed.commandName) {
      if (parsed.commandName === "autoaccept") {
        const result = bridge.autoAccept.handle(parsed.args?.[0]);
        await ctx.reply(result.message);
        return;
      }

      if (parsed.commandName === "screenshot") {
        await handleScreenshot(
          async (input, caption) => {
            await ctx.replyWithPhoto(input, { caption });
          },
          async (text) => {
            await ctx.reply(text);
          },
          getCurrentCdp(bridge),
        );
        return;
      }

      if (parsed.commandName === "status") {
        const activeNames = bridge.pool.getActiveWorkspaceNames();
        const currentMode = modeService.getCurrentMode();
        let statusText = `<b>🔧 Bot Status</b>\n\n`;
        statusText += `<b>CDP:</b> ${activeNames.length > 0 ? `🟢 ${activeNames.length} project(s)` : "⚪ Disconnected"}\n`;
        statusText += `<b>Mode:</b> ${escapeHtml(MODE_DISPLAY_NAMES[currentMode] || currentMode)}\n`;
        statusText += `<b>Auto Approve:</b> ${bridge.autoAccept.isEnabled() ? "🟢 ON" : "⚪ OFF"}`;
        await replyHtml(ctx, statusText);
        return;
      }

      const result = await slashCommandHandler.handleCommand(
        parsed.commandName,
        parsed.args || [],
      );
      await ctx.reply(result.message);

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
        } else {
          await ctx.reply(
            "Not connected to CDP. Send a message first to connect to a project.",
          );
        }
      }
      return;
    }

    // Regular message — route to Antigravity
    const keyTemp = channelKey(ch);
    const bindingTemp = workspaceBindingRepo.findByChannelId(keyTemp);

    if (!bindingTemp) {
      // [KaizenGuy] Forum topic fallback: if message from forum group topic,
      // try to resolve workspace from the topic mapping
      if (config.forumGroupId && ch.threadId && ch.chatId === config.forumGroupId) {
        const topicSession = chatSessionRepo.findByTopicId(ch.threadId);
        if (topicSession) {
          const wsPath = workspaceService.getWorkspacePath(topicSession.workspacePath);
          try {
            const cdp = await bridge.pool.getOrConnect(wsPath);
            const projectName = bridge.pool.extractProjectName(wsPath);
            bridge.lastActiveWorkspace = projectName;
            bridge.lastActiveChannel = ch;

            // NOTE: conversation switch happens INSIDE sendPromptToAntigravity (within workspace lock)

            const userMsgDetector = bridge.pool.getUserMessageDetector?.(projectName);
            if (userMsgDetector) userMsgDetector.addEchoHash(text);

            await promptDispatcher.send({
              channel: ch,
              prompt: text,
              cdp,
              inboundImages: [],
              options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
            });
            return;
          } catch (e: any) {
            logger.error(`[ForumTopic] Failed to route: ${e.message}`);
          }
        }
      }

      await ctx.reply(
        "No project is configured for this chat. Use /project to select one.",
      );
      return;
    }

    const resolved = await resolveWorkspaceAndCdp(ch);
    if (!resolved) {
      const wp = workspaceService.getWorkspacePath(bindingTemp.workspacePath);
      await ctx.reply(
        `⚠️ <b>CDP Connection Failed</b>\n\nFailed to connect to configured project: <code>${wp}</code>\n\nPlease ensure you have this project currently open in Antigravity IDE (VS Code).`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const session = chatSessionRepo.findByChannelId(key);

    // [KaizenGuy] Forum topic: register approval channel only (switch happens inside lock)
    if (config.forumGroupId && ch.threadId && ch.chatId === config.forumGroupId) {
      const topicSession = chatSessionRepo.findByTopicId(ch.threadId);
      if (topicSession?.displayName) {
        registerApprovalSessionChannel(
          bridge, resolved.projectName, topicSession.displayName, ch,
        );
      }
    } else if (session?.displayName) {
      registerApprovalSessionChannel(
        bridge,
        resolved.projectName,
        session.displayName,
        ch,
      );

      if (session?.isRenamed && session.displayName) {
        const activationResult = await chatSessionService.activateSessionByTitle(
          resolved.cdp,
          session.displayName,
        );
        if (!activationResult.ok) {
          await ctx.reply(
            `⚠️ Could not route to session (${session.displayName}).`,
          );
          return;
        }
      } else if (session && !session.isRenamed) {
        try {
          await chatSessionService.startNewChat(resolved.cdp);
        } catch {
          /* continue anyway */
        }
      }
    }

    const userMsgDetector = bridge.pool.getUserMessageDetector?.(
      resolved.projectName,
    );
    if (userMsgDetector) userMsgDetector.addEchoHash(text);

    await promptDispatcher.send({
      channel: ch,
      prompt: text,
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

  // [KaizenGuy] Media group buffer — gom ảnh cùng album trước khi inject
  
}
