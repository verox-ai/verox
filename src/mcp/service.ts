import { injectable } from "tsyringe";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Logger } from "src/utils/logger.js";
import { ToolRegistry } from "src/agent/tools/registry.js";
import { McpTool } from "./tool.js";
import type { z } from "zod";
import type { McpConfigSchema } from "src/types/schemas/schema.js";
import type { VaultService } from "src/vault/credentials.js";

export type McpServerStatus = {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
};

type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Manages connections to all configured MCP servers.
 *
 * Call `connect(config)` at startup to establish connections.
 * Call `registerTools(registry)` to inject discovered tools.
 * Call `disconnect()` on shutdown.
 */
@injectable()
export class McpService {
  private clients: Map<string, Client> = new Map();
  private status: Map<string, McpServerStatus> = new Map();
  private logger = new Logger(McpService.name);

  async connect(config: McpConfig, vault?: VaultService): Promise<void> {
    const servers = config.servers ?? {};
    const serverCount = Object.keys(servers).length;
    if (serverCount === 0) return;

    this.logger.info(`Connecting to ${serverCount} MCP server(s)…`);

    for (const [serverName, serverCfg] of Object.entries(servers)) {
      const entry: McpServerStatus = {
        name: serverName,
        transport: serverCfg.transport,
        connected: false,
        toolCount: 0,
        tools: [],
      };
      this.status.set(serverName, entry);

      try {
        this.logger.info(`MCP [${serverName}] connecting via ${serverCfg.transport}…`);

        let transport: StdioClientTransport | undefined;
        if (serverCfg.transport === "stdio") {
          if (!serverCfg.command) {
            const msg = "no command configured — skipping";
            this.logger.warn(`MCP [${serverName}] ${msg}`);
            entry.error = msg;
            continue;
          }
          this.logger.debug(`MCP [${serverName}] command: ${serverCfg.command} ${(serverCfg.args ?? []).join(" ")}`);
          transport = new StdioClientTransport({
            command: serverCfg.command,
            args: serverCfg.args ?? [],
            env: { ...process.env, ...resolveEnv(serverCfg.env ?? {}, vault) } as Record<string, string>,
          });
        } else if (serverCfg.transport === "sse" || serverCfg.transport === "http") {
          if (!serverCfg.url) {
            const msg = "no url configured — skipping";
            this.logger.warn(`MCP [${serverName}] ${msg}`);
            entry.error = msg;
            continue;
          }
          this.logger.debug(`MCP [${serverName}] url: ${serverCfg.url}`);
          const headers = resolveEnv(serverCfg.headers ?? {}, vault);
          const reqInit = Object.keys(headers).length ? { headers } : undefined;
          // Try StreamableHTTP first; fall back to legacy SSE for older servers.
          const streamableTransport = new StreamableHTTPClientTransport(new URL(serverCfg.url), { requestInit: reqInit });
          const streamableClient = new Client({ name: "verox", version: "1.0.0" });
          try {
            await streamableClient.connect(streamableTransport);
            this.clients.set(serverName, streamableClient);
            entry.connected = true;
            this.logger.info(`MCP [${serverName}] ✓ connected (StreamableHTTP)`);
          } catch {
            this.logger.info(`MCP [${serverName}] StreamableHTTP failed, retrying with SSE…`);
            const sseTransport = new SSEClientTransport(new URL(serverCfg.url), { requestInit: reqInit });
            const sseClient = new Client({ name: "verox", version: "1.0.0" });
            await sseClient.connect(sseTransport);
            this.clients.set(serverName, sseClient);
            entry.connected = true;
            this.logger.info(`MCP [${serverName}] ✓ connected (SSE fallback)`);
          }
          continue;
        }

        if (!transport) continue;
        const client = new Client({ name: "verox", version: "1.0.0" });
        await client.connect(transport);
        this.clients.set(serverName, client);
        entry.connected = true;
        this.logger.info(`MCP [${serverName}] ✓ connected`);
      } catch (err) {
        entry.error = String(err);
        this.logger.error(`MCP [${serverName}] ✗ connection failed: ${String(err)}`);
        // Non-fatal — other servers still work.
      }
    }
  }

  /**
   * Discovers tools from all connected MCP servers and registers them in the
   * given ToolRegistry. Call after `connect()`.
   */
  async registerTools(registry: ToolRegistry, config?: McpConfig): Promise<void> {
    for (const [serverName, client] of this.clients) {
      const entry = this.status.get(serverName);
      const alwaysInclude = config?.servers?.[serverName]?.alwaysInclude ?? false;
      try {
        const { tools } = await client.listTools();
        const toolNames = tools.map((t) => t.name);
        if (entry) { entry.toolCount = tools.length; entry.tools = toolNames; }
        const filterNote = alwaysInclude ? "always-include" : "contextual";
        this.logger.info(`MCP [${serverName}] ${tools.length} tool(s) [${filterNote}]: ${toolNames.join(", ") || "(none)"}`);
        for (const toolDef of tools) {
          const tool = new McpTool(serverName, client, {
            name: toolDef.name,
            description: toolDef.description,
            inputSchema: toolDef.inputSchema as Record<string, unknown>,
          }, alwaysInclude);
          registry.register(tool);
        }
      } catch (err) {
        if (entry) entry.error = String(err);
        this.logger.error(`MCP [${serverName}] failed to list tools: ${String(err)}`);
      }
    }
  }

  async disconnect(): Promise<void> {
    for (const [serverName, client] of this.clients) {
      try {
        await client.close();
        this.logger.info(`MCP [${serverName}] disconnected`);
      } catch (err) {
        this.logger.warn(`MCP [${serverName}] error during disconnect: ${String(err)}`);
      }
    }
    this.clients.clear();
  }

  /** Returns the current connection + tool status for every configured server. */
  getStatus(): McpServerStatus[] {
    return Array.from(this.status.values());
  }

  get connectedServerCount(): number {
    return this.clients.size;
  }
}

/**
 * Resolves vault references in an env/headers map.
 *
 * Two syntaxes are supported:
 *
 * 1. Full-value replacement — `vault:<key>`
 *    The entire value is replaced by the vault entry. If the key is not found
 *    the variable is omitted entirely (the literal "vault:…" string never reaches
 *    the process).
 *    Example:  API_KEY=vault:config.mcp.servers.myserver.apikey
 *
 * 2. Inline interpolation — `$vault:<key>`
 *    The `$vault:<key>` token is substituted within a larger string. If the key
 *    is not found the token is replaced with an empty string.
 *    Example:  Authorization=Bearer $vault:config.mcp.servers.myserver.token
 */
function resolveEnv(
  env: Record<string, string>,
  vault?: VaultService
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith("vault:")) {
      // Full-value replacement — omit if key not found.
      const resolved = vault?.get(value.slice("vault:".length));
      if (resolved !== undefined) result[key] = resolved;
    } else {
      // Inline interpolation — replace each $vault:<key> token.
      result[key] = value.replace(/\$vault:([^\s,;"']+)/g, (_, vaultKey: string) =>
        vault?.get(vaultKey) ?? ""
      );
    }
  }
  return result;
}
