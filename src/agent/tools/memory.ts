import { MemoryService, SemanticMemoryType } from "src/memory/service.js";
import { Tool } from "./toolbase";
import { Logger } from "src/utils/logger.js";
import { RiskLevel } from "../security.js";

/** Starter taxonomy surfaced in tool descriptions to keep tags consistent. */
const SUGGESTED_TAGS = [
  "preferences",
  "decisions",
  "people",
  "tasks",
  "technical",
  "facts",
  "reminders",
  "billing",
  "config",
  "project",
  "credentials",
  "pin"
];

const SEMANTIC_TYPES: SemanticMemoryType[] = [
  "event", "goal", "project", "preference",
  "constraint", "identity", "relationship", "fact"
];

/**
 * Agent tool: `memory_write`
 *
 * Saves a durable fact to long-term memory with one or more topical tags.
 * Use the `pin` tag for critical facts that should always appear in the
 * system prompt (use sparingly — most facts should not be pinned).
 * Use `supersedes` to replace an outdated entry by its numeric ID.
 */
export class MemoryWriteTool extends Tool {
  private logger = new Logger(MemoryWriteTool.name);

  constructor(private store: MemoryService) {
    super();
  }

  get name(): string {
    return "memory_write";
  }

  get description(): string {
    const isoToday = new Date().toISOString().slice(0, 10);
    return (
      `Save a durable fact to long-term memory. ` +
      `Call this proactively — do not wait for the user to say "remember". ` +
      `Write immediately when you learn: a preference, a decision, a person's name or role, ` +
      `a project name, a deadline, a technical choice, a system detail, or any fact likely ` +
      `to matter in a future conversation. One focused fact per call. ` +
      `IMPORTANT — absolute dates only: today is ${isoToday}. Never write relative time expressions ` +
      `such as "today", "yesterday", "tomorrow", "last week", "next Monday", or "recently". ` +
      `Always replace them with an ISO date (YYYY-MM-DD). ` +
      `Example: instead of "Shipment picked up today" write "Shipment picked up on ${isoToday}". ` +
      `If the exact date is unknown, omit it entirely. ` +
      `Duplicates are detected automatically: near-identical entries are auto-superseded; ` +
      `if the response contains similar_entries, use supersedes to update one instead of creating a new entry. ` +
      `Use supersedes to replace an outdated entry by its numeric ID. ` +
      `Suggested tags: ${SUGGESTED_TAGS.join(", ")}.`
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact to remember" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: `Tags categorising this entry. Suggested: ${SUGGESTED_TAGS.join(", ")}`
        },
        memory_type: {
          type: "string",
          enum: SEMANTIC_TYPES,
          description: "Semantic classification of what this memory represents. Pick the closest match: event (something that happened), goal (desired outcome), project (ongoing work), preference (user likes/dislikes), constraint (hard rule or limit), identity (who the user is), relationship (person or entity connection), fact (general knowledge)."
        },
        supersedes: {
          type: "number",
          description: "Numeric ID of an older entry this fact replaces (optional)"
        }
      },
      required: ["content", "tags"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const content = String(params.content ?? "").trim();
    if (!content) return "Error: content is required";

    // Reject entries that contain relative date words — they will age badly.
    const RELATIVE_DATE_PATTERN = /\b(today|yesterday|tomorrow|last\s+week|next\s+week|last\s+month|next\s+month|this\s+week|this\s+month|recently|soon|just\s+now|earlier\s+today|this\s+morning|this\s+afternoon|this\s+evening|tonight)\b/i;
    if (RELATIVE_DATE_PATTERN.test(content)) {
      const isoToday = new Date().toISOString().slice(0, 10);
      return `Error: memory content contains a relative date expression. Relative dates become meaningless over time. Replace it with an absolute ISO date. Today is ${isoToday}. Rewrite the content using the actual date and call memory_write again.`;
    }

    const rawTags = Array.isArray(params.tags)
      ? params.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
    if (!rawTags.length) return "Error: at least one tag is required";

    const memory_type = SEMANTIC_TYPES.includes(params.memory_type as SemanticMemoryType)
      ? (params.memory_type as SemanticMemoryType)
      : undefined;

    // Allow explicit caller-supplied supersedes; dedup may also set one below.
    let supersedes = params.supersedes != null ? Number(params.supersedes) : undefined;

    // ── Duplicate detection ───────────────────────────────────────────────────
    // Run similarity check unless the caller already supplied supersedes
    // (they know what they're updating).
    let autoSupersededId: number | undefined;
    const similar = supersedes == null ? this.store.findSimilarEntries(content, 5) : [];

    // >= 85 %: same fact, different wording — automatically supersede the old entry.
    const highMatch = similar.find((s) => s.similarity >= 0.85);
    if (highMatch) {
      supersedes = highMatch.entry.id;
      autoSupersededId = highMatch.entry.id;
      this.logger.debug("memory_write: auto-superseding near-duplicate", {
        supersedes: highMatch.entry.id,
        similarity: highMatch.similarity
      });
    }

    // protected is intentionally NOT exposed — only humans can set it via CLI.
    this.logger.debug("memory_write", { tags: rawTags, memory_type, supersedes });
    const entry = this.store.append({ content, tags: rawTags, type: "manual", supersedes, memory_type });

    // Build response — include dedup metadata so the LLM understands what happened.
    const result: Record<string, unknown> = {
      id: entry.id,
      content: entry.content,
      tags: entry.tags,
      created_at: entry.created_at
    };

    if (autoSupersededId != null) {
      result.auto_superseded = autoSupersededId;
      result.note = "A near-identical entry was automatically superseded.";
    } else {
      // 60–85 %: related entries — surface them so the LLM can decide to supersede
      const moderate = similar.filter((s) => s.similarity >= 0.6);
      if (moderate.length) {
        result.similar_entries = moderate.map((s) => ({
          id: s.entry.id,
          similarity_pct: Math.round(s.similarity * 100),
          content: s.entry.content
        }));
        result.note = "Similar entries found. If this updates one of them, retry with supersedes:<id>.";
      }
    }

    return JSON.stringify(result, null, 2);
  }
}

