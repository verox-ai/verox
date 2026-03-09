import { Tool } from "./toolbase.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Meta-tool that lets the LLM discover and activate contextual tools (e.g. MCP
 * tools) that weren't included in the initial request due to keyword filtering.
 *
 * The LLM calls this when it believes it needs a capability not visible in the
 * current tool list. Matching tools are activated immediately and will appear in
 * the next iteration's tool definitions.
 */
export class ToolSearchTool extends Tool {
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    super();
    this.registry = registry;
  }

  get name(): string { return "tool_search"; }

  get description(): string {
    return (
      "Discover and activate additional tools that are not currently visible. " +
      "Use this when you need a capability (e.g. home automation, calendar, custom MCP tools) " +
      "that you don't see in your current tool list. " +
      "Describe what you want to do and matching tools will be made available immediately."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Describe what you want to do or the capability you need (e.g. 'control smart home lights', 'read calendar events').",
        },
      },
      required: ["query"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const query = String(params["query"] ?? "");
    const matches = this.registry.searchContextualTools(query);

    if (matches.length === 0) {
      return `No additional tools found matching "${query}". The tools currently in your list are all that's available.`;
    }

    const activated = this.registry.activate(matches.map((t) => t.name));

    const lines = activated.map((t) => `- ${t.name}: ${t.description}`).join("\n");
    return (
      `Activated ${activated.length} tool(s) — they are now available in your tool list:\n${lines}\n\n` +
      `You can now call them directly.`
    );
  }
}
