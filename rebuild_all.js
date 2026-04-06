const fs = require('fs');

const imports = fs.readFileSync('/tmp/all_imports.ts', 'utf-8');

const tpl_types = `import { Bot, Context, InlineKeyboard } from "grammy";
import Database from "better-sqlite3";
${imports}

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
  db: any;
  getChannel: (ctx: Context) => any;
  resolveWorkspaceAndCdp: (ch: any) => Promise<any>;
  replyHtml: (ctx: Context, text: string, keyboard?: InlineKeyboard) => Promise<void>;
  
  // Callbacks
  cleanupHandler: any;
  planContentCache: Map<string, string[]>;
  getChannelFromCb: (ctx: Context) => any;

  // Messages
  planEditPendingChannels: Map<string, boolean>;
}
`;

fs.writeFileSync('src/bot/types.ts', tpl_types);

const createTpl = (code, handlerName, depsList) => `${imports}
import { CommandDeps } from "./types";
import { channelKey, stripHtmlForFile } from "./helpers";

export function ${handlerName}(bot: Bot, deps: CommandDeps) {
  let {
    ${depsList}
  } = deps;

${code}
}
`;

const commandsCode = fs.readFileSync('/tmp/commandsCode.ts', 'utf-8');
const callbackCode = fs.readFileSync('/tmp/callbackCode.ts', 'utf-8');
const messageCode = fs.readFileSync('/tmp/messageCode.ts', 'utf-8');
const mediaCode = fs.readFileSync('/tmp/mediaCode.ts', 'utf-8');
const httpCode = fs.readFileSync('/tmp/httpCode.ts', 'utf-8');

const allDepsTemplate = `bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, 
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels`;

fs.writeFileSync('src/bot/commandHandlers.ts', createTpl(commandsCode, 'registerCommands', allDepsTemplate));
fs.writeFileSync('src/bot/callbackHandler.ts', createTpl(callbackCode, 'registerCallbackHandler', allDepsTemplate));
fs.writeFileSync('src/bot/messageHandler.ts', createTpl(messageCode, 'registerMessageHandler', allDepsTemplate));
fs.writeFileSync('src/bot/mediaHandler.ts', createTpl(mediaCode, 'registerMediaHandlers', allDepsTemplate));
fs.writeFileSync('src/bot/httpServer.ts', createTpl(httpCode, 'startHttpServer', allDepsTemplate));

console.log("Recreated 5 files with all imports.");
