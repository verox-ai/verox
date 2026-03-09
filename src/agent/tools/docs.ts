import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import type { DocStore } from "src/docs/store.js";
import { extractText } from "src/docs/extractor.js";
import { Logger } from "src/utils/logger.js";

/**
 * Triggers indexing of the configured document paths (or a specific path/file).
 * Skips files whose content hash has not changed since last index.
 */
export class DocsIndexTool extends Tool {
  constructor(private store: DocStore) { super(); }

  get name(): string { return "docs_index"; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }
  get maxRisk(): RiskLevel { return RiskLevel.None; }

  get description(): string {
    return [
      "Index local documents for semantic search.",
      "With no arguments indexes all configured paths.",
      "Pass 'path' to index a single file or directory.",
      "Pass 'force: true' to re-index even if files are unchanged.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path:  { type: "string",  description: "Specific file or directory to index (optional)" },
        force: { type: "boolean", description: "Re-index files even if unchanged (default: false)" },
      },
      required: []
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const force = params.force === true;

    if (typeof params.path === "string" && params.path) {
      const result = await this.store.indexFile(params.path, force);
      if (result.status === "indexed")  return `Indexed ${result.path} — ${result.chunks} chunks`;
      if (result.status === "skipped")  return `Skipped ${result.path} (unchanged)`;
      return `Error indexing ${result.path}: ${result.error}`;
    }

    const { indexed, skipped, errors } = await this.store.indexAll(force);
    const lines = [`Indexed: ${indexed}  Skipped: ${skipped}  Errors: ${errors.length}`];
    if (errors.length) lines.push(...errors.map(e => `  • ${e}`));
    return lines.join("\n");
  }
}

/**
 * Semantic search over indexed local documents.
 * Returns the most relevant text chunks with source path and similarity score.
 */
export class DocsSearchTool extends Tool {
  private logger = new Logger(DocsSearchTool.name);
  constructor(private store: DocStore) { super(); }
  get name(): string { return "docs_search"; }
  get outputRisk(): RiskLevel { return RiskLevel.Low; }

  get description(): string {
    return [
      "Semantic search over locally indexed documents.",
      "Returns the most relevant chunks with source and similarity score.",
      "Each result contains a display name (e.g. 'Paperless › invoice.pdf') and an internal 'File:' path.",
      "IMPORTANT: When presenting results to the user always use the display name, never the raw File: path.",
      "The File: path is only for passing to docs_get or message(files=[...]) — never show it to the user.",
      "Run docs_index first to populate the index.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query:      { type: "string",  description: "Natural-language search query" },
        maxResults: { type: "integer", description: "Maximum number of chunks to return (default: 5)", minimum: 1, maximum: 20 },
      },
      required: ["query"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    this.logger.debug(`execute ${params.query}`);
    const query      = String(params.query ?? "").trim();
    const maxResults = typeof params.maxResults === "number" ? params.maxResults : undefined;

    if (!query) return "Error: query is required";

    const results = await this.store.search(query, maxResults);
    if (results.length === 0) return "No results found. Have you run docs_index?";

    const resultData = results.map((r, i) => {
      const displayName = r.pathObject ? `${r.pathObject.name} › ${r.fileName}` : r.fileName ?? r.path;
      return [
        `[${i + 1}] ${displayName}  (score: ${r.score.toFixed(3)})`,
        `[internal_path: ${r.path}]`,
        r.content,
      ].join("\n");
    }).join("\n\n---\n\n");

    this.logger.debug(`Result is ${results.map((r, i) => `[${i+1}] ${r.pathObject?.name ?? ""} › ${r.fileName}`).join(", ")}`);
    return resultData;
  }
}

/**
 * Reads the full text content of an indexed document.
 * To deliver the raw file as an attachment, use the message tool with files=[path] instead.
 */
export class DocGetTool extends Tool {
  constructor(private store: DocStore) { super(); }

  get name(): string { return "docs_get"; }
  get outputRisk(): RiskLevel { return RiskLevel.Low; }

  get description(): string {
    return [
      "Read the full text content of an indexed document.",
      "Use the 'File:' path shown in docs_search or docs_list results.",
      "To send the raw file as an attachment to the user, use the message tool with files=[path] instead.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the indexed document to read" },
      },
      required: ["path"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const filePath = String(params.path ?? "").trim();
    if (!filePath) return "Error: path is required";

    const indexed = this.store.listFiles().find(f => f.path === filePath);
    if (!indexed) return `Error: '${filePath}' is not in the document index. Run docs_list to see indexed files.`;

    try {
      return await extractText(filePath);
    } catch (err) {
      return `Error reading file: ${String(err)}`;
    }
  }
}

/**
 * Lists all files currently in the document index.
 */
export class DocsListTool extends Tool {
  constructor(private store: DocStore) { super(); }

  get name(): string { return "docs_list"; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description(): string {
    return "List all locally indexed documents with their chunk count and last indexed timestamp.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {}, required: [] };
  }

  async execute(): Promise<string> {
    const files = this.store.listFiles();
    if (files.length === 0) return "No documents indexed yet. Run docs_index first.";

    const header = "Share | File | Chunks | Indexed At | Full Path";
    const sep    = "----- | ---- | ------ | ---------- | ---------";
    const rows   = files.map(f => {
      const share = f.pathObject?.name ?? "—";
      const file  = f.fileName ?? f.path;
      return `${share} | ${file} | ${f.chunks} | ${f.indexedAt.slice(0, 19)} | ${f.path}`;
    });
    return [header, sep, ...rows].join("\n");
  }
}
