import http from "node:http";
import express, { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { BaseChannel } from "./base.js";
import { OutboundMessage } from "src/messagebus/events.js";
import { MessageBus } from "src/messagebus/queue.js";
import { Logger } from "src/utils/logger.js";
import { SessionManager } from "src/session/manager.js";

export type WebhookConfig = {
  enabled: boolean;
  port: number;
  host: string;
  path: string;
  jwtSecret: string;
  allowFrom: string[];
};

/**
 * WebhookChannel provides HTTP webhook support with JWT authentication.
 * Messages are sent via POST requests with a valid JWT token in the Authorization header.
 */
export class WebhookChannel extends BaseChannel<WebhookConfig> {
  name = "webhook";

  private server: http.Server | null = null;
  private logger = new Logger(WebhookChannel.name);
  private pendingResponses: Map<string, { resolve: (data: string) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }> = new Map();


  constructor(config: WebhookConfig, bus: MessageBus, sessionManager?: SessionManager) {
    super(config, bus, sessionManager);
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    // Webhook endpoint for receiving messages
    app.post(this.config.path, (req: Request, res: Response) => {
      void this.handleWebhookRequest(req, res);
    });

    this.server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => resolve());
      this.server!.once("error", reject);
    });

    this.running = true;
    this.logger.info("Webhook started", { host: this.config.host, port: this.config.port, path: this.config.path });
  }

  async stop(): Promise<void> {
    this.logger.debug("Stopping webhook");
    this.running = false;

    // Clear all pending responses
    for (const [, { timeout }] of this.pendingResponses) {
      clearTimeout(timeout);
    }
    this.pendingResponses.clear();

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server) resolve();
    });

    this.logger.info("Webhook stopped");
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Try to find a pending request waiting for this response
    const requestId = msg.metadata?.requestId as string | undefined;

    if (requestId && this.pendingResponses.has(requestId)) {
      const { resolve, timeout } = this.pendingResponses.get(requestId)!;
      clearTimeout(timeout);
      this.pendingResponses.delete(requestId);
      resolve(msg.content);
    }
  }

  private validateJWT(token: string): { valid: boolean; senderId?: string } {
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret) as { userId?: string; sub?: string };
      const senderId = decoded.userId || decoded.sub || "webhook";
      return { valid: true, senderId };
    } catch (err) {
      this.logger.warn("Invalid JWT token", { error: String(err) });
      return { valid: false };
    }
  }

  private async handleWebhookRequest(req: Request, res: Response): Promise<void> {
    try {
      // Extract and validate JWT token
      const authHeader = req.headers.authorization || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");

      if (!token) {
        res.status(401).json({ error: "Missing authorization token" });
        return;
      }

      const { valid, senderId } = this.validateJWT(token);
      if (!valid || !senderId) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }

      // Validate request body
      const body = req.body as Record<string, unknown>;
      const content = typeof body.message === "string" ? body.message.trim() : "";

      if (!content) {
        res.status(400).json({ error: "Message content is required" });
        return;
      }

      // Check allow list
      if (!this.isAllowed(senderId)) {
        res.status(403).json({ error: "Sender not authorized" });
        return;
      }

      // Generate a request ID for tracking this message through the system
      const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const chatId = (body.chatId as string) || senderId;

      // Optional cross-channel reply routing: caller can specify where the agent should send its reply
      const replyChannel = typeof body.replyChannel === "string" ? body.replyChannel : undefined;
      const replyChatId = typeof body.replyChatId === "string" ? body.replyChatId : undefined;
      // sessionless=true: agent processes without loading or saving any session history
      const sessionless = body.sessionless === true;
      this.logger.debug("Webhook routing", { replyChannel, replyChatId, sessionless, hasAgent: !!this.getAgent() });

      const agent = this.getAgent();
      if (agent) {
        const hints: string[] = [];
        if (replyChannel && replyChatId) {
          hints.push(
            `Send your reply via the message tool: message(action=send, channel="${replyChannel}", chatId="${replyChatId}", content=<your reply>). After sending, respond with NO_REPLY.`
          );
          // Fire-and-forget: agent will push the reply to the target channel asynchronously
          void agent.processDirect({
            content,
            channel: "webhook",
            chatId,
            metadata: { requestId, timestamp: new Date().toISOString() },
            messageToolHints: hints
          }).catch((err: unknown) => {
            this.logger.error("Error processing webhook message", { error: String(err) });
          });
          res.json({ success: true, response: "Message queued" });
          return;
        }

        // Sync path: await the agent and return the response directly in the HTTP reply
        const response = await agent.processDirect({
          content,
          channel: "webhook",
          chatId,
          metadata: { requestId, timestamp: new Date().toISOString() }
        });
        res.json({ success: true, response: response || "Done" });
        return;
      }

      // No direct agent reference — publish to the inbound bus
      if (replyChannel && replyChatId) {
        this.logger.debug("Webhook cross-channel: fire-and-forget to bus", { replyChannel, replyChatId, sessionless });
        // Fire-and-forget: agent will route its reply to the target channel via the bus
        void this.handleMessage({
          senderId,
          chatId,
          content,
          metadata: { requestId, timestamp: new Date().toISOString(), replyChannel, replyChatId, sessionless }
        }).catch((err) => {
          this.logger.error("Error handling webhook message", { error: String(err) });
        });
        res.json({ success: true, response: "Message queued" });
        return;
      }

      // Sync path: wait for the agent to reply back on the webhook channel
      const timeoutPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            this.pendingResponses.delete(requestId);
            reject(new Error("Response timeout"));
          },
          5000
        );
        this.pendingResponses.set(requestId, { resolve, reject, timeout });
      });

      void this.handleMessage({
        senderId,
        chatId,
        content,
        metadata: { requestId, timestamp: new Date().toISOString(), sessionless }
      }).catch((err) => {
        this.logger.error("Error handling webhook message", { error: String(err) });
        this.pendingResponses.delete(requestId);
      });

      try {
        const response = await timeoutPromise;
        res.json({ success: true, response });
      } catch {
        res.json({ success: true, response: "Message received" });
      }
    } catch (err) {
      this.logger.error("Webhook request error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  }
}
