import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Tool } from "src/agent/tools/toolbase.js";
import { RiskLevel } from "src/agent/security.js";
import { Logger } from "src/utils/logger";

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Wraps a single MCP server tool as an Verox Tool.
 *
 * The tool name in the registry is prefixed with `mcp__{serverName}__` so
 * tools from different servers never collide. The original MCP tool name is
 * stored separately and used when calling the server.
 *
 * MCP tools may return arbitrary external content, so outputRisk defaults to
 * High. Per-tool security overrides in config can relax this when needed.
 */
export class McpTool extends Tool {
  private _name: string;
  private _mcpToolName: string;
  private _description: string;
  private _parameters: Record<string, unknown>;
  private _alwaysInclude: boolean;
  private client: Client;
  private logger = new Logger(McpTool.name);

  constructor(serverName: string, client: Client, def: McpToolDef, alwaysInclude = false) {
    super();
    this._mcpToolName = def.name;
    this._name = `mcp__${serverName}__${def.name}`;
    this._description = def.description ?? def.name;
    // MCP tool inputSchema is already JSON Schema — pass through directly.
    this._parameters = def.inputSchema ?? { type: "object", properties: {} };
    this._alwaysInclude = alwaysInclude;
    this.client = client;
  }

  get name(): string { return this._name; }
  get description(): string { return this._description; }
  get parameters(): Record<string, unknown> { return this._parameters; }

  // MCP tools can return external/attacker-controlled content.
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  // MCP tools are contextually filtered unless the server is marked alwaysInclude.
  get contextual(): boolean { return !this._alwaysInclude; }

  async execute(params: Record<string, unknown>): Promise<string> {
    this.logger.debug(`execute ${JSON.stringify(params)}`);
    this._lastExecuteRisk = undefined;

    const result = await this.client.callTool({
      name: this._mcpToolName,
      arguments: params,
    });

    // MCP returns an array of typed content items.
    const items = (result.content ?? []) as Array<Record<string, unknown>>;

    if (result.isError) {
      const errText = items
        .filter((c) => c["type"] === "text")
        .map((c) => String(c["text"] ?? ""))
        .join("\n");
      this.logger.error(errText);
      return `Error from MCP tool ${this._mcpToolName}: ${errText || "unknown error"}`;
    }

    const parts: string[] = [];
    for (const item of items) {
      if (item["type"] === "text") {
        parts.push(String(item["text"] ?? ""));
      } else if (item["type"] === "image") {
        parts.push(`[image: ${item["mimeType"] ?? "unknown"}]`);
      } else if (item["type"] === "resource") {
        const res = item["resource"] as Record<string, unknown> | undefined;
        if (res?.["text"]) parts.push(String(res["text"]));
        else if (res?.["uri"]) parts.push(`[resource: ${res["uri"]}]`);
      }
    }
    this.logger.debug(parts.join("\n"));
    return parts.join("\n") || "(no output)";
  }
}
