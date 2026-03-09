import crypto from "node:crypto";
 import type { SessionManager } from "../../session/manager.js";
import { Tool } from "./toolbase.js";
import { MessageBus } from "src/messagebus/queue.js";
import { OutboundMessage } from "src/messagebus/events.js";
 import { RiskLevel } from "../security.js";


/** Default number of sessions / messages returned when no `limit` is supplied. */
const DEFAULT_LIMIT = 20;
/** Default number of inline messages included in a sessions_list entry (0 = none). */
const DEFAULT_MESSAGE_LIMIT = 0;
/** Hard cap on inline messages per session entry in sessions_list. */
const MAX_MESSAGE_LIMIT = 20;
/** Maximum byte size of the JSON response returned by sessions_history. */
const HISTORY_MAX_BYTES = 80 * 1024;
/** Maximum character length of a single message's content before truncation. */
const HISTORY_TEXT_MAX_CHARS = 4000;

/** Coerces `value` to a non-negative integer, returning `fallback` on failure. */
const toInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
};

/**
 * Parses a `channel:chatId` session key into its components.
 * Returns `null` if the key is missing the colon separator or either part is empty.
 */
const parseSessionKey = (key: string): { channel: string; chatId: string } | null => {
  const trimmed = key.trim();
  if (!trimmed.includes(":")) {
    return null;
  }
  const [channel, chatId] = trimmed.split(":", 2);
  if (!channel || !chatId) {
    return null;
  }
  return { channel, chatId };
};

/**
 * Classifies a session key into a human-readable kind label.
 *
 * | Prefix / value      | Kind    |
 * |---------------------|---------|
 * | `cron:` / heartbeat | `cron`  |
 * | `hook:`             | `hook`  |
 * | `subagent:` / `node:` | `node` |
 * | `system:`           | `other` |
 * | anything else       | `main`  |
 */
const classifySessionKind = (key: string): string => {
  if (key.startsWith("cron:") || key === "heartbeat") {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("subagent:") || key.startsWith("node:")) {
    return "node";
  }
  if (key.startsWith("system:")) {
    return "other";
  }
  return "main";
};

/**
 * Truncates `text` to {@link HISTORY_TEXT_MAX_CHARS} characters, appending an
 * ellipsis marker when truncation occurs.
 */
