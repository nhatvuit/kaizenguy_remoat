const fs = require('fs');
const content = fs.readFileSync('src/bot/index.ts', 'utf-8');

// The file startBot is from around line 1234
const startBotIndex = content.indexOf('export const startBot = async (cliLogLevel?: LogLevel) => {');

// The header includes imports and functions like stripHtmlForFile, etc.
const header = content.substring(0, startBotIndex);

// inside startBot we have setup and then handlers
// Let's find where bot.command("start", begins.
const cmdStartIndex = content.indexOf('bot.command("start",');

// Wait, the first handler is start?
// Let's grab everything inside startBot before bot.command("start",
const beforeCmdStart = content.substring(startBotIndex, cmdStartIndex);

// End of commands, start of callback handler
const cbStartIndex = content.indexOf('bot.on("callback_query:data",');
const commandsCode = content.substring(cmdStartIndex, cbStartIndex);

// End of callback handler, start of message text handler
const msgStartIndex = content.indexOf('bot.on("message:text",');
const callbackCode = content.substring(cbStartIndex, msgStartIndex);

// End of message text handler, start of message photo handler
const photoStartIndex = content.indexOf('bot.on("message:photo",');

// Before photo, there is the mediaGroupBuffer declaration
// It's around line 3170. Let's find it.
const mediaGroupBufferIndex = content.indexOf('const mediaGroupBuffer = ');
const messageCode = content.substring(msgStartIndex, mediaGroupBufferIndex);

// End of voices handler? Let's find where httpServer logic starts.
// Line 3390: const HTTP_PORT = 9999;
const httpPortIndex = content.indexOf('const HTTP_PORT = 9999;');
const mediaCode = content.substring(mediaGroupBufferIndex, httpPortIndex);

// End of httpServer? Let's find bot.start({
const botStartIndex = content.indexOf('await bot.start({');
const httpCode = content.substring(httpPortIndex, botStartIndex);

const footerCode = content.substring(botStartIndex);

fs.writeFileSync('/tmp/header.ts', header);
fs.writeFileSync('/tmp/beforeCmdStart.ts', beforeCmdStart);
fs.writeFileSync('/tmp/commandsCode.ts', commandsCode);
fs.writeFileSync('/tmp/callbackCode.ts', callbackCode);
fs.writeFileSync('/tmp/messageCode.ts', messageCode);
fs.writeFileSync('/tmp/mediaCode.ts', mediaCode);
fs.writeFileSync('/tmp/httpCode.ts', httpCode);
fs.writeFileSync('/tmp/footerCode.ts', footerCode);

console.log("Splitting complete. File lengths:");
console.log("header", header.length);
console.log("beforeCmdStart", beforeCmdStart.length);
console.log("commandsCode", commandsCode.length);
console.log("callbackCode", callbackCode.length);
console.log("messageCode", messageCode.length);
console.log("mediaCode", mediaCode.length);
console.log("httpCode", httpCode.length);
console.log("footerCode", footerCode.length);
