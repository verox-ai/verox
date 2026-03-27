import { SubagentManager } from "../subagent";
import { Tool } from "./toolbase";
import { RiskLevel } from "../security.js";

/**
 * Starts a tracked sub-agent and returns its job ID immediately.
 * Call multiple times in one turn to fan out work in parallel, then
 * collect results with agent_await.
 */
export class AgentRunTool extends Tool {
  constructor(private manager: SubagentManager) { super(); }

  get name() { return "agent_run"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }
  get maxRisk():    RiskLevel { return RiskLevel.None; }
  /** Run multiple agents in parallel within a single tool batch. */
  get parallel(): boolean { return true; }

  get description() {
    return [
      "Start a sub-agent to work on a task in the background and return its job ID.",
      "Call agent_run multiple times in the same response to run agents in parallel.",
      "Then use agent_await with each ID to collect the results.",
      "Use this for parallelisable work: research, summarisation, analysis of independent topics.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task:           { type: "string",  description: "Full task description for the sub-agent" },
        label:          { type: "string",  description: "Short label shown in status (optional)" },
        max_iterations: { type: "integer", description: "Max LLM iterations (default 15)", minimum: 1, maximum: 40 },
      },
      required: ["task"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const task  = String(params.task ?? "");
    const label = params.label ? String(params.label) : undefined;
    const maxIterations = params.max_iterations ? Number(params.max_iterations) : undefined;
    if (!task) return "Error: task is required";
    const id = this.manager.runTracked({ task, label, maxIterations });
    return `Agent started (id: ${id}). Use agent_await("${id}") to collect the result when ready.`;
  }
}

/**
 * Waits for a tracked sub-agent to finish and returns its result.
 * If the agent is already done, returns immediately.
 */
export class AgentAwaitTool extends Tool {
  constructor(private manager: SubagentManager) { super(); }

  get name() { return "agent_await"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }
  get maxRisk():    RiskLevel { return RiskLevel.None; }

  get description() {
    return "Wait for a sub-agent started with agent_run to finish and return its result. Blocks until done or timeout.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        id:              { type: "string",  description: "Job ID returned by agent_run" },
        timeout_seconds: { type: "integer", description: "Max seconds to wait (default 300)", minimum: 1, maximum: 600 },
      },
      required: ["id"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const id      = String(params.id ?? "");
    const timeout = params.timeout_seconds ? Number(params.timeout_seconds) * 1000 : undefined;
    return this.manager.awaitTracked(id, timeout);
  }
}

/**
 * Lists all tracked sub-agents (running and finished) for the current session.
 */
export class AgentStatusTool extends Tool {
  constructor(private manager: SubagentManager) { super(); }

  get name() { return "agent_status"; }

  get description() {
    return "List all sub-agents started with agent_run: their IDs, labels, and status (running/done/failed).";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  async execute(_params: Record<string, unknown>): Promise<string> {
    const jobs = this.manager.listTracked();
    if (!jobs.length) return "No tracked sub-agents.";
    return jobs.map(j => `[${j.id}] ${j.label} — ${j.status}${j.doneAt ? ` (done ${j.doneAt})` : ""}`).join("\n");
  }
}

export class SpawnTool extends Tool {
  private channel = "cli";
  private chatId = "direct";
  private replyChannel?: string;
  private replyChatId?: string;

  constructor(private manager: SubagentManager) {
    super();
  }

  get name(): string { return "spawn"; }

  // Spawning a subagent with attacker-controlled instructions is dangerous.
  get outputRisk(): RiskLevel { return RiskLevel.High; }
  get maxRisk():    RiskLevel { return RiskLevel.None; }

  get description(): string {
    return "Spawn a background subagent to handle a task";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task: { type: "string", description: "Task for the subagent" },
        label: { type: "string", description: "Optional label" }
      },
      required: ["task"]
    };
  }

  setContext(channel: string, chatId: string, replyChannel?: string, replyChatId?: string): void {
    this.channel = channel;
    this.chatId = chatId;
    this.replyChannel = replyChannel;
    this.replyChatId = replyChatId;
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const task = String(params.task ?? "");
    const label = params.label ? String(params.label) : undefined;
    return this.manager.spawn({
      task,
      label,
      originChannel: this.channel,
      originChatId: this.chatId,
      replyChannel: this.replyChannel,
      replyChatId: this.replyChatId
    });
  }
}
