const fs = require('fs');

const imports = fs.readFileSync('/tmp/all_imports.ts', 'utf-8');

const tpl_types = `import { Bot, Context } from "grammy";
import Database from "better-sqlite3";
${imports}

export interface CommandDeps {
  bridge: CdpBridge;
  config: ReturnType<typeof loadConfig>;
  chatSessionService: ChatSessionService;
  chatSessionRepo: ChatSessionRepository;
  workspaceBindingRepo: WorkspaceBindingRepository;
  templateRepo: TemplateRepository;
  scheduleService: ScheduleService;
  scheduleRepo: ScheduleRepository;
  topicManager: TelegramTopicManager;
  titleGenerator: TitleGeneratorService;
  workspaceService: WorkspaceService;
  modeService: ModeService;
  modelService: ModelService;
  promptDispatcher: PromptDispatcher;
  db: Database.Database;
  getChannel: (ctx: Context) => TelegramChannel;
  resolveWorkspaceAndCdp: (ch: TelegramChannel) => Promise<{cdp: CdpService; projectName: string; workspacePath: string} | null>;
  replyHtml: (ctx: Context, text: string, keyboard?: any) => Promise<void>;
  
  // Callbacks
  cleanupHandler: CleanupCommandHandler;
  planContentCache: Map<string, string[]>;
  getChannelFromCb: (ctx: Context) => TelegramChannel;

  // Messages
  planEditPendingChannels: Map<string, boolean>;
}
`;

fs.writeFileSync('src/bot/types.ts', tpl_types);

// Add imports to the split files. Let's just modify build_split.js
const headerVars = `
const userStopRequestedChannels = new Map<string, boolean>();
const planEditPendingChannels = new Map<string, boolean>();
const planContentCache = new Map<string, string[]>();

function channelKey(ch: TelegramChannel): string {
    return \`\${ch.chatId}:\${ch.threadId || "0"}\`;
}
function stripHtmlForFile(html: string): string {
  // dummy implementation just to clear ts errors if used inside handlers
  return html.replace(/<[^>]+>/g, "");
}
`;

// It's easier if we just prepend all_imports.ts and headerVars to all split files!
// Wait, duplicate identifiers if we redefine them. We shouldn't redefine userStopRequestedChannels everywhere.
// That's why they should be passed in deps! Wait, they ARE passed in deps! 
// channelKey should be imported from somewhere, perhaps put it in utils/telegramFormatter or create a helper block in each file.
