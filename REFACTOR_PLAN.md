# Remoat Refactor Plan — Chi tiết cho AI thực thi

> **Mục tiêu**: Tách file `src/bot/index.ts` (3,672 dòng) thành 6 module nhỏ, thêm auto-topic trong `/notify`, wrap CDP thành internal API.
> **Nguyên tắc**: KHÔNG thay đổi logic/behavior. Chỉ di chuyển code và tạo abstraction.
> **Ước lượng**: 4 phases, mỗi phase build + test riêng.

---

## Phase 1: Tách `index.ts` thành 6 files

### Bản đồ code hiện tại (line ranges trong `src/bot/index.ts`)

```
Lines 1-136:       Imports + constants
Lines 138-180:     stripHtmlForFile(), utility functions
Lines 182-220:     State variables (userStopRequestedChannels, planEditPendingChannels, etc.)
Lines 222-1232:    sendPromptToAntigravity() — HÀM LÕI, 1000+ dòng
Lines 1234-1495:   startBot() setup — bridge, bot init, middleware, helpers
Lines 1497-1535:   /start, /help commands
Lines 1536-1545:   /mode command
Lines 1547-1582:   /model command
Lines 1584-1622:   /template, /template_add, /template_delete commands
Lines 1624-1648:   /status command
Lines 1649-1661:   /autoaccept command
Lines 1662-1700:   /cleanup command
Lines 1701-1713:   /screenshot command
Lines 1714-1740:   /quota command
Lines 1741-1779:   /stop command
Lines 1780-1786:   /project command
Lines 1787-1955:   /schedule command (~170 dòng)
Lines 1956-2027:   /new command
Lines 2028-2149:   /chat command
Lines 2150-2262:   /chat_sync command
Lines 2265-2278:   /ping command
Lines 2281-2962:   bot.on("callback_query:data") — ~680 dòng
Lines 2963-3168:   bot.on("message:text") — ~200 dòng
Lines 3170-3280:   bot.on("message:photo") + mediaGroup buffer — ~110 dòng
Lines 3274-3388:   bot.on("message:voice") — ~110 dòng
Lines 3390-3672:   HTTP server (/notify, /api/schedule, /send) + bot.start()
```

### File mới 1: `src/bot/commandHandlers.ts`

**Chứa**: Tất cả `bot.command(...)` handlers.

**Cách tách**:
1. Tạo file `src/bot/commandHandlers.ts`
2. Export 1 function: `registerCommands(bot, deps)`
3. `deps` là object chứa mọi thứ mà handlers cần:
   ```typescript
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
     replyHtml: (ctx: Context, text: string) => Promise<void>;
   }
   ```
4. Di chuyển handlers cho: `start`, `help`, `mode`, `model`, `template`, `template_add`, `template_delete`, `status`, `autoaccept`, `cleanup`, `screenshot`, `quota`, `stop`, `project`, `new`, `chat`, `chat_sync`, `ping`
5. **ĐẶC BIỆT**: `/schedule` phức tạp nhất (~170 dòng) — vẫn di chuyển vào đây nhưng để nguyên logic.

**Test**: `npm run build` phải pass. Chạy bot, gõ `/ping`, `/status`, `/help` trên Telegram.

---

### File mới 2: `src/bot/callbackHandler.ts`

**Chứa**: `bot.on("callback_query:data", ...)` handler (lines 2281-2962).

**Cách tách**:
1. Tạo file `src/bot/callbackHandler.ts`
2. Export: `registerCallbackHandler(bot, deps)`
3. Di chuyển toàn bộ callback_query handler (approval buttons, planning buttons, error popup buttons, template buttons, mode buttons, model buttons, project selection, session picker, plan pages, cleanup confirm)
4. `deps` interface tương tự CommandDeps nhưng thêm:
   ```typescript
   cleanupHandler: CleanupCommandHandler;
   planContentCache: Map<string, string[]>;
   getChannelFromCb: (ctx: Context) => TelegramChannel;
   ```

**Test**: `npm run build`. Bấm nút Approve/Deny/Template trên Telegram.

---

### File mới 3: `src/bot/messageHandler.ts`

**Chứa**: `bot.on("message:text", ...)` handler (lines 2963-3168).

