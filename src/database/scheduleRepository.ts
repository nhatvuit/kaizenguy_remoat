import Database from 'better-sqlite3';

/**
 * Schedule record type definition
 */
export interface ScheduleRecord {
    /** Unique ID (auto-increment) */
    id: number;
    /** Cron expression (e.g. "0 9 * * *") */
    cronExpression: string;
    /** Prompt to execute */
    prompt: string;
    /** Target workspace path */
    workspacePath: string;
    /** Enabled/disabled */
    enabled: boolean;
    /** LLM model to use (e.g. "gemini-3-flash"). null = use current model */
    model?: string | null;
    /** Chat title to activate instead of creating new chat. null = create new chat */
    chatTitle?: string | null;
    /** Creation timestamp (ISO string) */
    createdAt?: string;
}

/**
 * Input type for schedule creation
 */
export interface CreateScheduleInput {
    cronExpression: string;
    prompt: string;
    workspacePath: string;
    enabled: boolean;
    model?: string | null;
    chatTitle?: string | null;
}

/**
 * Input type for schedule update (partial update)
 */
export interface UpdateScheduleInput {
    cronExpression?: string;
    prompt?: string;
    workspacePath?: string;
    enabled?: boolean;
    model?: string | null;
    chatTitle?: string | null;
}

/**
 * Repository class for SQLite persistence of scheduled jobs.
 * Handles saving, retrieving, updating, and deleting cron expressions and prompts.
 */
export class ScheduleRepository {
    private readonly db: Database.Database;

    // Cached prepared statements
    private readonly stmtCreate: Database.Statement;
    private readonly stmtFindAll: Database.Statement;
    private readonly stmtFindById: Database.Statement;
    private readonly stmtFindEnabled: Database.Statement;
    private readonly stmtDelete: Database.Statement;

    constructor(db: Database.Database) {
        this.db = db;
        this.initialize();

        this.stmtCreate = this.db.prepare(
            'INSERT INTO schedules (cron_expression, prompt, workspace_path, enabled, model, chat_title) VALUES (?, ?, ?, ?, ?, ?)'
        );
        this.stmtFindAll = this.db.prepare(
            'SELECT * FROM schedules ORDER BY id ASC'
        );
        this.stmtFindById = this.db.prepare(
            'SELECT * FROM schedules WHERE id = ?'
        );
        this.stmtFindEnabled = this.db.prepare(
            'SELECT * FROM schedules WHERE enabled = 1 ORDER BY id ASC'
        );
        this.stmtDelete = this.db.prepare(
            'DELETE FROM schedules WHERE id = ?'
        );
    }

    private initialize(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cron_expression TEXT NOT NULL,
                prompt TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        // Migration: add model column if not exists
        const cols = this.db.prepare("PRAGMA table_info(schedules)").all() as any[];
        if (!cols.some((c: any) => c.name === 'model')) {
            this.db.exec('ALTER TABLE schedules ADD COLUMN model TEXT');
        }
        // Migration: add chat_title column if not exists
        if (!cols.some((c: any) => c.name === 'chat_title')) {
            this.db.exec('ALTER TABLE schedules ADD COLUMN chat_title TEXT');
        }
    }

    public create(input: CreateScheduleInput): ScheduleRecord {
        const result = this.stmtCreate.run(
            input.cronExpression,
            input.prompt,
            input.workspacePath,
            input.enabled ? 1 : 0,
            input.model ?? null,
            input.chatTitle ?? null
        );

        return {
            id: result.lastInsertRowid as number,
            cronExpression: input.cronExpression,
            prompt: input.prompt,
            workspacePath: input.workspacePath,
            enabled: input.enabled,
            model: input.model ?? null,
            chatTitle: input.chatTitle ?? null,
        };
    }

    public findAll(): ScheduleRecord[] {
        const rows = this.stmtFindAll.all() as any[];
        return rows.map(this.mapRow);
    }

    public findById(id: number): ScheduleRecord | undefined {
        const row = this.stmtFindById.get(id) as any;
        if (!row) return undefined;
        return this.mapRow(row);
    }

    public findEnabled(): ScheduleRecord[] {
        const rows = this.stmtFindEnabled.all() as any[];
        return rows.map(this.mapRow);
    }

    public delete(id: number): boolean {
        const result = this.stmtDelete.run(id);
        return result.changes > 0;
    }

    /**
     * Partially update a schedule
     */
    public update(id: number, input: UpdateScheduleInput): boolean {
        const sets: string[] = [];
        const values: any[] = [];

        if (input.cronExpression !== undefined) {
            sets.push('cron_expression = ?');
            values.push(input.cronExpression);
        }
        if (input.prompt !== undefined) {
            sets.push('prompt = ?');
            values.push(input.prompt);
        }
        if (input.workspacePath !== undefined) {
            sets.push('workspace_path = ?');
            values.push(input.workspacePath);
        }
        if (input.enabled !== undefined) {
            sets.push('enabled = ?');
            values.push(input.enabled ? 1 : 0);
        }
        if (input.model !== undefined) {
            sets.push('model = ?');
            values.push(input.model);
        }
        if (input.chatTitle !== undefined) {
            sets.push('chat_title = ?');
            values.push(input.chatTitle);
        }

        if (sets.length === 0) return false;

        values.push(id);
        const sql = `UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`;
        const result = this.db.prepare(sql).run(...values);
        return result.changes > 0;
    }

    private mapRow(row: any): ScheduleRecord {
        return {
            id: row.id,
            cronExpression: row.cron_expression,
            prompt: row.prompt,
            workspacePath: row.workspace_path,
            enabled: row.enabled === 1,
            model: row.model ?? null,
            chatTitle: row.chat_title ?? null,
            createdAt: row.created_at,
        };
    }
}
