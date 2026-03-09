import type { Session, SessionManager } from "src/session/manager.js";
import type { ProviderManager } from "src/provider/manager.js";
import type { MemoryService } from "src/memory/service.js";
import type { ContextManager } from "./context.js";
import { extractMemoriesFromMessages } from "./extraction.js";
import { stripOrphanedToolCalls } from "./llm-loop.js";
import { getPrompt } from "src/prompts/loader.js";
import { Logger } from "src/utils/logger.js";
import { PersonalityService } from "./personality.js";

const logger = new Logger("compaction");

export type CompactionConfig = {
  enabled?: boolean;
  thresholdTokens?: number;
  keepRecentMessages?: number;
};

export function needCompaction(params: {
  session: Session;
  sessions: SessionManager;
  context: ContextManager;
  config?: CompactionConfig;
}): boolean {
  const { session, sessions, context, config } = params;

  if (config?.enabled === false) return false;

  const thresholdTokens = config?.thresholdTokens ?? 6000;
  const keepRecentMessages = config?.keepRecentMessages ?? 10;

  const history = sessions.getHistory(session);
  const estimated = context.estimateTokens(history);

  if (estimated <= thresholdTokens) return false;
  if (history.length <= keepRecentMessages) return false;
  return true;
}

/**
 * Summarizes the older portion of a session's history when it grows past
 * `thresholdTokens`, keeping only the most recent `keepRecentMessages` turns.
 *
 * The generated summary is stored in `session.metadata.compact_summary` and
 * injected into the system prompt on subsequent turns.
 * Silently skips compaction if the LLM call fails.
 */
export async function compactSessionIfNeeded(params: {
  session: Session;
  sessions: SessionManager;
  context: ContextManager;
  providerManager: ProviderManager;
  memory: MemoryService;
  personalityService: PersonalityService;
  config?: CompactionConfig;
  /**
   * When true, bypasses the token-count threshold and compacts immediately.
   * Used by topic-shift detection to clear out stale context after a topic change
   * even when the session hasn't hit the normal size limit yet.
   * The keepRecentMessages guard still applies so we never discard the current exchange.
   */
  force?: boolean;
}): Promise<void> {
  const { session, sessions, context, providerManager, personalityService, memory, config, force } = params;

  if (config?.enabled === false) return;

  const thresholdTokens = config?.thresholdTokens ?? 6000;
  const keepRecentMessages = config?.keepRecentMessages ?? 10;

  const history = sessions.getHistory(session);
  const estimated = context.estimateTokens(history);

  if (!force && estimated <= thresholdTokens) return;
  if (history.length <= keepRecentMessages) return;
  if (force) {
    logger.debug("Force-compacting session after topic shift");
  } else {
    logger.debug(`Context window is running low ${thresholdTokens} < ${estimated}`);
  }

  const toSummarize = history.slice(0, history.length - keepRecentMessages);
  const existingSummary = session.metadata.compact_summary as string | undefined;

  const conversationText = toSummarize
    .map((m) => {
      const role = String(m.role);
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role}: ${content}`;
    })
    .join("\n");

  logger.debug("Consulting Dr. Freud");
  await personalityService.processConversation([conversationText]);

  logger.debug("Compacting");
  const compactionSystemPrompt =
    getPrompt("compaction") ??
    "Summarize the conversation below, preserving key facts, decisions, and user preferences. Be brief. Output only the summary text.";

  const summaryMessages: Record<string, unknown>[] = [
    { role: "system", content: compactionSystemPrompt },
    {
      role: "user",
      content: existingSummary
        ? `Existing summary:\n${existingSummary}\n\nNew conversation to integrate:\n${conversationText}`
        : `Summarize this conversation:\n${conversationText}`
    }
  ];

  try {
    const summaryResponse = await providerManager.get().chat({
      messages: summaryMessages,
      model: providerManager.getUtilityModel()
    });

    const summary = summaryResponse.content?.trim();
    if (!summary) return;
    logger.debug("Extracting Memories");

    // Extract durable facts from all unprocessed messages before trimming.
    await extractMemoriesFromMessages({
      session,
      sessions,
      providerManager,
      memoryStore: memory
    }).catch((err) =>
      logger.warn("Memory extraction during compaction failed", { error: String(err) })
    );

    session.metadata.compact_summary = summary;
    let trimmed = session.messages.slice(-keepRecentMessages);
    // Ensure we never start on an orphaned tool message — find the first user turn.
    const firstUserIdx = trimmed.findIndex((m) => m.role === "user");
    if (trimmed.length > 0 && firstUserIdx > 0) trimmed = trimmed.slice(firstUserIdx);

    // Pass 1: remove tool-result messages whose tool_call_id has no matching
    // tool_calls entry in any assistant message that survived the slice.
    // This happens when the assistant that issued the call was in the trimmed-away portion.
    const declaredCallIds = new Set<string>();
    for (const m of trimmed) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{ id?: string }>) {
          if (typeof tc.id === "string") declaredCallIds.add(tc.id);
        }
      }
    }
    const before = trimmed.length;
    trimmed = trimmed.filter((m) => {
      if (m.role !== "tool") return true;
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : null;
      const keep = id !== null && declaredCallIds.has(id);
      if (!keep) logger.debug("Removed orphaned tool result after compaction", { tool_call_id: id });
      return keep;
    });
    if (trimmed.length < before) {
      logger.info("Stripped orphaned tool results", { removed: before - trimmed.length });
    }

    // Pass 2: remove assistant tool_call groups whose results are now missing
    // (the reverse direction — handles partial slices mid-tool-call sequence).
    stripOrphanedToolCalls(trimmed as Array<Record<string, unknown>>);

    session.messages = trimmed;
    sessions.save(session);
    const currentTokens = context.estimateTokens(trimmed)
    logger.info("Session compacted", {
      session: session.key,
      removedMessages: history.length - keepRecentMessages,
      keptMessages: keepRecentMessages,
      estimatedTokensBefore: estimated,
      currentTokens
    });
  } catch (err) {
    logger.warn("Session compaction failed, continuing without compaction", { error: String(err) });
  }
}
