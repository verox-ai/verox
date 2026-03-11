import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Session } from "src/session/manager.js";
import type { SessionManager } from "src/session/manager.js";
import { Logger } from "src/utils/logger.js";

const logger = new Logger("WorkflowService");

export type WorkflowPlan = {
  id: string;
  name: string;
  summary: string;
  steps: string[];
  tools_needed: string[];
};

export type SavedWorkflow = WorkflowPlan & {
  description: string;
  created_at: string;
};

const PENDING_KEY = "pending_workflow";
const ACTIVE_KEY  = "active_workflow";

/**
 * Manages workflow plans per session and persists reusable workflows to disk.
 *
 * Lifecycle:
 *   1. Agent calls workflow_plan → createPlan() stores plan in session.metadata.pending_workflow
 *   2. LLM presents plan to user; user confirms
 *   3. Agent calls workflow_activate → activate() moves pending → active_workflow
 *   4. llm-loop bypasses maxRisk for tools listed in active_workflow.tools_needed
 *   5. Optionally: workflow_save → save() writes to workspace/workflows/<name>.json for reuse
 *   6. Future: workflow_activate with name → loadAndActivate() replays a saved workflow
 */
export class WorkflowService {
  private currentSession: Session | null = null;
  private workflowsDir: string;

  constructor(private workspace: string, private sessions: SessionManager) {
    this.workflowsDir = join(workspace, "workflows");
  }

  /** Must be called by the agent before each runIterationLoop. */
  setSession(session: Session): void {
    this.currentSession = session;
  }

  // ── Session-scoped plan state ────────────────────────────────────────────

  createPlan(name: string, summary: string, steps: string[], tools_needed: string[]): WorkflowPlan {
    if (!this.currentSession) throw new Error("No session set");
    const plan: WorkflowPlan = { id: randomUUID(), name, summary, steps, tools_needed };
    this.currentSession.metadata[PENDING_KEY] = plan;
    this.sessions.save(this.currentSession);
    logger.info("Workflow plan created", { name, tools: tools_needed });
    return plan;
  }

  getPending(): WorkflowPlan | null {
    return (this.currentSession?.metadata[PENDING_KEY] as WorkflowPlan | undefined) ?? null;
  }

  getActive(): WorkflowPlan | null {
    return (this.currentSession?.metadata[ACTIVE_KEY] as WorkflowPlan | undefined) ?? null;
  }

  /**
   * Activates the pending workflow for this session, granting the listed tools
   * a maxRisk bypass for the duration of the active workflow.
   * If `name` is provided, loads and activates a saved workflow by that name instead.
   */
  activate(name?: string): { ok: boolean; plan?: WorkflowPlan; error?: string } {
    if (!this.currentSession) return { ok: false, error: "No session set" };

    if (name) {
      return this.loadAndActivate(name);
    }

    const pending = this.getPending();
    if (!pending) return { ok: false, error: "No pending workflow to activate. Call workflow_plan first." };

    this.currentSession.metadata[ACTIVE_KEY]  = pending;
    delete this.currentSession.metadata[PENDING_KEY];
    this.sessions.save(this.currentSession);
    logger.info("Workflow activated", { name: pending.name, tools: pending.tools_needed });
    return { ok: true, plan: pending };
  }

  loadAndActivate(name: string): { ok: boolean; plan?: WorkflowPlan; error?: string } {
    if (!this.currentSession) return { ok: false, error: "No session set" };
    const saved = this.loadByName(name);
    if (!saved) return { ok: false, error: `No saved workflow named "${name}". Use workflow_list to see available workflows.` };
    this.currentSession.metadata[ACTIVE_KEY] = saved;
    delete this.currentSession.metadata[PENDING_KEY];
    this.sessions.save(this.currentSession);
    logger.info("Saved workflow activated", { name });
    return { ok: true, plan: saved };
  }

  cancel(): void {
    if (!this.currentSession) return;
    delete this.currentSession.metadata[ACTIVE_KEY];
    delete this.currentSession.metadata[PENDING_KEY];
    this.sessions.save(this.currentSession);
    logger.info("Workflow cancelled");
  }

  /**
   * Returns the set of tool names approved by the active workflow,
   * or an empty set if no workflow is active.
   */
  getApprovedTools(): Set<string> {
    const active = this.getActive();
    return active ? new Set(active.tools_needed) : new Set();
  }

  // ── Persistent saved workflows ───────────────────────────────────────────

  save(name: string, description: string): SavedWorkflow {
    const plan = this.getActive() ?? this.getPending();
    if (!plan) throw new Error("No workflow to save. Call workflow_plan first.");
    mkdirSync(this.workflowsDir, { recursive: true });
    const saved: SavedWorkflow = { ...plan, name, description, created_at: new Date().toISOString() };
    const filePath = join(this.workflowsDir, `${this.safeName(name)}.json`);
    writeFileSync(filePath, JSON.stringify(saved, null, 2));
    logger.info("Workflow saved", { name, path: filePath });
    return saved;
  }

  list(): SavedWorkflow[] {
    if (!existsSync(this.workflowsDir)) return [];
    return readdirSync(this.workflowsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try { return JSON.parse(readFileSync(join(this.workflowsDir, f), "utf8")) as SavedWorkflow; }
        catch { return null; }
      })
      .filter((w): w is SavedWorkflow => w !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  delete(name: string): boolean {
    const filePath = join(this.workflowsDir, `${this.safeName(name)}.json`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }

  private loadByName(name: string): SavedWorkflow | null {
    const filePath = join(this.workflowsDir, `${this.safeName(name)}.json`);
    if (!existsSync(filePath)) return null;
    try { return JSON.parse(readFileSync(filePath, "utf8")) as SavedWorkflow; }
    catch { return null; }
  }

  private safeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  }
}