const truncateHistoryText = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, HISTORY_TEXT_MAX_CHARS)}\n…(truncated)…`, truncated: true };
};

/**
 * Returns a copy of `msg` with its `content` field truncated to
 * {@link HISTORY_TEXT_MAX_CHARS} characters.
 */
const sanitizeHistoryMessage = (msg: { role: string; content: string; timestamp: string }) => {
  const entry = { ...msg };
  const res = truncateHistoryText(entry.content ?? "");
  return { message: { ...entry, content: res.text }, truncated: res.truncated };
};

/** Returns the UTF-8 byte length of the JSON serialisation of `value`. */
const jsonBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
};

/**
 * Ensures the serialised size of `items` does not exceed {@link HISTORY_MAX_BYTES}.
 *
 * If the array is too large:
 * 1. Returns only the last item if it alone fits within the limit.
 * 2. Otherwise returns a single placeholder message indicating the history was omitted.
 */
const enforceHistoryHardCap = (items: unknown[]): unknown[] => {
  const bytes = jsonBytes(items);
  if (bytes <= HISTORY_MAX_BYTES) {
    return items;
  }
  const last = items.at(-1);
  if (last && jsonBytes([last]) <= HISTORY_MAX_BYTES) {
    return [last];
  }
  return [{ role: "assistant", content: "[sessions_history omitted: message too large]" }];
};

/**
 * Normalises a timestamp value to a Unix millisecond number.
 * Accepts a numeric ms value or an ISO date string; returns `undefined` on failure.
 */
const toTimestamp = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

/**
 * Agent tool: `sessions_list`
 *
 * Lists available conversation sessions with their timestamps and optional
 * inline message previews. Supports filtering by session kind, recency, and
 * an upper count limit.
 */
export class SessionsListTool extends Tool {
  constructor(private sessions: SessionManager) {
    super();
  }

  get name(): string {
    return "sessions_list";
  }

  get description(): string {
    return "List available sessions with timestamps";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "Filter by session kinds (main/group/cron/hook/other)"
        },
        limit: { type: "integer", minimum: 1, description: "Maximum number of sessions to return" },
        activeMinutes: { type: "integer", minimum: 1, description: "Only include active sessions" },
        messageLimit: { type: "integer", minimum: 0, description: "Include last N messages (max 20)" }
      }
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const limit = toInt(params.limit, DEFAULT_LIMIT);
    const rawKinds = Array.isArray(params.kinds) ? params.kinds.map((k) => String(k).toLowerCase()) : [];
    const kinds = rawKinds.length ? new Set(rawKinds) : null;
    const activeMinutes = toInt(params.activeMinutes, 0);
    const messageLimit = Math.min(toInt(params.messageLimit, DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT);
    const now = Date.now();
    const sessions = this.sessions
      .listSessions()
      .sort((a, b) => (toTimestamp(b.updated_at) ?? 0) - (toTimestamp(a.updated_at) ?? 0))
      .filter((entry) => {
        if (activeMinutes > 0 && entry.updated_at) {
          const updated = Date.parse(String(entry.updated_at));
          if (Number.isFinite(updated) && now - updated > activeMinutes * 60 * 1000) {
            return false;
          }
        }
        if (kinds) {
          const kind = classifySessionKind(String(entry.key ?? ""));
          if (!kinds.has(kind)) {
            return false;
          }
        }
        return true;
      })
      .slice(0, limit)
      .map((entry) => {
        const key = String(entry.key ?? "");
        const kind = classifySessionKind(key);
        const parsed = parseSessionKey(key);
        const metadata = (entry.metadata as Record<string, unknown> | undefined) ?? {};
        const label =
          typeof metadata.label === "string"
            ? metadata.label
            : typeof metadata.session_label === "string"
              ? metadata.session_label
              : undefined;
        const displayName =
          typeof metadata.displayName === "string"
            ? metadata.displayName
            : typeof metadata.display_name === "string"
              ? metadata.display_name
              : undefined;
        const deliveryContext =
          metadata.deliveryContext && typeof metadata.deliveryContext === "object"
            ? (metadata.deliveryContext as Record<string, unknown>)
            : undefined;
        const updatedAt = toTimestamp(entry.updated_at);
        const createdAt = toTimestamp(entry.created_at);
        const base: Record<string, unknown> = {
          key,
          kind,
          channel: parsed?.channel,
          label,
          displayName,
          deliveryContext,
          updatedAt,
          createdAt,
          sessionId: key,
          lastChannel:
            typeof metadata.last_channel === "string"
              ? metadata.last_channel
              : parsed?.channel ?? undefined,
          lastTo:
            typeof metadata.last_to === "string" ? metadata.last_to : parsed?.chatId ?? undefined,
          lastAccountId: typeof metadata.last_account_id === "string" ? metadata.last_account_id : undefined,
          transcriptPath: entry.path
        };
        if (messageLimit > 0) {
          const session = this.sessions.getIfExists(key);
          if (session) {
            const filtered = session.messages.filter((msg) => msg.role !== "tool");
            const recent = filtered.slice(-messageLimit).map((msg) => ({
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp
            }));
            const sanitized = recent.map((msg) => sanitizeHistoryMessage(msg).message);
            base.messages = sanitized;
          }
        }
        return base;
      });
    return JSON.stringify({ sessions }, null, 2);
  }
}

/**
 * Agent tool: `sessions_history`
 *
 * Fetches recent messages from a specific session, identified by key, chatId
 * suffix, or metadata label. Applies per-message content truncation and a
 * hard byte-size cap on the overall response to keep token usage predictable.
 */
export class SessionsHistoryTool extends Tool {
  constructor(private sessions: SessionManager) {
    super();
  }

  get name(): string {
    return "sessions_history";
  }

  get description(): string {
    return "Fetch recent messages from a session";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "Session key in the format channel:chatId" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of messages to return" },
        includeTools: { type: "boolean", description: "Include tool messages" }
      },
      required: ["sessionKey"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const sessionKey = String(params.sessionKey ?? "").trim();
    if (!sessionKey) {
      return "Error: sessionKey is required";
    }
    const session = this.sessions.findSession(sessionKey);
    if (!session) {
      return `Error: session '${sessionKey}' not found`;
    }
    const limit = toInt(params.limit, DEFAULT_LIMIT);
    const includeTools = typeof params.includeTools === "boolean" ? params.includeTools : false;
    const filtered = includeTools ? session.messages : session.messages.filter((msg) => msg.role !== "tool");
    const recent = filtered.slice(-limit).map((msg) => ({
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp
    }));
    const sanitized = recent.map((msg) => sanitizeHistoryMessage(msg).message);
    const capped = enforceHistoryHardCap(sanitized);
    return JSON.stringify({ sessionKey, messages: capped }, null, 2);
  }
}

/**
 * Agent tool: `sessions_send`
 *
 * Sends a message to another active session via the message bus, enabling
 * cross-channel delivery (e.g. an agent replying to a Telegram user from a
 * Slack-initiated task). The sent message is also appended to the target
 * session's transcript and persisted immediately.
 *
 * Either `sessionKey` (exact `channel:chatId`) or `label` (metadata label)
 * must be provided — not both.
 */
export class SessionsSendTool extends Tool {
  constructor(
    private sessions: SessionManager,
    private bus: MessageBus
  ) {
    super();
  }

  get name(): string {
    return "sessions_send";
  }
  //send my boss a message .... from another context .. Security Manager: NO !
  get maxRisk(): RiskLevel { return RiskLevel.None; }

  get description(): string {
    return "Send a message to another session (cross-channel delivery)";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "Target session key in the format channel:chatId" },
        label: { type: "string", description: "Session label (if sessionKey not provided)" },
        agentId: { type: "string", description: "Optional agent id (unused in local runtime)" },
        message: { type: "string", description: "Message content to send" },
        timeoutSeconds: { type: "number", description: "Optional timeout in seconds" },
        content: { type: "string", description: "Alias for message" },
        replyTo: { type: "string", description: "Message ID to reply to" },
        silent: { type: "boolean", description: "Send without notification where supported" }
      },
      required: ["message"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const runId = crypto.randomUUID();
    const sessionKeyParam = String(params.sessionKey ?? "").trim();
    const labelParam = String(params.label ?? "").trim();
    if (sessionKeyParam && labelParam) {
      return JSON.stringify(
        { runId, status: "error", error: "Provide either sessionKey or label (not both)" },
        null,
        2
      );
    }
    const message = String(params.message ?? params.content ?? "");
    if (!message) {
      return JSON.stringify({ runId, status: "error", error: "message is required" }, null, 2);
    }
    const keyOrLabel = sessionKeyParam || labelParam;
    if (!keyOrLabel) {
      return JSON.stringify({ runId, status: "error", error: "sessionKey or label is required" }, null, 2);
    }
    const session = this.sessions.findSession(keyOrLabel);
    if (!session) {
      return JSON.stringify({ runId, status: "error", error: `no session found for '${keyOrLabel}'` }, null, 2);
    }
    const parsed = parseSessionKey(session.key);
    if (!parsed) {
      return JSON.stringify(
        { runId, status: "error", error: "sessionKey must be in the format channel:chatId" },
        null,
        2
      );
    }
    const replyTo = params.replyTo ? String(params.replyTo) : undefined;
    const silent = typeof params.silent === "boolean" ? params.silent : undefined;
    const outbound: OutboundMessage = {
      channel: parsed.channel,
      chatId: parsed.chatId,
      content: message,
      replyTo,
      media: [],
      metadata: silent !== undefined ? { silent } : {}
    };
    await this.bus.publishOutbound(outbound);

    this.sessions.addMessage(session, "assistant", message, { via: "sessions_send" });
    this.sessions.save(session);

    return JSON.stringify(
      { runId, status: "ok", sessionKey: `${parsed.channel}:${parsed.chatId}` },
      null,
      2
    );
  }
}