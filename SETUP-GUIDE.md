# 🛠️ Hướng Dẫn Setup Hệ Thống Remoat + Antigravity + Daisy

> Tài liệu chi tiết để clone và setup toàn bộ hệ thống Daisy trên một Mac mới.
> Mục tiêu: máy mới có thể điều khiển Antigravity từ Telegram, chạy cron tự động, giữ máy luôn thức.
>
> **Cập nhật: 2026-04-01**

---

## Mục lục

1. [Tổng Quan Kiến Trúc](#1-tổng-quan-kiến-trúc)
2. [Yêu Cầu Hệ Thống](#2-yêu-cầu-hệ-thống)
3. [Bước 1: Cài Phần Mềm Cơ Bản](#3-bước-1-cài-phần-mềm-cơ-bản)
4. [Bước 2: Clone Repos](#4-bước-2-clone-repos)
5. [Bước 3: Setup Remoat (Telegram → Antigravity Bridge)](#5-bước-3-setup-remoat)
6. [Bước 4: Setup Daisy Workspace](#6-bước-4-setup-daisy-workspace)
7. [Bước 5: Tạo Telegram Bot](#7-bước-5-tạo-telegram-bot)
8. [Bước 6: Cấu Hình Remoat](#8-bước-6-cấu-hình-remoat)
9. [Bước 7: Tạo Scripts Start/Stop/Restart](#9-bước-7-tạo-scripts)
10. [Bước 8: Setup Caffeinate (Giữ Mac Luôn Thức)](#10-bước-8-caffeinate)
11. [Bước 9: Setup Cron Schedules](#11-bước-9-cron-schedules)
12. [Bước 10: Setup ZeroClaw (Tuỳ Chọn)](#12-bước-10-zeroclaw)
13. [Bước 11: Verify Toàn Bộ](#13-bước-11-verify)
14. [Troubleshooting](#14-troubleshooting)
15. [Tham Khảo: Hệ Thống Hiện Tại](#15-tham-khảo)

---

## 1. Tổng Quan Kiến Trúc

```
┌──────────────────────────────────────────────────────────────────┐
│                         Mac (luôn thức)                          │
│                                                                  │
│  ┌─────────────┐     CDP WebSocket      ┌───────────────────┐   │
│  │ Remoat Bot   │ ──────────────────────▶ │ Antigravity       │   │
│  │ (Node.js)    │ ◀────────────────────── │ (VS Code fork)    │   │
│  │ port 9999    │     DOM polling         │ CDP port 9222     │   │
│  └──────┬───────┘                        │ workspace: daisy  │   │
│         │                                └───────────────────┘   │
│         │ Grammy (Telegram Bot API)                              │
│         │                                                        │
│  ┌──────┴───────┐                        ┌───────────────────┐   │
│  │ Telegram      │                        │ ZeroClaw (tuỳ     │   │
│  │ @your_bot     │                        │ chọn, Homebrew)   │   │
│  └───────────────┘                        └───────────────────┘   │
│                                                                  │
│  ┌───────────────┐     ┌──────────────────────────────────────┐  │
│  │ caffeinate     │     │ LaunchAgents (auto-start khi boot)   │  │
│  │ (giữ thức)    │     │ - caffeinate                         │  │
│  └───────────────┘     │ - zeroclaw (tuỳ chọn)                │  │
│                        └──────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ Remoat Schedule Service (node-cron + SQLite)              │   │
│  │ → Tự động gửi prompt cho Antigravity theo lịch            │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Luồng hoạt động

1. User gửi tin nhắn Telegram → Remoat Bot nhận qua Grammy
2. Remoat kết nối Antigravity qua CDP WebSocket (port 9222)
3. Remoat inject prompt vào chat input DOM
4. Remoat polling DOM để lấy response
5. Remoat gửi response về Telegram

### Cron tự động

- Remoat có Schedule Service (node-cron + SQLite)
- Theo lịch cron → tự inject prompt vào Antigravity → lấy kết quả → gửi Telegram

---

## 2. Yêu Cầu Hệ Thống

| Yêu cầu | Chi tiết |
|----------|---------|
| **OS** | macOS (đã test trên Apple Silicon & Intel) |
| **Node.js** | >= 18.0.0 (khuyến nghị v20+). Hệ thống hiện tại dùng v24.11.1 |
| **npm** | >= 9 (đi kèm Node) |
| **Antigravity** | Cài từ file `.dmg`, đặt trong `/Applications/Antigravity.app` |
| **Git** | Để clone repos |
| **SQLite3** | Có sẵn trên macOS |
| **Python3** | Có sẵn trên macOS (dùng cho helper scripts) |
| **Telegram account** | Để tạo bot và nhận tin nhắn |
| **Đường truyền internet** | Luôn online (Mac không ngủ) |

---

## 3. Bước 1: Cài Phần Mềm Cơ Bản

### Node.js

```bash
# Cài qua nvm (khuyến nghị)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.zshrc
nvm install 20
nvm use 20
node --version  # >= 20.x
```

Hoặc cài qua Homebrew:
```bash
brew install node@20
```

### Antigravity

1. Tải file `.dmg` từ nguồn chính thức
2. Kéo vào `/Applications/`
3. Mở lần đầu để accept security prompt
4. Đăng nhập tài khoản (nếu cần)

### Homebrew (nếu chưa có)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

---

## 4. Bước 2: Clone Repos

```bash
# Tạo thư mục chứa projects
mkdir -p ~/MyApps
cd ~/MyApps

# Clone Remoat fork (KaizenGuy)
git clone https://github.com/nhatvuit/kaizenguy_remoat.git

# Clone Daisy workspace
git clone <YOUR_DAISY_REPO_URL> daisy
```

> ⚠️ **Quan trọng**: Thay `<YOUR_DAISY_REPO_URL>` bằng URL repo thật. Nếu daisy là private repo, dùng SSH hoặc personal access token.

### Cấu trúc thư mục sau khi clone

```
~/MyApps/
├── kaizenguy_remoat/    ← Remoat bot (TypeScript)
├── daisy/               ← Daisy workspace (skills, memory, scripts)
└── (các project khác)
```

---

## 5. Bước 3: Setup Remoat

### Build Remoat

```bash
cd ~/MyApps/kaizenguy_remoat

# Cài dependencies
npm install

# Build TypeScript → JavaScript
npm run build
```

Output sẽ nằm trong `dist/`. Entry point: `dist/bin/cli.js`

### Tạo thư mục config

```bash
mkdir -p ~/.remoat
mkdir -p ~/.remoat/images
```

### Verify build

```bash
node dist/bin/cli.js --help
```

---

## 6. Bước 4: Setup Daisy Workspace

Sau khi clone `daisy`, đảm bảo cấu trúc như sau:

```
daisy/
├── .agents/
│   └── skills/           ← Chứa tất cả skills (remoat-admin, crypto-trading, etc.)
├── memory/
│   ├── soul.md
│   ├── profile.md
│   ├── preferences.md
│   ├── projects.md
│   ├── decisions.md
│   ├── agenda.md
│   ├── reflections.md
│   ├── journal/          ← Nhật ký theo ngày
│   └── thoughts/         ← Second Brain
├── scripts/
│   ├── start-remoat.sh
│   ├── stop-remoat.sh
│   └── notify.sh
├── GEMINI.md             ← Instructions cho Antigravity
├── config.toml           ← ZeroClaw config (nếu dùng)
└── zeroclaw.toml         ← ZeroClaw Telegram config (nếu dùng)
```

### Cấp quyền execute cho scripts

```bash
chmod +x ~/MyApps/daisy/scripts/*.sh
```

---

## 7. Bước 5: Tạo Telegram Bot

### Tạo bot mới

1. Mở Telegram, tìm **@BotFather**
2. Gõ `/newbot`
3. Đặt tên bot (ví dụ: `My Antigravity Bot`)
4. Đặt username (ví dụ: `my_antigravity_bot`)
5. **Lưu lại Bot Token** (dạng `1234567890:ABCdefGhIjKlmNopQrstUvWxYz`)

### Lấy Telegram User ID

1. Mở Telegram, tìm **@userinfobot** hoặc **@raw_data_bot**
2. Gửi tin nhắn bất kỳ → bot trả về User ID (dạng `1234567890`)
3. **Lưu lại User ID**

---

## 8. Bước 6: Cấu Hình Remoat

### Tạo config file

```bash
cat > ~/.remoat/config.json << 'EOF'
{
  "telegramBotToken": "<BOT_TOKEN_TỪ_BƯỚC_5>",
  "allowedUserIds": [
    "<USER_ID_TỪ_BƯỚC_5>"
  ],
  "workspaceBaseDir": "/Users/<USERNAME>/MyApps",
  "autoApproveFileEdits": false,
  "logLevel": "info",
  "extractionMode": "structured",
  "disableProgressLog": true,
  "useTopics": true
}
EOF
```

**Thay thế:**
- `<BOT_TOKEN_TỪ_BƯỚC_5>` → Bot token từ BotFather
- `<USER_ID_TỪ_BƯỚC_5>` → Telegram User ID (CHỈ SỐ, không có dấu ngoặc kép phụ)
- `<USERNAME>` → macOS username (chạy `whoami` để xem)

### Giải thích config

| Key | Mô tả |
|-----|-------|
| `telegramBotToken` | Token từ BotFather |
| `allowedUserIds` | Chỉ user IDs này mới được dùng bot |
| `workspaceBaseDir` | Thư mục chứa các project. Remoat sẽ tìm workspace trong đây |
| `disableProgressLog` | `true` = không spam progress log lên Telegram |
| `useTopics` | `true` = tạo topic threads trên Telegram (nếu group) |
| `extractionMode` | `structured` = parse response có cấu trúc |

---

## 9. Bước 7: Tạo Scripts Start/Stop/Restart

### start-remoat.sh

```bash
cat > ~/MyApps/daisy/scripts/start-remoat.sh << 'SCRIPT'
#!/bin/bash
# Start Remoat — Mở Antigravity (CDP) + Telegram Bot

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# --- CẤU HÌNH --- (SỬA CHO PHÙ HỢP MÁY MỚI)
WORKSPACE_DIR="$HOME/MyApps/daisy"
REMOAT_DIR="$HOME/MyApps/kaizenguy_remoat"
CDP_PORT=9222
# -----------------

# Kill remoat bot cũ nếu có
pkill -f "remoat start" 2>/dev/null
sleep 1

# Check CDP đang hoạt động chưa
if curl -s --connect-timeout 2 http://127.0.0.1:$CDP_PORT/json/version > /dev/null 2>&1; then
    echo "✅ Antigravity đã mở với CDP. Bỏ qua bước mở."
else
    # Antigravity chạy nhưng không có CDP → quit graceful rồi mở lại
    if pgrep -f "Antigravity.app" > /dev/null 2>&1; then
        echo "⏳ Đóng Antigravity hiện tại (graceful quit)..."
        osascript -e 'tell application "Antigravity" to quit' 2>/dev/null
        sleep 5
    fi

    # Mở Antigravity với CDP
    echo "⏳ Mở Antigravity với CDP + workspace..."
    nohup /Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=$CDP_PORT "$WORKSPACE_DIR" > /dev/null 2>&1 &
    sleep 12

    # Verify CDP
    if curl -s --connect-timeout 2 http://127.0.0.1:$CDP_PORT/json/version > /dev/null 2>&1; then
        echo "✅ CDP hoạt động."
    else
        echo "❌ CDP không phản hồi. Có thể cần thử lại."
    fi
fi

# Khởi động Telegram bot từ local build
nohup node "$REMOAT_DIR/dist/bin/cli.js" start > ~/.remoat/bot.log 2>&1 &
echo "✅ Remoat bot started. PID: $!"
SCRIPT

chmod +x ~/MyApps/daisy/scripts/start-remoat.sh
```

> **Lưu ý cho Apple Silicon (M1/M2/M3+)**: Nếu Node bị lỗi architecture, thay `nohup node` thành `nohup arch -arm64 /usr/local/bin/node` hoặc dùng đường dẫn Node từ `which node`.

### stop-remoat.sh

```bash
cat > ~/MyApps/daisy/scripts/stop-remoat.sh << 'SCRIPT'
#!/bin/bash
# Stop Remoat — Tắt bot + (tuỳ chọn) tắt Antigravity

# Kill Remoat bot
if pgrep -f "remoat start" > /dev/null 2>&1; then
    pkill -f "remoat start"
    echo "✅ Remoat bot đã tắt."
else
    echo "ℹ️ Remoat bot không đang chạy."
fi

# Tắt Antigravity (graceful quit)
if pgrep -f "Antigravity.app" > /dev/null 2>&1; then
    osascript -e 'tell application "Antigravity" to quit' 2>/dev/null
    echo "✅ Antigravity đã tắt."
else
    echo "ℹ️ Antigravity không đang chạy."
fi
SCRIPT

chmod +x ~/MyApps/daisy/scripts/stop-remoat.sh
```

### restart-remoat.sh (tiện lợi)

```bash
cat > ~/MyApps/daisy/scripts/restart-remoat.sh << 'SCRIPT'
#!/bin/bash
# Restart Remoat — Stop rồi Start lại
echo "🔄 Restarting Remoat..."
bash "$(dirname "$0")/stop-remoat.sh"
sleep 5
bash "$(dirname "$0")/start-remoat.sh"
SCRIPT

chmod +x ~/MyApps/daisy/scripts/restart-remoat.sh
```

### notify.sh (gửi notification về Telegram)

```bash
cat > ~/MyApps/daisy/scripts/notify.sh << 'SCRIPT'
#!/bin/bash
# Gửi notification đến Telegram qua Remoat hoặc fallback direct API
# Usage: bash notify.sh "message"

[ -z "$1" ] && echo "Usage: bash notify.sh \"message\"" && exit 1

MSG="$1"
JSON_MSG=$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' <<< "$MSG")

# Lấy config
BOT_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.remoat/config.json'))['telegramBotToken'])" 2>/dev/null)
CHAT_ID=$(python3 -c "import json; print(json.load(open('$HOME/.remoat/config.json'))['allowedUserIds'][0])" 2>/dev/null)

[ -z "$BOT_TOKEN" ] && echo "❌ No bot token" && exit 1

# Try Remoat HTTP API first
RESP=$(curl --connect-timeout 3 --max-time 8 -s -X POST "http://127.0.0.1:9999/notify" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -d "{\"text\": $JSON_MSG}" 2>/dev/null)

if echo "$RESP" | grep -q '"ok"'; then
  echo "✅ Sent via Remoat"
  exit 0
fi

# Fallback: direct Telegram Bot API
curl --connect-timeout 10 --max-time 15 -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"$CHAT_ID\", \"text\": $JSON_MSG}" > /dev/null 2>&1

echo "✅ Sent via direct API"
SCRIPT

chmod +x ~/MyApps/daisy/scripts/notify.sh
```

---

## 10. Bước 8: Setup Caffeinate (Giữ Mac Luôn Thức)

Mac cần luôn thức để Remoat + Antigravity hoạt động 24/7.

### Tạo LaunchAgent

```bash
cat > ~/Library/LaunchAgents/com.nhatvu.caffeinate.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nhatvu.caffeinate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF
```

### Kích hoạt

```bash
launchctl load ~/Library/LaunchAgents/com.nhatvu.caffeinate.plist
```

### Verify

```bash
pgrep -la caffeinate
# Phải thấy: /usr/bin/caffeinate -s
```

### Giải thích flags

| Flag | Tác dụng |
|------|---------|
| `-s` | Ngăn system sleep (kể cả khi đóng nắp nếu cắm nguồn) |
| `-d` | Ngăn display sleep (thêm nếu cần màn hình luôn sáng) |
| `-i` | Ngăn idle sleep |

> **Tip**: Bật thêm trong **System Preferences → Energy Saver / Battery**:
> - ✅ Prevent your Mac from automatically sleeping when the display is off
> - ✅ Wake for network access

---

## 11. Bước 9: Cron Schedules

Remoat có Schedule Service tích hợp (node-cron + SQLite). Schedules lưu trong `~/.remoat/antigravity.db`.

### Database tự tạo khi Remoat start lần đầu

Nếu muốn tạo thủ công:

```bash
sqlite3 ~/.remoat/antigravity.db << 'SQL'
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron_expression TEXT NOT NULL,
    prompt TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    model TEXT
);
SQL
```

### Thêm schedules (ví dụ hệ thống hiện tại)

```bash
# ===== SCHEDULE 1: Báo Cáo Sáng (6:30 sáng) =====
sqlite3 ~/.remoat/antigravity.db "INSERT INTO schedules (cron_expression, prompt, workspace_path, enabled) VALUES (
'30 6 * * *',
'Đọc skill daisy-reminder rồi thực hiện Daily Brief (đọc agenda.md và 3 journal entries). SAU ĐÓ đọc skill crypto-trading, phân tích thị trường crypto (BTC, ETH, SOL, BNB) và MBB. CUỐI CÙNG, kiểm tra kế hoạch content tuần này của 2 dự án: Tân Phong và Sammebe xem hôm nay có bài cần đăng không. GOM TẤT CẢ thành 1 Báo Cáo Sáng duy nhất.',
'$HOME/MyApps/daisy',
1
);"

# ===== SCHEDULE 2: Nightly Save (23:00) =====
sqlite3 ~/.remoat/antigravity.db "INSERT INTO schedules (cron_expression, prompt, workspace_path, enabled) VALUES (
'0 23 * * *',
'save',
'$HOME/MyApps/daisy',
1
);"

# ===== SCHEDULE 3: Personal Branding (7:00 sáng) =====
sqlite3 ~/.remoat/antigravity.db "INSERT INTO schedules (cron_expression, prompt, workspace_path, enabled, model) VALUES (
'0 7 * * *',
'Đọc skill personal-branding. Thực hiện BÀI CHÍNH...',
'$HOME/MyApps/daisy',
1,
'Gemini 3.1 Pro (High)'
);"

# ===== SCHEDULE 4: Personal Branding Review (22:00) =====
sqlite3 ~/.remoat/antigravity.db "INSERT INTO schedules (cron_expression, prompt, workspace_path, enabled) VALUES (
'0 22 * * *',
'Đọc skill personal-branding. Chạy scrape-engagement.mjs...',
'$HOME/MyApps/daisy',
1
);"
```

> ⚠️ **Cron timezone**: Remoat chạy theo **system timezone** của Mac. Đảm bảo Mac đặt đúng timezone (VD: `Asia/Ho_Chi_Minh`).

### Quản lý schedules

```bash
# List tất cả
sqlite3 ~/.remoat/antigravity.db "SELECT id, cron_expression, substr(prompt, 1, 60), enabled, model FROM schedules;"

# Tắt 1 schedule (không xoá)
sqlite3 ~/.remoat/antigravity.db "UPDATE schedules SET enabled = 0 WHERE id = <ID>;"

# Bật lại
sqlite3 ~/.remoat/antigravity.db "UPDATE schedules SET enabled = 1 WHERE id = <ID>;"

# Xoá
sqlite3 ~/.remoat/antigravity.db "DELETE FROM schedules WHERE id = <ID>;"

# Set model cho schedule
sqlite3 ~/.remoat/antigravity.db "UPDATE schedules SET model = 'Gemini 3.1 Pro (High)' WHERE id = <ID>;"
```

> ⚠️ **Sau khi sửa schedule, PHẢI restart Remoat** vì node-cron chỉ load lúc startup.

---

## 12. Bước 10: Setup ZeroClaw (TÙY CHỌN)

ZeroClaw là agent AI chạy song song qua Telegram, **không bắt buộc** cho Remoat. Nhưng nếu muốn có thêm 1 kênh chat AI + aliases (mở/tắt Remoat từ Telegram):

### Cài qua Homebrew

```bash
brew install zeroclaw
```

### Tạo LaunchAgent

```bash
cat > ~/Library/LaunchAgents/com.nhatvu.zeroclaw.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nhatvu.zeroclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/zeroclaw</string>
        <string>daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ZEROCLAW_WORKSPACE</key>
        <string>/Users/<USERNAME>/MyApps/daisy</string>
        <key>GEMINI_API_KEY</key>
        <string><YOUR_GEMINI_API_KEY></string>
        <key>ZEROCLAW_BOT_TOKEN</key>
        <string><ZEROCLAW_BOT_TOKEN></string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/<USERNAME>/.zeroclaw/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/<USERNAME>/.zeroclaw/daemon.log</string>
</dict>
</plist>
EOF
```

### Config ZeroClaw

Trong `daisy/zeroclaw.toml` (file này đã có trong repo daisy), cập nhật:
- `allowed_users` → Telegram User ID của bạn
- Aliases → paths phù hợp với máy mới

### Kích hoạt

```bash
mkdir -p ~/.zeroclaw
launchctl load ~/Library/LaunchAgents/com.nhatvu.zeroclaw.plist
```

### Aliases hữu ích (trong zeroclaw.toml)

```toml
[[aliases]]
match = "exact"
trigger = "mở anti"
command = "bash /Users/<USERNAME>/MyApps/daisy/scripts/start-remoat.sh"

[[aliases]]
match = "exact"
trigger = "tắt anti"
command = "bash /Users/<USERNAME>/MyApps/daisy/scripts/stop-remoat.sh"

[[aliases]]
match = "exact"
trigger = "restart anti"
command = "bash /Users/<USERNAME>/MyApps/daisy/scripts/stop-remoat.sh && sleep 5 && bash /Users/<USERNAME>/MyApps/daisy/scripts/start-remoat.sh"

[[aliases]]
match = "exact"
trigger = "khoá màn hình"
command = "pmset displaysleepnow"
```

---

## 13. Bước 11: Verify Toàn Bộ

### Checklist xác nhận

```bash
# 1. Caffeinate đang chạy?
pgrep -la caffeinate
# ✅ Expect: /usr/bin/caffeinate -s

# 2. Antigravity mở được với CDP?
/Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=9222 ~/MyApps/daisy &
sleep 10
curl -s http://127.0.0.1:9222/json/version
# ✅ Expect: JSON response với "Browser" field

# 3. Remoat build OK?
node ~/MyApps/kaizenguy_remoat/dist/bin/cli.js --help
# ✅ Expect: Help text

# 4. Start Remoat
bash ~/MyApps/daisy/scripts/start-remoat.sh
# ✅ Expect: "Remoat bot started"

# 5. Test Telegram
# → Mở Telegram, gửi "hello" cho bot
# ✅ Expect: Antigravity trả lời qua Telegram

# 6. Check schedule
sqlite3 ~/.remoat/antigravity.db "SELECT id, cron_expression, substr(prompt,1,40) FROM schedules WHERE enabled=1;"
# ✅ Expect: List schedules

# 7. Check Remoat log
tail -20 ~/.remoat/bot.log
# ✅ Expect: Bot running, no errors
```

### Test notify

```bash
bash ~/MyApps/daisy/scripts/notify.sh "🎉 Remoat setup thành công!"
# ✅ Expect: Nhận được tin nhắn trên Telegram
```

---

## 14. Troubleshooting

### Bot không phản hồi Telegram

```bash
# 1. Check process
pgrep -f "remoat start"

# 2. Check log
tail -50 ~/.remoat/bot.log

# 3. Check CDP
curl -s http://127.0.0.1:9222/json/version

# 4. Nếu CDP không phản hồi → Antigravity chưa mở hoặc mở không có CDP flag
# → Restart:
bash ~/MyApps/daisy/scripts/restart-remoat.sh
```

### Lock file bị stuck

```bash
rm -f ~/.remoat/*.lock
```

### CDP port bị chiếm

```bash
lsof -i :9222
kill $(lsof -ti :9222)
```

### Node version sai

```bash
node --version  # Phải >= 18
which node      # Check đường dẫn
```

### Mac vẫn ngủ

```bash
# Check caffeinate
pgrep -la caffeinate

# Nếu không chạy
launchctl load ~/Library/LaunchAgents/com.nhatvu.caffeinate.plist

# Check System Preferences → Energy Saver
# ✅ Prevent automatic sleeping
# ✅ Wake for network access
```

### Schedule không chạy

```bash
# 1. Check schedule enabled
sqlite3 ~/.remoat/antigravity.db "SELECT id, enabled FROM schedules;"

# 2. Check timezone
date  # Phải đúng timezone

# 3. Restart Remoat (reload schedules)
bash ~/MyApps/daisy/scripts/restart-remoat.sh
```

### Telegram message bị cắt

- Telegram limit = 4096 chars/message
- Remoat tự split chunks
- Nếu vẫn miss: check `file://` links trong response (Telegram không hỗ trợ)

---

## 15. Tham Khảo: Hệ Thống Hiện Tại

### Danh sách LaunchAgents đang chạy

| Label | Mô tả |
|-------|-------|
| `com.nhatvu.caffeinate` | Giữ Mac luôn thức (`caffeinate -s`) |
| `com.nhatvu.zeroclaw` | ZeroClaw daemon (Daisy Telegram) |
| `com.daisy.crypto-dashboard` | Crypto dashboard local (port 6868) |

### Remoat Config hiện tại (`~/.remoat/config.json`)

```json
{
  "telegramBotToken": "<REDACTED>",
  "allowedUserIds": ["<USER_ID>"],
  "workspaceBaseDir": "/Users/<USERNAME>/MyApps",
  "autoApproveFileEdits": false,
  "logLevel": "info",
  "extractionMode": "structured",
  "disableProgressLog": true,
  "useTopics": true
}
```

### Schedules hiện tại

| ID | Cron | Mô tả | Model |
|----|------|-------|-------|
| 2 | `30 6 * * *` | Siêu Báo Cáo Sáng (Daily brief + Crypto + Content) | default |
| 12 | `0 23 * * *` | Nightly save (quét conversations, cập nhật memory) | default |
| 17 | `0 7 * * *` | Personal branding (viết bài + gen hình + post) | Gemini 3.1 Pro (High) |
| 23 | `0 22 * * *` | Personal branding review (scrape engagement + standup) | default |

### Custom Changes trong Remoat Fork

Các thay đổi so với upstream, tìm bằng comment `[KaizenGuy]`:

| Thay đổi | File | Lý do |
|----------|------|-------|
| Tắt Progress Log spam | `bot/index.ts` | Config `disableProgressLog` |
| Typing indicator | `bot/index.ts` | User biết bot đang xử lý |
| Strip `file://` links | `utils/telegramFormatter.ts` | Telegram không hỗ trợ `file://` |
| Fallback plain text | `bot/index.ts` | HTML parse fail → retry plain |
| Disable auto-launch on reconnect | `services/cdpService.ts` | Reconnect không tự mở Antigravity |
| HTTP /notify: album photos | `bot/index.ts` | `sendMediaGroup` — album ảnh |
| Ảnh lưu local `~/.remoat/images` | `utils/imageHandler.ts` | Không xóa ảnh sau inject |
| Telegram output hint | `bot/index.ts` | Inject `[remoat:telegram]` vào prompt |

### Remoat HTTP Notify API

```bash
# Gửi text
curl -X POST http://localhost:9999/notify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <BOT_TOKEN>" \
  -d '{"text":"Hello from script"}'

# Gửi 1 hình
curl -X POST http://localhost:9999/notify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <BOT_TOKEN>" \
  -d '{"photo":"/path/to/image.jpg","text":"caption"}'

# Gửi album
curl -X POST http://localhost:9999/notify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <BOT_TOKEN>" \
  -d '{"photos":["/path/img1.jpg","/path/img2.jpg"],"text":"caption"}'
```

### Các model Antigravity hiện có (tháng 3/2026)

| Tên (dùng cho schedule DB) | Ghi chú |
|----------------------------|---------|
| `Gemini 3.1 Pro (High)` | Mạnh nhất, viết bài |
| `Gemini 3.1 Pro (Low)` | Tiết kiệm |
| `Gemini 3 Flash` | Nhanh, task đơn giản |
| `Claude Sonnet 4.6 (Thinking)` | Không có search_web |
| `Claude Opus 4.6 (Thinking)` | Không có search_web |

---

## Quick Start (TL;DR)

```bash
# 1. Cài Node.js >= 18
# 2. Cài Antigravity vào /Applications/

# 3. Clone repos
cd ~/MyApps
git clone https://github.com/nhatvuit/kaizenguy_remoat.git
git clone <DAISY_REPO> daisy

# 4. Build Remoat
cd kaizenguy_remoat && npm install && npm run build && cd ..

# 5. Tạo config
mkdir -p ~/.remoat/images
# → Tạo ~/.remoat/config.json (xem Bước 6)

# 6. Tạo Telegram bot
# → @BotFather → /newbot → lưu token

# 7. Setup caffeinate
# → Tạo LaunchAgent (xem Bước 8)
launchctl load ~/Library/LaunchAgents/com.nhatvu.caffeinate.plist

# 8. Cấp quyền scripts
chmod +x ~/MyApps/daisy/scripts/*.sh

# 9. Start!
bash ~/MyApps/daisy/scripts/start-remoat.sh

# 10. Test — gửi tin nhắn cho bot trên Telegram
```

---

_Tài liệu này được tạo bởi Daisy · 01/04/2026_
_Source: Hệ thống production của anh Vũ (Nhất Vũ)_
