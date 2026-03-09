import { BaseChannel } from "./base.js";
import { MessageBus } from "src/messagebus/queue.js";
import { SessionManager } from "src/session/manager.js";
import { OutboundMessage } from "src/messagebus/events.js";
import { Logger } from "src/utils/logger.js";
import { Config } from "src/types/schemas/schema.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import qrcode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import type { WASocket, AuthenticationState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

type WhatsAppConfig = Config["channels"]["whatsapp"];

export class WhatsAppChannel extends BaseChannel<WhatsAppConfig> {
  name = "whatsapp";

  private socket: WASocket | null = null;
  private qrDataURL: string | null = null;
  private authState: { state: AuthenticationState; saveCreds: () => Promise<void> } | null = null;
  private sessionDir: string;
  private logger = new Logger(WhatsAppChannel.name);
  private shouldReconnect = true;

  constructor(
    config: WhatsAppConfig,
    bus: MessageBus,
    sessionManager: SessionManager,
    workspace: string
  ) {
    super(config, bus, sessionManager);
    this.sessionDir = join(workspace, "whatsapp", "session");
  }

  async start(): Promise<void> {
    this.running = true;
    this.shouldReconnect = true;
    mkdirSync(this.sessionDir, { recursive: true });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.running = false;
    this.socket?.end(undefined);
    this.socket = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.socket) {
      this.logger.warn("WhatsApp socket not ready, dropping message");
      return;
    }
    // chatId is stored as the JID (e.g. "14155552671@s.whatsapp.net" or group JID)
    const jid = msg.chatId.includes("@") ? msg.chatId : `${msg.chatId}@s.whatsapp.net`;
    try {
      await this.socket.sendMessage(jid, { text: msg.content ?? "" });
    } catch (err) {
      this.logger.error("WhatsApp send error", { error: String(err) });
    }
  }

  /** Returns the current QR code as a data URL, or null if already authenticated. */
  getQRDataURL(): string | null {
    return this.qrDataURL;
  }

  /** True once the WhatsApp session is authenticated and connected. */
  get isAuthenticated(): boolean {
    return this.socket !== null && this.qrDataURL === null;
  }

  private async connect(): Promise<void> {
    this.authState = await useMultiFileAuthState(this.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      auth: this.authState.state,
      printQRInTerminal: true, // also print in terminal for convenience
      logger: {
        level: "silent",
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (msg: unknown) => this.logger.debug("baileys warn", { msg }),
        error: (msg: unknown) => this.logger.warn("baileys error", { msg }),
        fatal: (msg: unknown) => this.logger.error("baileys fatal", { msg }),
        child: () => ({ level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) as never }),
      } as never,
    });

    this.socket.ev.on("creds.update", () => {
      void this.authState?.saveCreds();
    });

    this.socket.ev.on("connection.update", (update) => {
      void this.onConnectionUpdate(update);
    });

    this.socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        void this.onIncomingMessage(msg);
      }
    });
  }

  private async onConnectionUpdate(update: {
    connection?: string;
    lastDisconnect?: { error?: Error };
    qr?: string;
  }): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        this.qrDataURL = await qrcode.toDataURL(qr);
        this.logger.info("WhatsApp QR code ready — scan to link your phone (or GET /api/whatsapp/qr)");
      } catch (err) {
        this.logger.error("Failed to generate QR data URL", { error: String(err) });
      }
    }

    if (connection === "open") {
      this.qrDataURL = null; // authenticated — QR no longer needed
      this.logger.info("WhatsApp connected");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        this.logger.warn("WhatsApp logged out — deleting session, will need to re-scan QR");
        // Clear auth state so next connect generates a fresh QR
        this.authState = null;
        this.socket = null;
      } else {
        this.logger.warn("WhatsApp disconnected, reconnecting...", { statusCode });
      }

      if (this.shouldReconnect) {
        setTimeout(() => {
          void this.connect();
        }, 3000);
      }
    }
  }

  private async onIncomingMessage(rawMsg: Record<string, unknown>): Promise<void> {
    this.logger.debug(`Message from ${JSON.stringify(rawMsg)}`)
    const key = rawMsg.key as Record<string, unknown> | undefined;
    if (!key) return;

    const fromMe = !!key.fromMe;
    const remoteJid = key.remoteJid as string | undefined;
    if (!remoteJid) return;

    // Extract text content
    const message = rawMsg.message as Record<string, unknown> | undefined;
    if (!message) return;

    const text =
      (message.conversation as string | undefined) ??
      (message.extendedTextMessage as Record<string, unknown> | undefined)?.text as string | undefined ??
      (message.imageMessage as Record<string, unknown> | undefined)?.caption as string | undefined;

    if (!text) return;

    // Sender: for groups, use participant; for DMs, use remoteJid
    const isGroup = remoteJid.endsWith("@g.us");
    const senderJid = isGroup
      ? (key.participant as string | undefined) ?? remoteJid
      : remoteJid;

    // Messages sent from the linked account itself are always allowed —
    // the user is messaging the bot from their own phone.
    if (!fromMe) {
      const senderNumber = senderJid.replace("@s.whatsapp.net", "").replace("@g.us", "");
      if (!this.isAllowed(`${senderNumber}|${senderJid}`)) {
        this.logger.warn("WhatsApp message from disallowed sender", { senderJid });
        return;
      }
    }

    this.logger.debug("WhatsApp incoming", { from: senderJid, chat: remoteJid });

    await this.handleMessage({
      senderId: senderJid,
      chatId: remoteJid,
      content: text,
      metadata: {
        isGroup,
        messageId: key.id,
        participant: key.participant,
      },
    });
  }
}
