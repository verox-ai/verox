import { injectable, inject } from "tsyringe";
import type { BaseChannel } from "./base.js";
import { SessionManager } from "../session/manager.js";
import type { ExtensionChannelRegistration } from "../extensions/types.js";
import { MessageBus } from "src/messagebus/queue.js";
import { ExtensionChannelAdapter } from "./extension-channel.js";
import { OutboundMessage } from "src/messagebus/events.js";
import { TelegramChannel } from "./telegram.js";
import { WebChatChannel } from "./webchat.js";
import { WebhookChannel } from "./webhook.js";
import { WhatsAppChannel } from "./whatsapp.js";
import { Logger } from "src/utils/logger.js";
import { SlackChannel } from "./slack.js";
import { ImapIdleChannel } from "./imap-idle.js";
import { ConfigService } from "src/config/service.js";
import { VaultService } from "src/vault/credentials.js";
import { MemoryService } from "src/memory/service.js";
import { CronService } from "src/cron/service.js";
import { Agent } from "src/agent/agent.js";
import type { Config } from "src/types/schemas/schema.js";
import http from "node:http";

@injectable()
export class ChannelManager {
  private channels: Record<string, BaseChannel<Record<string, unknown>>> = {};
  private extensionChannels: ExtensionChannelRegistration[] = [];
  private dispatchTask: Promise<void> | null = null;
  private dispatching = false;
  private logger = new Logger(ChannelManager.name);
  private httpServer: http.Server | null = null;
  private lastChannelsCfgJson = "";

  constructor(
    @inject(ConfigService) private configService: ConfigService,
    @inject(MessageBus) private bus: MessageBus,
    @inject(SessionManager) private sessionManager: SessionManager,
    @inject("workspace") private workspace: string,
    @inject(VaultService) private vaultService: VaultService,
    @inject(MemoryService) private memoryService: MemoryService,
    @inject(CronService) private cronService: CronService,
    @inject(Agent) private agent: Agent
  ) {
    this.initChannels();
    configService.onConfigChange(cfg => { void this.onConfigChange(cfg); });
  }

  /** Called by APIService after the HTTP server is created so webchat can be reconnected on hot-reload. */
  setHttpServer(server: http.Server): void {
    this.httpServer = server;
  }

  private async onConfigChange(newCfg: Config): Promise<void> {
    const newJson = JSON.stringify(newCfg.channels);
    if (newJson === this.lastChannelsCfgJson) return;
    const oldChannelsCfgJson = this.lastChannelsCfgJson;
    this.lastChannelsCfgJson = newJson;
    this.logger.info("Channel config changed — applying hot-reload");

    // Webchat: update token in-place without restarting to preserve live WS connections.
    // Only fully restart if the enabled flag flipped.
    const oldWebchat = this.channels["webchat"] as WebChatChannel | undefined;
    const newWebchatCfg = newCfg.channels.webchat;
    if (oldWebchat && newWebchatCfg.enabled) {
      oldWebchat.updateConfig(newWebchatCfg);
    } else if (!oldWebchat && newWebchatCfg.enabled && this.httpServer && this.dispatching) {
      // Webchat newly enabled while server is already running.
      const ch = new WebChatChannel(newWebchatCfg, this.bus, this.sessionManager);
      this.channels["webchat"] = ch;
      await ch.connectWebChat(this.httpServer);
    } else if (oldWebchat && !newWebchatCfg.enabled) {
      delete this.channels["webchat"];
      await oldWebchat.stop();
    }

    // All other channels: stop+restart if config changed or enabled state flipped.
    await this.hotReloadChannel("telegram",  newCfg, () => newCfg.channels.telegram.enabled,
      () => new TelegramChannel(newCfg.channels.telegram, this.bus, this.sessionManager), oldChannelsCfgJson);
    await this.hotReloadChannel("slack",     newCfg, () => newCfg.channels.slack.enabled,
      () => new SlackChannel(newCfg.channels.slack, this.bus), oldChannelsCfgJson);
    await this.hotReloadChannel("webhook",   newCfg, () => newCfg.channels.webhook.enabled,
      () => new WebhookChannel(newCfg.channels.webhook, this.bus, this.sessionManager), oldChannelsCfgJson);
    await this.hotReloadChannel("imapIdle",  newCfg, () => newCfg.channels.imapIdle.enabled,
      () => new ImapIdleChannel(newCfg.channels.imapIdle, newCfg.tools.imap, this.bus, this.workspace), oldChannelsCfgJson);
    await this.hotReloadChannel("whatsapp",  newCfg, () => newCfg.channels.whatsapp.enabled,
      () => new WhatsAppChannel(newCfg.channels.whatsapp, this.bus, this.sessionManager, this.workspace), oldChannelsCfgJson);
  }

  private async hotReloadChannel(
    key: string,
    newCfg: Config,
    isEnabled: () => boolean,
    factory: () => BaseChannel<Record<string, unknown>>,
    oldChannelsCfgJson = "",
  ): Promise<void> {
    const existing = this.channels[key];
    const enabled = isEnabled();
    const oldChannelsCfg = oldChannelsCfgJson ? JSON.parse(oldChannelsCfgJson) as Record<string, unknown> : {};
    const cfgChanged = existing &&
      JSON.stringify((newCfg.channels as Record<string, unknown>)[key]) !==
      JSON.stringify(oldChannelsCfg[key]);

    if (existing && (!enabled || cfgChanged)) {
      delete this.channels[key];
      try { await existing.stop(); } catch { /* ignore */ }
    }
    if (enabled && (!existing || cfgChanged)) {
      const ch = factory();
      this.channels[key] = ch;
      if (this.dispatching) {
        try { await ch.start(); } catch (err) {
          this.logger.error(`Failed to start ${key} after config change`, { error: String(err) });
        }
      }
    }
  }

