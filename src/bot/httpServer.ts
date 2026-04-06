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

export async function startHttpServer(bot: Bot, deps: CommandDeps) {
  let {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels
  } = deps;

const HTTP_PORT = 9999;
  const { createServer } = await import("http");
  const httpServer = createServer(async (req, res) => {
    // CORS + health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // =========================================================================
    // [KaizenGuy] /notify — gửi text/photo/album ra Telegram qua Grammy bot
    // POST http://localhost:9999/notify
    //   { "text": "nội dung" }
    //   { "text": "caption", "photo": "/absolute/path/to/image.png" }
    //   { "text": "caption", "photos": ["/path/img1.png", "/path/img2.png"] }
    // Auth: Bearer <telegramBotToken>
    // =========================================================================
    if (req.method === "POST" && req.url?.startsWith("/notify")) {
      const notifyAuthHeader = req.headers.authorization || "";
      const notifyExpectedToken = `Bearer ${config.telegramBotToken}`;
      if (notifyAuthHeader !== notifyExpectedToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let notifyBody = "";
      for await (const chunk of req) notifyBody += chunk;
      let notifyData: { text?: string; photo?: string; photos?: string[]; chat_id?: string; topic_id?: string | number };
      try {
        notifyData = JSON.parse(notifyBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON. Expected: { "text": "...", "photo": "/path" }' }));
        return;
      }

      const notifyText = (notifyData.text || "").trim();
      const notifyPhoto = (notifyData.photo || "").trim();
      const notifyChatId = notifyData.chat_id || config.allowedUserIds?.[0] || "";
      const notifyTopicId = notifyData.topic_id ? Number(notifyData.topic_id) : undefined;

      const notifyPhotos = notifyData.photos || [];

      if (!notifyText && !notifyPhoto && notifyPhotos.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Need text, photo, or photos" }));
        return;
      }

      if (!notifyChatId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No chat_id and no allowedUserIds configured" }));
        return;
      }

      try {
        if (notifyPhotos.length > 0) {
          // [KaizenGuy] Album mode — sendMediaGroup, auto-batch max 10 per group
          const { readFileSync } = await import("fs");
          const { InputFile } = await import("grammy");
          const BATCH_SIZE = 10;
          const totalBatches = Math.ceil(notifyPhotos.length / BATCH_SIZE);
          for (let b = 0; b < totalBatches; b++) {
            const batch = notifyPhotos.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
            const media = batch.map((p: string, i: number) => ({
              type: "photo" as const,
              media: new InputFile(readFileSync(p), p.split("/").pop() || `photo${i}.png`),
              ...(b === 0 && i === 0 && notifyText ? { caption: notifyText, parse_mode: "HTML" as const } : {}),
            }));
            await bot.api.sendMediaGroup(Number(notifyChatId), media, {
              message_thread_id: notifyTopicId
              // Note: Grammy sendMediaGroup doesn't support a global parse_mode, each InputMediaPhoto needs it. I will add parse_mode to media directly below.
            });
          }
          logger.info(`[HTTP /notify] Sent ${notifyPhotos.length} photos (${totalBatches} batch) to ${notifyChatId}${notifyTopicId ? ` topic ${notifyTopicId}` : ''}`);
        } else if (notifyPhoto) {
          const { readFileSync } = await import("fs");
          const photoBuffer = readFileSync(notifyPhoto);
          const { InputFile } = await import("grammy");
          await bot.api.sendPhoto(
            Number(notifyChatId),
            new InputFile(photoBuffer, notifyPhoto.split("/").pop() || "photo.png"),
            { caption: notifyText || undefined, message_thread_id: notifyTopicId, parse_mode: "HTML" }
          );
          logger.info(`[HTTP /notify] Sent photo to ${notifyChatId}${notifyTopicId ? ` topic ${notifyTopicId}` : ''}`);
        } else {
          await bot.api.sendMessage(Number(notifyChatId), notifyText, {
            message_thread_id: notifyTopicId,
            parse_mode: "HTML"
          });
          logger.info(`[HTTP /notify] Sent text to ${notifyChatId}${notifyTopicId ? ` topic ${notifyTopicId}` : ''}`);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e: any) {
        logger.error("[HTTP /notify] Error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // [KaizenGuy] /notify/typing — endpoint to trigger 'typing' state
    if (req.method === "POST" && req.url?.startsWith("/notify/typing")) {
      const notifyAuthHeader = req.headers.authorization || "";
      const notifyExpectedToken = `Bearer ${config.telegramBotToken}`;
      if (notifyAuthHeader !== notifyExpectedToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let notifyBody = "";
      for await (const chunk of req) notifyBody += chunk;
      let notifyData: { chat_id?: string; topic_id?: string | number } = {};
      try {
        notifyData = notifyBody ? JSON.parse(notifyBody) : {};
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const notifyChatId = notifyData.chat_id || config.allowedUserIds?.[0] || "";
      const notifyTopicId = notifyData.topic_id ? Number(notifyData.topic_id) : undefined;

      if (!notifyChatId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No chat_id" }));
        return;
      }

      try {
        await bot.api.sendChatAction(Number(notifyChatId), "typing", {
          message_thread_id: notifyTopicId
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e: any) {
        logger.error("[HTTP /notify/typing] Error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // [KaizenGuy] /api/schedule — quản lý schedule qua HTTP (cho Antigravity gọi bằng curl)
    if (req.url?.startsWith("/api/schedule")) {
      const scheduleAuthHeader = req.headers.authorization || "";
      const scheduleExpectedToken = `Bearer ${config.telegramBotToken}`;
      if (scheduleAuthHeader !== scheduleExpectedToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let scheduleBody = "";
      for await (const chunk of req) scheduleBody += chunk;

      try {
        const params = scheduleBody ? JSON.parse(scheduleBody) : {};
        const action = params.action || "list";

        if (action === "list") {
          const jobs = scheduleService.listSchedules();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedules: jobs }));
        } else if (action === "add") {
          const { cron, prompt, workspace } = params;
          if (!cron || !prompt) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing cron or prompt" }));
            return;
          }
          const wsPath = workspace || config.workspaceBaseDir;
          const record = scheduleService.addSchedule(cron, prompt, wsPath, async (schedule) => {
            try {
              logger.info(`[Schedule] Firing job #${schedule.id}: ${schedule.prompt.substring(0, 80)}...`);
              const cdp2 = await bridge.pool.getOrConnect(schedule.workspacePath);
              bridge.lastActiveWorkspace = bridge.pool.extractProjectName(schedule.workspacePath);
              const defChatId = config.allowedUserIds[0] ? Number(config.allowedUserIds[0]) : 0;
              const sch: TelegramChannel = { chatId: defChatId, threadId: undefined };
              bridge.lastActiveChannel = sch;
              await promptDispatcher.send({
                channel: sch, prompt: schedule.prompt, cdp: cdp2, inboundImages: [],
                options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
              });
            } catch (e: any) {
              logger.error(`[Schedule] Job #${schedule.id} failed:`, e.message);
            }
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedule: record }));
        } else if (action === "remove") {
          const { id } = params;
          if (!id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing id" }));
            return;
          }
          const removed = scheduleService.removeSchedule(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, removed }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown action. Use: list, add, remove" }));
        }
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method !== "POST" || !req.url?.startsWith("/send")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Auth check
    const authHeader = req.headers.authorization || "";
    const expectedToken = `Bearer ${config.telegramBotToken}`;
    if (authHeader !== expectedToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Parse body
    let body = "";
    for await (const chunk of req) body += chunk;
    let msg: string;
    try {
      const parsed = JSON.parse(body);
      msg = (parsed.msg || parsed.message || "").trim();
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON. Expected: { \"msg\": \"...\" }" }));
      return;
    }

    if (!msg) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Empty message" }));
      return;
    }

    // Get CDP connection
    const cdp = getCurrentCdp(bridge);
    if (!cdp) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No CDP connection. Antigravity not connected." }));
      return;
    }

    // Use last active channel (or create a minimal one)
    const channel = bridge.lastActiveChannel || { chatId: 0, threadId: undefined };

    logger.info(`[HTTP API] Received message: ${msg.slice(0, 100)}...`);

    try {
      await promptDispatcher.send({
        channel,
        prompt: msg,
        cdp,
        inboundImages: [],
        options: {
          chatSessionService,
          chatSessionRepo,
          topicManager,
          titleGenerator,
        },
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Prompt sent to Antigravity" }));
    } catch (e: any) {
      logger.error("[HTTP API] Error sending prompt:", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    logger.info(`[HTTP API] Listening on http://127.0.0.1:${HTTP_PORT}/send`);
  });

  // Close HTTP server on shutdown
  process.on("SIGINT", () => {
    httpServer.close();
  });
  process.on("SIGTERM", () => {
    httpServer.close();
  });

  
}
