import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import type { SubagentManager } from "src/agent/subagent.js";

/**
 * Agent tool: `agent_run`
 *
 * Delegates a task to a sub-agent and waits for the result.
 * The sub-agent runs a full LLM loop with file, web, and IMAP tools and
 * returns its final text response as this tool's result.
 *
 * Unlike `spawn` (fire-and-forget), `agent_run` blocks until the sub-agent
 * finishes and surfaces the result inline. This lets the calling agent:
 *   - Delegate long-running or noisy work without polluting its own context
 *   - Run multiple independent tasks in parallel by issuing multiple agent_run
 *     calls in the same response (they execute concurrently)
 *
 * outputRisk = High  — sub-agent may return external/attacker-controlled content
 * maxRisk    = High  — allowed from any context (sub-agent is isolated)
 * parallel   = true  — multiple agent_run calls in one batch run concurrently
 */
export class AgentRunTool extends Tool {
  constructor(private subagents: SubagentManager) { super(); }

  get name() { return "agent_run"; }
  get outputRisk() { return RiskLevel.High; }
  get maxRisk() { return RiskLevel.High; }
  get parallel() { return true; }

  get description() {
    return (
      "Delegate a task to a sub-agent and get back the result. " +
      "Use this instead of doing lengthy multi-step work yourself when: " +
      "(1) the task is self-contained and its intermediate tool noise would clutter your context, " +
      "(2) you want to run multiple independent tasks at the same time — call agent_run multiple times " +
      "in one response and they execute in parallel. " +
      "The sub-agent has access to file, web, and email tools. " +
      "It cannot call exec/spawn or send messages. " +
      "Always include all context the sub-agent needs in the task prompt — it has no memory of your conversation."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Full task description for the sub-agent. Be specific — include all context it needs. It cannot ask follow-up questions."
        },
        maxIterations: {
          type: "integer",
          description: "Max LLM iterations for the sub-agent. Default: 15."
        }
      },
      required: ["task"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const task = String(params["task"] ?? "").trim();
    if (!task) return "Error: task is required";
    const maxIterations = typeof params["maxIterations"] === "number" ? params["maxIterations"] : 15;
    const result = await this.subagents.run({ task, maxIterations });
    return result;
  }
}