  /** Registers a plugin-provided channel. Must be called before `startAll()`. */
  registerExtensionChannel(registration: ExtensionChannelRegistration): void {
    this.extensionChannels.push(registration);
  }

  private get config() {
    return this.configService.app;
  }

  private initChannels(): void {
    this.lastChannelsCfgJson = JSON.stringify(this.config.channels);
    this.logger.info("Init Channels");
    if (this.config.channels.telegram.enabled) {
      this.logger.info("Init Telegram");
      const channel = new TelegramChannel(
        this.config.channels.telegram,
        this.bus,
        this.sessionManager
      );
      this.channels.telegram = channel;
    }

    if (this.config.channels.webchat.enabled) {
      this.logger.info("Init WebChat", { port: this.config.channels.webchat.port });
      this.channels.webchat = new WebChatChannel(
        this.config.channels.webchat,
        this.bus,
        this.sessionManager
      );
    }

    if (this.config.channels.slack.enabled) {
      const channel = new SlackChannel(this.config.channels.slack, this.bus);
      this.channels.slack = channel;
    }

    if (this.config.channels.webhook.enabled) {
      this.logger.info("Init Webhook", { port: this.config.channels.webhook.port });
      const channel = new WebhookChannel(this.config.channels.webhook, this.bus, this.sessionManager);
      this.channels.webhook = channel;
    }

    if (this.config.channels.imapIdle.enabled) {
      this.logger.info("Init IMAP IDLE", { mailbox: this.config.channels.imapIdle.mailbox });
      this.channels.imapIdle = new ImapIdleChannel(
        this.config.channels.imapIdle,
        this.config.tools.imap,
        this.bus,
        this.workspace
      );
    }

    if (this.config.channels.whatsapp.enabled) {
      this.logger.info("Init WhatsApp");
      this.channels.whatsapp = new WhatsAppChannel(
        this.config.channels.whatsapp,
        this.bus,
        this.sessionManager,
        this.workspace
      );
    }

    for (const registration of this.extensionChannels) {
      const id = registration.channel.id;
      if (!id) {
        continue;
      }
      if (this.channels[id]) {
          this.logger.warn(`Extension channel ignored because id already exists: ${id}`);
        continue;
      }
      this.channels[id] = new ExtensionChannelAdapter(this.config, this.bus, registration);
    }
  }

  private async startChannel(name: string, channel: BaseChannel<Record<string, unknown>>): Promise<void> {
    try {
      await channel.start();
    } catch (err) {
      this.logger.error(`Failed to start channel ${name}`, { error: String(err) });
    }
  }

  /** Starts all enabled channels and begins dispatching outbound messages. */
  async startAll(): Promise<void> {
    if (!Object.keys(this.channels).length) {
      return;
    }
    this.dispatching = true;
    this.dispatchTask = this.dispatchOutbound();
    const tasks = Object.entries(this.channels).map(([name, channel]) => this.startChannel(name, channel));
    await Promise.allSettled(tasks);
  }

  /** Gracefully stops the outbound dispatcher and all channels. */
  async stopAll(): Promise<void> {
    this.dispatching = false;
    await this.bus.publishOutbound({
      channel: "__control__",
      chatId: "",
      content: "",
      media: [],
      metadata: { reason: "shutdown" }
    });
    if (this.dispatchTask) {
      await this.dispatchTask;
    }
    const tasks = Object.entries(this.channels).map(async ([name, channel]) => {
      try {
        await channel.stop();
      } catch (err) {
        this.logger.error(`Error stopping ${name}`, { error: String(err) });
      }
    });
    await Promise.allSettled(tasks);
  }

  private async dispatchOutbound(): Promise<void> {
    while (this.dispatching) {
      const msg = await this.bus.consumeOutbound();
      const channel = this.channels[msg.channel];
      if (!channel) {
        continue;
      }
      try {
        await channel.send(msg as OutboundMessage);
      } catch (err) {
        this.logger.error(`Error sending to ${msg.channel}`, { error: String(err) });
      }
    }
  }

  /** Returns the channel instance for `name`, or `undefined` if not registered. */
  getChannel(name: string): BaseChannel<Record<string, unknown>> | undefined {
    return this.channels[name];
  }

  /** Returns the current WhatsApp connection state, including QR code data URL when pending auth. */
  getWhatsAppStatus(): { enabled: boolean; authenticated: boolean; qr: string | null } {
    const ch = this.channels["whatsapp"] as WhatsAppChannel | undefined;
    if (!ch) return { enabled: false, authenticated: false, qr: null };
    const qr = ch.getQRDataURL();
    return { enabled: true, authenticated: qr === null, qr };
  }

  /** Returns a status map of all registered channels: `{ enabled, running }` per channel name. */
  getStatus(): Record<string, { enabled: boolean; running: boolean }> {
    return Object.fromEntries(
      Object.entries(this.channels).map(([name, channel]) => [name, { enabled: true, running: channel.isRunning }])
    );
  }

  /** Names of all currently registered (enabled) channels. */
  get enabledChannels(): string[] {
    return Object.keys(this.channels);
  }
}