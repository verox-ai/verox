import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { AIProvider, AIResponse } from "./provider.js";
import { Logger } from "src/utils/logger.js";

export type OpenAICompatibleProviderOptions = {
    apiKey: string;
    apiBase?: string | null;
    defaultModel: string;
    utilityModel?: string | null;
    extraHeaders?: Record<string, string> | null;
    wireApi?: "auto" | "chat" | "responses" | null;
    /** When true, wraps system messages in a content-block array with cache_control.
     *  Supported by Anthropic's OpenAI-compatible endpoint. */
    promptCaching?: boolean;
    /**
     * Reasoning effort for o-series models (o1, o3, o4-mini, …).
     * Controls how many reasoning tokens the model uses:
     *   "low"    — fastest, fewest reasoning tokens, good for simple tasks
     *   "medium" — balanced (API default when omitted)
     *   "high"   — most thorough, slowest
     * Ignored for non-reasoning models.
     */
    reasoningEffort?: "low" | "medium" | "high" | null;
};

type ModelCapabilities = {
    /**
     * When set, temperature is always coerced to this value regardless of what
     * the caller requests. Applies to OpenAI reasoning models (o-series) and
     * gpt-5+ which only accept temperature=1.
     */
    fixedTemperature?: number;
    /**
     * True for o-series reasoning models that accept a `reasoning_effort`
     * parameter (o1, o1-mini, o3, o3-mini, o4-mini, …).
     */
    supportsReasoningEffort?: boolean;
};

/**
 * Infers model capabilities from the model identifier using family-level patterns.
 *
 * Note: the token-limit parameter name is API-path-specific, not model-specific:
 *   Chat Completions → always "max_completion_tokens"
 *   Responses API    → always "max_output_tokens"
 * Only temperature constraints and reasoning_effort support vary per model.
 */
function detectModelCapabilities(model: string): ModelCapabilities {
    const m = model.toLowerCase();
    // o-series reasoning models: o1, o1-mini, o3, o4-mini, o3-mini …
    if (/^o\d/.test(m)) return { fixedTemperature: 1, supportsReasoningEffort: true };
    // gpt-5 and future major versions
    if (/^gpt-[5-9]/.test(m)) return { fixedTemperature: 1 };
    // everything else: gpt-4, gpt-3.5, local/compatible providers
    return {};
}

/**
 * OpenAI-compatible API provider.
 *
 * Works with any provider that exposes an OpenAI-compatible REST API:
 * OpenAI, Anthropic (via their compat endpoint), Google Gemini, and others.
 */
export class OpenAICompatibleProvider extends AIProvider {
    private readonly client: OpenAI;
    private extraHeaders?: Record<string, string> | null;
    private wireApi: "auto" | "chat" | "responses";
    private defaultModel: string;
    private utilityModel: string | null;
    private promptCaching: boolean;
    private reasoningEffort: "low" | "medium" | "high" | null;
    private logger = new Logger(OpenAICompatibleProvider.name);

    constructor(options: OpenAICompatibleProviderOptions) {
        super(options.apiKey, options.apiBase);
        this.wireApi = options.wireApi ?? "auto";
        this.defaultModel = options.defaultModel;
        this.utilityModel = options.utilityModel ?? null;
        this.promptCaching = options.promptCaching ?? false;
        this.reasoningEffort = options.reasoningEffort ?? null;
        this.client = new OpenAI({
            apiKey: options.apiKey ?? undefined,
            baseURL: options.apiBase ?? undefined,
            defaultHeaders: options.extraHeaders ?? undefined
        });
        this.logger.debug(`Init Provider ${options.apiBase}`)
    }

    getDefaultModel(): string {
        return this.defaultModel;
    }

    getUtilityModel(): string | null {
        return this.utilityModel;
    }

    setDefaultModel(model: string): void {
        this.defaultModel = model;
    }

    /** Call the provider's /embeddings endpoint. Used by DocStore for local RAG. */
    async embed(texts: string[], model: string): Promise<number[][]> {
        const res = await this.client.embeddings.create({ model, input: texts });
        return res.data.map(d => d.embedding);
    }

    async chat(params: {
        messages: Array<Record<string, unknown>>;
        tools?: Array<Record<string, unknown>>;
        model?: string | null;
        maxTokens?: number;
        temperature?: number;
        reasoningEffort?: string | null;
    }): Promise<AIResponse> {
        if (this.wireApi === "chat") return this.chatCompletions(params);
        if (this.wireApi === "responses") return this.chatResponses(params);
        try {
            return await this.chatCompletions(params);
        } catch (error) {
            if (this.shouldFallbackToResponses(error)) return await this.chatResponses(params);
            throw error;
        }
    }

