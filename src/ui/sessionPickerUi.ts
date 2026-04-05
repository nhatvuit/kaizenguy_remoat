import { InlineKeyboard } from 'grammy';
import { t } from '../utils/i18n';
import { SessionListItem } from '../services/chatSessionService';
import { escapeHtml } from '../utils/telegramFormatter';

export const SESSION_SELECT_ID = 'session_select';

const MAX_SELECT_OPTIONS = 25;

export function isSessionSelectId(customId: string): boolean {
    return customId.startsWith(SESSION_SELECT_ID + ':') || customId === SESSION_SELECT_ID;
}

export function buildSessionPickerUI(
    sessions: SessionListItem[],
): { text: string; keyboard: InlineKeyboard } {
    if (sessions.length === 0) {
        return {
            text: `<b>🔗 Join Session</b>\n\n${t('No sessions found in the Antigravity side panel.')}`,
            keyboard: new InlineKeyboard(),
        };
    }

    const text = `<b>🔗 Join Session</b>\n\n` +
        t(`Select a session to join (${sessions.length} found)`);

    const keyboard = new InlineKeyboard();
    const pageItems = sessions.slice(0, MAX_SELECT_OPTIONS);

    for (const session of pageItems) {
        const label = session.isActive
            ? `✅ ${session.title.slice(0, 40)}`
            : session.title.slice(0, 40);
        // Telegram callback_data limit is 64 bytes. SESSION_SELECT_ID + ':' takes 15 bytes.
        // That leaves 49 bytes. Truncate strictly by UTF-8 byte length.
        let payloadText = session.title;
        while (Buffer.byteLength(payloadText, 'utf-8') > 48) {
            payloadText = payloadText.slice(0, -1);
        }
        keyboard.text(label, `${SESSION_SELECT_ID}:${payloadText}`).row();
    }

    return { text, keyboard };
}
