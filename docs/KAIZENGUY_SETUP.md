# KaizenGuy Fork — Setup Guide

Hướng dẫn setup Remoat (KaizenGuy fork) + Antigravity automation trên macOS.

> **Đối tượng**: agent Antigravity hoặc developer đọc rồi tự setup.

---

## 1. Cài đặt Remoat

```bash
# Clone repo
git clone <repo-url> ~/Remoat
cd ~/Remoat

# Install dependencies
npm install

# Build TypeScript → dist/
npm run build
```

## 2. Config

```bash
cp .env.example .env
```

Sửa `.env`:

```env
TELEGRAM_BOT_TOKEN=<bot token từ @BotFather>
ALLOWED_USER_IDS=<telegram user ID — lấy từ @userinfobot>
WORKSPACE_BASE_DIR=~/Code
```

Hoặc chạy wizard: `node dist/bin/cli.js setup`

## 3. Chạy

```bash
# Mở Antigravity với CDP (terminal 1)
node dist/bin/cli.js open

# Start bot (terminal 2)
node dist/bin/cli.js start
```

---

## 4. Scripts tự động hoá

Tạo folder `scripts/` trong workspace chính (nơi Antigravity mở), rồi copy các script bên dưới.

> **Quan trọng**: Thay các biến `WORKSPACE_DIR`, `REMOAT_DIR` cho đúng máy bạn.

### 4.1. `restart.command` — Double-click để restart tất cả

File `.command` trên macOS có thể double-click để chạy. Đặt ở Desktop hoặc thư mục dễ tìm.

```bash
#!/bin/bash
# Restart Antigravity + Remoat bot
# Double-click file này để chạy

# === CẤU HÌNH — SỬA CHO ĐÚNG MÁY BẠN ===
WORKSPACE_DIR="$HOME/Code/my-project"       # Workspace Antigravity mở
REMOAT_DIR="$HOME/Remoat"                   # Thư mục repo Remoat
CDP_PORT=9222                               # CDP port (mặc định 9222)
# ==========================================

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

echo "========== STOP =========="

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
    sleep 5
else
    echo "ℹ️ Antigravity không đang chạy."
fi

echo ""
echo "========== START =========="

# Mở Antigravity với CDP
if curl -s --connect-timeout 2 "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
    echo "✅ Antigravity đã mở với CDP. Bỏ qua."
else
    echo "⏳ Mở Antigravity với CDP + workspace..."
    nohup /Applications/Antigravity.app/Contents/MacOS/Electron \
        --remote-debugging-port=${CDP_PORT} "$WORKSPACE_DIR" > /dev/null 2>&1 &
    sleep 12

    if curl -s --connect-timeout 2 "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
        echo "✅ CDP hoạt động."
    else
        echo "❌ CDP không phản hồi. Thử lại."
    fi
fi

# Khởi động Remoat bot
nohup node "$REMOAT_DIR/dist/bin/cli.js" start > ~/.remoat/bot.log 2>&1 &
echo "✅ Remoat bot started. PID: $!"

# Tự đóng Terminal sau 2 giây
sleep 2
osascript -e 'tell application "Terminal" to close front window' &
exit 0
```

Sau khi tạo file, chạy: `chmod +x restart.command`

### 4.2. `start-remoat.sh` — Start (không restart)

```bash
#!/bin/bash
# Start Remoat — chỉ mở nếu chưa chạy

# === CẤU HÌNH ===
WORKSPACE_DIR="$HOME/Code/my-project"
REMOAT_DIR="$HOME/Remoat"
CDP_PORT=9222
# =================

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# Kill bot cũ nếu có
pkill -f "remoat start" 2>/dev/null
sleep 1

# Check CDP
if curl -s --connect-timeout 2 "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
    echo "✅ Antigravity đã mở với CDP."
else
    # Antigravity chạy nhưng không có CDP → quit rồi mở lại
    if pgrep -f "Antigravity.app" > /dev/null 2>&1; then
        echo "⏳ Đóng Antigravity hiện tại..."
        osascript -e 'tell application "Antigravity" to quit' 2>/dev/null
        sleep 5
    fi

    echo "⏳ Mở Antigravity với CDP..."
    nohup /Applications/Antigravity.app/Contents/MacOS/Electron \
        --remote-debugging-port=${CDP_PORT} "$WORKSPACE_DIR" > /dev/null 2>&1 &
    sleep 12

    if curl -s --connect-timeout 2 "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
        echo "✅ CDP hoạt động."
    else
        echo "❌ CDP không phản hồi."
    fi
fi

# Start bot
nohup node "$REMOAT_DIR/dist/bin/cli.js" start > ~/.remoat/bot.log 2>&1 &
echo "✅ Remoat bot started. PID: $!"
```

