import "reflect-metadata";
import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { injectable, inject } from "tsyringe";
import { ensureDir } from "src/utils/util.js";
import { Logger } from "src/utils/logger.js";

export type MemoryType = "manual" | "compaction" | "cron" | "deleted" | "derived";

/** Semantic classification of what a memory entry represents. */
export type SemanticMemoryType =
  | "event"
  | "goal"
  | "project"
  | "preference"
  | "constraint"
  | "identity"
  | "relationship"
  | "fact";

export type MemoryEntry = {
  id: number;
  type: MemoryType;
  content: string;
  confidence: number;
  pinned: boolean;
  protected: boolean;
  supersedes: number | null;
  expires_at: string | null;
  origin_session: string | null;
  created_at: string;
  tags: string[];
  /**
   * Source risk level inherited from the session turn that produced this entry.
   * 0 = None (safe to inject into system prompt), 1 = Low, 2 = High (attacker-controlled).
   * High-risk entries are excluded from automatic system prompt injection but remain
   * searchable and recallable via memory_search — accessing them raises the current
   * security context risk level so subsequent high-risk tool calls are blocked.
   */
  risk_level: number;
  /** Semantic classification of what this memory represents. Null when unclassified. */
  memory_type: SemanticMemoryType | null;
};

const ACTIVE_WHERE = `
  NOT EXISTS (SELECT 1 FROM memory n WHERE n.supersedes = m.id)
  AND m.type != 'deleted'
  AND (m.expires_at IS NULL OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`;

@injectable()
export class MemoryService {
  private db: Database.Database;
  private logger = new Logger(MemoryService.name);
  private maxResult = 10;

  constructor(@inject("workspace") private workspace: string) {
    const memoryDir = ensureDir(join(workspace, "memory"));
    this.db = new Database(join(memoryDir, "memory.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
    this.migrateFromJsonl(join(memoryDir, "memory.jsonl"));
  }

  // ── Schema ───────────────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slug       TEXT NOT NULL UNIQUE,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_slug ON knowledge(slug);
      CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge(updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        slug, title, content, tags,
        content='knowledge', content_rowid='id'
      );
    `);
    // Keep FTS index in sync via triggers
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, slug, title, content, tags)
          VALUES (new.id, new.slug, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, slug, title, content, tags)
          VALUES ('delete', old.id, old.slug, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, slug, title, content, tags)
          VALUES ('delete', old.id, old.slug, old.title, old.content, old.tags);
        INSERT INTO knowledge_fts(rowid, slug, title, content, tags)
          VALUES (new.id, new.slug, new.title, new.content, new.tags);
      END;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        type           TEXT    NOT NULL DEFAULT 'manual',
        content        TEXT    NOT NULL,
        confidence     REAL    NOT NULL DEFAULT 1.0,
        pinned         INTEGER NOT NULL DEFAULT 0,
        protected      INTEGER NOT NULL DEFAULT 0,
        supersedes     INTEGER REFERENCES memory(id),
        expires_at     TEXT,
        origin_session TEXT,
        risk_level     INTEGER NOT NULL DEFAULT 0,
        memory_type    TEXT,
        created_at     TEXT    NOT NULL
                       DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS tags (
        memory_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
        tag       TEXT    NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_pinned      ON memory(pinned);
      CREATE INDEX IF NOT EXISTS idx_memory_created_at  ON memory(created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_supersedes  ON memory(supersedes);
      CREATE INDEX IF NOT EXISTS idx_memory_type        ON memory(type);
      CREATE INDEX IF NOT EXISTS idx_tags_tag           ON tags(tag);
    `);
    // Live-migrate existing databases that predate the risk_level column.
    // Must run BEFORE any query that references risk_level (including index creation).
    const hasRiskLevel = (this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('memory') WHERE name = 'risk_level'"
    ).get() as { cnt: number }).cnt > 0;
    if (!hasRiskLevel) {
      this.db.exec("ALTER TABLE memory ADD COLUMN risk_level INTEGER NOT NULL DEFAULT 0");
      this.logger.info("Migrated memory table: added risk_level column");
    }
    // Create the index after ensuring the column exists.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_risk_level ON memory(risk_level)");

