import Database from 'better-sqlite3';

/**
 * Chat session record type definition
 */
export interface ChatSessionRecord {
    id: number;
    channelId: string;
    categoryId: string;
    workspacePath: string;
    sessionNumber: number;
    displayName: string | null;
    isRenamed: boolean;
    guildId: string;
    topicId: number | null;
    createdAt?: string;
}

/**
 * Input type for session creation
 */
export interface CreateChatSessionInput {
    channelId: string;
    categoryId: string;
    workspacePath: string;
    sessionNumber: number;
    guildId: string;
}

/**
 * Repository for persisting chat-to-session mapping in SQLite.
 * One session per channel (UNIQUE constraint).
 */
export class ChatSessionRepository {
    private readonly db: Database.Database;

    // Cached prepared statements
    private readonly stmtCreate: Database.Statement;
    private readonly stmtFindByChannelId: Database.Statement;
    private readonly stmtFindByCategoryId: Database.Statement;
    private readonly stmtGetNextSessionNumber: Database.Statement;
    private readonly stmtUpdateDisplayName: Database.Statement;
    private readonly stmtFindByDisplayName: Database.Statement;
    private readonly stmtDeleteByChannelId: Database.Statement;
    private readonly stmtFindByTopicId: Database.Statement;
    private readonly stmtFindAllByGuildId: Database.Statement;
    private readonly stmtUpsertByTopicId: Database.Statement;

    constructor(db: Database.Database) {
        this.db = db;
        this.initialize();

        this.stmtCreate = this.db.prepare(
            'INSERT INTO chat_sessions (channel_id, category_id, workspace_path, session_number, guild_id) VALUES (?, ?, ?, ?, ?)'
        );
        this.stmtFindByChannelId = this.db.prepare(
            'SELECT * FROM chat_sessions WHERE channel_id = ?'
        );
        this.stmtFindByCategoryId = this.db.prepare(
            'SELECT * FROM chat_sessions WHERE category_id = ? ORDER BY session_number ASC'
        );
        this.stmtGetNextSessionNumber = this.db.prepare(
            'SELECT MAX(session_number) as max_num FROM chat_sessions WHERE category_id = ?'
        );
        this.stmtUpdateDisplayName = this.db.prepare(
            'UPDATE chat_sessions SET display_name = ?, is_renamed = 1 WHERE channel_id = ?'
        );
        this.stmtFindByDisplayName = this.db.prepare(
            'SELECT * FROM chat_sessions WHERE workspace_path = ? AND display_name = ? ORDER BY id DESC LIMIT 1'
        );
        this.stmtDeleteByChannelId = this.db.prepare(
            'DELETE FROM chat_sessions WHERE channel_id = ?'
        );
        this.stmtFindByTopicId = this.db.prepare(
            'SELECT * FROM chat_sessions WHERE topic_id = ? ORDER BY id DESC LIMIT 1'
        );
        this.stmtFindAllByGuildId = this.db.prepare(
            'SELECT * FROM chat_sessions WHERE guild_id = ? ORDER BY id DESC'
        );
        this.stmtUpsertByTopicId = this.db.prepare(
            `INSERT INTO chat_sessions (channel_id, category_id, workspace_path, session_number, display_name, is_renamed, guild_id, topic_id)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(channel_id) DO UPDATE SET display_name = excluded.display_name, topic_id = excluded.topic_id`
        );
    }

    private initialize(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT NOT NULL UNIQUE,
                category_id TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                session_number INTEGER NOT NULL,
                display_name TEXT,
                is_renamed INTEGER NOT NULL DEFAULT 0,
                guild_id TEXT NOT NULL,
                topic_id INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);
        // Migration: add topic_id column if missing
        try {
            this.db.exec('ALTER TABLE chat_sessions ADD COLUMN topic_id INTEGER');
        } catch { /* column already exists */ }
    }

    public create(input: CreateChatSessionInput): ChatSessionRecord {
        const result = this.stmtCreate.run(
            input.channelId,
            input.categoryId,
            input.workspacePath,
            input.sessionNumber,
            input.guildId,
        );

        return {
            id: result.lastInsertRowid as number,
            channelId: input.channelId,
            categoryId: input.categoryId,
            workspacePath: input.workspacePath,
            sessionNumber: input.sessionNumber,
            displayName: null,
            isRenamed: false,
            guildId: input.guildId,
            topicId: null,
        };
    }

    public findByChannelId(channelId: string): ChatSessionRecord | undefined {
        const row = this.stmtFindByChannelId.get(channelId) as any;
        if (!row) return undefined;
        return this.mapRow(row);
    }

    public findByCategoryId(categoryId: string): ChatSessionRecord[] {
        const rows = this.stmtFindByCategoryId.all(categoryId) as any[];
        return rows.map(row => this.mapRow(row));
    }

    /**
     * Get the next session number within a category (MAX + 1, or 1 if none)
     */
    public getNextSessionNumber(categoryId: string): number {
        const row = this.stmtGetNextSessionNumber.get(categoryId) as any;
        return (row?.max_num ?? 0) + 1;
    }

    /**
     * Update session display name and set is_renamed to true
     */
    public updateDisplayName(channelId: string, displayName: string): boolean {
        const result = this.stmtUpdateDisplayName.run(displayName, channelId);
        return result.changes > 0;
    }

    /**
     * Find a session by display name within a workspace.
     * Returns the first match (most recent).
     */
    public findByDisplayName(workspacePath: string, displayName: string): ChatSessionRecord | undefined {
        const row = this.stmtFindByDisplayName.get(workspacePath, displayName) as any;
        if (!row) return undefined;
        return this.mapRow(row);
    }

    public deleteByChannelId(channelId: string): boolean {
        const result = this.stmtDeleteByChannelId.run(channelId);
        return result.changes > 0;
    }

    /**
     * Find session by Telegram Forum topic_id.
     */
    public findByTopicId(topicId: number): ChatSessionRecord | undefined {
        const row = this.stmtFindByTopicId.get(topicId) as any;
        if (!row) return undefined;
        return this.mapRow(row);
    }

    /**
     * Find all sessions for a given guild (group).
     */
    public findAllByGuildId(guildId: string): ChatSessionRecord[] {
        const rows = this.stmtFindAllByGuildId.all(guildId) as any[];
        return rows.map(row => this.mapRow(row));
    }

    /**
     * Upsert a session record keyed by topic_id.
     * Used by /chat_sync to create mappings for forum topics.
     */
    public upsertByTopicId(
        channelId: string,
        categoryId: string,
        workspacePath: string,
        sessionNumber: number,
        displayName: string,
        guildId: string,
        topicId: number,
    ): ChatSessionRecord {
        this.stmtUpsertByTopicId.run(
            channelId, categoryId, workspacePath, sessionNumber,
            displayName, guildId, topicId,
        );
        return this.findByChannelId(channelId)!;
    }

    private mapRow(row: any): ChatSessionRecord {
        return {
            id: row.id,
            channelId: row.channel_id,
            categoryId: row.category_id,
            workspacePath: row.workspace_path,
            sessionNumber: row.session_number,
            displayName: row.display_name,
            isRenamed: row.is_renamed === 1,
            guildId: row.guild_id,
            topicId: row.topic_id ?? null,
            createdAt: row.created_at,
        };
    }
}