### 4.3. `stop-remoat.sh` — Stop tất cả

```bash
#!/bin/bash
# Stop Remoat bot + Antigravity

# Kill Remoat bot
if pgrep -f "remoat start" > /dev/null 2>&1; then
    pkill -f "remoat start"
    echo "✅ Remoat bot đã tắt."
else
    echo "ℹ️ Remoat bot không đang chạy."
fi

# Tắt Antigravity
if pgrep -f "Antigravity.app" > /dev/null 2>&1; then
    osascript -e 'tell application "Antigravity" to quit' 2>/dev/null
    echo "✅ Antigravity đã tắt."
else
    echo "ℹ️ Antigravity không đang chạy."
fi
```

### 4.4. `notify.sh` — Gửi message qua Telegram

```bash
#!/bin/bash
# Gửi notification qua Remoat HTTP API
# Usage: bash notify.sh "message"

[ -z "$1" ] && echo "Usage: bash notify.sh \"message\"" && exit 1

MSG="$1"
JSON_MSG=$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' <<< "$MSG")

# Gửi qua Remoat endpoint
RESP=$(curl --connect-timeout 3 --max-time 8 -s -X POST "http://127.0.0.1:9999/notify" \
  -H "Content-Type: application/json" \
  -d "{\"text\": $JSON_MSG}" 2>/dev/null)

if echo "$RESP" | grep -q '"ok"'; then
  echo "✅ Sent via Remoat"
else
  echo "❌ Failed — Remoat bot đang chạy chưa?"
fi
```

---

## 5. Custom features (KaizenGuy fork)

Các thay đổi so với upstream, đánh dấu bằng comment `[KaizenGuy]` trong source:

| Feature | Mô tả |
|---------|--------|
| HTML parse fallback | Khi Telegram parse HTML fail → retry plain text |
| `disableProgressLog` | Config tắt progress spam (`.env`: `DISABLE_PROGRESS_LOG=true`) |
| Typing indicator | Gửi typing action khi bot đang xử lý |
| Strip `file://` links | Telegram không hỗ trợ `file://` → tự strip |
| Tắt auto-launch on reconnect | Reconnect CDP không tự mở Antigravity |
| HTTP `/notify` API | `POST http://localhost:9999/notify` — gửi text/photo/album ra Telegram |
| Media group buffer | Gom ảnh album trước khi inject vào Antigravity |
| Ảnh lưu local | Ảnh inbound lưu tại `~/.remoat/images/`, không xoá |

---

## 6. Troubleshooting

```bash
# Check bot đang chạy
pgrep -f "remoat start"

# Check CDP
curl -s http://127.0.0.1:9222/json/version

# Xem log
tail -50 ~/.remoat/bot.log

# CDP port bị chiếm
lsof -i :9222

# Lock file còn dính (bot crash)
rm -f ~/.remoat/*.lock

# Rebuild sau khi sửa code
cd ~/Remoat && npm run build
```

---

## 7. Ghi chú

- Bot cần Antigravity đang chạy với CDP mới hoạt động
- Config lưu tại `~/.remoat/config.json` — tự tạo sau `setup` hoặc `.env`
- Log tại `~/.remoat/bot.log`
- Ảnh inbound tại `~/.remoat/images/` — cần dọn thủ công nếu đầy disk
- Telegram message limit = 4096 chars — response dài tự split hoặc gửi `.md` file
