import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import { Logger } from "src/utils/logger.js";
import type { EmailStore } from "src/email/store.js";
import type { DocStore } from "src/docs/store.js";
import type { Config } from "src/types/schemas/schema.js";
import type { AgentServices } from "./tool-provider.js";
import type { ToolProvider } from "./tool-provider.js";

// ── email_search ──────────────────────────────────────────────────────────────

export class EmailSearchTool extends Tool {
  private logger = new Logger(EmailSearchTool.name);

  constructor(private emailStore: EmailStore, private docStore?: DocStore) {
    super();
  }

  get name(): string { return "email_search"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  get description(): string {
    return [
      "Search the email archive for messages related to a topic or question.",
      "Use this tool — NOT memory_search — whenever the user asks about past emails,",
      "conversations with specific people, or needs to find connections between emails.",
      "Supports semantic (meaning-based) search when the document store is enabled,",
      "otherwise falls back to full-text search.",
      "Optional filters: from (sender address fragment), date_from / date_to (ISO date strings), limit.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query:     { type: "string",  description: "What to search for — describe the topic, problem, or person." },
        from:      { type: "string",  description: "Filter by sender address (partial match)." },
        date_from: { type: "string",  description: "Only emails on or after this date (ISO format, e.g. 2026-01-01)." },
        date_to:   { type: "string",  description: "Only emails on or before this date (ISO format)." },
        limit:     { type: "integer", description: "Max results (default 10)." },
      },
      required: ["query"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const query    = String(params.query ?? "").trim();
    const from     = params.from     ? String(params.from).toLowerCase()  : null;
    const dateFrom = params.date_from ? String(params.date_from) : null;
    const dateTo   = params.date_to   ? String(params.date_to)   : null;
    const limit    = Math.min(20, Math.max(1, Number(params.limit ?? 10)));

    if (!query) return "Error: query is required";

    let results: Array<{ id: number; from_addr: string; to_addr: string; subject: string; received_at: string; snippet: string }> = [];

    if (this.docStore) {
      // Semantic search via DocStore — filter to email: paths
      const hits = await this.docStore.search(query, limit * 2); // over-fetch to allow post-filter
      const emailHits = hits.filter(h => h.path.startsWith("email:"));

      for (const hit of emailHits) {
        const id = parseInt(hit.path.slice("email:".length), 10);
        const email = this.emailStore.get(id);
        if (!email) continue;

        if (from && !email.from_addr.toLowerCase().includes(from)) continue;
        if (dateFrom && email.received_at < dateFrom) continue;
        if (dateTo   && email.received_at > dateTo + "T23:59:59Z") continue;

        results.push({
          id: email.id,
          from_addr:   email.from_addr,
          to_addr:     email.to_addr,
          subject:     email.subject,
          received_at: email.received_at,
          snippet:     hit.content.slice(0, 300),
        });
        if (results.length >= limit) break;
      }
    } else {
      // FTS5 fallback
      const rows = this.emailStore.ftsSearch(query, limit * 2);
      for (const row of rows) {
        if (from && !row.from_addr.toLowerCase().includes(from)) continue;
        if (dateFrom && row.received_at < dateFrom) continue;
        if (dateTo   && row.received_at > dateTo + "T23:59:59Z") continue;
        results.push(row);
        if (results.length >= limit) break;
      }
    }

    if (results.length === 0) return "No emails found matching your query.";

    return results.map(r =>
      `[ID:${r.id}] ${r.received_at.slice(0, 10)} | From: ${r.from_addr} | Subject: ${r.subject}\n  ${r.snippet}`
    ).join("\n\n");
  }
}

// ── email_save ────────────────────────────────────────────────────────────────

export class EmailSaveTool extends Tool {
  constructor(private emailStore: EmailStore) { super(); }

  get name(): string { return "email_save"; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description(): string {
    return [
      "Save an email to the archive so it can be found later with email_search.",
      "Call this after reading an email with imap_read when the email is worth keeping",
      "(e.g. contains useful information, is part of an ongoing topic, or is from a known contact).",
      "Do NOT save spam, newsletters, or one-off notifications.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        message_id:  { type: "string", description: "RFC 2822 Message-ID header (the 'message_id' field from imap_read). This is globally unique and stable across folder moves — always pass it." },
        uid:         { type: "integer", description: "IMAP UID from imap_read (folder-specific, used for reference)." },
        mailbox:     { type: "string", description: "Mailbox the email was read from (e.g. INBOX)." },
        from_addr:   { type: "string", description: "Sender address." },
        to_addr:     { type: "string", description: "Recipient address(es)." },
        subject:     { type: "string", description: "Email subject." },
        received_at: { type: "string", description: "Date/time the email was received (ISO format)." },
        body:        { type: "string", description: "Your concise summary of the email — why it matters, key facts, action items." },
        raw_body:    { type: "string", description: "The complete original plain-text content from imap_read (the 'content' field). Store this verbatim for full-text search and later reference." },
      },
      required: ["message_id", "subject", "from_addr", "body"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    try {
      this.emailStore.save({
        message_id:  String(params.message_id ?? ""),
        uid:         Number(params.uid ?? 0),
        mailbox:     String(params.mailbox ?? ""),
        from_addr:   String(params.from_addr ?? ""),
        to_addr:     String(params.to_addr ?? ""),
        subject:     String(params.subject ?? ""),
        received_at: String(params.received_at ?? new Date().toISOString()),
        body:        String(params.body ?? ""),
        raw_body:    params.raw_body ? String(params.raw_body) : undefined,
      });
      return "Email saved to archive.";
    } catch (err) {
      return `Error: ${String(err)}`;
    }
  }
}

// ── email_get ─────────────────────────────────────────────────────────────────

export class EmailGetTool extends Tool {
  constructor(private emailStore: EmailStore) { super(); }

  get name(): string { return "email_get"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  get description(): string {
    return "Fetch the full content of a specific email by its archive ID (from email_search results).";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        id: { type: "integer", description: "Email archive ID from email_search." },
      },
      required: ["id"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const id = Number(params.id ?? 0);
    if (!id) return "Error: id is required";
    const email = this.emailStore.get(id);
    if (!email) return `Error: email ID ${id} not found`;
    return JSON.stringify({
      id:          email.id,
      from:        email.from_addr,
      to:          email.to_addr,
      subject:     email.subject,
      received_at: email.received_at,
      mailbox:     email.mailbox,
      body:        email.body,
    }, null, 2);
  }
}

// ── email_list ────────────────────────────────────────────────────────────────

export class EmailListTool extends Tool {
  constructor(private emailStore: EmailStore) { super(); }

  get name(): string { return "email_list"; }
  get outputRisk(): RiskLevel { return RiskLevel.Low; }

  get description(): string {
    return "List recent emails in the archive. Returns metadata only (no body). Use email_get to read a specific email.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        mailbox: { type: "string",  description: "Filter by mailbox (e.g. INBOX). Omit for all mailboxes." },
        limit:   { type: "integer", description: "Number of emails to return (default 20, max 50)." },
      },
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const mailbox = params.mailbox ? String(params.mailbox) : undefined;
    const limit   = Math.min(50, Math.max(1, Number(params.limit ?? 20)));
    const emails  = this.emailStore.list({ mailbox, limit });
    if (emails.length === 0) return "No emails in archive.";
    return emails.map(e =>
      `[ID:${e.id}] ${e.received_at.slice(0, 16)} | From: ${e.from_addr} | Subject: ${e.subject}`
    ).join("\n");
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class EmailArchiveProvider implements ToolProvider {
  readonly id = "email-archive";
  public emailStore?: EmailStore;

  isEnabled(config: Config): boolean {
    const imap = config.tools?.imap;
    return !!(imap?.host && imap?.user);
  }

  createTools(config: Config, services: AgentServices): Tool[] {
    if (!services.emailStore) return [];
    this.emailStore = services.emailStore;
    const docStore = services.docStore;
    return [
      new EmailSaveTool(services.emailStore),
      new EmailSearchTool(services.emailStore, docStore),
      new EmailGetTool(services.emailStore),
      new EmailListTool(services.emailStore),
    ];
  }
}
