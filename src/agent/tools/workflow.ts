import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import type { WorkflowService } from "../workflow.js";

/**
 * Declares a multi-step workflow plan and stores it in the session for user review.
 *
 * The agent calls this tool when a task requires several sequential tool calls
 * that would normally be blocked by security holds (e.g. browser automation
 * followed by email reading). The plan is presented to the user; once confirmed
 * the listed tools are approved to run without maxRisk interruption.
 */
export class WorkflowPlanTool extends Tool {
  constructor(private workflow: WorkflowService) { super(); }

  get name() { return "workflow_plan"; }
  get maxRisk(): RiskLevel { return RiskLevel.High; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return (
      "Declare a multi-step workflow plan that requires running several tools in sequence. " +
      "Use this when a task involves browser automation, email access, and other tools " +
      "that would normally be interrupted by security holds. " +
      "The plan is shown to the user for confirmation before execution begins. " +
      "After the user confirms, call workflow_activate to start the approved execution. " +
      "Use clear step descriptions so the user can understand exactly what will happen."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name:         { type: "string",  description: "Short identifier for this workflow (e.g. 'signup-and-verify')." },
        summary:      { type: "string",  description: "One-sentence description of the overall goal." },
        steps:        { type: "array",   items: { type: "string" }, description: "Ordered list of steps the agent will perform." },
        tools_needed: { type: "array",   items: { type: "string" }, description: "Tool names that need security approval (e.g. ['browser_navigate', 'imap_read'])." }
      },
      required: ["name", "summary", "steps", "tools_needed"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name         = String(params.name    ?? "").trim();
    const summary      = String(params.summary ?? "").trim();
    const steps        = Array.isArray(params.steps)        ? (params.steps as unknown[]).map(String)        : [];
    const tools_needed = Array.isArray(params.tools_needed) ? (params.tools_needed as unknown[]).map(String) : [];

    if (!name)         return "Error: name is required";
    if (!summary)      return "Error: summary is required";
    if (!steps.length) return "Error: steps is required";
    if (!tools_needed.length) return "Error: tools_needed is required";

    const plan = this.workflow.createPlan(name, summary, steps, tools_needed);

    const stepsText  = steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
    const toolsText  = tools_needed.map(t => `  • ${t}`).join("\n");

    return [
      `[WORKFLOW_PENDING — YOU MUST NOW STOP AND PRESENT THIS TO THE USER. DO NOT CALL ANY MORE TOOLS.]`,
      ``,
      `**Workflow Plan: "${name}"**`,
      `**Goal:** ${summary}`,
      ``,
      `**Steps:**`,
      stepsText,
      ``,
      `**Tools that will be approved:**`,
      toolsText,
      ``,
      `INSTRUCTION: Send the above plan to the user NOW as your reply. Ask: "Shall I proceed? (yes / no)"`,
      `Do NOT call workflow_activate or any other tool until the user explicitly confirms.`,
      `When the user confirms, call workflow_activate to start the approved execution.`,
    ].join("\n");
  }
}

/**
 * Activates a pending workflow (after user confirmation) or loads a saved reusable workflow.
 * Once active, the listed tools bypass the maxRisk security check for this session.
 */
export class WorkflowActivateTool extends Tool {
  constructor(private workflow: WorkflowService) { super(); }

  get name() { return "workflow_activate"; }
  get maxRisk(): RiskLevel { return RiskLevel.High; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return (
      "Activate a workflow plan after the user has confirmed it. " +
      "Call this immediately after the user says yes/confirm/proceed following a workflow_plan presentation. " +
      "Optionally pass a saved workflow name to load and activate a previously saved reusable workflow. " +
      "Once activated, the approved tools run without security holds for this session."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of a saved reusable workflow to load (optional). Omit to activate the current pending plan." }
      },
      required: []
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name = params.name ? String(params.name).trim() : undefined;
    const result = this.workflow.activate(name);

    if (!result.ok) return `Error: ${result.error}`;

    const plan = result.plan!;
    return [
      `**Workflow "${plan.name}" is now active.**`,
      `Approved tools: ${plan.tools_needed.join(", ")}`,
      `These tools will run without security holds for this session.`,
      `Proceed with the task.`,
    ].join("\n");
  }
}

/**
 * Saves the current active workflow for future reuse.
 * The saved workflow can be loaded by name with workflow_activate.
 */
export class WorkflowSaveTool extends Tool {
  constructor(private workflow: WorkflowService) { super(); }

  get name() { return "workflow_save"; }
  get maxRisk(): RiskLevel { return RiskLevel.High; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return (
      "Save the current workflow plan to disk for future reuse. " +
      "Can be called right after workflow_plan — the workflow does not need to have been activated or run first. " +
      "Provide a name and description. The saved workflow can be loaded in any future session with workflow_activate(name)."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name:        { type: "string", description: "Unique name for the saved workflow (e.g. 'signup-site-x')." },
        description: { type: "string", description: "Human-readable description of what this workflow does." }
      },
      required: ["name", "description"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name        = String(params.name        ?? "").trim();
    const description = String(params.description ?? "").trim();
    if (!name)        return "Error: name is required";
    if (!description) return "Error: description is required";

    try {
      const saved = this.workflow.save(name, description);
      return `Workflow "${saved.name}" saved. Load it in any future session with: workflow_activate(name: "${saved.name}")`;
    } catch (err) {
      return `Error: ${String(err)}`;
    }
  }
}

/**
 * Lists all saved reusable workflows.
 */
export class WorkflowListTool extends Tool {
  constructor(private workflow: WorkflowService) { super(); }

  get name() { return "workflow_list"; }
  get maxRisk(): RiskLevel { return RiskLevel.High; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return "List all saved reusable workflows. Use workflow_activate(name) to run one.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {}, required: [] };
  }

  async execute(): Promise<string> {
    const workflows = this.workflow.list();
    if (!workflows.length) return "No saved workflows yet. Use workflow_plan + workflow_save to create one.";

    const rows = workflows.map(w =>
      `• **${w.name}** — ${w.description}\n  Tools: ${w.tools_needed.join(", ")}\n  Steps: ${w.steps.length}  |  Saved: ${w.created_at.slice(0, 10)}`
    );
    return `**Saved Workflows (${workflows.length}):**\n\n${rows.join("\n\n")}`;
  }
}

/**
 * Cancels the active or pending workflow for this session.
 */
export class WorkflowCancelTool extends Tool {
  constructor(private workflow: WorkflowService) { super(); }

  get name() { return "workflow_cancel"; }
  get maxRisk(): RiskLevel { return RiskLevel.High; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return "Cancel the active or pending workflow for this session. The security bypass is immediately removed.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {}, required: [] };
  }

  async execute(): Promise<string> {
    const had = this.workflow.getActive() ?? this.workflow.getPending();
    this.workflow.cancel();
    return had ? `Workflow "${had.name}" cancelled. Security holds are back to normal.` : "No active workflow to cancel.";
  }
}
