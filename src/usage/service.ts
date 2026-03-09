import Database from "better-sqlite3";
import { join } from "node:path";
import { ensureDir } from "src/utils/util.js";
import { Logger } from "src/utils/logger.js";

export type UsagePeriod = "today" | "date" | "week" | "month" | "all";

export type UsageDayRow = {
  date: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
};

export type UsageStats = {
  period: UsagePeriod;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  by_day: UsageDayRow[];
};

/**
 * Tracks token usage for every LLM call, aggregated by day and model.
 * Stored in a lightweight SQLite database at {workspace}/usage/usage.db.
 * Persists across restarts — callers can query for cost estimation.
 */
export class UsageService {
  private db: Database.Database;
  private logger = new Logger(UsageService.name);

  constructor(workspace: string) {
    const dir = ensureDir(join(workspace, "usage"));
    this.db = new Database(join(dir, "usage.db"));
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily (
        date               TEXT    NOT NULL,
        model              TEXT    NOT NULL DEFAULT '',
        prompt_tokens      INTEGER NOT NULL DEFAULT 0,
        completion_tokens  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, model)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date);
    `);
  }

  /**
   * Records token usage from a single LLM call.
   * Upserts into the daily bucket for today, keyed by model.
   */
  record(promptTokens: number, completionTokens: number, model = ""): void {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    this.db.prepare(`
      INSERT INTO usage_daily (date, model, prompt_tokens, completion_tokens)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date, model) DO UPDATE SET
        prompt_tokens     = prompt_tokens     + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens
    `).run(date, model, promptTokens, completionTokens);
  }

  /**
   * Returns aggregated stats for the requested period.
   * Includes a per-day breakdown and overall totals.
   */
  getStats(period: UsagePeriod = "month", date?:Date): UsageStats {
    let cutoff: string;
    const today = new Date().toISOString().slice(0, 10);
    
    switch (period) {
      case "date":
        if (date) {
        cutoff = date?.toISOString().slice(0, 10);
        } else {
          cutoff = "0000-00-00";
        }
        break;
      case "today":
        cutoff = today;
        break;
      case "week": {
        const d = new Date();
        d.setDate(d.getDate() - 6);
        cutoff = d.toISOString().slice(0, 10);
        break;
      }
      case "month": {
        const d = new Date();
        d.setDate(d.getDate() - 29);
        cutoff = d.toISOString().slice(0, 10);
        break;
      }
      default:
        cutoff = "0000-00-00";
    }
    this.logger.debug(`Cutof is ${cutoff}`);
    const rows = this.db.prepare(`
      SELECT date, model, prompt_tokens, completion_tokens
      FROM usage_daily
      WHERE date >= ?
      ORDER BY date DESC, model ASC
    `).all(cutoff) as UsageDayRow[];

    const prompt_tokens    = rows.reduce((s, r) => s + r.prompt_tokens, 0);
    const completion_tokens = rows.reduce((s, r) => s + r.completion_tokens, 0);

    return {
      period,
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
      by_day: rows
    };
  }
}
