import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { Logger } from "src/utils/logger.js";

export interface EmailRecord {
  id: number;
  message_id: string;
  uid: number;
  mailbox: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  received_at: string;
  body: string;
  raw_body: string;
  indexed: number;
}

export interface SaveEmailParams {
  message_id: string;
  uid: number;
  mailbox: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  received_at: string;
  body: string;
  raw_body?: string;
}

export interface EmailSearchResult {
  id: number;
  from_addr: string;
  to_addr: string;
  subject: string;
  received_at: string;
  snippet: string;
}

export class EmailStore {
  private db: Database.Database;
  private logger = new Logger(EmailStore.name);

  constructor(workspace: string) {
    const memoryDir = join(workspace, "memory");
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    this.db = new Database(join(memoryDir, "emails.db"));
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    // Base table — raw_body included from the start for new installs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS emails (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id  TEXT UNIQUE NOT NULL,
        uid         INTEGER NOT NULL DEFAULT 0,
        mailbox     TEXT NOT NULL DEFAULT '',
        from_addr   TEXT NOT NULL DEFAULT '',
        to_addr     TEXT NOT NULL DEFAULT '',
        subject     TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        body        TEXT NOT NULL DEFAULT '',
        raw_body    TEXT NOT NULL DEFAULT '',
        indexed     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS emails_received_at ON emails(received_at DESC);
      CREATE INDEX IF NOT EXISTS emails_indexed     ON emails(indexed);
    `);

    // Migration: add raw_body if the table predates this column
    const cols = (this.db.prepare("PRAGMA table_info(emails)").all() as { name: string }[]).map(c => c.name);
    if (!cols.includes("raw_body")) {
      this.db.exec("ALTER TABLE emails ADD COLUMN raw_body TEXT NOT NULL DEFAULT ''");
    }

    // Rebuild FTS5 if raw_body isn't indexed yet (check the stored CREATE statement)
    const ftsRow = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='emails_fts'"
    ).get() as { sql: string } | undefined;
    const needFtsRebuild = !ftsRow || !ftsRow.sql.includes("raw_body");

    if (needFtsRebuild) {
      this.db.exec(`
        DROP TABLE IF EXISTS emails_fts;
        DROP TRIGGER IF EXISTS emails_fts_insert;
        DROP TRIGGER IF EXISTS emails_fts_delete;

        CREATE VIRTUAL TABLE emails_fts USING fts5(
          subject, from_addr, body, raw_body,
          content='emails',
          content_rowid='id'
        );

        INSERT INTO emails_fts(rowid, subject, from_addr, body, raw_body)
          SELECT id, subject, from_addr, body, raw_body FROM emails;

        CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
          INSERT INTO emails_fts(rowid, subject, from_addr, body, raw_body)
            VALUES (new.id, new.subject, new.from_addr, new.body, new.raw_body);
        END;

        CREATE TRIGGER emails_fts_delete AFTER DELETE ON emails BEGIN
          INSERT INTO emails_fts(emails_fts, rowid, subject, from_addr, body, raw_body)
            VALUES ('delete', old.id, old.subject, old.from_addr, old.body, old.raw_body);
        END;
      `);
    } else {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN
          INSERT INTO emails_fts(rowid, subject, from_addr, body, raw_body)
            VALUES (new.id, new.subject, new.from_addr, new.body, new.raw_body);
        END;

        CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN
          INSERT INTO emails_fts(emails_fts, rowid, subject, from_addr, body, raw_body)
            VALUES ('delete', old.id, old.subject, old.from_addr, old.body, old.raw_body);
        END;
      `);
    }
  }

  /** Insert an email. If message_id already exists, updates raw_body if the stored one is empty. */
  save(params: SaveEmailParams): void {
    this.db.prepare(`
      INSERT INTO emails
        (message_id, uid, mailbox, from_addr, to_addr, subject, received_at, body, raw_body, indexed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(message_id) DO UPDATE SET
        raw_body = CASE WHEN raw_body = '' AND excluded.raw_body != '' THEN excluded.raw_body ELSE raw_body END,
        indexed  = CASE WHEN raw_body = '' AND excluded.raw_body != '' THEN 0 ELSE indexed END
    `).run(
      params.message_id, params.uid, params.mailbox,
      params.from_addr, params.to_addr, params.subject,
      params.received_at, params.body, params.raw_body ?? ""
    );
  }

  get(id: number): EmailRecord | null {
    return (this.db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as EmailRecord | undefined) ?? null;
  }

  list(opts: { mailbox?: string; limit?: number } = {}): EmailRecord[] {
    const limit = opts.limit ?? 20;
    if (opts.mailbox) {
      return this.db.prepare(
        "SELECT * FROM emails WHERE mailbox = ? ORDER BY received_at DESC LIMIT ?"
      ).all(opts.mailbox, limit) as EmailRecord[];
    }
    return this.db.prepare(
      "SELECT * FROM emails ORDER BY received_at DESC LIMIT ?"
    ).all(limit) as EmailRecord[];
  }

  listPage(opts: { mailbox?: string; limit: number; offset: number }): EmailRecord[] {
    if (opts.mailbox) {
      return this.db.prepare(
        "SELECT * FROM emails WHERE mailbox = ? ORDER BY received_at DESC LIMIT ? OFFSET ?"
      ).all(opts.mailbox, opts.limit, opts.offset) as EmailRecord[];
    }
    return this.db.prepare(
      "SELECT * FROM emails ORDER BY received_at DESC LIMIT ? OFFSET ?"
    ).all(opts.limit, opts.offset) as EmailRecord[];
  }

  /** Emails not yet embedded by DocStore — called by DocStore.indexEmails(). */
  listUnindexed(limit = 100): EmailRecord[] {
    return this.db.prepare(
      "SELECT * FROM emails WHERE indexed = 0 ORDER BY received_at ASC LIMIT ?"
    ).all(limit) as EmailRecord[];
  }

  markIndexed(ids: number[]): void {
    if (ids.length === 0) return;
    const ph = ids.map(() => "?").join(",");
    this.db.prepare(`UPDATE emails SET indexed = 1 WHERE id IN (${ph})`).run(...ids);
  }

  /** FTS5 full-text search — used as fallback when DocStore (vector search) is not available. */
  ftsSearch(query: string, limit = 10): EmailSearchResult[] {
    try {
      // Snippet from raw_body (col 3) when available, else body (col 2)
      return this.db.prepare(`
        SELECT e.id, e.from_addr, e.to_addr, e.subject, e.received_at,
               snippet(emails_fts, 3, '[', ']', '...', 12) AS snippet
        FROM emails_fts
        JOIN emails e ON e.id = emails_fts.rowid
        WHERE emails_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit) as EmailSearchResult[];
    } catch (err) {
      this.logger.warn("FTS search failed", { error: String(err) });
      return [];
    }
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM emails WHERE id = ?").run(id);
    return result.changes > 0;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM emails").get() as { n: number }).n;
  }
}
