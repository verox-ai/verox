import { MemoryService } from "src/memory/service.js";
import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import { APP_USER_AGENT } from "src/constants.js";

/**
 * Agent tool: `knowledge_write`
 *
 * Creates or replaces a long-form knowledge document in the database.
 * Use this for procedural how-tos, reference notes, system descriptions —
 * anything too long or structured to fit in a single memory entry.
 * Documents are identified by a slug (e.g. "deploy-procedure") and can be
 * updated in-place. Titles appear in the knowledge map every turn so the
 * agent always knows what docs exist.
 */
export class KnowledgeWriteTool extends Tool {
  constructor(private store: MemoryService) { super(); }

  get name() { return "knowledge_write"; }

  get description() {
    return (
      "Save a long-form knowledge document (how-to, reference, procedure, system description). " +
      "Use this for content that is too detailed or structured for a single memory entry — " +
      "step-by-step guides, API references, project notes, decision records, recurring workflows. " +
      "Documents are stored by slug (short kebab-case identifier) and can be updated in-place. " +
      "The title and slug appear in every system prompt so you always know what docs exist. " +
      "Call knowledge_read to load the full content of any doc."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Short unique identifier in kebab-case (e.g. 'deploy-procedure', 'nas-setup'). Used to read/update this doc later."
        },
        title: {
          type: "string",
          description: "Human-readable title (e.g. 'NAS folder structure and upload process')"
        },
        content: {
          type: "string",
          description: "Full document content. Markdown supported. No length limit."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorisation and search (e.g. ['technical', 'nas', 'workflow'])"
        }
      },
      required: ["slug", "title", "content"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const slug = String(params.slug ?? "").trim();
    const title = String(params.title ?? "").trim();
    const content = String(params.content ?? "").trim();
    if (!slug) return "Error: slug is required";
    if (!title) return "Error: title is required";
    if (!content) return "Error: content is required";
    const tags = Array.isArray(params.tags)
      ? params.tags.map(t => String(t).trim()).filter(Boolean)
      : [];
    const doc = this.store.knowledgeWrite({ slug, title, content, tags });
    return JSON.stringify({ slug: doc.slug, title: doc.title, updated_at: doc.updated_at, chars: doc.content.length }, null, 2);
  }
}

/**
 * Agent tool: `knowledge_read`
 *
 * Loads the full content of a knowledge document by slug.
 */
export class KnowledgeReadTool extends Tool {
  constructor(private store: MemoryService) { super(); }

  get name() { return "knowledge_read"; }

  get description() {
    return (
      "Read the full content of a knowledge document by its slug. " +
      "Check the Knowledge index in the system prompt to see which docs exist. " +
      "Use knowledge_search to find docs by topic if unsure of the slug."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        slug: { type: "string", description: "The slug of the document to read" }
      },
      required: ["slug"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const slug = String(params.slug ?? "").trim();
    if (!slug) return "Error: slug is required";
    const doc = this.store.knowledgeGet(slug);
    if (!doc) return `Error: no knowledge document found with slug "${slug}". Use knowledge_list to see all docs.`;
    return JSON.stringify(doc, null, 2);
  }
}

/**
 * Agent tool: `knowledge_search`
 *
 * Full-text searches knowledge documents by title, content, and tags.
 * Returns matching document metadata (no content) — call knowledge_read to load a specific doc.
 */
export class KnowledgeSearchTool extends Tool {
  constructor(private store: MemoryService) { super(); }

  get name() { return "knowledge_search"; }

