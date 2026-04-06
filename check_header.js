const fs = require('fs');

const header = fs.readFileSync('/tmp/header.ts', 'utf-8');
const footer = fs.readFileSync('/tmp/footerCode.ts', 'utf-8');

const tpl_index = `${header}
import { CommandDeps } from "./types";
import { registerCommands } from "./commandHandlers";
import { registerCallbackHandler } from "./callbackHandler";
import { registerMessageHandler } from "./messageHandler";
import { registerMediaHandlers } from "./mediaHandler";
import { startHttpServer } from "./httpServer";
import { CleanupCommandHandler } from "../commands/cleanupCommandHandler";

// Shared Maps
const userStopRequestedChannels = new Map<string, boolean>();
const planEditPendingChannels = new Map<string, boolean>();
const planContentCache = new Map<string, string[]>();

export const startBot = async (cliLogLevel?: LogLevel) => {
  // Existing init blocks ...
  if (cliLogLevel) {
    logger.level = cliLogLevel;
  }
  const config = loadConfig();
  if (config.debugMode) {
    logger.level = "debug";
  }

  // NOTE: the code in header.ts probably already contains part of startBot.
`;

fs.writeFileSync('/tmp/check_header.js', `
const fs = require('fs');
const header = fs.readFileSync('/tmp/header.ts', 'utf-8');
console.log(header.slice(-500));
`);
