const fs = require('fs');

const header = fs.readFileSync('/tmp/header.ts', 'utf-8');
const beforeCmdStart = fs.readFileSync('/tmp/beforeCmdStart.ts', 'utf-8');
const footer = fs.readFileSync('/tmp/footerCode.ts', 'utf-8');

const tpl_index = `${header}
import { CommandDeps } from "./types";
import { CleanupCommandHandler } from "../commands/cleanupCommandHandler";

// Shared Maps
const userStopRequestedChannels = new Map<string, boolean>();
const planEditPendingChannels = new Map<string, boolean>();
const planContentCache = new Map<string, string[]>();

${beforeCmdStart}
  const deps = {
    bridge, config, chatSessionService, chatSessionRepo, workspaceBindingRepo, templateRepo, 
    scheduleService, scheduleRepo, topicManager, titleGenerator, 
    workspaceService, modeService, modelService, promptDispatcher, db, 
    getChannel, resolveWorkspaceAndCdp, replyHtml, cleanupHandler, planContentCache, getChannelFromCb: getChannel, planEditPendingChannels
  };

  const { registerCommands } = await import("./commandHandlers");
  registerCommands(bot, deps as any);

  const { registerCallbackHandler } = await import("./callbackHandler");
  registerCallbackHandler(bot, deps as any);

  const { registerMessageHandler } = await import("./messageHandler");
  registerMessageHandler(bot, deps as any);

  const { registerMediaHandlers } = await import("./mediaHandler");
  registerMediaHandlers(bot, deps as any);

  const { startHttpServer } = await import("./httpServer");
  await startHttpServer(bot, deps as any);

${footer}
`;

fs.writeFileSync('src/bot/index.ts', tpl_index);
console.log("src/bot/index.ts rewritten. Running tsc...");
