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

export async function registerCommands(bot: Bot, deps: CommandDeps) {
  let {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels
  } = deps;

bot.command("start", async (ctx) => {
    await replyHtml(
      ctx,
      `<b>Remoat Online</b>\n\n` +
        `Use /help for available commands.\n` +
        `Send any text message to forward it to Antigravity.`,
    );
  });

  // /help command
  bot.command("help", async (ctx) => {
    await replyHtml(
      ctx,
      `<b>📖 Remoat Commands</b>\n\n` +
        `<b>💬 Chat</b>\n` +
        `/new — Start a new chat session\n` +
        `/chat — Show current session info\n\n` +
        `<b>⏹️ Control</b>\n` +
        `/stop — Interrupt active LLM generation\n` +
        `/screenshot — Capture Antigravity screen\n\n` +
        `<b>⚙️ Settings</b>\n` +
        `/mode — Display and change execution mode\n` +
        `/model — Display and change LLM model\n\n` +
        `<b>📁 Projects</b>\n` +
        `/project — Display project list\n\n` +
        `<b>📝 Templates</b>\n` +
        `/template — Show templates\n` +
        `/template_add — Register a template\n` +
        `/template_delete — Delete a template\n\n` +
        `<b>🔧 System</b>\n` +
        `/status — Display overall bot status\n` +
        `/autoaccept — Toggle auto-approve mode\n` +
        `/cleanup [days] — Clean up inactive sessions\n` +
        `/ping — Check latency\n\n` +
        `<i>Text messages are sent directly to Antigravity</i>`,
    );
  });

  // /mode command
  bot.command("mode", async (ctx) => {
    await sendModeUI(
      async (text, keyboard) => {
        await replyHtml(ctx, text, keyboard);
      },
      modeService,
      { getCurrentCdp: () => getCurrentCdp(bridge) },
    );
  });

  // /model command
  bot.command("model", async (ctx) => {
    const ch = getChannel(ctx);
    const resolved = await resolveWorkspaceAndCdp(ch);
    const getCdp = (): CdpService | null =>
      resolved?.cdp ?? getCurrentCdp(bridge);
    const modelName = ctx.match?.trim();
    if (modelName) {
      const cdp = getCdp();
      if (!cdp) {
        await ctx.reply(
          "Not connected to CDP. Send a message first to connect.",
        );
        return;
      }
      const res = await cdp.setUiModel(modelName);
      if (res.ok) {
        await ctx.reply(
          `Model changed to <b>${escapeHtml(res.model || modelName)}</b>.`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(res.error || "Failed to change model.");
      }
    } else {
      await sendModelsUI(
        async (text, keyboard) => {
          await replyHtml(ctx, text, keyboard);
        },
        {
          getCurrentCdp: getCdp,
          fetchQuota: async () => bridge.quota.fetchQuota(),
        },
      );
    }
  });

  // /template command
  bot.command("template", async (ctx) => {
    const templates = templateRepo.findAll();
    await sendTemplateUI(async (text, keyboard) => {
      await replyHtml(ctx, text, keyboard);
    }, templates);
  });

  // /template_add command
  bot.command("template_add", async (ctx) => {
    const args = (ctx.match || "").trim();
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply("Usage: /template_add <name> <prompt>");
      return;
    }
    const name = parts[0];
    const prompt = parts.slice(1).join(" ");
    const result = await slashCommandHandler.handleCommand("template", [
      "add",
      name,
      prompt,
    ]);
    await ctx.reply(result.message);
  });

  // /template_delete command
  bot.command("template_delete", async (ctx) => {
    const name = (ctx.match || "").trim();
    if (!name) {
      await ctx.reply("Usage: /template_delete <name>");
      return;
    }
    const result = await slashCommandHandler.handleCommand("template", [
      "delete",
      name,
    ]);
    await ctx.reply(result.message);
  });

  // /status command
  bot.command("status", async (ctx) => {
    const activeNames = bridge.pool.getActiveWorkspaceNames();
    const currentMode = modeService.getCurrentMode();
    const autoAcceptStatus = bridge.autoAccept.isEnabled() ? "🟢 ON" : "⚪ OFF";

    let text = `<b>🔧 Bot Status</b>\n\n`;
    text += `<b>CDP:</b> ${activeNames.length > 0 ? `🟢 ${activeNames.length} project(s) connected` : "⚪ Disconnected"}\n`;
    text += `<b>Mode:</b> ${escapeHtml(MODE_DISPLAY_NAMES[currentMode] || currentMode)}\n`;
    text += `<b>Auto Approve:</b> ${autoAcceptStatus}\n`;

    if (activeNames.length > 0) {
      text += `\n<b>Connected Projects:</b>\n`;
      for (const name of activeNames) {
        const cdp = bridge.pool.getConnected(name);
        const contexts = cdp ? cdp.getContexts().length : 0;
        text += `• <b>${escapeHtml(name)}</b> — Contexts: ${contexts}\n`;
      }
    } else {
      text += `\nSend a message to auto-connect to a project.`;
    }

    await replyHtml(ctx, text);
  });

  // /autoaccept command
  bot.command("autoaccept", async (ctx) => {
    const requestedMode = (ctx.match || "").trim();
    if (requestedMode === "on" || requestedMode === "off") {
      const result = bridge.autoAccept.handle(requestedMode);
      await ctx.reply(result.message);
    } else {
      await sendAutoAcceptUI(async (text, keyboard) => {
        await replyHtml(ctx, text, keyboard);
      }, bridge.autoAccept);
    }
  });

  // /cleanup command
  bot.command("cleanup", async (ctx) => {
    const days = Math.max(1, parseInt((ctx.match || "").trim(), 10) || 7);
    const guildId = String(ctx.chat!.id);
    const inactive = cleanupHandler.findInactiveSessions(guildId, days);

    if (inactive.length === 0) {
      await replyHtml(
        ctx,
        `No inactive sessions older than <b>${days}</b> day(s).`,
      );
      return;
    }

    const list = inactive
      .slice(0, 20)
      .map(({ binding, session }) => {
        const label = session?.displayName ?? binding.workspacePath;
        return `• ${escapeHtml(label)}`;
      })
      .join("\n");
    const extra =
      inactive.length > 20 ? `\n…and ${inactive.length - 20} more` : "";

    const keyboard = new InlineKeyboard()
      .text("📦 Archive", `${CLEANUP_ARCHIVE_BTN}:${days}`)
      .text("🗑 Delete", `${CLEANUP_DELETE_BTN}:${days}`)
      .text("❌ Cancel", CLEANUP_CANCEL_BTN);

    await replyHtml(
      ctx,
      `<b>🧹 Cleanup</b>\n\n` +
        `Found <b>${inactive.length}</b> session(s) older than <b>${days}</b> day(s):\n\n` +
        `${list}${extra}\n\n` +
        `Choose an action:`,
      keyboard,
    );
  });

  // /screenshot command
  bot.command("screenshot", async (ctx) => {
    await handleScreenshot(
      async (input, caption) => {
        await ctx.replyWithPhoto(input, { caption });
      },
      async (text) => {
        await ctx.reply(text);
      },
      getCurrentCdp(bridge),
    );
  });

  // /quota command
  bot.command("quota", async (ctx) => {
    const ch = getChannel(ctx);
    const resolved = await resolveWorkspaceAndCdp(ch);
    const cdp = resolved?.cdp ?? getCurrentCdp(bridge);
    if (!cdp) {
      await ctx.reply("⚠️ Không thấy Antigravity nào. Anh mở anti lên trước rứa nghen.");
      return;
    }

    const quotaPrompt = "Dùng browser_subagent mở UI Settings của Antigravity, chụp màn hình và đọc data % quota còn lại của các model hiện có, sau đó tóm tắt báo cáo trạng thái quota gọn gàng vô cái bảng.";
    await ctx.reply("🔍 Đang nhét subagent chui vô UI đọc quota, anh Vũ đợi xíu nghen...");

    await promptDispatcher.send({
      channel: ch,
      prompt: quotaPrompt,
      cdp,
      inboundImages: [],
      options: {
        chatSessionService,
        chatSessionRepo,
        topicManager,
        titleGenerator,
      },
    });
  });

  // /stop command
  bot.command("stop", async (ctx) => {
    const ch = getChannel(ctx);
    const resolved = await resolveWorkspaceAndCdp(ch);
    const cdp = resolved?.cdp ?? getCurrentCdp(bridge);
    if (!cdp) {
      await ctx.reply("⚠️ Not connected to CDP.");
      return;
    }

    try {
      const contextId = cdp.getPrimaryContextId();
      const callParams: Record<string, unknown> = {
        expression: RESPONSE_SELECTORS.CLICK_STOP_BUTTON,
        returnByValue: true,
        awaitPromise: false,
      };
      if (contextId !== null) callParams.contextId = contextId;
      const result = await cdp.call("Runtime.evaluate", callParams);
      const value = result?.result?.value;

      if (value?.ok) {
        const ch = getChannel(ctx);
        userStopRequestedChannels.add(channelKey(ch));
        await replyHtml(
          ctx,
          `<b>⏹️ Generation Interrupted</b>\nAI response generation was safely stopped.`,
        );
      } else {
        await replyHtml(
          ctx,
          `<b>⚠️ Could Not Stop</b>\n${escapeHtml(value?.error || "Stop button not found.")}`,
        );
      }
    } catch (e: any) {
      await ctx.reply(`❌ Error during stop: ${e.message}`);
    }
  });

  // /project command
  bot.command("project", async (ctx) => {
    const workspaces = workspaceService.scanWorkspaces();
    const { text, keyboard } = buildProjectListUI(workspaces, 0);
    await replyHtml(ctx, text, keyboard);
  });

  // [KaizenGuy] /schedule command — quản lý scheduled jobs từ Telegram
  bot.command("schedule", async (ctx) => {
    const args = (ctx.match || "").trim();
    const parts = args.split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();

    if (!subCmd || subCmd === "list") {
      // /schedule list
      const jobs = scheduleService.listSchedules();
      if (jobs.length === 0) {
        await ctx.reply("📭 Không có schedule nào.");
        return;
      }
      let text = `<b>🕒 Scheduled Jobs (${jobs.length})</b>\n\n`;
      for (const job of jobs) {
        const status = job.enabled ? "🟢" : "⚪";
        const promptPreview = job.prompt.length > 60 ? job.prompt.substring(0, 60) + "..." : job.prompt;
        const modelTag = job.model ? ` · 🤖 ${escapeHtml(job.model)}` : "";
        text += `${status} <b>#${job.id}</b> | <code>${escapeHtml(job.cronExpression)}</code>${modelTag}\n`;
        text += `   <i>${escapeHtml(promptPreview)}</i>\n\n`;
      }
      text += `<i>Dùng /schedule add, /schedule remove, /schedule toggle</i>`;
      await replyHtml(ctx, text);
    } else if (subCmd === "add") {
      // /schedule add <cron> | <prompt> [| <model>]
      const rest = args.substring(4).trim();
      const pipeParts = rest.split("|").map(s => s.trim());
      if (pipeParts.length < 2 || !pipeParts[0] || !pipeParts[1]) {
        await ctx.reply("Usage: /schedule add <cron> | <prompt> [| <model>]\nVD: /schedule add 0 9 * * * | Nhắc anh Vũ | gemini-3-flash");
        return;
      }
      const cronExpr = pipeParts[0];
      const prompt = pipeParts[1];
      const scheduleModel = pipeParts[2] || null; // optional model
      try {
        const ch = getChannel(ctx);
        const binding = workspaceBindingRepo.findByChannelId(channelKey(ch));
        const wsPath = binding?.workspacePath || config.workspaceBaseDir;
        const record = scheduleService.addSchedule(cronExpr, prompt, wsPath, async (schedule) => {
          try {
            logger.info(`[Schedule] Firing job #${schedule.id}: ${schedule.prompt.substring(0, 80)}...`);
            const cdp = await bridge.pool.getOrConnect(schedule.workspacePath);
            const projectName = bridge.pool.extractProjectName(schedule.workspacePath);
            bridge.lastActiveWorkspace = projectName;

            // [KaizenGuy] Switch model nếu schedule có chỉ định
            let previousModel: string | null = null;
            if (schedule.model) {
              try {
                previousModel = await cdp.getCurrentModel();
                await cdp.setUiModel(schedule.model);
                logger.info(`[Schedule] Switched to model: ${schedule.model}`);
              } catch (modelErr: any) {
                logger.warn(`[Schedule] Model switch error: ${modelErr.message}`);
              }
            }

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
                options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
              });
            } finally {
              if (previousModel && schedule.model) {
                try { await cdp.setUiModel(previousModel); } catch { /* best effort */ }
              }
            }
          } catch (e: any) {
            logger.error(`[Schedule] Job #${schedule.id} failed:`, e.message);
            const defaultChatId = config.allowedUserIds[0] ? Number(config.allowedUserIds[0]) : 0;
            if (defaultChatId && bot.api) {
              bot.api.sendMessage(defaultChatId, `⚠️ Schedule job #${schedule.id} failed: ${e.message}`).catch(() => {});
            }
          }
        }, scheduleModel);
        const modelInfo = scheduleModel ? `\n🤖 ${escapeHtml(scheduleModel)}` : "";
        await replyHtml(ctx, `✅ Schedule #${record.id} đã tạo\n<code>${escapeHtml(cronExpr)}</code>\n<i>${escapeHtml(prompt.substring(0, 100))}</i>${modelInfo}`);
      } catch (e: any) {
        await ctx.reply(`❌ Lỗi: ${e.message}`);
      }
    } else if (subCmd === "remove" || subCmd === "rm" || subCmd === "delete") {
      // /schedule remove <id>
      const id = parseInt(parts[1]);
      if (!id || isNaN(id)) {
        await ctx.reply("Usage: /schedule remove <id>");
        return;
      }
      const removed = scheduleService.removeSchedule(id);
      if (removed) {
        await ctx.reply(`✅ Schedule #${id} đã xoá (cron đã dừng).`);
      } else {
        await ctx.reply(`❌ Không tìm thấy schedule #${id}.`);
      }
    } else if (subCmd === "toggle") {
      // /schedule toggle <id>
      const id = parseInt(parts[1]);
      if (!id || isNaN(id)) {
        await ctx.reply("Usage: /schedule toggle <id>");
        return;
      }
      const jobs = scheduleService.listSchedules();
      const job = jobs.find(j => j.id === id);
      if (!job) {
        await ctx.reply(`❌ Không tìm thấy schedule #${id}.`);
        return;
      }
      // Toggle: nếu đang enabled thì remove (stop cron), nếu disabled thì re-add
      if (job.enabled) {
        scheduleService.removeSchedule(id);
        // Re-insert as disabled
        const db2 = db; // reuse same db reference
        db2.prepare("INSERT INTO schedules (id, cron_expression, prompt, workspace_path, enabled, model) VALUES (?, ?, ?, ?, 0, ?)").run(id, job.cronExpression, job.prompt, job.workspacePath, job.model ?? null);
        await ctx.reply(`⚪ Schedule #${id} đã tắt.`);
      } else {
        // Enable: delete disabled record, re-add as enabled
        db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
        scheduleService.addSchedule(job.cronExpression, job.prompt, job.workspacePath, async (schedule) => {
          try {
            const cdp = await bridge.pool.getOrConnect(schedule.workspacePath);
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
            await promptDispatcher.send({
              channel: scheduleCh, prompt: schedule.prompt, cdp, inboundImages: [],
              options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
            });
          } catch (e: any) {
            logger.error(`[Schedule] Job failed:`, e.message);
          }
        });
        await ctx.reply(`🟢 Schedule #${id} đã bật lại.`);
      }
    } else {
      await replyHtml(ctx,
        `<b>🕒 /schedule commands</b>\n\n` +
        `/schedule list — Xem danh sách\n` +
        `/schedule add &lt;cron&gt; | &lt;prompt&gt; [| &lt;model&gt;] — Thêm mới\n` +
        `/schedule remove &lt;id&gt; — Xoá\n` +
        `/schedule toggle &lt;id&gt; — Bật/tắt`
      );
    }
  });

  // /new command
  bot.command("new", async (ctx) => {
    const ch = getChannel(ctx);
    const key = channelKey(ch);
    const session = chatSessionRepo.findByChannelId(key);
    const binding = workspaceBindingRepo.findByChannelId(key);
    const workspaceName = session?.workspacePath ?? binding?.workspacePath;

    // [KaizenGuy] Forum group fallback: use default workspace if no binding
    const isForum = config.forumGroupId && ch.chatId === config.forumGroupId;
    const resolvedWorkspace = workspaceName ?? (isForum ? "daisy" : null);

    if (!resolvedWorkspace) {
      await ctx.reply(
        "⚠️ No project is bound to this chat. Use /project to select one.",
      );
      return;
    }

    const workspacePath = workspaceService.getWorkspacePath(resolvedWorkspace);
    let cdp;
    try {
      cdp = await bridge.pool.getOrConnect(workspacePath);
    } catch (e: any) {
      await ctx.reply(`⚠️ Failed to connect: ${e.message}`);
      return;
    }

    try {
      const chatResult = await chatSessionService.startNewChat(cdp);
      if (chatResult.ok) {
        // [KaizenGuy] Create Forum Topic for the new conversation
        if (isForum && config.forumGroupId) {
          try {
            topicManager.setChatId(config.forumGroupId);
            const topicName = `💬 New Chat #${Date.now().toString(36)}`;
            const topicId = await topicManager.createSessionTopic(topicName);
            const channelId = `${config.forumGroupId}:${topicId}`;
            const guildId = String(config.forumGroupId);

            chatSessionRepo.upsertByTopicId(
              channelId, guildId, resolvedWorkspace, 1,
              topicName, guildId, topicId,
            );
            workspaceBindingRepo.upsert({
              channelId, workspacePath: resolvedWorkspace, guildId,
            });

            await bot.api.sendMessage(
              config.forumGroupId,
              `<b>💬 New Chat Created</b>\n\nSend your message in this topic.`,
              { parse_mode: "HTML", message_thread_id: topicId },
            );
            await ctx.reply(`✅ Topic "${topicName}" created. Go to the topic to start chatting.`);
          } catch (e: any) {
            logger.error(`[/new] Failed to create forum topic: ${e.message}`);
            await replyHtml(ctx, `<b>💬 New Chat Started</b>\nSend your message now.\n\n⚠️ Forum topic creation failed: ${e.message}`);
          }
        } else {
          await replyHtml(
            ctx,
            `<b>💬 New Chat Started</b>\nSend your message now.`,
          );
        }
      } else {
        await ctx.reply(`⚠️ Could not start new chat: ${chatResult.error}`);
      }
    } catch (e: any) {
      await ctx.reply(`⚠️ Error: ${e.message}`);
    }
  });

  // /chat command — [KaizenGuy] Rewritten to scrape real conversations from Antigravity UI
  bot.command("chat", async (ctx) => {
    const ch = getChannel(ctx);
    const resolved = await resolveWorkspaceAndCdp(ch);
    const activeNames = bridge.pool.getActiveWorkspaceNames();
    const cdp =
      resolved?.cdp ??
      (activeNames.length > 0
        ? bridge.pool.getConnected(activeNames[0])
        : null);

    if (!cdp) {
      await replyHtml(
        ctx,
        `<b>💬 Chat Sessions</b>\n\n` +
          `⚪ Not connected to CDP.\n` +
          `<i>Send a message first or use /project to bind a project.</i>`,
      );
      return;
    }

    // Get current session info
    const info = await chatSessionService.getCurrentSessionInfo(cdp);

    // Scrape real conversations from Antigravity Past Conversations panel
    const wsName = cdp.getCurrentWorkspaceName() ?? 'unknown';
    const ctxCount = cdp.getContexts().length;
    logger.info(`[/chat] workspace=${wsName} contexts=${ctxCount} activeNames=${activeNames.join(',')}`);
    try {
      const sessions = await chatSessionService.listAllSessions(cdp);
      logger.info(`[/chat] listAllSessions returned ${sessions.length} sessions`);

      if (sessions.length === 0) {
        // [KaizenGuy] Debug: dump DOM info to find Past Conversations button selector
        let debugInfo = `workspace: ${wsName}\ncontexts: ${ctxCount}\nactiveNames: ${activeNames.join(', ')}`;
        const ctxs = cdp.getContexts();
        for (const c of ctxs) {
          debugInfo += `\nctx: id=${c.id} name=${c.name} url=${(c.url || '').substring(0, 60)}`;
        }
        try {
          const contexts = cdp.getContexts();
          for (const c of contexts) {
            try {
              const r = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                  const info = [];
                  // All data-tooltip-id elements
                  document.querySelectorAll('[data-tooltip-id]').forEach(el => {
                    info.push('tooltip: ' + el.getAttribute('data-tooltip-id') + ' [' + el.tagName + '] visible=' + (el.offsetParent !== null));
                  });
                  // SVG lucide classes
                  document.querySelectorAll('svg[class*="lucide"]').forEach(svg => {
                    info.push('svg: ' + (svg.className.baseVal || svg.getAttribute('class')));
                  });
                  // Panel header buttons
                  const panel = document.querySelector('.antigravity-agent-side-panel');
                  if (panel) {
                    const header = panel.querySelector('div[class*="border-b"]');
                    if (header) {
                      header.querySelectorAll('*').forEach(el => {
                        const tid = el.getAttribute && el.getAttribute('data-tooltip-id');
                        const cls = (el.className || '').toString().substring(0, 80);
                        if (tid || el.tagName === 'BUTTON' || el.tagName === 'SVG') {
                          info.push('hdr: <' + el.tagName + '> tooltip=' + tid + ' class=' + cls);
                        }
                      });
                    } else {
                      info.push('no header found in panel');
                    }
                  } else {
                    info.push('no .antigravity-agent-side-panel found');
                  }
                  // data-past-conversations-toggle check
                  info.push('toggle: ' + !!document.querySelector('[data-past-conversations-toggle]'));
                  return info.join('\\n');
                })()`,
                returnByValue: true,
                contextId: c.id,
              });
              const val = r?.result?.value;
              if (val && typeof val === 'string' && val.length > 10) {
                debugInfo = val;
                break;
              }
            } catch (_) {}
          }
        } catch (_) {}

        await replyHtml(
          ctx,
          `<b>💬 Chat Sessions</b>\n\n` +
            `<b>Current:</b> ${escapeHtml(info.title)}\n` +
            `<b>Status:</b> ${info.hasActiveChat ? "🟢 Active" : "⚪ Empty"}\n\n` +
            `<i>No past conversations found.</i>\n\n` +
            `<pre>${escapeHtml(debugInfo || 'no debug info')}</pre>`,
        );
        return;
      }

      // Build session picker with inline keyboard
      const { text: pickerText, keyboard } = buildSessionPickerUI(sessions);

      await replyHtml(
        ctx,
        `<b>💬 Chat Sessions</b>\n\n` +
          `<b>Current:</b> ${escapeHtml(info.title)}\n` +
          `<b>Status:</b> ${info.hasActiveChat ? "🟢 Active" : "⚪ Empty"}\n\n` +
          pickerText,
        keyboard,
      );
    } catch (e: any) {
      logger.warn(`[/chat] Failed to list sessions: ${e.message}`);
      await replyHtml(
        ctx,
        `<b>💬 Chat Sessions</b>\n\n` +
          `<b>Current:</b> ${escapeHtml(info.title)}\n` +
          `<b>Status:</b> ${info.hasActiveChat ? "🟢 Active" : "⚪ Empty"}\n\n` +
          `⚠️ Could not load past conversations.`,
      );
    }
  });

  // [KaizenGuy] /chat_sync — sync all Antigravity conversations → Forum Topics
  bot.command("chat_sync", async (ctx) => {
    if (!config.forumGroupId) {
      await ctx.reply("⚠️ forumGroupId chưa cấu hình trong ~/.remoat/config.json");
      return;
    }

    const ch = getChannel(ctx);
    const resolved = await resolveWorkspaceAndCdp(ch);
    const activeNames = bridge.pool.getActiveWorkspaceNames();
    const cdp =
      resolved?.cdp ??
      (activeNames.length > 0
        ? bridge.pool.getConnected(activeNames[0])
        : null);

    if (!cdp) {
      await ctx.reply("⚠️ Không kết nối được CDP. Mở Antigravity trước.");
      return;
    }

    await ctx.reply("🔄 Đang sync conversations → Forum Topics...");

    try {
      const sessions = await chatSessionService.listAllSessions(cdp);
      if (sessions.length === 0) {
        await ctx.reply("⚠️ Không tìm thấy conversation nào trên Antigravity.");
        return;
      }

      const guildId = String(config.forumGroupId);
      const workspacePath = resolved?.projectName ?? activeNames[0] ?? "daisy";

      // Get existing topic mappings
      const existingRecords = chatSessionRepo.findAllByGuildId(guildId);
      const existingByName = new Map<string, ChatSessionRecord>();
      for (const rec of existingRecords) {
        if (rec.displayName) existingByName.set(rec.displayName, rec);
      }

      let created = 0;
      let skipped = 0;
      const errors: string[] = [];

      topicManager.setChatId(config.forumGroupId);

      for (const session of sessions) {
        const title = session.title;
        if (!title || title === "(Untitled)" || title === "Agent") {
          skipped++;
          continue;
        }

        // Check if topic still exists for this conversation
        const existing = existingByName.get(title);
        if (existing?.topicId) {
          // Verify topic is still alive — editForumTopic will throw if deleted
          try {
            await bot.api.editForumTopic(config.forumGroupId!, existing.topicId, {
              name: `💬 ${title}`,
            });
            skipped++;
            continue;
          } catch {
            // Topic was deleted on Telegram — clean up DB and recreate
            logger.info(`[chat_sync] Topic ${existing.topicId} for "${title}" no longer exists, recreating`);
            chatSessionRepo.deleteByChannelId(existing.channelId);
            workspaceBindingRepo.deleteByChannelId(existing.channelId);
          }
        }

        try {
          // Create Forum Topic
          const topicId = await topicManager.createSessionTopic(title);

          // Save mapping to DB
          const channelId = `${config.forumGroupId}:${topicId}`;
          chatSessionRepo.upsertByTopicId(
            channelId,
            guildId,
            workspacePath,
            created + 1,
            title,
            guildId,
            topicId,
          );

          // Also register workspace binding so messages route correctly
          workspaceBindingRepo.upsert({
            channelId,
            workspacePath,
            guildId,
          });

          created++;
          // Rate limit: Telegram allows ~20 requests/min for groups
          await new Promise(r => setTimeout(r, 1500));
        } catch (e: any) {
          errors.push(`${title}: ${e.message}`);
          logger.error(`[chat_sync] Failed to create topic for "${title}": ${e.message}`);
        }
      }

      let report = `✅ <b>Sync hoàn tất</b>\n\n`;
      report += `📌 Tạo mới: <b>${created}</b> topic(s)\n`;
      report += `⏭️ Bỏ qua: <b>${skipped}</b> (đã có hoặc không tên)\n`;
      if (errors.length > 0) {
        report += `\n⚠️ Lỗi:\n` + errors.map(e => `• ${escapeHtml(e)}`).join('\n');
      }
      await replyHtml(ctx, report);
    } catch (e: any) {
      await ctx.reply(`❌ Lỗi sync: ${e.message}`);
    }
  });

  // /ping command
  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply("🏓 Pong!");
    const latency = Date.now() - start;
    await bot.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      `🏓 Pong! Latency: <b>${latency}ms</b>`,
      { parse_mode: "HTML" },
    );
  });

  // =============================================================================
  // Callback query handler (inline keyboard buttons)
  // =============================================================================

  
}
