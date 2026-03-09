import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { BaseChannel } from "./base.js";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import { Config } from "src/types/schemas/schema.js";
import { MessageBus } from "src/messagebus/queue.js";
import { OutboundMessage } from "src/messagebus/events.js";
import { Logger } from "src/utils/logger.js";

export class SlackChannel extends BaseChannel<Config["channels"]["slack"]> {
  name = "slack";
  private webClient: WebClient | null = null;
  private socketClient: SocketModeClient | null = null;
  private botUserId: string | null = null;
  private logger = new Logger(SlackChannel.name);

  constructor(config: Config["channels"]["slack"], bus: MessageBus) {
    super(config, bus);
  }

  async start(): Promise<void> {
    if (!this.config.botToken || !this.config.appToken) {
      throw new Error("Slack bot/app token not configured");
    }
    if (this.config.mode !== "socket") {
      throw new Error(`Unsupported Slack mode: ${this.config.mode}`);
    }

    this.running = true;
    this.webClient = new WebClient(this.config.botToken);
    this.socketClient = new SocketModeClient({
      appToken: this.config.appToken
    });

    this.socketClient.on("slack_event", async ({ ack, type, body }) => {
      await ack();
      if (type === "events_api") {
        await this.handleEvent(body?.event as Record<string, unknown>);
      }
    });

    this.socketClient.on("connected", () => {
      this.logger.debug("Socket connected");
    });

    try {
      const auth = await this.webClient.auth.test();
      this.botUserId = auth.user_id ?? null;
      this.logger.debug(`Bot User ID: ${this.botUserId}` );
    } catch {
      this.botUserId = null;
    }

    await this.socketClient.start();
    this.logger.debug("Slack started")
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.socketClient) {
      await this.socketClient.disconnect();
      this.socketClient = null;
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.webClient) {
      return;
    }
    const slackMeta = (msg.metadata?.slack as Record<string, unknown>) ?? {};
    const threadTs = slackMeta.thread_ts as string | undefined;
    const channelType = slackMeta.channel_type as string | undefined;
    const useThread = Boolean(threadTs && channelType !== "im");
    // Strip "slack:" prefix if the LLM passed the session key instead of the bare channel ID.
    const chatId = msg.chatId.startsWith("slack:") ? msg.chatId.slice("slack:".length) : msg.chatId;
    const channel = !useThread ? (this.config.dm.channelid || chatId) : chatId;

    if (msg.media && msg.media.length > 0) {
      for (let i = 0; i < msg.media.length; i++) {
        const filePath = msg.media[i];
        // files.uploadV2 requires a real channel ID (C/D/G/Z prefix) — never a user ID.
        // chatId has already had the "slack:" prefix stripped above.
        const uploadChannel = chatId;
        this.logger.info("Uploading file to Slack", { filePath, uploadChannel, useThread, threadTs });
        try {
          const fileBuffer = readFileSync(filePath);
          this.logger.debug("File read", { filePath, bytes: fileBuffer.length });
          const uploadArgs = {
            channel_id: uploadChannel,
            filename: basename(filePath),
            file: fileBuffer,
            initial_comment: i === 0 ? (msg.content ?? undefined) : undefined
          };
          if (useThread && threadTs) {
            await this.webClient.files.uploadV2({ ...uploadArgs, thread_ts: threadTs });
          } else {
            await this.webClient.files.uploadV2(uploadArgs);
          }
          this.logger.info("File uploaded successfully", { filePath, channel });
        } catch (err) {
          this.logger.error("File upload failed", { filePath, uploadChannel, error: String(err) });
          // Fall back to sending the file path as text so the user isn't left with nothing
          await this.webClient.chat.postMessage({
            channel: uploadChannel,
            text: `${i === 0 ? (msg.content ? msg.content + "\n" : "") : ""}(File: ${filePath})`,
            thread_ts: useThread ? threadTs : undefined
          });
        }
      }
      return;
    }

    await this.webClient.chat.postMessage({
      channel: channel,
      text: msg.content ?? "",
      thread_ts: useThread ? threadTs : undefined
    });
  }

  private async handleEvent(event: Record<string, unknown> | undefined): Promise<void> {
    this.logger.debug(`handleEvent ${event}`)
    if (!event) {
      return;
    }
    const eventType = event.type as string | undefined;
    if (eventType !== "message" && eventType !== "app_mention") {
      return;
    }

    if (event.subtype) {
      return;
    }

    const senderId = event.user as string | undefined;
    const chatId = event.channel as string | undefined;
    const channelType = (event.channel_type as string | undefined) ?? "";
    const text = (event.text as string | undefined) ?? "";

    if (!senderId || !chatId) {
      return;
    }
    if (this.botUserId && senderId === this.botUserId) {
      return;
    }
    if (eventType === "message" && this.botUserId && text.includes(`<@${this.botUserId}>`)) {
      return;
    }

    if (!this.isAllowedInSlack(senderId, chatId, channelType)) {
      this.logger.warn("User not allowed")
      return;
    }
    if (channelType !== "im" && !this.shouldRespondInChannel(eventType, text, chatId)) {
      return;
    }

    const cleanText = this.stripBotMention(text);
    const threadTs = (event.thread_ts as string | undefined) ?? (event.ts as string | undefined);

    try {
      if (this.webClient && event.ts) {
        await this.webClient.reactions.add({
          channel: chatId,
          name: "eyes",
          timestamp: event.ts as string
        });
      }
    } catch {
      // ignore reaction errors
    }


    
    await this.handleMessage({
      senderId,
      chatId,
      content: cleanText,
      media: [],
      metadata: {
        slack: {
          event,
          thread_ts: threadTs,
          channel_type: channelType
        }
      }
    });
  }

   isAllowed(senderId: string): boolean {
    // we have checked the allow not allow previously 
    return true;
  }

  private isAllowedInSlack(senderId: string, chatId: string, channelType: string): boolean {
    this.logger.debug(`isAllowedInSlack ${senderId}, ${chatId}, ${channelType}`)
    if (channelType === "im") {
      if (!this.config.dm.enabled) {
        this.logger.warn("DMs are disabled")
        return false;
      }
      if (this.config.dm.policy === "restricted") {
        const senderAllowed = this.config.dm.allowFrom.includes(senderId);
        this.logger.warn(`${senderId} is ${senderAllowed}`);
        return senderAllowed;
      }
      return true;
    }
    if (this.config.groupPolicy === "restricted") {
      const groupAllowed = this.config.groupAllowFrom.includes(chatId);
      this.logger.warn(`${chatId} is ${groupAllowed}`);
      return groupAllowed;
    }
    return true;
  }

  private shouldRespondInChannel(eventType: string, text: string, chatId: string): boolean {
    this.logger.debug(`shouldRespondInChannel ${eventType}, ${text}, ${chatId}`)
    if (this.config.groupPolicy === "none") {
      return true;
    }
    if (this.config.groupPolicy === "mention") {
      if (eventType === "app_mention") {
        return true;
      }
      return this.botUserId ? text.includes(`<@${this.botUserId}>`) : false;
    }
    if (this.config.groupPolicy === "restricted") {
      return this.config.groupAllowFrom.includes(chatId);
    }
    return false;
  }

  private stripBotMention(text: string): string {
    if (!text || !this.botUserId) {
      return text;
    }
    const pattern = new RegExp(`<@${this.botUserId}>\\s*`, "g");
    return text.replace(pattern, "").trim();
  }
}
