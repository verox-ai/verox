import type { ProviderManager } from "src/provider/manager.js";
import type { ToolRegistry } from "./tools/registry.js";
import { Logger } from "src/utils/logger.js";
import { OutputSanitizer } from "./sanitizer.js";
import { type SecurityManager, RiskLevel, riskLevelFromString } from "./security.js";

const logger = new Logger("llm-loop");

export type LLMLoopParams = {
  messages: Array<Record<string, unknown>>;
  tools: ToolRegistry;
  providerManager: ProviderManager;
  maxIterations?: number;
  /** Called before each iteration. Return true to abort. */
  isCancelled?: () => boolean;
  /** Return steering messages to inject at the start of each iteration. */
  drainSteering?: () => string[];
  /**
   * Called after every provider `chat()` response with the token counts reported
   * by the API. Use this to accumulate usage for cost tracking.
   * `model` is the default model of the active provider at call time.
   */
  onUsage?: (promptTokens: number, completionTokens: number, model: string) => void;
  /**
   * Called when the assistant responds with tool calls.
   * Use this for session persistence — the loop has already appended the
   * assistant message to `messages`.
   */
  onAssistantMessage?: (
    content: string | null,
    toolCalls: Array<Record<string, unknown>>,
    reasoningContent: string | null
  ) => void;
  /**
   * Called after each tool result is appended to `messages`.
   * Use this for session persistence.
   * `riskLevel` is the effective output risk of the tool call — the maximum of
   * the tool's static `outputRisk`, any config override, forced unsigned-skill
   * risk, and dynamic risk reported by `tool.getLastExecuteRisk()`. Storing it
   * on the session message lets the memory extraction pipeline propagate taint
   * into extracted memory items so high-risk facts are kept out of future prompts.
   */
  onToolResult?: (callId: string, toolName: string, result: string, riskLevel?: number) => void;
  /**
   * Called when a 400 orphaned-tool-call error is caught and the in-flight
   * `messages` array has already been stripped. Use this to strip and persist
   * any external message store (e.g. session). The loop retries once.
   */
  onOrphanedToolCallError?: () => void;
  /** Called just before a tool is executed. Use to surface progress to the user. */
  onToolCall?: (toolName: string) => void;
  /**
   * Called for each streamed content token from the provider.
   * When provided the loop uses chatStream() instead of chat() so the caller
   * receives tokens as they arrive rather than waiting for the full response.
   */
  onTokenDelta?: (token: string) => void;
  /**
   * When provided, every tool call is checked against the current context risk
   * level before execution. Blocked calls are surfaced to the LLM as a
   * SECURITY_HOLD message asking it to escalate to the user.
   */
  securityManager?: SecurityManager;
  /**
   * Per-tool risk overrides sourced from `tools.security` in config.
   * Keys are tool names; values can override `maxRisk` and/or `outputRisk`.
   */
  securityOverrides?: Record<string, { maxRisk?: string; outputRisk?: string }>;
  /**
   * Per-skill risk overrides sourced from `tools.skillSecurity` in config.
   * Keys are skill names (first word of the exec command). Overrides exec's
   * default `maxRisk=None` for individual skills.
   */
  skillSecurityOverrides?: Record<string, { maxRisk?: string; outputRisk?: string }>;
  /**
   * Returns the manifest signing status for a skill command:
   *   true      — signed and hash matches (trusted)
   *   false     — in manifest but hash mismatch (tampered; exec already blocked it)
   *   undefined — not in manifest (unsigned)
   * Unsigned and tampered skills always produce High output risk regardless of
   * skillSecurity config, because their content has not been audited.
   */
  isSkillSigned?: (command: string) => boolean | undefined;
  /**
   * Ordered list of reasoning effort levels to use as the loop progresses.
   * The loop distributes iterations evenly across levels, escalating as
   * the iteration count rises. E.g. ["low", "medium", "high"] with
   * maxIterations=20 → iterations 0-6 use "low", 7-13 "medium", 14-19 "high".
   *
   * When omitted the provider's configured reasoningEffort is used for every call.
   */
  reasoningEffortLevels?: string[];
  /**
   * The user's initial message for this turn, used to filter contextual tools
   * (e.g. MCP tools) by keyword relevance. When provided, only tools whose
   * name/description share a keyword with this text are included in the request.
   * Core tools are always included regardless of this value.
   */
  toolContext?: string;
  /**
   * Tool names approved by the active workflow for this session.
   * Tools in this set bypass the maxRisk security check — the user has
   * explicitly confirmed the multi-step plan that uses them.
   */
  workflowApprovedTools?: Set<string>;
};

