import { Tool } from "./toolbase.js";
import type { GoalsService, GoalStatus, StepStatus } from "src/goals/service.js";

/** Creates a new persistent goal with an ordered list of steps. */
export class GoalCreateTool extends Tool {
  constructor(private goals: GoalsService) { super(); }

  get name() { return "goal_create"; }
  get description() {
    return [
      "Create a persistent multi-step goal that survives session restarts.",
      "Use this when the user asks you to do something that requires multiple actions across time.",
      "The goal and its step progress are shown in every future turn so you always know where you left off.",
      "Immediately set the goal to in_progress and mark the first step in_progress too.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        title:       { type: "string", description: "Short goal title (1 line)" },
        description: { type: "string", description: "What the goal achieves and why" },
        steps:       { type: "array",  items: { type: "string" }, description: "Ordered list of step titles" },
      },
      required: ["title", "description", "steps"],
    };
  }

  async execute(params: Record<string, unknown>, toolCallId?: string): Promise<string> {
    const title = String(params.title ?? "");
    const description = String(params.description ?? "");
    const steps = (params.steps as string[]).map(String);
    if (!title || !description || !steps.length) return "Error: title, description, and steps are required";
    const goal = this.goals.create({ title, description, steps });
    return JSON.stringify(goal, null, 2);
  }
}

/** Updates the status or step progress of an existing goal. */
export class GoalUpdateTool extends Tool {
  constructor(private goals: GoalsService) { super(); }

  get name() { return "goal_update"; }
  get description() {
    return [
      "Update a goal's status or the status/notes of individual steps.",
      "Use this after completing, failing, or starting a step.",
      "Mark a goal completed or failed when all work is done.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        id:     { type: "string", description: "Goal ID returned by goal_create or goal_list" },
        status: { type: "string", enum: ["pending","in_progress","completed","failed","cancelled"], description: "New overall goal status (optional)" },
        result: { type: "string", description: "Final outcome summary when completing or failing the goal (optional)" },
        step_updates: {
          type: "array",
          description: "Individual step progress updates (optional)",
          items: {
            type: "object",
            properties: {
              id:     { type: "string", description: "Step ID from goal_get" },
              status: { type: "string", enum: ["pending","in_progress","completed","failed","skipped"] },
              notes:  { type: "string", description: "Optional notes about how this step resolved" },
            },
            required: ["id"],
          },
        },
      },
      required: ["id"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const id = String(params.id ?? "");
    const updated = this.goals.update(id, {
      status: params.status as GoalStatus | undefined,
      result: params.result != null ? String(params.result) : undefined,
      stepUpdates: (params.step_updates as Array<{ id: string; status?: string; notes?: string }> | undefined)
        ?.map(su => ({ id: su.id, status: su.status as StepStatus | undefined, notes: su.notes })),
    });
    if (!updated) return `Error: Goal '${id}' not found`;
    return JSON.stringify(updated, null, 2);
  }
}

/** Returns a single goal with all step details. */
export class GoalGetTool extends Tool {
  constructor(private goals: GoalsService) { super(); }

  get name() { return "goal_get"; }
  get description() { return "Get full details of a goal including all step IDs, statuses, and notes."; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        id: { type: "string", description: "Goal ID" },
      },
      required: ["id"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const goal = this.goals.get(String(params.id ?? ""));
    if (!goal) return `Error: Goal '${params.id}' not found`;
    return JSON.stringify(goal, null, 2);
  }
}

/** Lists all goals, optionally filtered by status. */
export class GoalListTool extends Tool {
  constructor(private goals: GoalsService) { super(); }

  get name() { return "goal_list"; }
  get description() { return "List all goals, optionally filtered by status. Active goals are also shown in every system prompt."; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending","in_progress","completed","failed","cancelled"], description: "Filter by status (omit for all)" },
      },
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const goals = this.goals.list(params.status as GoalStatus | undefined);
    if (!goals.length) return "No goals found.";
    return goals.map(g => {
      const done = g.steps.filter(s => s.status === "completed").length;
      return `[${g.id}] ${g.title} — ${g.status} (${done}/${g.steps.length} steps done)`;
    }).join("\n");
  }
}