**Cách tách**:
1. Tạo file `src/bot/messageHandler.ts`
2. Export: `registerMessageHandler(bot, deps)`
3. Di chuyển logic: plan edit interception, command parsing, forum topic fallback, session routing, prompt dispatch
4. Cần access đến: `planEditPendingChannels` Map — export nó từ nơi khai báo hoặc pass qua deps.

**Test**: `npm run build`. Gửi tin nhắn text bình thường vào Topic trên Telegram, kiểm tra nó inject vào Antigravity đúng.

---

### File mới 4: `src/bot/mediaHandler.ts`

**Chứa**: `bot.on("message:photo")`, `bot.on("message:voice")`, `mediaGroupBuffer`, `processPhotoGroup()` (lines 3170-3388).

**Cách tách**:
1. Tạo file `src/bot/mediaHandler.ts`
2. Export: `registerMediaHandlers(bot, deps)`
3. Di chuyển: mediaGroupBuffer Map, processPhotoGroup function, photo handler, voice handler.

**Test**: `npm run build`. Gửi ảnh vào Telegram bot.

---

### File mới 5: `src/bot/httpServer.ts`

**Chứa**: HTTP server setup + `/notify`, `/api/schedule`, `/send` endpoints (lines 3390-3645).

**Cách tách**:
1. Tạo file `src/bot/httpServer.ts`
2. Export: `startHttpServer(bot, deps)`
3. Di chuyển toàn bộ createServer logic, /notify handler, /api/schedule handler, /send handler.
4. Xoá file `src/services/notificationService.ts` cũ (port 3847) vì đã gộp chức năng vào `/notify` (port 9999). Nhưng **CHỈ XOÁ NẾU** confirm port 3847 không còn ai dùng. Kiểm tra bằng: `grep -r "3847\|notificationService" src/` — nếu chỉ có import + start call trong index.ts thì xoá được.

**Test**: `npm run build`. Chạy `curl http://localhost:9999/health`. Test `/notify` push message.

---

### File mới 6: `src/bot/index.ts` (rút gọn)

Sau khi tách xong, `index.ts` chỉ còn:
```typescript
// Imports
import { registerCommands } from './commandHandlers';
import { registerCallbackHandler } from './callbackHandler';
import { registerMessageHandler } from './messageHandler';
import { registerMediaHandlers } from './mediaHandler';
import { startHttpServer } from './httpServer';
// + existing imports for sendPromptToAntigravity, bridge setup, etc.

// Lines 138-220: utilities + state variables — GIỮ NGUYÊN
// Lines 222-1232: sendPromptToAntigravity — GIỮ NGUYÊN (quá phức tạp, tách sau)
// Lines 1234-1495: startBot setup — GIỮ NGUYÊN nhưng thay thế inline handlers bằng:

export const startBot = async (...) => {
  // ... existing setup code (bridge, bot, middleware, resolveWorkspaceAndCdp, etc.)
  
  const deps = { bridge, config, chatSessionService, ... };
  
  registerCommands(bot, deps);
  registerCallbackHandler(bot, deps);
  registerMessageHandler(bot, deps);
  registerMediaHandlers(bot, deps);
  startHttpServer(bot, deps);
  
  await bot.start({ onStart: ... });
};
```

**Ước tính `index.ts` sau tách**: ~1,400 dòng (setup + sendPromptToAntigravity). Giảm 62%.

---

## Phase 2: Auto-topic trong `/notify`

### Vị trí sửa: `src/bot/httpServer.ts` (sau Phase 1) hoặc trực tiếp `src/bot/index.ts` nếu chưa tách.

### Logic thêm vào `/notify` endpoint:

Trong handler POST `/notify`, sau khi parse JSON body, thêm logic:

