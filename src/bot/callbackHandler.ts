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

export async function registerCallbackHandler(bot: Bot, deps: CommandDeps) {
  let {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels
  } = deps;

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const ch = getChannelFromCb(ctx);

    // Mode selection
    if (data.startsWith("mode_select:")) {
      const selectedMode = data.replace("mode_select:", "");
      modeService.setMode(selectedMode);
      const cdp = getCurrentCdp(bridge);
      if (cdp) {
        const res = await cdp.setUiMode(selectedMode);
        if (!res.ok) logger.warn(`[Mode] UI switch failed: ${res.error}`);
      }
      const { text, keyboard } = await buildModeUI(modeService, {
        getCurrentCdp: () => getCurrentCdp(bridge),
      });
      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch {
        /* may fail if unchanged */
      }
      await ctx.answerCallbackQuery({
        text: `Mode: ${MODE_DISPLAY_NAMES[selectedMode] || selectedMode}`,
      });
      return;
    }

    // Exhausted model button — show alert toast
    if (data.startsWith("model_exhausted_")) {
      const modelName = data.replace("model_exhausted_", "");
      await ctx.answerCallbackQuery({
        text: `⛔ ${modelName} is exhausted. Wait for quota reset or pick another model.`,
        show_alert: true,
      });
      return;
    }

    // Model selection
    if (data.startsWith("model_btn_")) {
      const modelName = data.replace("model_btn_", "");
      const cdp = getCurrentCdp(bridge);
      if (!cdp) {
        await ctx.answerCallbackQuery({ text: "Not connected to CDP." });
        return;
      }
      const res = await cdp.setUiModel(modelName);
      if (res.ok) {
        const payload = await buildModelsUI(cdp, () =>
          bridge.quota.fetchQuota(),
        );
        if (payload)
          try {
            await ctx.editMessageText(payload.text, {
              parse_mode: "HTML",
              reply_markup: payload.keyboard,
            });
          } catch {}
        await ctx.answerCallbackQuery({ text: `Model: ${res.model}` });
      } else {
        await ctx.answerCallbackQuery({
          text: res.error || "Failed to change model.",
        });
      }
      return;
    }

    // Model refresh
    if (data === "model_refresh_btn") {
      const cdp = getCurrentCdp(bridge);
      if (!cdp) {
        await ctx.answerCallbackQuery({ text: "Not connected." });
        return;
      }
      const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
      if (payload)
        try {
          await ctx.editMessageText(payload.text, {
            parse_mode: "HTML",
            reply_markup: payload.keyboard,
          });
        } catch {}
      await ctx.answerCallbackQuery({ text: "Refreshed" });
      return;
    }

    // Auto-accept buttons
    if (data === AUTOACCEPT_BTN_ON || data === AUTOACCEPT_BTN_OFF) {
      const action = data === AUTOACCEPT_BTN_ON ? "on" : "off";
      bridge.autoAccept.handle(action);
      await sendAutoAcceptUI(async (text, keyboard) => {
        try {
          await ctx.editMessageText(text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } catch {}
      }, bridge.autoAccept);
      await ctx.answerCallbackQuery({
        text: `Auto-accept: ${action.toUpperCase()}`,
      });
      return;
    }

    if (data === AUTOACCEPT_BTN_REFRESH) {
      await sendAutoAcceptUI(async (text, keyboard) => {
        try {
          await ctx.editMessageText(text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } catch {}
      }, bridge.autoAccept);
      await ctx.answerCallbackQuery({ text: "Refreshed" });
      return;
    }

    // Project selection
    if (data.startsWith(`${PROJECT_SELECT_ID}:`)) {
      const workspacePath = data.replace(`${PROJECT_SELECT_ID}:`, "");
      if (!workspaceService.exists(workspacePath)) {
        await ctx.answerCallbackQuery({
          text: `Project "${workspacePath}" not found.`,
        });
        return;
      }

      let key = channelKey(ch);
      const guildId = String(ch.chatId);
      const isForum =
        ctx.chat?.type === "supergroup" && (ctx.chat as any).is_forum === true;

      // Auto-create topic if conditions are met
      if (config.useTopics && isForum && !ch.threadId) {
        try {
          const existing = workspaceBindingRepo.findByWorkspacePathAndGuildId(
            workspacePath,
            guildId,
          );
          const existingTopic = existing.find((b) => b.channelId.includes(":"));

          let topicId: number;
          if (existingTopic) {
            topicId = Number(existingTopic.channelId.split(":")[1]);
            topicManager.registerTopic(workspacePath, topicId);
          } else {
            topicManager.setChatId(ch.chatId);
            const sanitized = topicManager.sanitizeName(workspacePath);
            const result = await topicManager.ensureTopic(sanitized);
            topicId = result.topicId;
          }

          key = `${ch.chatId}:${topicId}`;

          // Send welcome message in the new topic
          const fullPath = workspaceService.getWorkspacePath(workspacePath);
          await bot.api.sendMessage(
            ch.chatId,
            `<b>📁 Project Selected</b>\n\n✅ <b>${escapeHtml(workspacePath)}</b>\n<code>${escapeHtml(fullPath)}</code>\n\nSend messages here to interact with this project.`,
            { parse_mode: "HTML", message_thread_id: topicId },
          );
          workspaceBindingRepo.upsert({
            channelId: key,
            workspacePath,
            guildId,
          });
          await ctx.answerCallbackQuery({
            text: `Topic created for: ${workspacePath}`,
          });
          return;
        } catch (e: any) {
          logger.warn(
            `[ProjectSelect] Topic creation failed, falling back: ${e.message}`,
          );
          // Fall through to default behavior
        }
      }

      workspaceBindingRepo.upsert({ channelId: key, workspacePath, guildId });

      const fullPath = workspaceService.getWorkspacePath(workspacePath);
      await ctx.editMessageText(
        `<b>📁 Project Selected</b>\n\n✅ <b>${escapeHtml(workspacePath)}</b>\n<code>${escapeHtml(fullPath)}</code>\n\nSend messages here to interact with this project.`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCallbackQuery({ text: `Selected: ${workspacePath}` });
      return;
    }

    // Project page navigation
    if (data.startsWith(`${PROJECT_PAGE_PREFIX}:`)) {
      const page = parseProjectPageId(data);
      if (!isNaN(page)) {
        const workspaces = workspaceService.scanWorkspaces();
        const { text, keyboard } = buildProjectListUI(workspaces, page);
        try {
          await ctx.editMessageText(text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } catch {}
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // Template button
    if (data.startsWith(TEMPLATE_BTN_PREFIX)) {
      const templateId = parseTemplateButtonId(data);
      if (isNaN(templateId)) {
        await ctx.answerCallbackQuery({ text: "Invalid template." });
        return;
      }
      const template = templateRepo.findById(templateId);
      if (!template) {
        await ctx.answerCallbackQuery({ text: "Template not found." });
        return;
      }

      const resolved = await resolveWorkspaceAndCdp(ch);
      if (!resolved) {
        const cdp = getCurrentCdp(bridge);
        if (!cdp) {
          await ctx.answerCallbackQuery({ text: "Not connected." });
          return;
        }
        await promptDispatcher.send({
          channel: ch,
          prompt: template.prompt,
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
        await promptDispatcher.send({
          channel: ch,
          prompt: template.prompt,
          cdp: resolved.cdp,
          inboundImages: [],
          options: {
            chatSessionService,
            chatSessionRepo,
            topicManager,
            titleGenerator,
          },
        });
      }
      await ctx.answerCallbackQuery({ text: `Running: ${template.name}` });
      return;
    }

    // Session selection — [KaizenGuy] Enhanced with logging + wait after switch
    if (isSessionSelectId(data)) {
      const selectedTitle = data.replace(`${SESSION_SELECT_ID}:`, "");
      logger.info(`[SESSION_SELECT] User selected: "${selectedTitle}"`);

      const key = channelKey(ch);
      const binding = workspaceBindingRepo.findByChannelId(key);

      // Get CDP connection: from binding, or fallback to any active workspace
      let cdp: CdpService | null = null;
      try {
        if (binding) {
          const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
          cdp = await bridge.pool.getOrConnect(workspacePath);
        } else {
          const activeNames = bridge.pool.getActiveWorkspaceNames();
          cdp = activeNames.length > 0 ? bridge.pool.getConnected(activeNames[0]) : null;
        }
      } catch (e: any) {
        logger.warn(`[SESSION_SELECT] CDP connection error: ${e.message}`);
      }

      if (!cdp) {
        await ctx.answerCallbackQuery({ text: "No CDP connection available." });
        return;
      }

      try {
        const activateResult = await chatSessionService.activateSessionByTitle(
          cdp,
          selectedTitle,
        );
        logger.info(`[SESSION_SELECT] activateResult: ${JSON.stringify(activateResult)}`);

        if (activateResult.ok) {
          // Wait for conversation to fully load after switch
          await new Promise((r) => setTimeout(r, 2000));

          // Verify conversation switched correctly
          const currentInfo = await chatSessionService.getCurrentSessionInfo(cdp);
          logger.info(`[SESSION_SELECT] After switch, current title: "${currentInfo.title}"`);

          await ctx.editMessageText(
            `<b>🔗 Joined Session</b>\n\n<b>${escapeHtml(selectedTitle)}</b>`,
            { parse_mode: "HTML" },
          );
        } else {
          logger.warn(`[SESSION_SELECT] Activate failed: ${activateResult.error}`);
          await ctx.answerCallbackQuery({
            text: `Failed: ${activateResult.error}`,
          });
        }
      } catch (e: any) {
        logger.error(`[SESSION_SELECT] Error: ${e.message}`);
        await ctx.answerCallbackQuery({ text: `Error: ${e.message}` });
      }
      return;
    }

    // Approval buttons
    const approvalAction = parseApprovalCustomId(data);
    if (approvalAction) {
      const projectName =
        approvalAction.projectName ?? bridge.lastActiveWorkspace;
      const detector = projectName
        ? bridge.pool.getApprovalDetector(projectName)
        : undefined;
      if (!detector) {
        await ctx.answerCallbackQuery({ text: "Approval detector not found." });
        return;
      }

      let success = false;
      let actionLabel = "";
      if (approvalAction.action === "approve") {
        success = await detector.approveButton();
        actionLabel = "Allow";
      } else if (approvalAction.action === "always_allow") {
        success = await detector.alwaysAllowButton();
        actionLabel = "Allow Chat";
      } else {
        success = await detector.denyButton();
        actionLabel = "Deny";
      }

      if (success) {
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch {}
        await ctx.answerCallbackQuery({ text: `${actionLabel} executed.` });
      } else {
        await ctx.answerCallbackQuery({ text: "Button not found." });
      }
      return;
    }

    // Planning buttons (legacy parsing for backward compat)
    const planningAction = parsePlanningCustomId(data);
    if (planningAction) {
      const projectName =
        planningAction.projectName ?? bridge.lastActiveWorkspace;
      const detector = projectName
        ? bridge.pool.getPlanningDetector(projectName)
        : undefined;
      if (!detector) {
        await ctx.answerCallbackQuery({ text: "Planning detector not found." });
        return;
      }

      if (planningAction.action === "open") {
        const clicked = await detector.clickOpenButton();
        if (clicked) {
          await new Promise((r) => setTimeout(r, 500));
          let planContent: string | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            planContent = await detector.extractPlanContent();
            if (planContent) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          if (planContent) {
            const chKey = channelKey(ch);
            const pages = paginatePlanContent(planContent);
            planContentCache.set(chKey, pages);
            const targetChannelStr = ch.threadId
              ? String(ch.threadId)
              : String(ch.chatId);
            const { text: pageText, keyboard: pageKeyboard } =
              buildPlanContentUI(pages, 0, projectName || "", targetChannelStr);
            await bot.api.sendMessage(ch.chatId, pageText, {
              parse_mode: "HTML",
              message_thread_id: ch.threadId,
              reply_markup: pageKeyboard,
            });
          }
        }
        await ctx.answerCallbackQuery({
          text: clicked ? "Opened" : "Open button not found.",
        });
      } else {
        const clicked = await detector.clickProceedButton();
        if (clicked)
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch {}
        await ctx.answerCallbackQuery({
          text: clicked ? "Proceeding..." : "Proceed button not found.",
        });
      }
      return;
    }

    // New plan UI buttons (View/Proceed/Edit/Refresh)
    if (data.startsWith(PLAN_VIEW_BTN + ":")) {
      const suffix = data.substring(PLAN_VIEW_BTN.length + 1);
      const [projectName] = suffix.split(":");
      const detector = projectName
        ? bridge.pool.getPlanningDetector(projectName)
        : undefined;
      if (!detector) {
        await ctx.answerCallbackQuery({ text: "Planning detector not found." });
        return;
      }

      const clicked = await detector.clickOpenButton();
      if (clicked) {
        await new Promise((r) => setTimeout(r, 500));
        let planContent: string | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          planContent = await detector.extractPlanContent();
          if (planContent) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (planContent) {
          const chKey = channelKey(ch);
          const pages = paginatePlanContent(planContent);
          planContentCache.set(chKey, pages);
          const targetChannelStr = ch.threadId
            ? String(ch.threadId)
            : String(ch.chatId);
          const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(
            pages,
            0,
            projectName,
            targetChannelStr,
          );
          await bot.api.sendMessage(ch.chatId, pageText, {
            parse_mode: "HTML",
            message_thread_id: ch.threadId,
            reply_markup: pageKeyboard,
          });
        }
      }
      await ctx.answerCallbackQuery({
        text: clicked ? "Opened" : "Open button not found.",
      });
      return;
    }

    if (data.startsWith(PLAN_PROCEED_BTN + ":")) {
      const suffix = data.substring(PLAN_PROCEED_BTN.length + 1);
      const [projectName] = suffix.split(":");
      const detector = projectName
        ? bridge.pool.getPlanningDetector(projectName)
        : undefined;
      if (!detector) {
        await ctx.answerCallbackQuery({ text: "Planning detector not found." });
        return;
      }

      const clicked = await detector.clickProceedButton();
      if (clicked) {
        planEditPendingChannels.delete(channelKey(ch));
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch {}
      }
      await ctx.answerCallbackQuery({
        text: clicked ? "Proceeding..." : "Proceed button not found.",
      });
      return;
    }

    if (data.startsWith(PLAN_EDIT_BTN + ":")) {
      const suffix = data.substring(PLAN_EDIT_BTN.length + 1);
      const [projectName] = suffix.split(":");
      planEditPendingChannels.set(channelKey(ch), { projectName });
      await ctx.answerCallbackQuery({
        text: "Type your edit instructions (or /cancel).",
      });
      await bot.api.sendMessage(
        ch.chatId,
        "<b>Edit Plan</b>\n\nType your plan edit instructions below.\nSend <code>/cancel</code> to cancel.",
        { parse_mode: "HTML", message_thread_id: ch.threadId },
      );
      return;
    }

    if (data.startsWith(PLAN_REFRESH_BTN + ":")) {
      const suffix = data.substring(PLAN_REFRESH_BTN.length + 1);
      const [projectName, targetChannelStr] = suffix.split(":");
      const detector = projectName
        ? bridge.pool.getPlanningDetector(projectName)
        : undefined;
      if (!detector) {
        await ctx.answerCallbackQuery({ text: "Planning detector not found." });
        return;
      }

      const info = detector.getLastDetectedInfo();
      if (info) {
        const { text: uiText, keyboard: uiKeyboard } = buildPlanNotificationUI(
          info,
          projectName,
          targetChannelStr || String(ch.chatId),
        );
        try {
          await ctx.editMessageText(uiText, {
            parse_mode: "HTML",
            reply_markup: uiKeyboard,
          });
        } catch {}
      }
      await ctx.answerCallbackQuery({ text: "Refreshed" });
      return;
    }

    // Plan pagination
    if (data.startsWith(PLAN_PAGE_PREFIX + ":")) {
      const rest = data.substring(PLAN_PAGE_PREFIX.length + 1);
      const colonIdx = rest.indexOf(":");
      const page = parseInt(rest.substring(0, colonIdx), 10);
      const suffix = rest.substring(colonIdx + 1);
      const [projectName, targetChannelStr] = suffix.split(":");
      const chKey = channelKey(ch);
      const pages = planContentCache.get(chKey);
      if (!pages || isNaN(page)) {
        await ctx.answerCallbackQuery({ text: "Page not found." });
        return;
      }

      const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(
        pages,
        page,
        projectName,
        targetChannelStr || String(ch.chatId),
      );
      try {
        await ctx.editMessageText(pageText, {
          parse_mode: "HTML",
          reply_markup: pageKeyboard,
        });
      } catch {}
      await ctx.answerCallbackQuery({
        text: `Page ${page + 1}/${pages.length}`,
      });
      return;
    }

    // Error popup buttons
    const errorAction = parseErrorPopupCustomId(data);
    if (errorAction) {
      const projectName = errorAction.projectName ?? bridge.lastActiveWorkspace;
      const detector = projectName
        ? bridge.pool.getErrorPopupDetector(projectName)
        : undefined;
      if (!detector) {
        await ctx.answerCallbackQuery({
          text: "Error popup detector not found.",
        });
        return;
      }

      if (errorAction.action === "dismiss") {
        const clicked = await detector.clickDismissButton();
        if (clicked)
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch {}
        await ctx.answerCallbackQuery({
          text: clicked ? "Dismissed" : "Button not found.",
        });
      } else if (errorAction.action === "copy_debug") {
        const clicked = await detector.clickCopyDebugInfoButton();
        let clipboardOk = false;
        if (clicked) {
          await new Promise((r) => setTimeout(r, 300));
          const clipboardContent = await detector.readClipboard();
          if (clipboardContent) {
            clipboardOk = true;
            const truncated =
              clipboardContent.length > 3800
                ? clipboardContent.substring(0, 3800) + "\n(truncated)"
                : clipboardContent;
            await bot.api.sendMessage(
              ch.chatId,
              `<b>Debug Info</b>\n\n<pre>${escapeHtml(truncated)}</pre>`,
              { parse_mode: "HTML", message_thread_id: ch.threadId },
            );
          }
        }
        const feedbackText = !clicked
          ? "Button not found."
          : clipboardOk
            ? "Copied"
            : "Could not read clipboard.";
        await ctx.answerCallbackQuery({ text: feedbackText });
      } else {
        const clicked = await detector.clickRetryButton();
        if (clicked)
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch {}
        await ctx.answerCallbackQuery({
          text: clicked ? "Retrying..." : "Button not found.",
        });
      }
      return;
    }

    // Cleanup buttons
    if (
      data.startsWith(CLEANUP_ARCHIVE_BTN) ||
      data.startsWith(CLEANUP_DELETE_BTN) ||
      data === CLEANUP_CANCEL_BTN
    ) {
      if (data === CLEANUP_CANCEL_BTN) {
        try {
          await ctx.editMessageText("Cleanup cancelled.");
        } catch {}
        await ctx.answerCallbackQuery({ text: "Cancelled" });
        return;
      }

      const isDelete = data.startsWith(CLEANUP_DELETE_BTN);
      const callbackDays = parseInt(data.split(":")[1], 10) || 7;
      const guildId = String(ch.chatId);
      const inactive = cleanupHandler.findInactiveSessions(
        guildId,
        callbackDays,
      );

      let processed = 0;
      for (const { binding } of inactive) {
        const threadId = binding.channelId.includes(":")
          ? Number(binding.channelId.split(":")[1])
          : undefined;

        if (threadId) {
          try {
            if (isDelete) {
              await bot.api.deleteForumTopic(ch.chatId, threadId);
            } else {
              await bot.api.closeForumTopic(ch.chatId, threadId);
            }
          } catch (e: any) {
            logger.warn(
              `[Cleanup] Topic operation failed for ${binding.channelId}: ${e.message}`,
            );
          }
        }

        cleanupHandler.cleanupByChannelId(binding.channelId);
        processed++;
      }

      const action = isDelete ? "deleted" : "archived";
      try {
        await ctx.editMessageText(
          `✅ Cleanup complete — ${processed} session(s) ${action}.`,
        );
      } catch {}
      await ctx.answerCallbackQuery({
        text: `${processed} session(s) ${action}`,
      });
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // =============================================================================
  // Text message handler (main chat flow)
  // =============================================================================

  
}
