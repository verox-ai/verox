import { Tool } from "./toolbase.js";
import { ProviderManager } from "src/provider/manager.js";
import { Logger } from "src/utils/logger.js";

/**
 * Agent tool: `provider_list`
 *
 * Returns all configured LLM providers and which one is currently active.
 */
export class ProviderListTool extends Tool {
  constructor(private manager: ProviderManager) {
    super();
  }

  get name(): string {
    return "provider_list";
  }

  get description(): string {
    return "List all configured LLM providers and which one is currently active.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  async execute(_params: Record<string, unknown>): Promise<string> {
    const providers = this.manager.list();
    return JSON.stringify({ providers }, null, 2);
  }
}

/**
 * Agent tool: `provider_switch`
 *
 * Switches the active LLM provider at the user's request.
 * Always specify a model appropriate for the target provider.
 */
export class ProviderSwitchTool extends Tool {
  private logger = new Logger(ProviderSwitchTool.name);

  constructor(private manager: ProviderManager) {
    super();
  }

  get name(): string {
    return "provider_switch";
  }

  get description(): string {
    return (
      "Switch the active LLM provider. Use provider_list first to see what is configured. " +
      "Always pass a model appropriate for the target provider " +
      "(e.g. claude-opus-4-6 for anthropic, gpt-4o for openai, gemini-2.0-flash for gemini). " +
      "The switch takes effect immediately for all subsequent messages."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider name to switch to (e.g. anthropic, openai, gemini)"
        },
        model: {
          type: "string",
          description: "Model to use with the provider (e.g. claude-opus-4-6)"
        }
      },
      required: ["provider", "model"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const provider = String(params.provider ?? "").trim();
    const model = String(params.model ?? "").trim();
    if (!provider) return "Error: provider is required";
    if (!model) return "Error: model is required";

    this.logger.info("provider_switch", { provider, model });
    const ok = this.manager.switch(provider, model);
    if (!ok) {
      const available = this.manager.list().map((p) => p.name).join(", ");
      return `Error: provider '${provider}' is not configured. Available: ${available}`;
    }
    return `Switched to ${provider} (${model}).`;
  }
}