```typescript
// Sau dòng:  const notifyTopicId = notifyData.topic_id ? Number(notifyData.topic_id) : undefined;
// Thêm:

const notifyChatTitle = (notifyData.chat_title || "").trim();
let resolvedTopicId = notifyTopicId;

// Auto-create topic nếu có chat_title mà không có topic_id
if (!resolvedTopicId && notifyChatTitle && config.forumGroupId) {
  const guildId = String(config.forumGroupId);
  // Tìm trong DB theo displayName
  const existingSession = chatSessionRepo.findByDisplayName(
    "daisy", // default workspace — có thể lấy từ notifyData.workspace nếu cần
    notifyChatTitle,
  );
  if (existingSession?.topicId) {
    resolvedTopicId = existingSession.topicId;
    logger.info(`[HTTP /notify] Resolved chat_title "${notifyChatTitle}" → topic ${resolvedTopicId}`);
  } else {
    // Tạo topic mới
    try {
      topicManager.setChatId(config.forumGroupId);
      const newTopicId = await topicManager.createSessionTopic(notifyChatTitle);
      const channelId = `${config.forumGroupId}:${newTopicId}`;
      chatSessionRepo.upsertByTopicId(
        channelId, guildId, "daisy", 1, notifyChatTitle, guildId, newTopicId,
      );
      workspaceBindingRepo.upsert({
        channelId, workspacePath: "daisy", guildId,
      });
      resolvedTopicId = newTopicId;
      logger.info(`[HTTP /notify] Auto-created topic "${notifyChatTitle}" → ${newTopicId}`);
    } catch (e: any) {
      logger.error(`[HTTP /notify] Failed to auto-create topic: ${e.message}`);
    }
  }
}

// Thay thế notifyTopicId bằng resolvedTopicId trong tất cả các lệnh sendMessage/sendPhoto/sendMediaGroup bên dưới.
```

### Cần thêm deps cho httpServer:
- `chatSessionRepo: ChatSessionRepository`
- `workspaceBindingRepo: WorkspaceBindingRepository`
- `topicManager: TelegramTopicManager`
- `config` (đã có)

### Cập nhật `notifyData` type:
```typescript
let notifyData: {
  text?: string;
  photo?: string;
  photos?: string[];
  chat_id?: string;
  topic_id?: string | number;
  chat_title?: string;         // ← THÊM MỚI
  workspace?: string;           // ← THÊM MỚI (optional, default "daisy")
};
```

### Cập nhật GEMINI.md (system prompt):
Trong section "Bắt buộc: Giao tiếp qua Telegram", thêm ghi chú rằng Agent có thể gửi `chat_title` thay cho `topic_id` nếu không biết topic_id.

**Test**: 
```bash
TOKEN=$(cat ~/.remoat/config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['telegramBotToken'])")
curl -X POST http://localhost:9999/notify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"Test auto topic","chat_title":"Test Auto Topic"}'
```
Kiểm tra Telegram có tạo Topic mới tên "Test Auto Topic" và gửi text vô đó.

---

## Phase 3: Wrap CDP thành `AgentService`

### File mới: `src/services/agentService.ts`

```typescript
import { CdpService } from './cdpService';
import { ChatSessionService } from './chatSessionService';

export interface ChatSnapshot {
  title: string | null;
  isGenerating: boolean;
}

export class AgentService {
  constructor(
    private cdp: CdpService,
    private chatSessionService: ChatSessionService,
  ) {}

  /** Inject prompt vào textbox và nhấn Enter */
  async send(prompt: string): Promise<void> {
    // Gọi cdp.typeAndSubmitPrompt() hoặc logic tương đương
    // Hiện tại logic này nằm rải rác trong sendPromptToAntigravity
    // Phase 3 chỉ wrap, KHÔNG thay đổi logic bên trong
  }

  /** Tạo chat mới trong Antigravity */
  async newChat(): Promise<{ ok: boolean; error?: string }> {
    return this.chatSessionService.startNewChat(this.cdp);
  }

  /** Switch sang chat có title cụ thể */
  async switchChat(title: string): Promise<{ ok: boolean; error?: string }> {
    return this.chatSessionService.activateSessionByTitle(this.cdp, title);
  }

  /** Lấy title chat hiện tại */
  async getCurrentTitle(): Promise<string | null> {
    // Wrap getCurrentChatTitle() từ cdpBridgeManager.ts
    const { getCurrentChatTitle } = await import('./cdpBridgeManager');
    return getCurrentChatTitle(this.cdp);
  }

  /** Lấy danh sách tất cả sessions */
  async listSessions(): Promise<Array<{ title: string; isActive: boolean }>> {
    return this.chatSessionService.listAllSessions(this.cdp);
  }

  /** Set model */
  async setModel(model: string): Promise<void> {
    await this.cdp.setUiModel(model);
  }

  /** Get current model */
  async getModel(): Promise<string | null> {
    return this.cdp.getCurrentModel();
  }
}
```