  get description() {
    return (
      "Search knowledge documents by title, content, and tags using full-text search. " +
      "Returns matching document slugs and titles — call knowledge_read to load the full content. " +
      "Use this when the knowledge index mentions docs that might be relevant but you need to narrow down which one."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (full-text match on title, content, tags)" },
        limit: { type: "integer", description: "Max results (default 10)" }
      },
      required: ["query"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const query = String(params.query ?? "").trim();
    if (!query) return "Error: query is required";
    const limit = typeof params.limit === "number" ? params.limit : 10;
    const results = this.store.knowledgeSearch(query, limit);
    if (!results.length) return JSON.stringify({ results: [], note: "No documents matched. Use knowledge_list to see all docs." }, null, 2);
    return JSON.stringify({ results }, null, 2);
  }
}

/**
 * Agent tool: `knowledge_list`
 *
 * Lists all knowledge documents (slug, title, tags, dates) without loading content.
 */
export class KnowledgeListTool extends Tool {
  constructor(private store: MemoryService) { super(); }

  get name() { return "knowledge_list"; }

  get description() {
    return "List all knowledge documents (slug, title, tags, last updated). No content is loaded. Use knowledge_read to get the full content of a specific doc.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  async execute(): Promise<string> {
    const docs = this.store.knowledgeList();
    if (!docs.length) return JSON.stringify({ docs: [], note: "No knowledge documents yet. Use knowledge_write to create one." }, null, 2);
    return JSON.stringify({ count: docs.length, docs }, null, 2);
  }
}

/**
 * Agent tool: `knowledge_delete`
 *
 * Permanently deletes a knowledge document by slug.
 */
export class KnowledgeDeleteTool extends Tool {
  constructor(private store: MemoryService) { super(); }

  get name() { return "knowledge_delete"; }

  get description() {
    return "Permanently delete a knowledge document by its slug. Use this to remove outdated or incorrect docs.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the document to delete" }
      },
      required: ["slug"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const slug = String(params.slug ?? "").trim();
    if (!slug) return "Error: slug is required";
    const deleted = this.store.knowledgeDelete(slug);
    return deleted
      ? `Knowledge document "${slug}" deleted.`
      : `Error: no document found with slug "${slug}".`;
  }
}

/**
 * Agent tool: `knowledge_clip`
 *
 * Fetches a URL, extracts readable text (strips HTML), and saves it as a
 * knowledge document. Useful for saving web pages, articles, documentation
 * for later reference without re-fetching.
 */
export class KnowledgeClipTool extends Tool {
  constructor(private store: MemoryService) { super(); }

  get name() { return "knowledge_clip"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  get description() {
    return (
      "Fetch a URL and save its content as a knowledge document for permanent reference. " +
      "Strips HTML to readable text. Auto-generates a slug from the URL if not provided. " +
      "Use this to clip articles, docs, or any web page into the knowledge base."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch and clip" },
        title: { type: "string", description: "Document title. If omitted, extracted from the page <title> tag." },
        slug: { type: "string", description: "Slug for the doc (kebab-case). Auto-generated from URL if omitted." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      required: ["url"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const url = String(params.url ?? "").trim();
    if (!url) return "Error: url is required";

    let html: string;
    try {
      const res = await fetch(url, { headers: { "User-Agent": APP_USER_AGENT } });
      if (!res.ok) return `Error: fetch failed (${res.status})`;
      html = await res.text();
    } catch (err) {
      return `Error fetching URL: ${String(err)}`;
    }

    const extractedTitle = extractTitle(html);
    const title = String(params.title ?? extractedTitle ?? url).trim();
    const slug = String(params.slug ?? "").trim() || urlToSlug(url);
    const tags = Array.isArray(params.tags)
      ? params.tags.map(t => String(t).trim()).filter(Boolean)
      : ["clipped"];
    const content = htmlToText(html);

    const doc = this.store.knowledgeWrite({ slug, title, content, tags });
    return JSON.stringify({
      slug: doc.slug,
      title: doc.title,
      chars: doc.content.length,
      tags: doc.tags,
      note: "Saved to knowledge base.",
    }, null, 2);
  }
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

function urlToSlug(url: string): string {
  try {
    const u = new URL(url);
    const path = (u.hostname + u.pathname)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return path || "clipped-page";
  } catch {
    return "clipped-page";
  }
}

function htmlToText(html: string): string {
  // Remove script/style blocks entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "");

  // Convert block elements to newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|article|section)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "• ");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim().slice(0, 50_000);
}
