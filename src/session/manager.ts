import { Logger } from "src/utils/logger";
import { injectable, inject } from "tsyringe";
import { JsonlSessionStore, type SessionHeader } from "./store.js";

/**
 * A single message stored in a session transcript.
 *
 * Mirrors the OpenAI chat message format. Extra fields (e.g. `tool_calls`,
 * `tool_call_id`, `reasoning_content`) are carried transparently via the
 * index signature so the session layer stays format-agnostic.
 */
export type SessionMessage = {
  role: string;
  content: string;
  timestamp: string;
  [key: string]: unknown;
};

/**
 * Typed view of the well-known fields stored in session metadata.
 * The index signature allows arbitrary extra fields from plugins/channels.
 */
export type SessionMetadata = {
  label?: string;
  session_label?: string;
  last_channel?: string;
  last_to?: string;
  last_account_id?: string;
  last_message_id?: string;
  compact_summary?: string;
  memory_extracted_at?: string;
  displayName?: string;
  display_name?: string;
  deliveryContext?: unknown;
} & Record<string, unknown>;

/**
 * An in-memory conversation session.
 *
 * Sessions are keyed by `channel:chatId` (e.g. `"telegram:123456789"`) and
 * persisted as JSONL files on disk. The first line of each file is a metadata
 * record; subsequent lines are individual {@link SessionMessage} entries.
 */
export type Session = {
  /** Unique identifier — typically `channel:chatId`. */
  key: string;
  messages: SessionMessage[];
  createdAt: Date;
  updatedAt: Date;
  metadata: SessionMetadata;
};

// Re-export so callers that previously imported SessionHeader from manager still work.
export type { SessionHeader };

/**
 * Manages conversation sessions: in-memory cache + lifecycle.
 *
 * All disk I/O is delegated to {@link JsonlSessionStore}. This class is
 * responsible only for cache management, session creation, and the
 * message-history sanitisation needed before sending to the LLM.
 */
@injectable()
export class SessionManager {
  private store: JsonlSessionStore;
  private cache: Map<string, Session> = new Map();
  private logger = new Logger(SessionManager.name);

  constructor(@inject("workspace") _workspace: string) {
    this.store = new JsonlSessionStore();
    this.logger.debug("Init session Manager");
    this.logger.debug(`Session folder is ${this.store.getSessionsDir()}`);
  }

  getSessionFolder(): string {
    return this.store.getSessionsDir();
  }

  /**
   * Returns the cached session for `key`, loading it from disk if necessary.
   * Creates a new empty session when no persisted data exists.
   */
  getOrCreate(key: string): Session {
    return this.cache.get(key) ?? this.loadAndCache(key) ?? this.createEmpty(key);
  }

  /**
   * Returns the session for `key` if it exists in cache or on disk,
   * or `null` otherwise. Unlike {@link getOrCreate} this never creates.
   */
  getIfExists(key: string): Session | null {
    return this.cache.get(key) ?? this.loadAndCache(key);
  }

  /**
   * Finds a session by exact key, key suffix, or metadata label.
   *
   * Resolution order:
   * 1. Exact key match.
   * 2. Any session whose key ends with `:<keyOrLabel>` (chatId suffix).
   * 3. Any session whose `metadata.label` or `metadata.session_label` matches.
   */
  findSession(keyOrLabel: string): Session | null {
    const trimmed = keyOrLabel.trim();
    const direct = this.getIfExists(trimmed);
    if (direct) return direct;

    const match = this.store.listHeaders().find((h) => {
      if (h.key.endsWith(`:${trimmed}`)) return true;
      const label = h.metadata.label ?? h.metadata.session_label;
      return typeof label === "string" && label.trim() === trimmed;
    });

    return match ? this.getIfExists(match.key) : null;
  }

  /**
   * Appends a message to the session transcript and updates `updatedAt`.
   */
  addMessage(session: Session, role: string, content: string, extra: Record<string, unknown> = {}): void {
    session.messages.push({ role, content, timestamp: new Date().toISOString(), ...extra });
    session.updatedAt = new Date();
  }