### Migration plan:
- Phase 3 CHỈ tạo file và export class.
- KHÔNG refactor callers ngay. Callers (sendPromptToAntigravity, command handlers) vẫn gọi cdp trực tiếp.
- Sau khi AgentService ổn định, dần dần migrate từng caller sang dùng AgentService (Phase 4+, tương lai).

**Test**: `npm run build` pass. AgentService chưa được gọi từ đâu nên không ảnh hưởng runtime.

---

## Phase 4: Dọn code chết (CHỈ LÀM SAU KHI ĐÃ CHẠY ỔN 1 TUẦN)

### Kiểm tra trước khi xoá:
```bash
# Kiểm tra ResponseMonitor còn được gọi ở đâu
grep -rn "ResponseMonitor\|responseMonitor" src/ --include="*.ts"

# Kiểm tra DomExtractor còn được gọi ở đâu  
grep -rn "assistantDomExtractor\|extractAssistant" src/ --include="*.ts"

# Kiểm tra notificationService port 3847 còn được gọi ở đâu
grep -rn "3847\|startNotificationService\|stopNotificationService" src/ --include="*.ts"
```

### Nếu không còn ai dùng:
1. Xoá `src/services/notificationService.ts` (port 3847 — đã thay bằng port 9999)
2. Trong `sendPromptToAntigravity`, ResponseMonitor vẫn được dùng cho non-forum flows. CHỈ XOÁ khi 100% traffic đã chạy qua Forum Topics Push API.

### Thứ KHÔNG XOÁ:
- `ResponseMonitor` — vẫn cần cho trường hợp chưa migrate hết
- `approvalDetector`, `planningDetector`, `errorPopupDetector` — vẫn cần, đây là tính năng core

---

## Checklist thực thi cho AI

```
Phase 1 — Tách index.ts:
[ ] Tạo src/bot/commandHandlers.ts — export registerCommands()
[ ] Tạo src/bot/callbackHandler.ts — export registerCallbackHandler()
[ ] Tạo src/bot/messageHandler.ts — export registerMessageHandler()
[ ] Tạo src/bot/mediaHandler.ts — export registerMediaHandlers()
[ ] Tạo src/bot/httpServer.ts — export startHttpServer()
[ ] Sửa src/bot/index.ts — import và gọi 5 register functions
[ ] npm run build — PASS
[ ] Chạy bot — /ping, /status, gửi text, gửi ảnh đều hoạt động

Phase 2 — Auto-topic /notify:
[ ] Sửa /notify handler — thêm chat_title logic
[ ] Thêm deps (chatSessionRepo, workspaceBindingRepo, topicManager)
[ ] Test curl với chat_title mới
[ ] Cập nhật GEMINI.md thêm hướng dẫn chat_title

Phase 3 — AgentService:
[ ] Tạo src/services/agentService.ts
[ ] Export AgentService class
[ ] npm run build — PASS

Phase 4 — Dọn code chết:
[ ] grep kiểm tra dependencies
[ ] Xoá notificationService.ts nếu an toàn
[ ] Xoá import startNotificationService trong index.ts
```

---

## Lưu ý quan trọng cho AI thực thi:

1. **KHÔNG sửa logic bên trong sendPromptToAntigravity** — Hàm này 1000+ dòng, cực kỳ fragile. Chỉ di chuyển code xung quanh nó.
2. **KHÔNG đổi tên biến/function** — Import paths thay đổi nhưng tên giữ nguyên.
3. **Shared state** (`planEditPendingChannels`, `planContentCache`, `userStopRequestedChannels`) cần được export từ nơi khai báo hoặc pass qua deps.
4. **`channelKey()`, `getChannel()`, `getChannelFromCb()`, `resolveWorkspaceAndCdp()`, `replyHtml()`** — đây là helper functions cần pass qua deps hoặc export riêng.
5. **Build sau mỗi file tách** — `npm run build` phải PASS trước khi tiếp file tiếp theo.
6. **Kiến trúc file mới phải tương thích Grammy bot framework** — mỗi file nhận `bot: Bot` instance và register handlers lên đó.
