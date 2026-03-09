import { APP_USER_AGENT } from "src/constants";
import { Tool } from "./toolbase";
import { Logger } from "src/utils/logger";
import { RiskLevel } from "../security.js";
import { ExecTool } from "./shell";
import type { HttpToolConfigSchema } from "src/types/schemas/schema.js";
import type { z } from "zod";

type HttpToolConfig = z.infer<typeof HttpToolConfigSchema>;

type SearchItem = Record<string, unknown>;
type BraveResult  = { web: { results?: SearchItem[] } };
type GenericResult = { results?: SearchItem[] };
type SearchResponse = BraveResult | GenericResult;

function shellQuote(cmd: string): string {
  return `'${cmd.replace(/'/g, "'\\''")}'`;
}

function isBraveResult(data: SearchResponse): data is BraveResult {
  return "web" in data && data.web !== null && typeof data.web === "object";
}

function extractResults(data: SearchResponse): SearchItem[] {
  return isBraveResult(data) ? (data.web.results ?? []) : (data.results ?? []);
}

export class WebSearchTool extends Tool {
  private logger = new Logger(WebSearchTool.name);
  constructor(private apiKey?: string | null, private maxResults = 5, private strUrl: string = "https://api.search.brave.com/res/v1/web/search") {
    super();
  }

  get name(): string { return "web_search"; }
  // Search titles and snippets — low taint (no full page content).
  get outputRisk(): RiskLevel { return RiskLevel.Low; }

  get description(): string {
    return "Search the web using Brave Search API";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: { type: "integer", description: "Max results" }
      },
      required: ["query"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    if (!this.apiKey) {
      return "Error: Brave Search API key not configured";
    }
    const query = String(params.query ?? "");
    const maxResults = Number(params.maxResults ?? this.maxResults);
    const url = new URL(this.strUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));
    const headers: Record<string, string> = {
      "Accept": "application/json",
      ...(this.apiKey && { "X-Subscription-Token": this.apiKey })
    };
    const strCUrl = url.toString();
    this.logger.debug(`WebSearch ${strCUrl}`)
    const response = await fetch(strCUrl, {
      headers
    });

    if (!response.ok) {
      return `Error: Search request failed (${response.status})`;
    }
    this.logger.debug(`Search Response ${JSON.stringify(response)}`);
    const data = await response.json() as SearchResponse;
    const results = extractResults(data);
    if (!results.length) {
      return "No results found.";
    }
    const lines = results.map((item: SearchItem) => {
      const title = item.title ?? "";
      const urlValue = item.url ?? "";
      const description = item.description ?? item.content ?? "";
      return `- ${title}\n  ${urlValue}\n  ${description}`;
    });
    return lines.join("\n\n");
  }
}

export class WebFetchTool extends Tool {
  get name(): string { return "web_fetch"; }
  // Full page content is attacker-controlled — high taint.
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  get description(): string {
    return "Fetch the contents of a web page";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" }
      },
      required: ["url"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const url = String(params.url ?? "");
    const response = await fetch(url, { headers: { "User-Agent": APP_USER_AGENT } });
    if (!response.ok) {
      return `Error: Fetch failed (${response.status})`;
    }
    const text = await response.text();
    return text.slice(0, 12000);
  }
}

export class WebCrawlTool extends Tool {
  private logger = new Logger(WebCrawlTool.name);
  get name(): string { return "web_crawl"; }
  // Full crawled page content — high taint.
  get outputRisk(): RiskLevel { return RiskLevel.High; }

 constructor(private crawlCommand:string) {
    super();
  }


  get description(): string {
    return "Extends Web Fetch but it will return a structured version of the page";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" }
      },
      required: ["url"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    this.logger.debug(`crawling page ${params.url}`);
    const url = String(params.url ?? "");
    const execTool = new ExecTool({timeout: 120});
    const command = this.crawlCommand.replace("%s",shellQuote(url));
    const result = await execTool.execute({command});
    this.logger.debug(result.slice(0, 1000));
    return result;
  }
}

/** Sensitive header names whose values are redacted from debug logs. */
const SENSITIVE_HEADER_RE = /auth|token|secret|key|password|bearer|cookie/i;

/**
 * General-purpose HTTP client tool.
 *
 * Supports all common methods (GET/POST/PUT/PATCH/DELETE/HEAD), arbitrary
 * request headers, and a string body. Returns status, response headers, and
 * body as a JSON object so the agent can reason about each part separately.
 *
 * Risk: High — response body is attacker-controlled external content.
 */
export class HttpRequestTool extends Tool {
  private logger = new Logger(HttpRequestTool.name);

  constructor(private config: HttpToolConfig) {
    super();
  }

  get name(): string { return "http_request"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  get description(): string {
    return [
      "Make an HTTP request with any method, headers, and body.",
      "Returns status code, response headers, and body.",
      "For JSON APIs set Content-Type: application/json in headers and pass the serialized JSON as body.",
      "Auth headers (Authorization, X-Api-Key, etc.) are accepted but never logged.",
    ].join(" ");
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url:     { type: "string",  description: "Full URL including query string" },
        method:  { type: "string",  enum: ["GET","POST","PUT","PATCH","DELETE","HEAD"], description: "HTTP method (default: GET)" },
        headers: { type: "object",  description: "Request headers as key-value pairs", additionalProperties: { type: "string" } },
        body:    { type: "string",  description: "Request body (use serialized JSON for JSON APIs)" },
        timeout: { type: "integer", description: "Timeout in seconds, 1–120 (default: 30)", minimum: 1, maximum: 120 },
      },
      required: ["url"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const url     = String(params.url ?? "");
    const method  = String(params.method ?? "GET").toUpperCase();
    const headers = (typeof params.headers === "object" && params.headers !== null
      ? params.headers : {}) as Record<string, string>;
    const body    = params.body != null ? String(params.body) : undefined;
    const timeout = Math.min(120, Math.max(1, Number(params.timeout ?? 30))) * 1000;

    // Host allow-list
    if (this.config.allowedHosts.length > 0) {
      let hostname: string;
      try { hostname = new URL(url).hostname; }
      catch { return "Error: Invalid URL"; }
      const allowed = this.config.allowedHosts.some(
        h => hostname === h || hostname.endsWith(`.${h}`)
      );
      if (!allowed) return `Error: Host '${hostname}' is not in tools.web.http.allowedHosts`;
    }

    // Redact sensitive headers for debug log
    const safeHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, SENSITIVE_HEADER_RE.test(k) ? "[redacted]" : v])
    );
    this.logger.debug(`http_request ${method} ${url}`, { headers: safeHeaders });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: { "User-Agent": APP_USER_AGENT, ...headers },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const raw = await res.text();
      const truncated = raw.length > this.config.maxResponseBytes;
      const bodyText  = raw.slice(0, this.config.maxResponseBytes);

      // Pretty-print JSON responses so the model can read them more easily
      const contentType = res.headers.get("content-type") ?? "";
      let responseBody = bodyText;
      if (contentType.includes("application/json")) {
        try { responseBody = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* keep raw */ }
      }

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });

      return JSON.stringify({
        status:     res.status,
        statusText: res.statusText,
        headers:    responseHeaders,
        body:       responseBody,
        ...(truncated && { truncated: true, originalSize: raw.length }),
      }, null, 2);

    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        return `Error: Request timed out after ${timeout / 1000}s`;
      }
      return `Error: ${String(err)}`;
    }
  }
}