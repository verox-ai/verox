import { join } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { Logger } from "src/utils/logger.js";

export type GoalStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type GoalStep = {
  id: string;
  title: string;
  status: StepStatus;
  notes?: string;
};

export type Goal = {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  steps: GoalStep[];
  channel?: string;
  chatId?: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
};

type GoalRow = {
  id: string;
  title: string;
  description: string;
  status: string;
  steps_json: string;
  channel: string | null;
  chat_id: string | null;
  created_at: string;
  updated_at: string;
  result: string | null;
};

/**
 * Persistent storage for agent goals.
 * Goals are multi-step intentions that survive session compaction and restarts.
 * Active goals are injected into the system prompt every turn so the agent
 * always knows what it is working toward.
 */
export class GoalsService {
  private db: Database.Database;
  private logger = new Logger(GoalsService.name);

  constructor(workspace: string) {
    const dir = join(workspace, "memory");
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "goals.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.logger.debug("GoalsService initialized");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        description TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        steps_json TEXT NOT NULL DEFAULT '[]',
        channel    TEXT,
        chat_id    TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result     TEXT
      )
    `);
  }

  private rowToGoal(row: GoalRow): Goal {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status as GoalStatus,
      steps: JSON.parse(row.steps_json) as GoalStep[],
      channel: row.channel ?? undefined,
      chatId: row.chat_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      result: row.result ?? undefined,
    };
  }

  /** Creates a new goal and returns it. */
  create(params: {
    title: string;
    description: string;
    steps: string[];
    channel?: string;
    chatId?: string;
  }): Goal {
    const now = new Date().toISOString();
    const steps: GoalStep[] = params.steps.map(title => ({
      id: crypto.randomUUID(),
      title,
      status: "pending",
    }));
    const goal: Goal = {
      id: crypto.randomUUID(),
      title: params.title,
      description: params.description,
      status: "pending",
      steps,
      channel: params.channel,
      chatId: params.chatId,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO goals (id, title, description, status, steps_json, channel, chat_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goal.id, goal.title, goal.description, goal.status,
      JSON.stringify(goal.steps),
      goal.channel ?? null, goal.chatId ?? null,
      now, now
    );
    return goal;
  }

  /**
   * Applies a partial update to a goal's status, result, or individual steps.
   * Returns the updated goal or null if not found.
   */
  update(id: string, patch: {
    status?: GoalStatus;
    result?: string;
    stepUpdates?: Array<{ id: string; status?: StepStatus; notes?: string }>;
  }): Goal | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
    if (!row) return null;

    const goal = this.rowToGoal(row);
    if (patch.status !== undefined) goal.status = patch.status;
    if (patch.result !== undefined) goal.result = patch.result;

    for (const su of patch.stepUpdates ?? []) {
      const step = goal.steps.find(s => s.id === su.id);
      if (!step) continue;
      if (su.status !== undefined) step.status = su.status;
      if (su.notes !== undefined) step.notes = su.notes;
    }

    goal.updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE goals SET status=?, steps_json=?, result=?, updated_at=? WHERE id=?
    `).run(goal.status, JSON.stringify(goal.steps), goal.result ?? null, goal.updatedAt, id);

    return goal;
  }

  /** Returns a single goal by id, or null. */
  get(id: string): Goal | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
    return row ? this.rowToGoal(row) : null;
  }

  /** Lists all goals, optionally filtered by status. */
  list(status?: GoalStatus): Goal[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM goals WHERE status = ? ORDER BY created_at DESC").all(status) as GoalRow[]
      : this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all() as GoalRow[];
    return rows.map(r => this.rowToGoal(r));
  }

  /** Returns only active (pending / in_progress) goals for system prompt injection. */
  listActive(): Goal[] {
    return (this.db.prepare(
      "SELECT * FROM goals WHERE status IN ('pending','in_progress') ORDER BY updated_at DESC"
    ).all() as GoalRow[]).map(r => this.rowToGoal(r));
  }

  /** Hard-deletes a goal. */
  delete(id: string): boolean {
    const info = this.db.prepare("DELETE FROM goals WHERE id = ?").run(id);
    return info.changes > 0;
  }
}
