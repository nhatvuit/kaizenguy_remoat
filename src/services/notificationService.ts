/**
 * Notification Service — HTTP endpoint for push notifications
 * 
 * Allows Antigravity (or any local process) to send messages to the user
 * via Telegram without going through the full Remoat bridge.
 * 
 * [KaizenGuy] Custom feature for Daisy push notifications.
 * 
 * Usage: POST http://localhost:3847/notify
 * Body: { "message": "Hello from Daisy" }
 */

import http from 'http';
import { logger } from '../utils/logger';

const NOTIFY_PORT = 3847;

interface NotificationSender {
  sendMessage(chatId: number | string, text: string, options?: Record<string, unknown>): Promise<unknown>;
}

let server: http.Server | null = null;

export function startNotificationService(
  botApi: NotificationSender,
  allowedChatIds: (number | string)[],
): void {
  if (server) {
    logger.warn('[NotifyService] Already running, skipping');
    return;
  }

  server = http.createServer((req, res) => {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found. POST /notify' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const message = data.message || data.text;

        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing "message" field' }));
          return;
        }

        // [KaizenGuy] Support topic_id for forum routing
        const topicId = data.topic_id ? Number(data.topic_id) : undefined;
        const targetChatId = data.chat_id ? Number(data.chat_id) : undefined;

        // If chat_id + topic_id specified, send to specific forum topic
        if (targetChatId && topicId) {
          try {
            await botApi.sendMessage(targetChatId, message, {
              parse_mode: data.parse_mode || 'HTML',
              message_thread_id: topicId,
            });
            logger.info(`[NotifyService] Sent to forum topic ${topicId} in ${targetChatId}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, target: { chatId: targetChatId, topicId } }));
          } catch (err: any) {
            logger.error(`[NotifyService] Failed to send to topic ${topicId}:`, err?.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err?.message }));
          }
          return;
        }

        // Default: send to all allowed chat IDs (original behavior)
        const results = [];
        for (const chatId of allowedChatIds) {
          try {
            await botApi.sendMessage(chatId, message, {
              parse_mode: data.parse_mode || 'HTML',
              message_thread_id: topicId,
            });
            results.push({ chatId, sent: true });
          } catch (err: any) {
            logger.error(`[NotifyService] Failed to send to ${chatId}:`, err?.message);
            // Retry without parse_mode if HTML fails
            try {
              await botApi.sendMessage(chatId, message.replace(/<[^>]+>/g, ''));
              results.push({ chatId, sent: true, fallback: true });
            } catch (err2: any) {
              results.push({ chatId, sent: false, error: err2?.message });
            }
          }
        }

        logger.info(`[NotifyService] Notification sent: "${message.slice(0, 50)}..."`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + err.message }));
      }
    });
  });

  server.listen(NOTIFY_PORT, '127.0.0.1', () => {
    logger.info(`[NotifyService] Listening on http://127.0.0.1:${NOTIFY_PORT}/notify`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`[NotifyService] Port ${NOTIFY_PORT} already in use, skipping`);
    } else {
      logger.error('[NotifyService] Server error:', err);
    }
  });
}

export function stopNotificationService(): void {
  if (server) {
    server.close();
    server = null;
    logger.info('[NotifyService] Stopped');
  }
}
