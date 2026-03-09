import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { HttpRequestTool, WebCrawlTool, WebFetchTool, WebSearchTool } from "../web.js";

/** Web tools: search, fetch, HTTP requests, crawl. Always enabled. */
export class WebProvider implements ToolProvider {
  readonly id = "web";

  isEnabled(_config: Config): boolean {
    return true;
  }

  createTools(config: Config, _services: AgentServices): Tool[] {
    const { apiKey, maxResults, strUrl } = config.tools?.web?.search ?? {};
    const tools: Tool[] = [
      new WebSearchTool(apiKey, maxResults, strUrl),
      new WebFetchTool(),
      new HttpRequestTool(config.tools?.web?.http ?? { allowedHosts: [], maxResponseBytes: 100_000 }),
    ];
    if (config.tools?.web?.crawl) {
      tools.push(new WebCrawlTool(config.tools.web.crawl));
    }
    return tools;
  }
}
