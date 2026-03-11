import { Tool, type ToolResult } from "./toolbase";
import { Logger } from "src/utils/logger.js";
import type { ToolProvider, AgentServices } from "./tool-provider.js";
import type { Config } from "src/types/schemas/schema.js";

/**
 * Holds all tools available to the LLM during a conversation.
 *
 * Tools are registered by name. The registry is consulted by `runLLMLoop`
 * to build the tool definitions sent to the provider and to dispatch tool
 * calls returned in the LLM response.
 *
 * ToolProviders can be registered via `addProvider()`. Calling `syncAllProviders()`
 * loads providers whose `isEnabled()` returns true, unloads those that became
 * disabled, and updates already-loaded providers (in-place via `onConfigChange`,
 * or by re-creating their tools when `onConfigChange` is absent).
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private logger = new Logger(ToolRegistry.name);

  private providers = new Map<string, ToolProvider>();
  /** Maps provider id → list of registered tool names, for clean unloading. */
  private providerToolNames = new Map<string, string[]>();
  /** Tools explicitly activated this turn via ToolSearchTool (reset each turn). */
  private activatedTools = new Set<string>();

  /** Adds a tool to the registry, replacing any existing tool with the same name. */
  register(tool: Tool): void {
    this.logger.debug("Register tool", { tool: tool.name });
    this.tools.set(tool.name, tool);
  }

  /** Removes a tool from the registry by name. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Returns tool definitions in the OpenAI function-calling wire format.
   *
   * Contextual tools (e.g. MCP) are included when:
   *   - They were explicitly activated this turn via `activate()`, OR
   *   - They share a keyword with the context string (keyword pre-filter), OR
   *   - No context string was provided (include all).
   *
   * Non-contextual tools are always included.
   */
  getDefinitions(context?: string): Array<Record<string, unknown>> {
    const contextTokens = context ? tokenize(context) : [];
    return Array.from(this.tools.values())
      .filter((tool) =>
        !tool.contextual ||
        this.activatedTools.has(tool.name) ||
        contextTokens.length === 0 ||
        isRelevant(tool, contextTokens)
      )
      .map((tool) => tool.toSchema());
  }

  /** Resets per-turn tool activations. Call at the start of each user turn. */
  resetActivations(): void {
    this.activatedTools.clear();
  }

  /**
   * Activates contextual tools by name, making them available for the current turn.
   * Called by ToolSearchTool when the LLM requests additional capabilities.
   * Returns the tools that were actually activated (existed and were contextual).
   */
  activate(names: string[]): Tool[] {
    const activated: Tool[] = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool?.contextual) {
        this.activatedTools.add(name);
        activated.push(tool);
      }
    }
    return activated;
  }

  /**
   * Searches all contextual tools not yet visible in the current turn.
   * Used by ToolSearchTool to let the LLM discover tools by description.
   */
  searchContextualTools(query: string): Tool[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    return Array.from(this.tools.values()).filter(
      (tool) => tool.contextual && isRelevant(tool, queryTokens)
    );
  }

  /**
   * Validates parameters and calls the named tool.
   * Returns a string result — on any error (unknown tool, bad params, thrown
   * exception) the error is returned as a string rather than thrown, so the
   * LLM loop can surface it to the model naturally.
   */
  async execute(name: string, params: Record<string, unknown>, toolCallId?: string): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Tool '${name}' not found`;
    }
    try {
      const errors = tool.validateParams(params);
      if (errors.length) {
        return `Error: Invalid parameters for tool '${name}': ${errors.join("; ")}`;
      }
      return await tool.execute(params, toolCallId);
    } catch (err) {
      return `Error executing ${name}: ${String(err)}`;
    }
  }

  /** Names of all registered tools (used to populate the system prompt). */
  get toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  // ── Provider management + context-relevance helpers ─────────────────────

  /** Registers a provider so it is considered by `syncAllProviders()`. */
  addProvider(provider: ToolProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Returns a registered provider by id, cast to the given type.
   * Useful for accessing provider-specific data (e.g. DocsProvider.docStore).
   */
  getProvider<T extends ToolProvider>(id: string): T | undefined {
    return this.providers.get(id) as T | undefined;
  }

  /**
   * Synchronises all registered providers against the current config:
   * - Newly enabled providers → createTools() + register each tool.
   * - Already enabled providers → onConfigChange() if defined, else createTools() + re-register.
   * - Newly disabled providers → unregister all their tools.
   */
  syncAllProviders(config: Config, services: AgentServices): void {
    for (const [id, provider] of this.providers) {
      const loadedNames = this.providerToolNames.get(id) ?? [];
      const isLoaded = loadedNames.length > 0;
      const shouldLoad = provider.isEnabled(config);

      if (shouldLoad && isLoaded) {
        if (provider.onConfigChange) {
          provider.onConfigChange(config);
        } else {
          // Re-create and overwrite existing tools by name (stateless providers).
          for (const tool of provider.createTools(config, services)) {
            this.register(tool);
          }
        }
      } else if (shouldLoad && !isLoaded) {
        const newTools = provider.createTools(config, services);
        const names: string[] = [];
        for (const tool of newTools) {
          this.register(tool);
          names.push(tool.name);
        }
        this.providerToolNames.set(id, names);
        this.logger.info(`Provider loaded: ${id} (${names.length} tools)`);
      } else if (!shouldLoad && isLoaded) {
        for (const name of loadedNames) {
          this.unregister(name);
        }
        this.providerToolNames.set(id, []);
        this.logger.info(`Provider unloaded: ${id}`);
      }
    }
  }
}

// ── Relevance helpers (module-level, only used by getDefinitions) ────────────

/** Splits text into lowercase tokens of ≥4 chars (splits on non-word chars and underscores). */
function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[\W_]+/).filter((t) => t.length >= 4))];
}

/**
 * Returns true if any context token is a substring of a tool token or vice-versa.
 * "lights" (context) matches "light" (tool) because "lights".includes("light").
 */
function isRelevant(tool: Tool, contextTokens: string[]): boolean {
  const toolTokens = tokenize(`${tool.name} ${tool.description}`);
  return contextTokens.some((ct) => toolTokens.some((tt) => tt.includes(ct) || ct.includes(tt)));
}