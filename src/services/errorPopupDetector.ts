import { logger } from '../utils/logger';
import { buildClickScript } from './approvalDetector';
import { CdpService } from './cdpService';

/** Error popup information */
export interface ErrorPopupInfo {
    /** Error popup title text */
    title: string;
    /** Error popup body/description text */
    body: string;
    /** Button labels found in the popup */
    buttons: string[];
}

export interface ErrorPopupDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 3000ms) */
    pollIntervalMs?: number;
    /** Callback when an error popup is detected */
    onErrorPopup: (info: ErrorPopupInfo) => void;
    /** Callback when a previously detected error popup is resolved (popup disappeared) */
    onResolved?: () => void;
}

const ERROR_PATTERNS = [
    'agent terminated',
    'terminated due to error',
    'unexpected error',
    'something went wrong',
    'an error occurred',
    'quota',
    'rate limit',
    'exhausted',
    'retry',
    '429',
    'api key',
];

/**
 * Read clipboard content via navigator.clipboard.readText().
 * Requires awaitPromise=true since clipboard API returns a Promise.
 */
const READ_CLIPBOARD_SCRIPT = `(async () => {
    try {
        const text = await navigator.clipboard.readText();
        return text || null;
    } catch (e) {
        return null;
    }
})()`;

/**
 * Detects error popup dialogs (e.g. "Agent terminated due to error") in the
 * Antigravity UI via polling.
 *
 * Follows the same polling pattern as PlanningDetector / ApprovalDetector:
 * - start()/stop() lifecycle
 * - Duplicate notification prevention via lastDetectedKey
 * - Cooldown to suppress rapid re-detection
 * - CDP error tolerance (continues polling on error)
 */
export class ErrorPopupDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onErrorPopup: (info: ErrorPopupInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected error popup (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full ErrorPopupInfo from the last detection */
    private lastDetectedInfo: ErrorPopupInfo | null = null;
    /** Timestamp of last notification (for cooldown-based dedup) */
    private lastNotifiedAt: number = 0;
    /** Cooldown period in ms to suppress duplicate notifications (10s for error popups) */
    private static readonly COOLDOWN_MS = 10000;

    constructor(options: ErrorPopupDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 3000;
        this.onErrorPopup = options.onErrorPopup;
        this.onResolved = options.onResolved;
        
        this.handleConsoleMessage = this.handleConsoleMessage.bind(this);
    }

    /** Start monitoring via CDP event. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastNotifiedAt = 0;
        this.cdpService.on('Runtime.consoleAPICalled', this.handleConsoleMessage);
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
        this.cdpService.off('Runtime.consoleAPICalled', this.handleConsoleMessage);
    }

    /** Return the last detected error popup info. Returns null if nothing has been detected. */
    getLastDetectedInfo(): ErrorPopupInfo | null {
        return this.lastDetectedInfo;
    }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Click the Dismiss button via CDP.
     * @returns true if click succeeded
     */
    async clickDismissButton(): Promise<boolean> {
        return this.clickButton('Dismiss');
    }

    /**
     * Click the "Copy debug info" button via CDP.
     * @returns true if click succeeded
     */
    async clickCopyDebugInfoButton(): Promise<boolean> {
        return this.clickButton('Copy debug info');
    }

    /**
     * Click the Retry button via CDP.
     * @returns true if click succeeded
     */
    async clickRetryButton(): Promise<boolean> {
        return this.clickButton('Retry');
    }

    /**
     * Read clipboard content from the browser via navigator.clipboard.readText().
     * Should be called after clickCopyDebugInfoButton() with a short delay.
     * @returns Clipboard text or null if unavailable
     */
    async readClipboard(): Promise<string | null> {
        try {
            const result = await this.runEvaluateScript(READ_CLIPBOARD_SCRIPT, true);
            return typeof result === 'string' ? result : null;
        } catch (error) {
            logger.error('[ErrorPopupDetector] Error reading clipboard:', error);
            return null;
        }
    }

    private handleConsoleMessage(params: any): void {
        if (!this.isRunning) return;

        const type = params.type; // 'log', 'warning', 'error', etc.
        if (type !== 'error' && type !== 'warning') return;

        const args = params.args || [];
        const textParts = args.map((a: any) => a.value || a.description || '');
        const fullText = textParts.join(' ');
        const normalizedText = fullText.toLowerCase();

        const isError = ERROR_PATTERNS.some(p => normalizedText.includes(p));
        if (!isError) return;

        const now = Date.now();
        if (now - this.lastNotifiedAt < ErrorPopupDetector.COOLDOWN_MS) return;

        this.lastNotifiedAt = now;

        const title = type === 'error' ? 'Console Error' : 'Console Warning';
        const body = fullText.substring(0, 1000);
        
        // Cung cấp các nút chuẩn để Telegram hiển thị (các nút này gọi CDP click)
        const buttons = ['Dismiss', 'Copy Debug', 'Retry'];

        const info: ErrorPopupInfo = { title, body, buttons };
        this.lastDetectedInfo = info;
        this.lastDetectedKey = `${title}::${body.slice(0, 100)}`;
        
        Promise.resolve(this.onErrorPopup(info)).catch((err) => {
            logger.error('[ErrorPopupDetector] onErrorPopup callback failed:', err);
        });
    }

    /** Internal click handler using buildClickScript from approvalDetector. */
    private async clickButton(buttonText: string): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(buildClickScript(buttonText));
            return result?.ok === true;
        } catch (error) {
            logger.error('[ErrorPopupDetector] Error while clicking button:', error);
            return false;
        }
    }

    /** Execute Runtime.evaluate with contextId and return result.value. */
    private async runEvaluateScript(expression: string, awaitPromise: boolean = false): Promise<any> {
        const contextId = this.cdpService.getPrimaryContextId();
        const callParams: Record<string, unknown> = {
            expression,
            returnByValue: true,
            awaitPromise,
        };
        if (contextId !== null) {
            callParams.contextId = contextId;
        }
        const result = await this.cdpService.call('Runtime.evaluate', callParams);
        return result?.result?.value;
    }
}
