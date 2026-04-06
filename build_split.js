const fs = require('fs');
const path = require('path');

const commandsCode = fs.readFileSync('/tmp/commandsCode.ts', 'utf-8');
const callbackCode = fs.readFileSync('/tmp/callbackCode.ts', 'utf-8');
const messageCode = fs.readFileSync('/tmp/messageCode.ts', 'utf-8');
const mediaCode = fs.readFileSync('/tmp/mediaCode.ts', 'utf-8');
const httpCode = fs.readFileSync('/tmp/httpCode.ts', 'utf-8');

const tpl_commands = `import { Bot, Context, InlineKeyboard } from "grammy";
import { CommandDeps } from "./types";
import { logger } from "../utils/logger";
import { parseMessageContent } from "../commands/messageParser";
import { SlashCommandHandler } from "../commands/slashCommandHandler";
import { CLEANUP_ARCHIVE_BTN, CLEANUP_DELETE_BTN, CLEANUP_CANCEL_BTN } from "../commands/cleanupCommandHandler";
import { buildModeModelLines, splitForEmbedDescription } from "../utils/streamMessageFormatter";
import { formatForTelegram } from "../utils/telegramFormatter";
import { buildModeUI, sendModeUI } from "../ui/modeUi";
import { buildModelsUI, sendModelsUI } from "../ui/modelsUi";
import { sendTemplateUI } from "../ui/templateUi";
import { sendAutoAcceptUI } from "../ui/autoAcceptUi";
import { handleScreenshot } from "../ui/screenshotUi";
import { buildProjectListUI } from "../ui/projectListUi";
import { buildSessionPickerUI } from "../ui/sessionPickerUi";
import { getAntigravityCdpHint } from "../utils/pathUtils";

export function registerCommands(bot: Bot, deps: CommandDeps) {
  const {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, 
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml
  } = deps;

${commandsCode}
}
`;

const tpl_callback = `import { Bot, Context, InlineKeyboard } from "grammy";
import { CommandDeps } from "./types";
import { logger } from "../utils/logger";
import { escapeHtml } from "../utils/telegramFormatter";
import { parseApprovalCustomId, parseErrorPopupCustomId, parsePlanningCustomId, ensureApprovalDetector, ensureErrorPopupDetector, ensurePlanningDetector } from "../services/cdpBridgeManager";
import { PLAN_VIEW_BTN, PLAN_PROCEED_BTN, PLAN_EDIT_BTN, PLAN_REFRESH_BTN, PLAN_PAGE_PREFIX, buildPlanNotificationUI, buildPlanContentUI, paginatePlanContent } from "../ui/planUi";
import { TEMPLATE_BTN_PREFIX, parseTemplateButtonId } from "../ui/templateUi";
import { AUTOACCEPT_BTN_ON, AUTOACCEPT_BTN_OFF, AUTOACCEPT_BTN_REFRESH, sendAutoAcceptUI } from "../ui/autoAcceptUi";
import { PROJECT_PAGE_PREFIX, PROJECT_SELECT_ID, parseProjectPageId, buildProjectListUI } from "../ui/projectListUi";
import { SESSION_SELECT_ID, isSessionSelectId } from "../ui/sessionPickerUi";
import { AVAILABLE_MODES, MODE_DISPLAY_NAMES } from "../services/modeService";
import { CLEANUP_ARCHIVE_BTN, CLEANUP_DELETE_BTN, CLEANUP_CANCEL_BTN } from "../commands/cleanupCommandHandler";

export function registerCallbackHandler(bot: Bot, deps: CommandDeps) {
  const {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, topicManager, titleGenerator, workspaceService, modeService, modelService, 
    promptDispatcher, getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb
  } = deps;

${callbackCode}
}
`;

const tpl_message = `import { Bot, Context } from "grammy";
import { CommandDeps } from "./types";
import { logger } from "../utils/logger";

export function registerMessageHandler(bot: Bot, deps: CommandDeps) {
  const {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, 
    topicManager, titleGenerator, workspaceService, promptDispatcher, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, planEditPendingChannels
  } = deps;

${messageCode}
}
`;

const tpl_media = `import { Bot, Context, InputFile } from "grammy";
import { CommandDeps } from "./types";
import { logger } from "../utils/logger";
import { downloadTelegramImages, buildPromptWithAttachmentUrls } from "../utils/imageHandler";
import { checkWhisperAvailability, downloadTelegramVoice, transcribeVoice } from "../utils/voiceHandler";

export function registerMediaHandlers(bot: Bot, deps: CommandDeps) {
  const {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, 
    topicManager, titleGenerator, workspaceService, promptDispatcher, 
    getChannel, resolveWorkspaceAndCdp, replyHtml
  } = deps;

${mediaCode}
}
`;

const tpl_http = `import { Bot } from "grammy";
import { CommandDeps } from "./types";
import { logger } from "../utils/logger";
import { getCurrentCdp, TelegramChannel } from "../services/cdpBridgeManager";

export async function startHttpServer(bot: Bot, deps: CommandDeps) {
  const {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, 
    scheduleService, topicManager, titleGenerator, promptDispatcher
  } = deps;

${httpCode}
}
`;

fs.writeFileSync('src/bot/commandHandlers.ts', tpl_commands);
fs.writeFileSync('src/bot/callbackHandler.ts', tpl_callback);
fs.writeFileSync('src/bot/messageHandler.ts', tpl_message);
fs.writeFileSync('src/bot/mediaHandler.ts', tpl_media);
fs.writeFileSync('src/bot/httpServer.ts', tpl_http);
console.log("Created 5 files.");