    const hasMemoryType = (this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('memory') WHERE name = 'memory_type'"
    ).get() as { cnt: number }).cnt > 0;
    if (!hasMemoryType) {
      this.db.exec("ALTER TABLE memory ADD COLUMN memory_type TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_memory_type ON memory(memory_type)");

    this.db.exec(`
        CREATE TABLE IF NOT EXISTS related_memory
        (memory_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
        related_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
        PRIMARY KEY(memory_id, related_id))`);
  }

  // ── JSONL migration ──────────────────────────────────────────────────────────

  private migrateFromJsonl(jsonlPath: string): void {
    if (!existsSync(jsonlPath)) return;
    this.logger.info("Migrating memory.jsonl → SQLite");
    try {
      const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
      const migrate = this.db.transaction(() => {
        for (const line of lines) {
          try {
            const e = JSON.parse(line) as {
              content: string;
              tags?: string[];
              source?: string;
              created_at?: string;
              protected?: boolean;
              origin_session?: string;
            };
            const tags = e.tags ?? [];
            const isPinned = tags.some((t) => t.toLowerCase() === "pin");
            const info = this.db.prepare(`
              INSERT INTO memory (type, content, pinned, protected, origin_session, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              e.source ?? "manual",
              e.content,
              isPinned ? 1 : 0,
              e.protected ? 1 : 0,
              e.origin_session ?? null,
              e.created_at ?? new Date().toISOString()
            );
            this.insertTagsRaw(info.lastInsertRowid as number, tags);
          } catch {
            // skip malformed lines
          }
        }
      });
      migrate();
      renameSync(jsonlPath, `${jsonlPath}.migrated`);
      this.logger.info(`Migration complete — ${lines.length} entries imported`);
    } catch (err) {
      this.logger.error("JSONL migration failed", { error: String(err) });
    }
  }

  // ── Write ────────────────────────────────────────────────────────────────────

  /**
   * Appends an immutable memory entry.
   * Pass `supersedes` to logically replace an older entry.
   * Pass `pinned: true` or include the `"pin"` tag to always surface it.
   */
  append(item: {
    content: string;
    tags?: string[];
    type?: MemoryType;
    pinned?: boolean;
    protected?: boolean;
    supersedes?: number;
    confidence?: number;
    expires_at?: string;
    origin_session?: string;
    /** 0=None, 1=Low, 2=High — inherited from the session turn that produced this entry. */
    risk_level?: number;
    memory_type?: SemanticMemoryType;
  }): MemoryEntry {
    const tags = item.tags ?? [];
    const isPinned = item.pinned ?? tags.some((t) => t.toLowerCase() === "pin");
    const info = this.db.prepare(`
      INSERT INTO memory
        (type, content, confidence, pinned, protected, supersedes, expires_at, origin_session, risk_level, memory_type)
      VALUES
        (@type, @content, @confidence, @pinned, @protected, @supersedes, @expires_at, @origin_session, @risk_level, @memory_type)
    `).run({
      type: item.type ?? "manual",
      content: item.content,
      confidence: item.confidence ?? 1.0,
      pinned: isPinned ? 1 : 0,
      protected: item.protected ? 1 : 0,
      supersedes: item.supersedes ?? null,
      expires_at: item.expires_at ?? null,
      origin_session: item.origin_session ?? null,
      risk_level: item.risk_level ?? 0,
      memory_type: item.memory_type ?? null,
    });
    const id = info.lastInsertRowid as number;
    this.insertTagsRaw(id, tags);
    return this.getById(id)!;
  }

  appendWithSupersedes(item: {
    content: string;
    tags?: string[];
    type?: MemoryType;
    pinned?: boolean;
    protected?: boolean;
    supersedes?: number;
    confidence?: number;
    date?: string;        // optional extracted date
    origin_session?: string;
    risk_level?: number;
    related_ids?: number[]; // for derived facts
    memory_type?: SemanticMemoryType;
  }) {
    const tags = item.tags ?? [];
    const isPinned = item.pinned ?? tags.some((t) => t.toLowerCase() === "pin");

    // --- Normalize content for matching ---
    const normContent = item.content.trim().toLowerCase();

    // --- Find existing matching fact ---
    const existing = this.db.prepare(`
    SELECT id, confidence, created_at
    FROM memory
    WHERE LOWER(content) = @content AND type = @type AND pinned = 0
    ORDER BY confidence DESC, created_at DESC
    LIMIT 1
  `).get({ content: normContent, type: item.type ?? "manual" }) as ConfidenceRow | null;

    if (existing) {
      const newConfidence = item.confidence ?? 1.0;
      const newDate = item.date ?? new Date().toISOString();
      // Supersede if newer or higher confidence
      if (newConfidence > existing.confidence || newDate > existing.created_at) {
        item.supersedes = existing.id;
      } else {
        // Optional: update confidence if slightly higher
        return existing.id;
      }
    }

    // --- Insert normally ---
    const info = this.db.prepare(`
    INSERT INTO memory
      (type, content, confidence, pinned, protected, supersedes, expires_at, origin_session, risk_level, memory_type)
    VALUES
      (@type, @content, @confidence, @pinned, @protected, @supersedes, @expires_at, @origin_session, @risk_level, @memory_type)
  `).run({
      type: item.type ?? "manual",
      content: item.content,
      confidence: item.confidence ?? 1.0,
      pinned: isPinned ? 1 : 0,
      protected: item.protected ? 1 : 0,
      supersedes: item.supersedes ?? null,
      expires_at: null,
      origin_session: item.origin_session ?? null,
      risk_level: item.risk_level ?? 0,
      memory_type: item.memory_type ?? null,
    });

    const id = info.lastInsertRowid as number;
    this.insertTagsRaw(id, tags);

    // Store related_ids if derived
    if (item.related_ids?.length) {
      const stmt = this.db.prepare("INSERT INTO related_memory (memory_id, related_id) VALUES (?, ?)");
      for (const rid of item.related_ids) stmt.run(id, rid);
    }

    return this.getById(id)!;
  }
  // ── Query ────────────────────────────────────────────────────────────────────

  getById(id: number): MemoryEntry | null {
    const row = this.db.prepare(`
      SELECT m.*, group_concat(t.tag, ',') AS tag_list
      FROM memory m
      LEFT JOIN tags t ON t.memory_id = m.id
      WHERE m.id = ?
      GROUP BY m.id
    `).get(id) as RawRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  search(query?: string, tags?: string[], limit?: number, offset?: number): MemoryEntry[] {
    const params: unknown[] = [];
    let sql = `
      SELECT m.*, group_concat(t.tag, ',') AS tag_list
      FROM memory m
      LEFT JOIN tags t ON t.memory_id = m.id
      WHERE ${ACTIVE_WHERE}
    `;
    if (tags?.length) {
      sql += ` AND m.id IN (SELECT memory_id FROM tags WHERE tag IN (${tags.map(() => "?").join(",")}))`;
      params.push(...tags);
    }
    if (query) {
      // Split multi-word queries into keywords and OR-match each one so that
      // "cost per 1k tokens" matches content like "Pricing rates (per 1,000,000 tokens)"
      // even though no single substring covers the full phrase.
      const words = query.trim().split(/\s+/).filter(w => w.length >= 3);
      if (words.length > 1) {
        sql += ` AND (${words.map(() => "m.content LIKE ?").join(" OR ")})`;
        params.push(...words.map(w => `%${w}%`));
      } else {
        sql += " AND m.content LIKE ?";
        params.push(`%${query}%`);
      }
    }
    const effectiveLimit = limit ?? this.maxResult;
    const effectiveOffset = offset ?? 0;
    sql += ` GROUP BY m.id ORDER BY m.confidence DESC, m.created_at DESC LIMIT ${effectiveLimit} OFFSET ${effectiveOffset};`;
    const result =  (this.db.prepare(sql).all(...params) as RawRow[]).map((r) => this.rowToEntry(r));
    return result;
  }

  listTags(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT t.tag
      FROM tags t
      JOIN memory m ON m.id = t.memory_id
      WHERE ${ACTIVE_WHERE}
      ORDER BY t.tag ASC
    `).all() as { tag: string }[]).map((r) => r.tag);
  }

  // ── Supersede (agent "update/delete" path) ───────────────────────────────────

  /**
   * Logically deletes an entry by superseding it with a tombstone.
   * The original entry is preserved in history; it just stops appearing
   * in queries. Protected entries cannot be superseded.
   * Returns `"superseded"`, `"protected"`, or `"not_found"`.
   */
  supersede(id: number): "superseded" | "protected" | "not_found" {
    const row = this.db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as RawRow | undefined;
    if (!row) return "not_found";
    if (row.protected) return "protected";
    this.append({ content: "[superseded]", type: "deleted", supersedes: id });
    return "superseded";
  }

  // ── Pruning ──────────────────────────────────────────────────────────────────

  /**
   * Removes low-value memory entries using three complementary rules:
   *
   * 1. **Age**: non-pinned entries older than `maxAgeDays` are tombstoned.
   * 2. **Confidence**: non-pinned entries below `minConfidence` are tombstoned.
   * 3. **Count cap**: if the active count still exceeds `maxEntries` after the
   *    above, the oldest/lowest-confidence entries are removed until under cap.
   *
   * Pinned and protected entries are always skipped. Entries newer than
   * `graceDays` are also skipped regardless of confidence, giving the
   * extraction pipeline time to reinforce freshly stored facts.
   *
   * Tombstoning (not hard-delete) is used so the entry's history is preserved
   * and supersession integrity is maintained.
   *
   * @returns How many entries were pruned by each rule.
   */
  prune(options: {
    maxAgeDays?: number;
    minConfidence?: number;
    maxEntries?: number;
    maxDerivedEntries?: number;
    graceDays?: number;
  }): { byAge: number; byConfidence: number; byCount: number; byDerived: number; expired: number } {
    const maxAgeDays = options.maxAgeDays ?? 90;
    const minConfidence = options.minConfidence ?? 0.3;
    const maxEntries = options.maxEntries ?? 1000;
    const maxDerivedEntries = options.maxDerivedEntries ?? 500;
    const graceDays = options.graceDays ?? 7;

    const result = { byAge: 0, byConfidence: 0, byCount: 0, byDerived: 0, expired: 0 };
    const graceDate = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000).toISOString();

    const tombstone = this.db.prepare(`
      INSERT INTO memory (type, content, supersedes, created_at)
      VALUES ('deleted', '[pruned]', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    const tombstoneMany = this.db.transaction((ids: number[]) => {
      for (const id of ids) tombstone.run(id);
    });

    // Rule 0: Hard-remove entries that have already expired (expires_at in the past).
    // They are invisible to queries but still occupy storage.
    const expired = this.db.prepare(`
      SELECT id FROM memory
      WHERE expires_at IS NOT NULL
        AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND type != 'deleted'
    `).all() as { id: number }[];
    if (expired.length) {
      this.db.prepare(`
        DELETE FROM memory
        WHERE expires_at IS NOT NULL
          AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND type != 'deleted'
      `).run();
      result.expired = expired.length;
    }

    // Rule 1: Age-based tombstoning.
    if (maxAgeDays > 0) {
      const ageCutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const ids = (this.db.prepare(`
        SELECT m.id FROM memory m
        WHERE ${ACTIVE_WHERE}
          AND m.pinned = 0 AND m.protected = 0 AND m.type != 'derived'
          AND m.created_at < ? AND m.created_at < ?
      `).all(ageCutoff, graceDate) as { id: number }[]).map(r => r.id);
      if (ids.length) { tombstoneMany(ids); result.byAge = ids.length; }
    }

    // Rule 2: Low-confidence tombstoning (re-queries, so Rule 1 victims are already excluded).
    if (minConfidence > 0) {
      const ids = (this.db.prepare(`
        SELECT m.id FROM memory m
        WHERE ${ACTIVE_WHERE}
          AND m.pinned = 0 AND m.protected = 0 AND m.type != 'derived'
          AND m.confidence < ? AND m.created_at < ?
      `).all(minConfidence, graceDate) as { id: number }[]).map(r => r.id);
      if (ids.length) { tombstoneMany(ids); result.byConfidence = ids.length; }
    }

    // Rule 3: Count cap for non-derived entries.
    if (maxEntries > 0) {
      const { cnt } = this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM memory m WHERE ${ACTIVE_WHERE} AND m.type != 'derived'
      `).get() as { cnt: number };
      if (cnt > maxEntries) {
        const excess = cnt - maxEntries;
        const ids = (this.db.prepare(`
          SELECT m.id FROM memory m
          WHERE ${ACTIVE_WHERE}
            AND m.pinned = 0 AND m.protected = 0 AND m.type != 'derived' AND m.created_at < ?
          ORDER BY m.confidence ASC, m.created_at ASC
          LIMIT ?
        `).all(graceDate, excess) as { id: number }[]).map(r => r.id);
        if (ids.length) { tombstoneMany(ids); result.byCount = ids.length; }
      }
    }

    // Rule 4: Derived entry pruning — age-based first, then count cap.
    // Confidence-based pruning is skipped since derived entries are synthesised
    // and their confidence score is less meaningful than for manually stored facts.
    if (maxAgeDays > 0) {
      const ageCutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const ids = (this.db.prepare(`
        SELECT m.id FROM memory m
        WHERE ${ACTIVE_WHERE}
          AND m.pinned = 0 AND m.protected = 0 AND m.type = 'derived'
          AND m.created_at < ? AND m.created_at < ?
      `).all(ageCutoff, graceDate) as { id: number }[]).map(r => r.id);
      if (ids.length) { tombstoneMany(ids); result.byDerived += ids.length; }
    }
    if (maxDerivedEntries > 0) {
      const { cnt } = this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM memory m WHERE ${ACTIVE_WHERE} AND m.type = 'derived'
      `).get() as { cnt: number };
      if (cnt > maxDerivedEntries) {
        const excess = cnt - maxDerivedEntries;
        const ids = (this.db.prepare(`
          SELECT m.id FROM memory m
          WHERE ${ACTIVE_WHERE}
            AND m.pinned = 0 AND m.protected = 0 AND m.type = 'derived' AND m.created_at < ?
          ORDER BY m.confidence ASC, m.created_at ASC
          LIMIT ?
        `).all(graceDate, excess) as { id: number }[]).map(r => r.id);
        if (ids.length) { tombstoneMany(ids); result.byDerived += ids.length; }
      }
    }

    return result;
  }

  // ── CLI-only operations ──────────────────────────────────────────────────────

  /** Hard-deletes an entry from the database. CLI-only — use `supersede` for agent-initiated changes. */
  hardDelete(id: number): "deleted" | "protected" | "not_found" {
    const row = this.db.prepare("SELECT id, protected FROM memory WHERE id = ?").get(id) as Pick<RawRow, "id" | "protected"> | undefined;
    if (!row) return "not_found";
    if (row.protected) return "protected";
    this.db.prepare("DELETE FROM memory WHERE id = ?").run(id);
    return "deleted";
  }

  /** Updates content, tags, and/or memory_type of an existing entry. Protected entries are allowed (UI edit). */
  updateEntry(id: number, patch: { content?: string; tags?: string[]; memory_type?: string }): "updated" | "not_found" {
    const row = this.db.prepare("SELECT id FROM memory WHERE id = ?").get(id);
    if (!row) return "not_found";
    if (patch.content !== undefined) {
      this.db.prepare("UPDATE memory SET content = ? WHERE id = ?").run(patch.content, id);
    }
    if (patch.memory_type !== undefined) {
      this.db.prepare("UPDATE memory SET type = ? WHERE id = ?").run(patch.memory_type, id);
    }
    if (patch.tags !== undefined) {
      this.db.prepare("DELETE FROM tags WHERE memory_id = ?").run(id);
      this.insertTagsRaw(id, patch.tags);
    }
    return "updated";
  }

  /** Updates the protected flag. CLI-only. */
  setProtected(id: number, protect: boolean): "updated" | "not_found" {
    const row = this.db.prepare("SELECT id FROM memory WHERE id = ?").get(id);
    if (!row) return "not_found";
    this.db.prepare("UPDATE memory SET protected = ? WHERE id = ?").run(protect ? 1 : 0, id);
    return "updated";
  }

  getRecentEntries(since: Date): RawRow[] {
    const recent = this.db.prepare(`
      SELECT m.*, group_concat(t.tag, ',') AS tag_list
      FROM memory m
      LEFT JOIN tags t ON t.memory_id = m.id
      WHERE m.pinned = 0 AND m.created_at > ? AND m.type != 'derived' AND m.risk_level < 2 AND ${ACTIVE_WHERE}
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `).all(since.toISOString()) as RawRow[];
    return recent as RawRow[];
  }

  searchSmart(
  query?: string,
  tags?: string[],
  includeDerived = true,
  minConfidence = 0.0,
  memoryType?: SemanticMemoryType,
  limit = 20,
  offset = 0
): MemoryEntry[] {
  const params: unknown[] = [];

  let sql = `
    SELECT m.*, group_concat(t.tag, ',') AS tag_list
    FROM memory m
    LEFT JOIN tags t ON t.memory_id = m.id
    WHERE ${ACTIVE_WHERE}
      AND (m.confidence >= ? OR m.pinned = 1)
  `;
  params.push(minConfidence);

  if (!includeDerived) {
    sql += ` AND m.type != 'derived'`;
  }

  if (memoryType) {
    sql += ` AND m.memory_type = ?`;
    params.push(memoryType);
  }

  if (query) {
    const words = query.trim().split(/\s+/).filter(w => w.length >= 3);
    if (words.length > 1) {
      sql += ` AND (${words.map(() => "m.content LIKE ?").join(" OR ")})`;
      params.push(...words.map(w => `%${w}%`));
    } else {
      sql += " AND m.content LIKE ?";
      params.push(`%${query}%`);
    }
  }

  if (tags?.length) {
    sql += ` AND m.id IN (
      SELECT memory_id FROM tags WHERE tag IN (${tags.map(() => "?").join(",")})
    )`;
    params.push(...tags);
  }

  sql += `
    GROUP BY m.id
    ORDER BY pinned DESC, confidence DESC, created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  try {
    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    return rows.map((r) => this.rowToEntry(r));
  } catch (err) {
    this.logger.error(`[searchSmart] SQLite query failed: ${err}`);
    return [];
  }
}

  countSearchSmart(
    query?: string,
    tags?: string[],
    includeDerived = true,
    minConfidence = 0.0,
    memoryType?: SemanticMemoryType
  ): number {
    const params: unknown[] = [];
    let sql = `
      SELECT COUNT(DISTINCT m.id) as cnt
      FROM memory m
      LEFT JOIN tags t ON t.memory_id = m.id
      WHERE ${ACTIVE_WHERE}
        AND (m.confidence >= ? OR m.pinned = 1)
    `;
    params.push(minConfidence);
    if (!includeDerived) sql += ` AND m.type != 'derived'`;
    if (memoryType) { sql += ` AND m.memory_type = ?`; params.push(memoryType); }
    if (query) {
      const words = query.trim().split(/\s+/).filter(w => w.length >= 3);
      if (words.length > 1) {
        sql += ` AND (${words.map(() => "m.content LIKE ?").join(" OR ")})`;
        params.push(...words.map(w => `%${w}%`));
      } else {
        sql += " AND m.content LIKE ?";
        params.push(`%${query}%`);
      }
    }
    if (tags?.length) {
      sql += ` AND m.id IN (SELECT memory_id FROM tags WHERE tag IN (${tags.map(() => "?").join(",")}))`;
      params.push(...tags);
    }
    try {
      const row = this.db.prepare(sql).get(...params) as { cnt: number };
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  buildPromptContextSmart(options?: {
    maxPinChars?: number;
    maxRecentChars?: number;
    recentDays?: number;
    includeDerived?: boolean;
    minConfidence?: number;
  }): string {
    const maxPinChars = options?.maxPinChars ?? 2000;
    const maxRecentChars = options?.maxRecentChars ?? 4000;
    const recentDays = options?.recentDays ?? 7;
    const includeDerived = options?.includeDerived ?? true;
    const minConfidence = options?.minConfidence ?? 0.0;

    const cutoff = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString();

    // Pinned facts first
    const pinned = this.searchSmart(undefined, undefined, includeDerived, minConfidence)
      .filter(f => f.pinned)
      .sort((a, b) => b.confidence - a.confidence);

    // Recent facts next (non-pinned, recentDays)
    const recent = this.searchSmart(undefined, undefined, includeDerived, minConfidence)
      .filter(f => !f.pinned && f.created_at > cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    const parts: string[] = [];

    if (pinned.length) {
      let chars = 0;
      const lines: string[] = [];
      for (const e of pinned) {
        const line = this.formatMemoryLine(e);
        if (chars + line.length > maxPinChars) break;
        lines.push(line);
        chars += line.length;
      }
      if (lines.length) parts.push(`## Pinned\n${lines.join("\n")}`);
    }

    if (recent.length) {
      let chars = 0;
      const lines: string[] = [];
      for (const e of recent) {
        const line = this.formatMemoryLine(e);
        if (chars + line.length > maxRecentChars) break;
        lines.push(line);
        chars += line.length;
      }
      if (lines.length) parts.push(`## Recent (last ${recentDays} days)\n${lines.join("\n")}`);
    }

    return parts.join("\n\n");
  }

  // ── Prompt context ───────────────────────────────────────────────────────────

  buildPromptContext_DEPRECATED(options?: {
    maxPinChars?: number;
    maxRecentChars?: number;
    recentDays?: number;
  }): string {
    const maxPinChars = options?.maxPinChars ?? 2000;
    const maxRecentChars = options?.maxRecentChars ?? 4000;
    const recentDays = options?.recentDays ?? 7;
    const cutoff = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString();

    // High-risk entries (risk_level >= 2) are excluded from automatic system-prompt
    // injection to prevent silently poisoning every future turn with attacker-controlled
    // content. They remain searchable via memory_search, but accessing them raises the
    // SecurityManager's context level so subsequent high-risk tool calls are blocked.
    const pinned = this.db.prepare(`
      SELECT m.*, group_concat(t.tag, ',') AS tag_list
      FROM memory m
      LEFT JOIN tags t ON t.memory_id = m.id
      WHERE m.pinned = 1 AND m.risk_level < 2 AND ${ACTIVE_WHERE}
      GROUP BY m.id
      ORDER BY m.confidence DESC
    `).all() as RawRow[];

    const recent = this.db.prepare(`
      SELECT m.*, group_concat(t.tag, ',') AS tag_list
      FROM memory m
      LEFT JOIN tags t ON t.memory_id = m.id
      WHERE m.pinned = 0 AND m.created_at > ? AND m.risk_level < 2 AND ${ACTIVE_WHERE}
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `).all(cutoff) as RawRow[];

    const parts: string[] = [];

    if (pinned.length) {
      let chars = 0;
      const lines: string[] = [];
      for (const row of pinned) {
        const e = this.rowToEntry(row);
        const line = `- [${e.tags.join(", ")}] ${e.content}`;
        if (chars + line.length > maxPinChars) break;
        lines.push(line);
        chars += line.length;
      }
      if (lines.length) parts.push(`## Pinned\n${lines.join("\n")}`);
    }

    if (recent.length) {
      let chars = 0;
      const lines: string[] = [];
      for (const row of recent) {
        const e = this.rowToEntry(row);
        const line = `- [${e.tags.join(", ")}] ${e.content}`;
        if (chars + line.length > maxRecentChars) break;
        lines.push(line);
        chars += line.length;
      }
      if (lines.length) parts.push(`## Recent (last ${recentDays} days)\n${lines.join("\n")}`);
    }

    return parts.join("\n\n");
  }

  // ── Knowledge documents ──────────────────────────────────────────────────────

  /**
   * Creates or fully replaces a knowledge document identified by `slug`.
   * If a document with the same slug already exists it is updated in-place.
   */
  knowledgeWrite(item: {
    slug: string;
    title: string;
    content: string;
    tags?: string[];
  }): KnowledgeDoc {
    const slug = item.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const tags = JSON.stringify(item.tags ?? []);
    const existing = this.db.prepare("SELECT id FROM knowledge WHERE slug = ?").get(slug) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE knowledge SET title = ?, content = ?, tags = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE slug = ?
      `).run(item.title, item.content, tags, slug);
    } else {
      this.db.prepare(`
        INSERT INTO knowledge (slug, title, content, tags) VALUES (?, ?, ?, ?)
      `).run(slug, item.title, item.content, tags);
    }
    return this.knowledgeGet(slug)!;
  }

  /** Reads a knowledge document by slug. Returns null if not found. */
  knowledgeGet(slug: string): KnowledgeDoc | null {
    const row = this.db.prepare("SELECT * FROM knowledge WHERE slug = ?")
      .get(slug.trim().toLowerCase()) as KnowledgeRow | undefined;
    return row ? rowToKnowledge(row) : null;
  }

  /** Lists all knowledge documents (without content — titles and metadata only). */
  knowledgeList(): KnowledgeDocMeta[] {
    return (this.db.prepare(
      "SELECT id, slug, title, tags, created_at, updated_at FROM knowledge ORDER BY updated_at DESC"
    ).all() as KnowledgeRow[]).map(r => ({
      slug: r.slug,
      title: r.title,
      tags: JSON.parse(r.tags ?? "[]") as string[],
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Full-text searches knowledge documents on title + content + tags.
   * Returns matching docs without content (caller calls knowledgeGet to read one).
   */
  knowledgeSearch(query: string, limit = 10): KnowledgeDocMeta[] {
    try {
      const rows = this.db.prepare(`
        SELECT k.id, k.slug, k.title, k.tags, k.created_at, k.updated_at
        FROM knowledge_fts f
        JOIN knowledge k ON k.id = f.rowid
        WHERE knowledge_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit) as KnowledgeRow[];
      return rows.map(r => ({
        slug: r.slug,
        title: r.title,
        tags: JSON.parse(r.tags ?? "[]") as string[],
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
    } catch {
      // FTS syntax error — fall back to LIKE search on title
      const rows = this.db.prepare(`
        SELECT id, slug, title, tags, created_at, updated_at FROM knowledge
        WHERE title LIKE ? OR content LIKE ?
        ORDER BY updated_at DESC LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit) as KnowledgeRow[];
      return rows.map(r => ({
        slug: r.slug,
        title: r.title,
        tags: JSON.parse(r.tags ?? "[]") as string[],
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
    }
  }

  /** Hard-deletes a knowledge document. Returns false if not found. */
  knowledgeDelete(slug: string): boolean {
    const result = this.db.prepare("DELETE FROM knowledge WHERE slug = ?")
      .run(slug.trim().toLowerCase());
    return result.changes > 0;
  }

  /** Total count of active (non-deleted, non-superseded) entries. */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM memory m WHERE ${ACTIVE_WHERE}`).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Returns a compact knowledge map: tag frequencies, memory-type distribution,
   * and which tags appeared in recently-created entries.
   * Used to inject a lightweight "table of contents" into the system prompt so
   * the agent knows what topics exist without loading entry content.
   */
  getKnowledgeMap(): {
    total: number;
    byTag: { tag: string; count: number }[];
    byType: { type: string; count: number }[];
    recentTags: string[];
    knowledgeDocs: { slug: string; title: string }[];
  } {
    const total = this.count();

    const byTag = (this.db.prepare(`
      SELECT t.tag, COUNT(*) AS cnt
      FROM tags t
      JOIN memory m ON m.id = t.memory_id
      WHERE ${ACTIVE_WHERE} AND m.risk_level < 2
      GROUP BY t.tag
      ORDER BY cnt DESC
      LIMIT 30
    `).all() as { tag: string; cnt: number }[])
      .map(r => ({ tag: r.tag, count: r.cnt }));

    const byType = (this.db.prepare(`
      SELECT m.memory_type AS type, COUNT(*) AS cnt
      FROM memory m
      WHERE ${ACTIVE_WHERE} AND m.memory_type IS NOT NULL AND m.risk_level < 2
      GROUP BY m.memory_type
      ORDER BY cnt DESC
    `).all() as { type: string; cnt: number }[])
      .map(r => ({ type: r.type, count: r.cnt }));

    const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentTags = (this.db.prepare(`
      SELECT DISTINCT t.tag
      FROM tags t
      JOIN memory m ON m.id = t.memory_id
      WHERE ${ACTIVE_WHERE} AND m.created_at > ? AND m.risk_level < 2
      ORDER BY m.created_at DESC
      LIMIT 10
    `).all(recentCutoff) as { tag: string }[])
      .map(r => r.tag);

    const knowledgeDocs = (this.db.prepare(
      "SELECT slug, title FROM knowledge ORDER BY updated_at DESC"
    ).all() as { slug: string; title: string }[]);

    return { total, byTag, byType, recentTags, knowledgeDocs };
  }

  /**
   * Extracts keywords from `text` and searches for matching memory entries.
   * Excludes entries already present in `excludeIds` (e.g. pinned/recent already injected).
   * Returns at most `limit` results, safe to inject into the system prompt (risk_level < 2).
   */
  contextualSearch(text: string, limit = 5, excludeIds: Set<number> = new Set()): MemoryEntry[] {
    const keywords = tokenizeMemory(text)
      .sort((a, b) => b.length - a.length) // prefer longer/more specific words
      .slice(0, 8);
    if (keywords.length === 0) return [];

    const query = keywords.join(" ");
    const results = this.search(query, undefined, limit + excludeIds.size);
    return results
      .filter((e) => !excludeIds.has(e.id) && e.risk_level < 2)
      .slice(0, limit);
  }

  // ── Similarity search ────────────────────────────────────────────────────────

  /**
   * Finds active memory entries that are textually similar to `content`.
   * Uses a keyword SQL pre-filter to keep the candidate set small, then ranks
   * by Jaccard similarity on word tokens.
   *
   * Returns at most `limit` results with similarity >= 0.5, sorted descending.
   */
  findSimilarEntries(content: string, limit = 5): Array<{ entry: MemoryEntry; similarity: number }> {
    const words = tokenizeMemory(content);
    if (words.length < 2) return [];

    // Use the longest words as SQL pre-filter keywords (avoids full-table scan).
    const keywords = [...words].sort((a, b) => b.length - a.length).slice(0, 4);
    const likeClauses = keywords.map(() => "LOWER(m.content) LIKE ?").join(" OR ");
    const likeParams = keywords.map((k) => `%${k}%`);

    const sql = `
      SELECT m.*, group_concat(t.tag, ',') AS tag_list
      FROM memory m
      LEFT JOIN tags t ON t.memory_id = m.id
      WHERE ${ACTIVE_WHERE} AND (${likeClauses})
      GROUP BY m.id
      LIMIT 100
    `;

    const candidates = (this.db.prepare(sql).all(...likeParams) as RawRow[])
      .map((r) => this.rowToEntry(r));

    return candidates
      .map((entry) => ({ entry, similarity: jaccardSimilarity(content, entry.content) }))
      .filter((r) => r.similarity >= 0.5)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private insertTagsRaw(memoryId: number, tags: string[]): void {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)");
    for (const tag of tags) {
      const t = tag.trim();
      if (t) stmt.run(memoryId, t);
    }
  }

  private formatMemoryLine(e: MemoryEntry): string {
    const typePart = e.memory_type ? `(${e.memory_type}) ` : "";
    return `- ${typePart}[${e.tags.join(",")}] ${e.content}`;
  }

  private rowToEntry(row: RawRow): MemoryEntry {
    return {
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      confidence: row.confidence,
      pinned: Boolean(row.pinned),
      protected: Boolean(row.protected),
      supersedes: row.supersedes ?? null,
      expires_at: row.expires_at ?? null,
      origin_session: row.origin_session ?? null,
      created_at: row.created_at,
      tags: row.tag_list ? row.tag_list.split(",").filter(Boolean) : [],
      risk_level: row.risk_level ?? 0,
      memory_type: (row.memory_type as SemanticMemoryType | null) ?? null,
    };
  }
}

type RawRow = {
  id: number;
  type: string;
  content: string;
  confidence: number;
  pinned: number;
  protected: number;
  supersedes: number | null;
  expires_at: string | null;
  origin_session: string | null;
  created_at: string;
  tag_list: string | null;
  risk_level: number;
  memory_type: string | null;
};

type ConfidenceRow = {
  id: number,
  confidence: number;
  created_at: string;
}

// ── Knowledge document types ─────────────────────────────────────────────────

export type KnowledgeDoc = {
  slug: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
};

export type KnowledgeDocMeta = Omit<KnowledgeDoc, "content">;

type KnowledgeRow = {
  id: number;
  slug: string;
  title: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
};

function rowToKnowledge(r: KnowledgeRow): KnowledgeDoc {
  return {
    slug: r.slug,
    title: r.title,
    content: r.content,
    tags: JSON.parse(r.tags ?? "[]") as string[],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Text similarity helpers ───────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "are", "was", "has", "have",
  "been", "will", "its", "can", "from", "not", "but", "you", "your", "user"
]);

/** Lowercases and splits text into meaningful word tokens, filtering stopwords. */
function tokenizeMemory(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Jaccard similarity on word-token sets: |A ∩ B| / |A ∪ B|. Range 0–1. */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenizeMemory(a));
  const setB = new Set(tokenizeMemory(b));
  if (!setA.size && !setB.size) return 1.0;
  if (!setA.size || !setB.size) return 0.0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}