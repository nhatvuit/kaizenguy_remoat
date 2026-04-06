import { Bot, Context, InlineKeyboard } from "grammy";
import { CommandDeps } from "./types";
import { logger } from "../utils/logger";
import { parseMessageContent } from "../commands/messageParser";
import { SlashCommandHandler } from "../commands/slashCommandHandler";
import {
  CLEANUP_ARCHIVE_BTN,
  CLEANUP_DELETE_BTN,
  CLEANUP_CANCEL_BTN,
} from "../commands/cleanupCommandHandler";
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

const fs = require('fs');

export function registerCommands(bot: Bot, deps: CommandDeps) {
  const {
    bridge, config, chatSessionService, chatSessionRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, 
    workspaceService,
    modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml
  } = deps;

  // READ CODE
  const code = fs.readFileSync('/tmp/commandsCode.ts', 'utf-8');
  eval(code);
}