    override async chatStream(
        params: Parameters<OpenAICompatibleProvider["chat"]>[0],
        onDelta: (token: string) => void
    ): Promise<AIResponse> {
        // Responses API doesn't support streaming here — fall back to chat()
        if (this.wireApi === "responses") return this.chatStream_fallback(params, onDelta);
        try {
            return await this.chatCompletionsStream(params, onDelta);
        } catch (error) {
            if (this.shouldFallbackToResponses(error)) return this.chatStream_fallback(params, onDelta);
            throw error;
        }
    }

    private async chatStream_fallback(
        params: Parameters<OpenAICompatibleProvider["chat"]>[0],
        onDelta: (token: string) => void
    ): Promise<AIResponse> {
        const response = await this.chatResponses(params);
        if (response.content) onDelta(response.content);
        return response;
    }

    private async chatCompletionsStream(
        params: Parameters<OpenAICompatibleProvider["chat"]>[0],
        onDelta: (token: string) => void
    ): Promise<AIResponse> {
        const model = params.model ?? this.defaultModel;
        const caps = detectModelCapabilities(model);
        const temperature = caps.fixedTemperature ?? (params.temperature ?? 0);
        const maxTokens = params.maxTokens ?? 4096;
        const reasoningEffort = (params.reasoningEffort ?? this.reasoningEffort) || null;

        const sanitized = sanitizeMessages(params.messages);
        const messages = this.promptCaching
            ? sanitized.map((msg) =>
                msg.role === "system" && typeof msg.content === "string"
                    ? { ...msg, content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }] }
                    : msg
            )
            : sanitized;

        const body: any = {
            model,
            messages: messages as unknown as import("openai/resources/chat/completions").ChatCompletionMessageParam[],
            tools: params.tools as import("openai/resources/chat/completions").ChatCompletionTool[] | undefined,
            tool_choice: params.tools?.length ? "auto" : undefined,
            max_completion_tokens: maxTokens,
            stream: true,
            stream_options: { include_usage: true },
        };
        if (temperature > 0) body.temperature = temperature;
        if (reasoningEffort && caps.supportsReasoningEffort) body.reasoning_effort = reasoningEffort;

        this.logger.debug(`LLM Stream Call ${model}`);

        const stream = await this.client.chat.completions.create(body);

        let content = "";
        // tool_call_id → { name, arguments }
        const toolCallMap: Map<number, { id: string; name: string; args: string }> = new Map();
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let finishReason = "stop";

        for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            if (choice) {
                finishReason = choice.finish_reason ?? finishReason;
                const delta = choice.delta;
                if (delta.content) {
                    content += delta.content;
                    onDelta(delta.content);
                }
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index;
                        if (!toolCallMap.has(idx)) {
                            // Initialize with empty name/args — the append block below fills them in
                            toolCallMap.set(idx, { id: tc.id ?? "", name: "", args: "" });
                        }
                        const entry = toolCallMap.get(idx)!;
                        if (tc.id) entry.id = tc.id;
                        if (tc.function?.name) entry.name += tc.function.name;
                        if (tc.function?.arguments) entry.args += tc.function.arguments;
                    }
                }
            }
            if (chunk.usage) {
                usage = {
                    prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                    completion_tokens: chunk.usage.completion_tokens ?? 0,
                    total_tokens: chunk.usage.total_tokens ?? 0,
                };
            }
        }

        const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
        for (const [, tc] of [...toolCallMap.entries()].sort(([a], [b]) => a - b)) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.args || "{}"); } catch { args = {}; }
            toolCalls.push({ id: tc.id, name: tc.name, arguments: args });
        }

        this.logger.debug(`Stream complete — content length: ${content.length}, tool calls: ${toolCalls.length}`);
        return { content: content || null, toolCalls, finishReason, usage, reasoningContent: null };
    }

    private async chatCompletions(params: {
        messages: Array<Record<string, unknown>>;
        tools?: Array<Record<string, unknown>>;
        model?: string | null;
        maxTokens?: number;
        temperature?: number;
        reasoningEffort?: string | null;
    }): Promise<AIResponse> {
        const model = params.model ?? this.defaultModel;
        const caps = detectModelCapabilities(model);
        const temperature = caps.fixedTemperature ?? (params.temperature ?? 0);
        const maxTokens = params.maxTokens ?? 4096;
        // Per-call override takes precedence over instance default.
        const reasoningEffort = (params.reasoningEffort ?? this.reasoningEffort) || null;

        const sanitized = sanitizeMessages(params.messages);
        const messages = this.promptCaching
            ? sanitized.map((msg) =>
                msg.role === "system" && typeof msg.content === "string"
                    ? { ...msg, content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }] }
                    : msg
            )
            : sanitized;

        const body: any = {
            model,
            messages: messages as unknown as ChatCompletionMessageParam[],
            tools: params.tools as ChatCompletionTool[] | undefined,
            tool_choice: params.tools?.length ? "auto" : undefined,
            max_completion_tokens: maxTokens,  // Chat Completions API always uses this name
        }
        if (temperature > 0) {
            body.temperature = temperature;
        }
        if (reasoningEffort && caps.supportsReasoningEffort) {
            body.reasoning_effort = reasoningEffort;
        }

        this.logger.debug(`LLM Call ${model}, Temperature ${temperature} reasoningEffort ${reasoningEffort}`);

        try {
            const response = await this.client.chat.completions.create(body);

            const choice = response.choices[0];
            const message = choice?.message;

            const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
            if (message?.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    if (toolCall.type !== "function") continue;
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(toolCall.function.arguments ?? "{}"); } catch { args = {}; }
                    toolCalls.push({ id: toolCall.id, name: toolCall.function.name, arguments: args });
                }
            }
            const reasoningContent =
                (message as { reasoning_content?: string } | undefined)?.reasoning_content ??
                (message as { reasoning?: string } | undefined)?.reasoning ??
                null;

            return {
                content: message?.content ?? null,
                toolCalls,
                finishReason: choice?.finish_reason ?? "stop",
                usage: {
                    prompt_tokens: response.usage?.prompt_tokens ?? 0,
                    completion_tokens: response.usage?.completion_tokens ?? 0,
                    total_tokens: response.usage?.total_tokens ?? 0
                },
                reasoningContent
            };
        } catch (e) {
            this.logger.error(JSON.stringify(e));
            throw e;
        }
    }

    private async chatResponses(params: {
        messages: Array<Record<string, unknown>>;
        tools?: Array<Record<string, unknown>>;
        model?: string | null;
        maxTokens?: number;
        temperature?: number;
        reasoningEffort?: string | null;
    }): Promise<AIResponse> {
        const model = params.model ?? this.defaultModel;
        const caps = detectModelCapabilities(model);
        const temperature = caps.fixedTemperature ?? (params.temperature ?? 0);
        const maxTokens = params.maxTokens ?? 4096;
        const reasoningEffort = (params.reasoningEffort ?? this.reasoningEffort) || null;
        const input = this.toResponsesInput(params.messages);
        const body: Record<string, unknown> = {
            model,
            input: input as unknown,
            max_output_tokens: maxTokens,  // Responses API always uses this name
        };
        if (temperature > 0) body.temperature = temperature;
        if (params.tools?.length) body.tools = params.tools as unknown;
        if (reasoningEffort && caps.supportsReasoningEffort) {
            // Responses API uses a nested object: { reasoning: { effort: "low" | "medium" | "high" } }
            body.reasoning = { effort: reasoningEffort };
        }

        const base = this.apiBase ?? "https://api.openai.com/v1";
        const responseUrl = new URL("responses", base.endsWith("/") ? base : `${base}/`);
        const response = await fetch(responseUrl.toString(), {
            method: "POST",
            headers: {
                "Authorization": this.apiKey ? `Bearer ${this.apiKey}` : "",
                "Content-Type": "application/json",
                ...(this.extraHeaders ?? {})
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Responses API failed (${response.status}): ${text.slice(0, 200)}`);
        }

        const responseAny = (await response.json()) as {
            output?: Array<Record<string, unknown>>;
            usage?: Record<string, number>;
            status?: string;
        };
        const outputItems = responseAny.output ?? [];
        const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
        const contentParts: string[] = [];
        let reasoningContent: string | null = null;

        for (const item of outputItems) {
            const itemAny = item as Record<string, unknown>;
            if (itemAny.type === "reasoning" && Array.isArray(itemAny.summary)) {
                reasoningContent = (itemAny.summary as Array<Record<string, unknown> | string>)
                    .map((e) => (typeof e === "string" ? e : String((e as { text?: string }).text ?? "")))
                    .filter(Boolean).join("\n") || reasoningContent;
            }
            if (itemAny.type === "message" && Array.isArray(itemAny.content)) {
                for (const part of itemAny.content as Array<Record<string, unknown>>) {
                    if (part?.type === "output_text" || part?.type === "text") {
                        const text = String(part?.text ?? "");
                        if (text) contentParts.push(text);
                    }
                }
            }
            if (itemAny.type === "tool_call" || itemAny.type === "function_call") {
                const fn = itemAny.function as Record<string, unknown> | undefined;
                const name = String(itemAny.name ?? fn?.name ?? "");
                const rawArgs = itemAny.arguments ?? fn?.arguments ?? itemAny.input ?? fn?.input ?? "{}";
                let args: Record<string, unknown> = {};
                try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs as Record<string, unknown>); } catch { args = {}; }
                toolCalls.push({
                    id: String(itemAny.id ?? itemAny.call_id ?? `${name}-${toolCalls.length}`),
                    name,
                    arguments: args
                });
            }
        }

        const usage = responseAny.usage ?? {};
        return {
            content: contentParts.join("") || null,
            toolCalls,
            finishReason: responseAny.status ?? "stop",
            usage: {
                prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
                completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
                total_tokens: usage.total_tokens ?? 0
            },
            reasoningContent
        };
    }

    private shouldFallbackToResponses(error: unknown): boolean {
        const err = error as { status?: number; message?: string };
        const msg = err?.message ?? "";
        return err?.status === 404
            || (msg.includes("Cannot POST") && msg.includes("chat/completions"))
            || (msg.includes("chat/completions") && msg.includes("404"));
    }

    private toResponsesInput(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
        const input: Array<Record<string, unknown>> = [];
        for (const msg of messages) {
            const role = String(msg.role ?? "user");
            const content = msg.content;
            if (role === "tool") {
                input.push({
                    type: "function_call_output",
                    call_id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : "",
                    output: typeof content === "string" ? content
                        : Array.isArray(content) ? JSON.stringify(content)
                            : String(content ?? "")
                });
                continue;
            }
            const out: Record<string, unknown> = {
                role,
                content: Array.isArray(content) || typeof content === "string" ? content : String(content ?? "")
            };
            if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
                out.reasoning = msg.reasoning_content;
            }
            input.push(out);
            if (Array.isArray(msg.tool_calls)) {
                for (const call of msg.tool_calls as Array<Record<string, unknown>>) {
                    const fn = (call.function as Record<string, unknown> | undefined) ?? {};
                    const callId = String(call.id ?? call.call_id ?? "");
                    const name = String(fn.name ?? call.name ?? "");
                    const args = String(fn.arguments ?? call.arguments ?? "{}");
                    if (!callId || !name) continue;
                    input.push({ type: "function_call", name, arguments: args, call_id: callId });
                }
            }
        }
        return input;
    }
}

/**
 * Normalises a messages array before sending to the API.
 *
 * Catches common issues that cause opaque provider errors (400/429 no-body):
 * - `content: undefined`  → coerced to `null` (assistant) or `""` (tool/user)
 * - tool messages missing `tool_call_id` → dropped (would cause API rejection)
 * - tool messages with empty content → replaced with a placeholder string
 * - `reasoning_content` field stripped (provider-internal, not part of the wire format)
 */
function sanitizeMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
        const role = msg.role;
        if (typeof role !== "string" || !role) continue; // drop messages without a role

        // Tool result messages need a valid tool_call_id and non-empty content.
        if (role === "tool") {
            if (typeof msg.tool_call_id !== "string" || !msg.tool_call_id) continue;
            const content = typeof msg.content === "string" && msg.content
                ? msg.content
                : "[no result]";
            out.push({ role, tool_call_id: msg.tool_call_id, name: msg.name, content });
            continue;
        }

        // Assistant messages: content may be null when tool_calls are present.
        if (role === "assistant") {
            const content = msg.content === undefined ? null : msg.content;
            const entry: Record<string, unknown> = { role, content };
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) entry.tool_calls = msg.tool_calls;
            if (typeof msg.reasoning_content === "string" && msg.reasoning_content) entry.reasoning_content = msg.reasoning_content;
            out.push(entry);
            continue;
        }

        // System / user messages: content must be a non-null string or array.
        const content = msg.content ?? "";
        out.push({ ...msg, content });
    }
    return out;
}