/**
 * Agent tool: `memory_search`
 *
 * Searches long-term memory by text and/or tags. Run this before answering
 * questions about prior work, preferences, people, or past decisions.
 */
export class MemorySearchTool extends Tool {
  private logger = new Logger(MemorySearchTool.name);

  constructor(private store: MemoryService) {
    super();
  }

  get name(): string {
    return "memory_search";
  }

  get description(): string {
    return (
      "Search long-term memory by text and/or tags. " +
      "Run this proactively when any topic, project, or person is mentioned that could have prior history — " +
      "not only when the user explicitly asks. " +
      "The system prompt only shows recent entries; older or specific facts require an explicit search. " +
      "Query tips: use short keywords (e.g. 'pricing', 'token cost') rather than long phrases — " +
      "multi-word queries match any entry containing at least one keyword. " +
      "Tags are optional; omit them for broader recall. " +
      "If unsure what tags exist, call memory_list_tags first and use those exact tag names."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for (optional if tags or memory_type supplied)"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to entries with any of these tags (OR match). Use memory_list_tags to discover available tags."
        },
        memory_type: {
          type: "string",
          enum: SEMANTIC_TYPES,
          description: "Filter by semantic type. Useful for broad recall: e.g. 'preference' to find all user preferences, 'constraint' for hard rules, 'fact' for stored knowledge."
        },
        limit: {
          type: "integer",
          description: "Max results per page (default: 20, max: 100)."
        },
        page: {
          type: "integer",
          description: "Page number, 1-based (default: 1). Check total_pages in the response to know if more pages exist."
        }
      }
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    this.logger.debug(`execute ${JSON.stringify(params)}`);
    this._lastExecuteRisk = undefined; // reset before each call
    const query = params.query ? String(params.query).trim() : undefined;
    const tags = Array.isArray(params.tags)
      ? params.tags.map((t) => String(t).trim()).filter(Boolean)
      : undefined;
    const memory_type = SEMANTIC_TYPES.includes(params.memory_type as SemanticMemoryType)
      ? (params.memory_type as SemanticMemoryType)
      : undefined;
    const limit  = Math.min(typeof params.limit === "number" ? params.limit : 20, 100);
    const page   = Math.max(typeof params.page  === "number" ? params.page  : 1, 1);
    const offset = (page - 1) * limit;

    this.logger.debug("memory_search", { query, tags, memory_type, limit, page });
    const results = this.store.searchSmart(query, tags, true, 0, memory_type, limit, offset);
    const total   = this.store.countSearchSmart(query, tags, true, 0, memory_type);
    this.logger.debug(`result ${results.length} of ${total}`);

    // If any recalled entry was sourced from a high-risk session turn, raise the
    // dynamic output risk so the SecurityManager can gate subsequent tool calls.
    const maxRisk = results.reduce((max, r) => Math.max(max, r.risk_level ?? 0), 0);
    if (maxRisk > RiskLevel.None) {
      this._lastExecuteRisk = maxRisk as RiskLevel;
      this.logger.debug(`memory_search: recalled ${results.length} entries, max risk_level=${maxRisk}`);
    }

    return JSON.stringify({
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      results
    }, null, 2);
  }
}

/**
 * Agent tool: `memory_list_tags`
 *
 * Returns a sorted list of all tags currently in use in long-term memory.
 */
export class MemoryListTagsTool extends Tool {
  private logger = new Logger(MemoryListTagsTool.name);

  constructor(private store: MemoryService) {
    super();
  }

  get name(): string {
    return "memory_list_tags";
  }

  get description(): string {
    return "List all tags used in long-term memory. Discover what topics have been stored.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  async execute(_params: Record<string, unknown>): Promise<string> {
    const tags = this.store.listTags();
    this.logger.debug("memory_list_tags", { tags });
    return JSON.stringify({ tags }, null, 2);
  }
}

/**
 * Agent tool: `memory_delete`
 *
 * Logically removes a memory entry by superseding it — the original is
 * preserved in history but will no longer appear in searches or context.
 * Use `memory_write` with `supersedes` to replace a fact with updated content.
 * Protected entries cannot be deleted.
 */
export class MemoryDeleteTool extends Tool {
  constructor(private store: MemoryService) {
    super();
  }

  get name(): string {
    return "memory_delete";
  }

  get description(): string {
    return "Remove an outdated or incorrect memory entry by its numeric id. The entry is superseded (history preserved) rather than permanently erased.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        id: { type: "number", description: "The numeric id of the memory entry to remove" }
      },
      required: ["id"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return "Error: id must be a positive integer";
    const result = this.store.supersede(id);
    if (result === "superseded") return `Memory entry ${id} removed`;
    if (result === "protected") return `Error: memory entry ${id} is protected and cannot be removed`;
    return `Error: no entry found with id ${id}`;
  }
}
