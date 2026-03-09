export type ToolCallRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AIResponse = {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: string;
  usage: Record<string, number>;
  reasoningContent?: string | null;
};

export abstract class AIProvider {
  protected apiKey?: string | null;
  protected apiBase?: string | null;

  constructor(apiKey?: string | null, apiBase?: string | null) {
    this.apiKey = apiKey ?? undefined;
    this.apiBase = apiBase ?? undefined;
  }

  abstract chat(params: {
    messages: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>>;
    model?: string | null;
    maxTokens?: number;
    temperature?: number;
    /** Per-call override for reasoning effort (o-series models only). Overrides the instance default. */
    reasoningEffort?: string | null;
  }): Promise<AIResponse>;

  /**
   * Streaming variant of chat(). Calls onDelta for each content token as it
   * arrives, then returns the full assembled AIResponse.
   * Default implementation falls back to chat() (no streaming).
   */
  async chatStream(
    params: Parameters<AIProvider["chat"]>[0],
    onDelta: (token: string) => void
  ): Promise<AIResponse> {
    const response = await this.chat(params);
    if (response.content) onDelta(response.content);
    return response;
  }

  abstract getDefaultModel(): string;
  abstract getUtilityModel(): string | null;

  isEnabled() {
    return this.apiKey && this.apiKey.length > 1;
  }
}