  /**
   * Returns the session's message history formatted for the LLM API.
   *
   * Applies two sanitisation passes:
   * 1. **Leading orphan drop** — strips messages before the first `user` turn.
   * 2. **Incomplete tool-call drop** — truncates at the first `assistant`
   *    message whose tool calls are not immediately followed by all matching
   *    tool results. The truncation is persisted to `session.messages`.
   *
   * Only the fields understood by the LLM API are included in the output.
   */
  getHistory(session: Session, maxMessages = 50): Array<Record<string, unknown>> {
    let recent = session.messages.length > maxMessages
      ? session.messages.slice(-maxMessages)
      : session.messages;

    // Drop leading non-user messages.
    const firstUserIdx = recent.findIndex((m) => m.role === "user");
    if (firstUserIdx > 0) recent = recent.slice(firstUserIdx);

    // Truncate at the first orphaned tool call sequence.
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || (m.tool_calls as unknown[]).length === 0) continue;
      const expectedIds = new Set((m.tool_calls as Array<{ id: string }>).map((tc) => tc.id));
      const immediateResultIds = new Set<string>();
      for (let j = i + 1; j < recent.length && recent[j].role === "tool"; j++) {
        const id = recent[j].tool_call_id as string;
        if (typeof id === "string") immediateResultIds.add(id);
      }
      if ([...expectedIds].some((id) => !immediateResultIds.has(id))) {
        const cutIndex = session.messages.indexOf(recent[i] as SessionMessage);
        if (cutIndex !== -1) session.messages = session.messages.slice(0, cutIndex);
        recent = recent.slice(0, i);
        break;
      }
    }

    return recent.map((msg) => {
      // Normalize assistant+tool_calls messages: empty-string content should be
      // null so providers that reject "" (Anthropic compat, Gemini) don't error.
      const content = (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.content === "")
        ? null
        : msg.content;
      const entry: Record<string, unknown> = { role: msg.role, content };
      if (typeof msg.name === "string") entry.name = msg.name;
      if (typeof msg.tool_call_id === "string") entry.tool_call_id = msg.tool_call_id;
      if (Array.isArray(msg.tool_calls)) entry.tool_calls = msg.tool_calls;
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
        entry.reasoning_content = msg.reasoning_content;
      }
      return entry;
    });
  }

  /** Erases all messages from the session without touching its metadata. */
  clear(session: Session): void {
    session.messages = [];
    session.updatedAt = new Date();
  }

  /** Persists the session to disk and updates the cache. */
  save(session: Session): void {
    this.store.save(session);
    this.cache.set(session.key, session);
  }

  /** Removes a session from cache and deletes its file from disk. */
  delete(key: string): boolean {
    this.cache.delete(key);
    return this.store.delete(key);
  }

  /** Persists every cached session to disk. Called during graceful shutdown. */
  saveAll(): void {
    for (const session of this.cache.values()) this.save(session);
  }

  /** Removes a session from the in-memory cache without writing to disk. */
  discard(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Returns a lightweight summary of sessions active within the given window.
   * Checks the in-memory cache first, then falls back to disk headers.
   */
  listRecentSessions(hoursAgo: number): Array<{ key: string; lastChannel: string | null; lastTo: string | null; updatedAt: string }> {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    const result: Array<{ key: string; lastChannel: string | null; lastTo: string | null; updatedAt: string }> = [];
    const seen = new Set<string>();

    for (const session of this.cache.values()) {
      if (session.updatedAt >= cutoff) {
        seen.add(session.key);
        result.push({
          key: session.key,
          lastChannel: session.metadata.last_channel ?? null,
          lastTo: session.metadata.last_to ?? null,
          updatedAt: session.updatedAt.toISOString()
        });
      }
    }

    for (const h of this.store.listHeaders()) {
      if (seen.has(h.key)) continue;
      const updatedAt = new Date(h.updated_at);
      if (updatedAt >= cutoff) {
        result.push({
          key: h.key,
          lastChannel: (h.metadata.last_channel as string | undefined) ?? null,
          lastTo: (h.metadata.last_to as string | undefined) ?? null,
          updatedAt: updatedAt.toISOString()
        });
      }
    }

    return result;
  }

  /**
   * Returns lightweight metadata headers for all sessions on disk.
   * Only the first line of each file is read.
   */
  listSessions(): SessionHeader[] {
    return this.store.listHeaders();
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private loadAndCache(key: string): Session | null {
    const loaded = this.store.load(key);
    if (loaded) this.cache.set(key, loaded);
    return loaded;
  }

  private createEmpty(key: string): Session {
    const session: Session = { key, messages: [], createdAt: new Date(), updatedAt: new Date(), metadata: {} };
    this.cache.set(key, session);
    return session;
  }
}