/**
 * Core LLM ↔ tool execution loop shared by Agent and SubagentManager.
 *
 * Each iteration sends `messages` to the active provider. If the response
 * contains tool calls, each tool is executed and its result is appended to
 * `messages` (mutated in place). The loop continues until the LLM produces a
 * plain-text response (no tool calls) or `maxIterations` is reached.
 *
 * On a 400 "orphaned tool_calls" error the in-flight messages are stripped and
 * the request is retried once. `onOrphanedToolCallError` is invoked so callers
 * can mirror the strip to any persistent store.
 *
 * @returns The final text content from the LLM, or `null` if the loop
 *   exhausted `maxIterations` or was cancelled.
 */
export async function runLLMLoop(params: LLMLoopParams): Promise<string | null> {
  const {
    messages,
    tools,
    providerManager,
    maxIterations = 20,
    isCancelled,
    drainSteering,
    onUsage,
    onAssistantMessage,
    onToolResult,
    onOrphanedToolCallError,
    onToolCall,
    onTokenDelta,
    securityManager,
    securityOverrides,
    skillSecurityOverrides,
    isSkillSigned,
    reasoningEffortLevels,
    toolContext,
    workflowApprovedTools
  } = params;

  let cleanedOnce = false;

  for (let i = 0; i < maxIterations; i++) {
    if (isCancelled?.()) return null;

    for (const note of drainSteering?.() ?? []) {
      messages.push({ role: "user", content: note });
    }

    // Compute the reasoning effort for this iteration.
    // When reasoningEffortLevels is set, distribute iterations evenly across levels.
    // e.g. ["low","medium","high"] with maxIterations=20 → 0-6=low, 7-13=medium, 14-19=high.
    const currentEffort = reasoningEffortLevels?.length
      ? (() => {
          const levelIndex = Math.min(
            Math.floor(i / Math.ceil(maxIterations / reasoningEffortLevels.length)),
            reasoningEffortLevels.length - 1
          );
          if (levelIndex > 0 && i === Math.ceil(maxIterations / reasoningEffortLevels.length) * levelIndex) {
            logger.debug(`Escalating reasoning effort → ${reasoningEffortLevels[levelIndex]} (iteration ${i})`);
          }
          return reasoningEffortLevels[levelIndex];
        })()
      : undefined;

    let response;
    try {
      const provider = providerManager.get();
      const chatParams = { messages, tools: tools.getDefinitions(toolContext), reasoningEffort: currentEffort };
      response = onTokenDelta
        ? await provider.chatStream(chatParams, onTokenDelta)
        : await provider.chat(chatParams);
    } catch (err) {
      if (!cleanedOnce && isOrphanedToolCallError(err)) {
        cleanedOnce = true;
        stripOrphanedToolCalls(messages);
        onOrphanedToolCallError?.();
        logger.warn("Stripped orphaned tool_calls, retrying");
        i--; // don't count the retry as an iteration
        continue;
      }
      throw err;
    }

    if (onUsage && response.usage) {
      onUsage(
        response.usage.prompt_tokens ?? 0,
        response.usage.completion_tokens ?? 0,
        providerManager.get().getDefaultModel()
      );
    }

    if (!response.toolCalls.length) {
      return response.content;
    }

    // Format tool calls into the wire format expected by the provider.
    const toolCallDicts = response.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }));

    // Append the assistant message. Use null (not "") when there is no text
    // content alongside tool calls — several providers reject the empty string.
    const assistantMsg: Record<string, unknown> = { role: "assistant", content: response.content ?? null };
    if (toolCallDicts.length) assistantMsg.tool_calls = toolCallDicts;
    if (response.reasoningContent) assistantMsg.reasoning_content = response.reasoningContent;
    messages.push(assistantMsg);

    onAssistantMessage?.(response.content, toolCallDicts, response.reasoningContent ?? null);

    // Execute each tool and append the result.
    // Tools flagged `parallel=true` are grouped and run concurrently within
    // a batch; sequential tools (the default) interrupt any pending parallel
    // batch before running. Security checks still run in declaration order
    // so risk state accumulates correctly before each check.
    const pendingParallel: Array<{
      call: (typeof response.toolCalls)[0];
      resultPromise: Promise<import("./tools/toolbase.js").ToolResult>;
      effectiveOutRisk: RiskLevel;
      blocked: boolean;
      holdMsg?: string;
    }> = [];

    const flushParallel = async () => {
      if (!pendingParallel.length) return;
      const settled = await Promise.all(pendingParallel.map(p =>
        p.blocked ? Promise.resolve(null) : p.resultPromise.then(r => r)
      ));
      for (let idx = 0; idx < pendingParallel.length; idx++) {
        const p = pendingParallel[idx];
        if (p.blocked) {
          messages.push({ role: "tool", tool_call_id: p.call.id, name: p.call.name, content: p.holdMsg! });
          onToolResult?.(p.call.id, p.call.name, p.holdMsg!);
          continue;
        }
        const result = settled[idx]!;
        const tool = tools.get(p.call.name);
        if (tool && securityManager) securityManager.recordOutput(tool, p.effectiveOutRisk);
        let messageContent: unknown;
        let resultForStorage: string;
        if (typeof result === "string") {
          const sanitizer = new OutputSanitizer();
          const scan = sanitizer.sanitize(result);
          if (!scan.isSafe) logger.warn(`Password leak in tool ${p.call.name}`);
          messageContent = scan.sanitizedText;
          resultForStorage = result;
        } else {
          messageContent = result;
          resultForStorage = JSON.stringify(result);
        }
        messages.push({ role: "tool", tool_call_id: p.call.id, name: p.call.name, content: messageContent });
        onToolResult?.(p.call.id, p.call.name, resultForStorage, p.effectiveOutRisk);
      }
      pendingParallel.length = 0;
    };

    for (const call of response.toolCalls) {
      // Security check: block high-risk tools when the context has been
      // contaminated by external content (email body, web pages, etc.).
      if (securityManager) {
        const tool = tools.get(call.name);
        if (tool) {
          // For exec, check if the command resolves to a known skill and apply
          // per-skill overrides before falling back to the tool-level override.
          let cfg = securityOverrides?.[call.name];
          let skillVerified = false;
          if (call.name === "exec" && typeof call.arguments?.command === "string") {
            const skillName = call.arguments.command.trim().split(/\s+/)[0] ?? "";
            if (skillName) {
              if (skillSecurityOverrides?.[skillName]) {
                cfg = skillSecurityOverrides[skillName];
              }
              // Manifest-verified skills can chain after another verified skill result
              // (context = Low). This allows search → fetch sequences within the same
              // user turn. Raw commands and unsigned skills still require context = None.
              if (isSkillSigned?.(call.arguments.command as string) === true) {
                skillVerified = true;
              }
            }
          }
          const maxRisk = cfg?.maxRisk !== undefined
            ? riskLevelFromString(cfg.maxRisk)
            : skillVerified ? RiskLevel.Low : undefined;
          // Workflow-approved tools bypass maxRisk — the user explicitly confirmed
          // the plan that uses them. The outputRisk still applies so context taint
          // accumulates normally, protecting exec/spawn which have maxRisk=None.
          const workflowApproved = workflowApprovedTools?.has(call.name) ?? false;
          const { allowed } = workflowApproved ? { allowed: true } : securityManager.check(tool, maxRisk);
          if (!allowed) {
            const levelName = RiskLevel[securityManager.level];
            const holdMsg = `[SECURITY_HOLD] Tool "${call.name}" was blocked — it requires a trusted context`
              + ` but the current context risk level is ${levelName} due to previously consumed external content.`
              + ` Params: ${JSON.stringify(call.arguments)}.`
              + ` Please tell the user exactly what you wanted to do and ask them to confirm.`;
            logger.warn(`Security hold: ${call.name} blocked at context level ${levelName}`);
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: holdMsg });
            onToolResult?.(call.id, call.name, holdMsg);
            continue;
          }
        }
      }

      // Helper: compute effectiveOutRisk for a call (does not record it yet).
      const computeOutRisk = (callName: string, callArgs: Record<string, unknown>): RiskLevel => {
        const tool = tools.get(callName);
        if (!tool) return RiskLevel.None;
        let cfg = securityOverrides?.[callName];
        let forcedOutRisk: RiskLevel | undefined;
        if (callName === "exec" && typeof callArgs?.command === "string") {
          const command = (callArgs.command as string).trim();
          const skillName = command.split(/\s+/)[0] ?? "";
          if (skillName && skillSecurityOverrides?.[skillName]) cfg = skillSecurityOverrides[skillName];
          if (isSkillSigned && skillName) {
            const signed = isSkillSigned(command);
            if (signed !== true) forcedOutRisk = RiskLevel.High;
            else if (cfg?.outputRisk === undefined) forcedOutRisk = RiskLevel.Low;
          }
        }
        const configOutRisk = forcedOutRisk ?? (cfg?.outputRisk !== undefined ? riskLevelFromString(cfg.outputRisk) : undefined);
        const dynamicRisk = tool.getLastExecuteRisk();
        const baseRisk = configOutRisk ?? tool.outputRisk;
        return dynamicRisk !== undefined ? Math.max(dynamicRisk, baseRisk) as RiskLevel : baseRisk;
      };

      const tool = tools.get(call.name);
      const isParallel = tool?.parallel ?? false;

      if (!isParallel) {
        // Sequential: flush any pending parallel tasks first, then run inline.
        await flushParallel();
        logger.debug(`Tool call: ${call.name}`, { args: JSON.stringify(call.arguments).slice(0, 120) });
        onToolCall?.(call.name);
        const result = await tools.execute(call.name, call.arguments, call.id);
        const effectiveOutRisk = computeOutRisk(call.name, call.arguments);
        if (tool && securityManager) securityManager.recordOutput(tool, effectiveOutRisk);

        let messageContent: unknown;
        let resultForStorage: string;
        if (typeof result === "string") {
          const sanitizer = new OutputSanitizer();
          const scan = sanitizer.sanitize(result);
          if (!scan.isSafe) logger.warn(`Looks like the tool call leaked some passwords ${call.name} ${JSON.stringify(call.arguments)}`);
          messageContent = scan.sanitizedText;
          resultForStorage = result;
        } else {
          messageContent = result;
          resultForStorage = JSON.stringify(result);
        }
        messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: messageContent });
        onToolResult?.(call.id, call.name, resultForStorage, effectiveOutRisk);
      } else {
        // Parallel: start execution now, collect result later in flushParallel.
        logger.debug(`Tool call (parallel): ${call.name}`, { args: JSON.stringify(call.arguments).slice(0, 120) });
        onToolCall?.(call.name);
        const effectiveOutRisk = computeOutRisk(call.name, call.arguments);
        // Pre-record output risk so subsequent security checks in this batch see the raised level.
        if (tool && securityManager) securityManager.recordOutput(tool, effectiveOutRisk);
        pendingParallel.push({
          call,
          resultPromise: tools.execute(call.name, call.arguments, call.id),
          effectiveOutRisk,
          blocked: false,
        });
      }
    }

    // Flush any remaining parallel tasks at end of the tool batch.
    await flushParallel();

    // After all tools in this iteration have been executed, decay the context
    // risk level by one step (High → Low). The LLM has now processed the
    // tainted data and generated its own response — that response is a
    // semantic checkpoint, not raw external content. This lets verified skills
    // (maxRisk=Low) execute in the next iteration while raw exec (maxRisk=None)
    // remains blocked.
    securityManager?.decay();
  }

  return null;
}

/**
 * Removes the first assistant message whose tool_calls are not immediately
 * followed by complete matching tool result messages, plus everything after it.
 * Mutates the array in place.
 */
export function stripOrphanedToolCalls(messages: Array<Record<string, unknown>>): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || (m.tool_calls as unknown[]).length === 0) continue;
    const expectedIds = new Set((m.tool_calls as Array<{ id: string }>).map((tc) => tc.id));
    const immediateResultIds = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
      const id = messages[j].tool_call_id as string;
      if (typeof id === "string") immediateResultIds.add(id);
    }
    if ([...expectedIds].some((id) => !immediateResultIds.has(id))) {
      messages.splice(i);
      return;
    }
  }
}

function isOrphanedToolCallError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 400 && typeof e?.message === "string" && e.message.includes("tool_calls");
}
