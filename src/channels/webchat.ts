
import { WebSocketServer, WebSocket } from "ws";
import { BaseChannel } from "./base.js";
import { OutboundMessage } from "src/messagebus/events.js";
import { MessageBus } from "src/messagebus/queue.js";
import { Logger } from "src/utils/logger.js";
import { SessionManager } from "src/session/manager.js";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

export type WebChatConfig = {
  enabled: boolean;
  port: number;
  host: string;
  allowFrom: string[];
  uiToken?: string;
};

type WsMessage =
  | { type: "message"; content: string; role: "user" | "assistant"; timestamp: string }
  | { type: "token_delta"; content: string }
  | { type: "tool_call"; tool: string }
  | { type: "typing" }
  | { type: "system"; content: string }
  | { type: "pong" };

const CHAT_ID = "default";
const MAX_HISTORY = 100;



export class WebChatChannel extends BaseChannel<WebChatConfig> {

  name = "webchat";

  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private messageHistory: Array<{ role: string; content: string; timestamp: string }> = [];
  private logger = new Logger(WebChatChannel.name);

  constructor(
    config: WebChatConfig,
    bus: MessageBus,
    sessionManager: SessionManager,
  ) {
    super(config, bus, sessionManager);
  }

  async start(): Promise<void> {
  }

  async connectWebChat(server: http.Server | null) {
    if (!server) {
      return;
    }
    this.wss = new WebSocketServer({ server: server, path: "/ws" });

    // Load chat history
    const folder = this.sessionManager?.getSessionFolder();
    if (folder) {
      const historyFile = join(folder, "webchat.history");
      if (existsSync(historyFile)) {
        try {
          this.messageHistory = JSON.parse(readFileSync(historyFile).toString());
        } catch { /* ignore */ }
      }
    }

    this.wss.on("connection", (ws,request) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (!url || url.searchParams.get("token") !== this.config.uiToken) {
        this.logger.error("Invalid Authorization");
        ws.close(4001, "Unauthorized");
        return;
      }
      
      this.clients.add(ws);
      this.logger.debug("WebChat client connected", { total: this.clients.size });

      this.sendTo(ws, { type: "history" as const, messages: this.messageHistory } as never);

      ws.on("message", (data) => {
        void this.onClientMessage(ws, data.toString());
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        this.logger.debug("WebChat client disconnected", { total: this.clients.size });
      });

      ws.on("error", (err) => {
        this.logger.warn("WebChat client error", { error: String(err) });
      });
    });

    this.logger.info("WebChat started and connected to WebAPI Service");

  }

  /** Hot-update config (token, allowFrom) without restarting the WS server. */
  updateConfig(cfg: WebChatConfig): void {
    this.config = cfg;
  }

  async stop(): Promise<void> {
    this.logger.debug("Stopping webchat");
    const folder = this.sessionManager?.getSessionFolder();
    if (folder) {
      writeFileSync(join(folder, "webchat.history"), JSON.stringify(this.messageHistory));
      this.logger.debug("History written to disc");
    }

    this.running = false;
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
      if (!this.wss) resolve();
    });

    this.logger.info("WebChat stopped");
  }

  async send(msg: OutboundMessage): Promise<void> {
    const entry = { role: "assistant", content: msg.content, timestamp: new Date().toISOString() };
    this.pushHistory(entry);
    this.broadcast({ type: "message", ...entry });
  }

  isAllowed(_senderId: string): boolean {
    return true;
  }

  private async onClientMessage(ws: WebSocket, raw: string): Promise<void> {
    let parsed: { type: string; content?: string };
    try {
      parsed = JSON.parse(raw) as { type: string; content?: string };
    } catch {
      return;
    }

    if (parsed.type === "ping") {
      this.sendTo(ws, { type: "pong" });
      return;
    }

    if (parsed.type === "message") {
      const content = (parsed.content ?? "").trim();
      if (!content) return;

      const entry = { role: "user", content, timestamp: new Date().toISOString() };
      this.pushHistory(entry);

      this.broadcast({ type: "typing" });

      await this.handleMessage({
        senderId: "user",
        chatId: CHAT_ID,
        content,
        onTokenDelta: (token) => this.broadcast({ type: "token_delta", content: token }),
        onToolCall: (tool) => this.broadcast({ type: "tool_call", tool }),
      });
    }
  }

  private pushHistory(entry: { role: string; content: string; timestamp: string }): void {
    this.messageHistory.push(entry);
    if (this.messageHistory.length > MAX_HISTORY) {
      this.messageHistory.shift();
    }
    this.persistHistory();
  }

  private persistHistory(): void {
    const folder = this.sessionManager?.getSessionFolder();
    if (!folder) return;
    try {
      writeFileSync(join(folder, "webchat.history"), JSON.stringify(this.messageHistory));
    } catch { /* ignore write errors */ }
  }

  private broadcast(data: unknown): void {
    const json = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(json);
        } catch { /* ignore send errors for individual clients */ }
      }
    }
  }

  private sendTo(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

}

