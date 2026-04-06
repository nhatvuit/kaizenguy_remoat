
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

export interface CommandDeps {
  bridge: any;
  config: any;
  chatSessionService: any;
  chatSessionRepo: any;
  workspaceBindingRepo: any;
  templateRepo: any;
  scheduleService: any;
  scheduleRepo: any;
  topicManager: any;
  titleGenerator: any;
  workspaceService: any;
  modeService: any;
  modelService: any;
  promptDispatcher: any;
  slashCommandHandler: any;
  api: any;
  db: any;
  getChannel: (ctx: Context) => any;
  resolveWorkspaceAndCdp: (ch: any) => Promise<any>;
  replyHtml: (ctx: Context, text: string, keyboard?: any) => Promise<void>;
  
  // Callbacks
  cleanupHandler: any;
  planContentCache: Map<string, string[]>;
  getChannelFromCb: (ctx: Context) => any;

  // Messages
  planEditPendingChannels: any;
}
