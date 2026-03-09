import type { ProviderManager } from "src/provider/manager.js";
import type { Session, SessionMessage } from "src/session/manager.js";
import type { SessionManager } from "src/session/manager.js";
import type { MemoryService } from "src/memory/service.js";
import { Logger } from "src/utils/logger.js";
import { getPrompt } from "src/prompts/loader.js";

const logger = new Logger("extraction");

/** Minimum number of non-tool messages required before attempting extraction. */
const MIN_MESSAGES_DEFAULT = 3;

/**
 * Extracts durable facts from a session's unprocessed messages and stores them
 * in the memory store.
 *
 * This function is the shared core of the two memory-learning triggers:
 * 1. **Compaction** — called after the LLM summarises old messages, before they
 *    are trimmed from the session. Extracts facts from all messages not yet
 *    covered by the `memory_extracted_at` watermark.
 * 2. **Memory cron job** — called periodically for stale sessions that never
 *    reached the compaction threshold.
 *
 * ### Watermark
 * `session.metadata.memory_extracted_at` is an ISO timestamp. Only messages
 * with a `timestamp` strictly after this value are processed. After a
 * successful (or empty) extraction the watermark is advanced to the timestamp
 * of the most recently processed message so messages are never extracted twice.
 *
 * ### First-time sessions
 * When `memory_extracted_at` is absent the session is brand-new to the
 * extraction system. Pass `initializeOnly = true` to set the watermark to the
 * current time without extracting anything (no-backfill policy).
 *
 * @returns The number of memory entries written, or 0 if nothing was extracted.
 */
export async function extractMemoriesFromMessages(params: {
  session: Session;
  sessions: SessionManager;
  providerManager: ProviderManager;
  memoryStore: MemoryService;
  minMessages?: number;
  /** When true, just initialise the watermark and return 0 without calling the LLM. */
  initializeOnly?: boolean;
}): Promise<number> {
  const {
    session,
    sessions,
    providerManager,
    memoryStore,
    minMessages = MIN_MESSAGES_DEFAULT,
    initializeOnly = false
  } = params;

  const watermark = session.metadata.memory_extracted_at as string | undefined;

  // On first encounter: set watermark to now and skip extraction (no backfill).
  if (!watermark) {
    session.metadata.memory_extracted_at = new Date().toISOString();
    sessions.save(session);
    return 0;
  }

  if (initializeOnly) return 0;

  // Compute the maximum risk level across ALL messages in the watermark range
  // (including tool result messages, which carry the risk_level annotation set
  // by the LLM loop). This propagates the taint from e.g. an imap_read call
  // into every memory item extracted from that session window.
  const maxRiskInRange = (session.messages as SessionMessage[]).reduce((max, m) => {
    const ts = m.timestamp as string | undefined;
    if (!ts || ts <= watermark) return max;
    const rl = typeof m.risk_level === "number" ? m.risk_level : 0;
    return Math.max(max, rl);
  }, 0);

  // Filter to non-tool messages after the watermark for the extraction prompt.
  const eligible = (session.messages as SessionMessage[]).filter((m) => {
    if (m.role === "tool") return false;
    const ts = m.timestamp as string | undefined;
    if (!ts) return false;
    return ts > watermark;
  });

  const nonToolCount = eligible.filter(
    (m) => m.role === "user" || m.role === "assistant"
  ).length;

  if (nonToolCount < minMessages) {
    // Not enough new content — still advance watermark if there are any eligible messages.
    advanceWatermark(session, sessions, eligible);
    return 0;
  }

  const conversationText = eligible
    .map((m) => {
      const role = String(m.role);
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role}: ${content}`;
    })
    .join("\n");

  const extractionSystemPrompt =
    getPrompt("memory-extraction") ??
    "You are a memory extraction assistant. Extract durable facts as a JSON array: " +
    '[{"content": "fact", "tags": ["tag"]}]. Output empty array [] if nothing to extract.';

  const extractionMessages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: extractionSystemPrompt
    },
    {
      role: "user",
      content: `Extract facts from this conversation:\n\n${conversationText}`
    }
  ];

  try {
    const response = await providerManager.get().chat({
      messages: extractionMessages,
      model: providerManager.getUtilityModel()
    });

    const raw = (response.content ?? "[]").trim();
    // Strip any accidental markdown code fences.
    const jsonStr = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const facts = JSON.parse(jsonStr) as Array<{ content: string; tags: string[] }>;

    if (!Array.isArray(facts) || facts.length === 0) {
      advanceWatermark(session, sessions, eligible);
      return 0;
    }

    let written = 0;
    for (const fact of facts) {
      const content = String(fact.content ?? "").trim();
      if (!content) continue;
      const tags = Array.isArray(fact.tags)
        ? fact.tags.map((t) => String(t).trim()).filter(Boolean)
        : ["facts"];
      memoryStore.appendWithSupersedes({
        content,
        tags,
        type: "compaction",
        origin_session: session.key,
        // Inherit the highest risk level seen in this session window.
        // High-risk entries are kept out of the system prompt but remain
        // recallable via memory_search (which raises the security context level).
        ...(maxRiskInRange > 0 ? { risk_level: maxRiskInRange } : {})
      });
      written++;
    }

    advanceWatermark(session, sessions, eligible);
    logger.info("Extracted memories", { session: session.key, count: written });
    return written;
  } catch (err) {
    logger.warn("Memory extraction failed", {
      session: session.key,
      error: String(err)
    });
    return 0;
  }
}

/** Advances `memory_extracted_at` to the latest timestamp among the processed messages. */
function advanceWatermark(
  session: Session,
  sessions: SessionManager,
  processed: Array<{ timestamp?: string }>
): void {
  const latest = processed
    .map((m) => m.timestamp)
    .filter((ts): ts is string => typeof ts === "string" && ts.length > 0)
    .sort()
    .at(-1);

  if (latest) {
    session.metadata.memory_extracted_at = latest;
    sessions.save(session);
  }
}
