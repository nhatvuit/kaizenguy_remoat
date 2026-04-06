const fs = require('fs');

const header = fs.readFileSync('/tmp/header.ts', 'utf-8');

// Find the last import statement
const lastImportIndex = header.lastIndexOf('import ');
let endOfImports = header.indexOf(';', lastImportIndex);
if (endOfImports === -1) endOfImports = header.indexOf('\n', lastImportIndex);

let imports = header.substring(0, endOfImports + 1);
// remove duplicate imports for better-sqlite3 and grammy if they are already in the manual ones? No, just use imports block only.

const tpl_types = `
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
`;

fs.writeFileSync('src/bot/types.ts', tpl_types);

const createTpl = (code, handlerName, depsList) => `// @ts-nocheck
${imports}
import { CommandDeps } from "./types";
import { channelKey, stripHtmlForFile } from "./helpers";

export async function ${handlerName}(bot: Bot, deps: CommandDeps) {
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
    scheduleService, scheduleRepo, topicManager, titleGenerator, api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels`;

fs.writeFileSync('src/bot/commandHandlers.ts', createTpl(commandsCode, 'registerCommands', allDepsTemplate));
fs.writeFileSync('src/bot/callbackHandler.ts', createTpl(callbackCode, 'registerCallbackHandler', allDepsTemplate));
fs.writeFileSync('src/bot/messageHandler.ts', createTpl(messageCode, 'registerMessageHandler', allDepsTemplate));
fs.writeFileSync('src/bot/mediaHandler.ts', createTpl(mediaCode, 'registerMediaHandlers', allDepsTemplate));
fs.writeFileSync('src/bot/httpServer.ts', createTpl(httpCode, 'startHttpServer', allDepsTemplate));

const beforeCmdStart = fs.readFileSync('/tmp/beforeCmdStart.ts', 'utf-8');
const footer = fs.readFileSync('/tmp/footerCode.ts', 'utf-8');

const tpl_index = `// @ts-nocheck\n${header}
import { CommandDeps } from "./types";
import { channelKey } from "./helpers";

${beforeCmdStart}
  const deps = {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, api: bot.api, slashCommandHandler,
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb, planEditPendingChannels
  };

  const { registerCommands } = await import("./commandHandlers");
  await registerCommands(bot, deps as any);

  const { registerCallbackHandler } = await import("./callbackHandler");
  await registerCallbackHandler(bot, deps as any);

  const { registerMessageHandler } = await import("./messageHandler");
  await registerMessageHandler(bot, deps as any);

  const { registerMediaHandlers } = await import("./mediaHandler");
  await registerMediaHandlers(bot, deps as any);

  const { startHttpServer } = await import("./httpServer");
  await startHttpServer(bot, deps as any);

${footer}
`;

fs.writeFileSync('src/bot/index.ts', tpl_index);

console.log("Recreated 5 files with all imports and index.ts.");
