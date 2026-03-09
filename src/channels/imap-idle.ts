import { ImapFlow } from "imapflow";
import { BaseChannel } from "./base.js";
import type { MessageBus } from "src/messagebus/queue.js";
import type { OutboundMessage } from "src/messagebus/events.js";
import type { ImapConfig } from "src/agent/tools/imap.js";
import { Logger } from "src/utils/logger.js";
import { getPrompt } from "src/prompts/loader.js";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

export type ImapIdleChannelConfig = {
  enabled: boolean;
  /** Mailbox to watch. Default: "INBOX" */
  mailbox: string;
  /** Agent session / conversation ID that receives email trigger messages. */
  chatId: string;
  /** Identifies this channel as the sender. Default: "imap" */
  senderId: string;
  allowFrom: string[];
  /** "none" = allow all (internal trigger); "restricted" = use allowFrom list. Default: "none". */
  policy: "none" | "restricted";
  /**
   * Where the agent should send its reply. When set, the agent routes its
   * response to this channel+chatId instead of back to imap-idle (which is
   * receive-only). Maps to `metadata.replyChannel / replyChatId` which the
   * agent already reads natively.
   */
  replyTo?: {
    channel: string;
    chatId: string;
  };
  quietHours: {
    enabled: boolean;
    /** Start of quiet period in HH:MM 24 h format, e.g. "22:00". */
    start: string;
    /** End of quiet period in HH:MM 24 h format, e.g. "07:00". */
    end: string;
    /** IANA timezone string, e.g. "Europe/Berlin". */
    timezone: string;
  };
};

/** Returns `{ hours, minutes }` for the current moment in the given IANA timezone. */
function localTime(timezone: string): { hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  return {
    hours: parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10),
    minutes: parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10)
  };
}

/**
 * Returns true when the current local time in `timezone` falls inside the
 * window defined by `start`..`end` (both HH:MM strings).
 * Handles overnight spans: "22:00"–"07:00" wraps midnight correctly.
 */
function isInQuietHours(start: string, end: string, timezone: string): boolean {
  const { hours, minutes } = localTime(timezone);
  const now = hours * 60 + minutes;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  if (startMins <= endMins) {
    // Same-day window (e.g. 02:00–08:00)
    return now >= startMins && now < endMins;
  }
  // Overnight window (e.g. 22:00–07:00)
  return now >= startMins || now < endMins;
}

/**
 * IMAP IDLE channel — maintains a persistent IMAP connection and fires an
 * agent trigger whenever new email arrives in the watched mailbox.
 *
 * The channel is a **pure trigger**: it does not fetch message content itself.
 * Instead it sends a prompt to the agent to call `imap_mail list_new`, which
 * uses the persisted `status_imap` watermark to find new messages. This keeps
 * the watermark consistent across restarts and cron-based catch-ups.
 *
 * Credentials are shared with the `tools.imap` configuration so they only
 * need to be configured once.
 *
 * `replyTo`: when set, the agent's response is automatically routed to the
 * specified channel+chatId (e.g. Slack).
 *
 * Quiet hours: during the configured window the EXISTS events are silently
 * noted via a `pendingCatchUp` flag. No in-memory buffer is used — if the
 * process restarts during quiet hours the flag resets, but `list_new` uses
 * the persisted watermark so no emails are ever permanently lost. When quiet
 * hours end the channel sends a single catch-up prompt and the agent picks up
 * any missed mail via `imap_mail list_new`.
 */
export class ImapIdleChannel extends BaseChannel<ImapIdleChannelConfig> {
  readonly name = "imap-idle";

  private client: ImapFlow | null = null;
  private readonly logger = new Logger(ImapIdleChannel.name);
  /** True when at least one email arrived during quiet hours and is waiting for catch-up. */
  private pendingCatchUp = false;
  private quietCheckTimer: NodeJS.Timeout | null = null;
  /** Debounce timer for EXISTS events — coalesces rapid-fire notifications into one check. */
  private existsDebounce: NodeJS.Timeout | null = null;
  /** Prevents concurrent checkForNewMail() runs. */
  private checking = false;
  private initializing = true;
  constructor(
    config: ImapIdleChannelConfig,
    private readonly imapConfig: ImapConfig,
    bus: MessageBus,
    private workspace: string
  ) {
    super(config, bus);
  }

  async start(): Promise<void> {
    this.running = true;
    const qh = this.config.quietHours;
    if (qh.enabled) {
      // If starting during quiet hours assume we may have missed emails
      // (e.g. a nightly reboot) and queue a catch-up for when they end.
      if (isInQuietHours(qh.start, qh.end, qh.timezone)) {
        this.pendingCatchUp = true;
        this.logger.info("Started during quiet hours — catch-up queued for when they end");
      }
      // Poll every 60 s to detect the end of quiet hours.
      this.quietCheckTimer = setInterval(() => void this.checkQuietHoursTransition(), 60_000);
    }
    void this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.quietCheckTimer) {
      clearInterval(this.quietCheckTimer);
      this.quietCheckTimer = null;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // ignore — connection may already be closed
      }
      this.client = null;
    }
  }

  /** IMAP is receive-only; agent routes replies via replyTo or tools. */
  async send(_msg: OutboundMessage): Promise<void> {
    this.logger.debug("imap-idle: outbound message dropped (receive-only channel)");
  }

  // ── Connection loop ────────────────────────────────────────────────────────

  getLastUid(host: string, account: string) {
    const persist = join(this.workspace, "status_imap");
    const cache = existsSync(persist) ? JSON.parse(readFileSync(persist, "utf8")) : {};

    cache[host] ??= {};
    cache[host][account] ??= {};
    const userdata = cache[host][account];
    const lastuid = Number(userdata.uid ?? 0);
    return lastuid;
  }

  private async runLoop(): Promise<void> {
    let delay = 5_000;
    while (this.running) {
      try {
        await this.connectAndIdle();
        delay = 5_000; // reset backoff on clean exit
      } catch (err) {
        if (!this.running) break;
        this.logger.warn("IMAP IDLE connection lost, reconnecting", {
          delay,
          error: String(err)
        });
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 300_000); // cap at 5 min
      }
    }
  }

  private async connectAndIdle(): Promise<void> {
    this.client = new ImapFlow({
      host: this.imapConfig.host,
      port: this.imapConfig.port,
      secure: this.imapConfig.tls,
      auth: { user: this.imapConfig.user, pass: this.imapConfig.password },
      logger: false
    });

    await this.client.connect();
    this.logger.info("IMAP IDLE connected", {
      host: this.imapConfig.host,
      mailbox: this.config.mailbox
    });

    const lock = await this.client.getMailboxLock(this.config.mailbox);
    try {
      this.client.on("exists", () => {
        // Debounce: the server can fire multiple EXISTS in quick succession
        // (e.g. during SELECT or when search() itself triggers a notification).
        // Wait 300 ms after the last event before running the actual check.
        if (this.existsDebounce) clearTimeout(this.existsDebounce);
        this.existsDebounce = setTimeout(() => {
          this.existsDebounce = null;
          void this.checkForNewMail();
        }, 300);
      });

      if (this.initializing) {
        // Check on connect — catches mail that arrived while the connection was down.
        await this.checkForNewMail();
        this.initializing = false;
      }
      // Blocks until connection drops or client.logout() is called.
      await this.client.idle();
    } finally {
      lock.release();
    }
  }

  /**
   * Searches the open mailbox for unseen messages above the persisted UID watermark.
   * Triggers the agent when new mail is found. Falls back to triggering unconditionally
   * if the search itself fails so no email is ever silently missed.
   */
  private async checkForNewMail(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    const lastuid = this.getLastUid(this.imapConfig.host, this.imapConfig.user);
    this.logger.debug(`checking for new mail, watermark uid=${lastuid}`);
    try {
      const unseenUids = await this.client?.search({ seen: false }, { uid: true });
      this.logger.debug(`unseen UIDs: ${JSON.stringify(unseenUids)}`);
      const newUids = (Array.isArray(unseenUids) ? unseenUids : []).filter((uid: number) => uid > lastuid);
      if (newUids.length > 0) {
        this.logger.debug(`${newUids.length} new message(s) above watermark — triggering agent`);
        await this.onExists();
      } else {
        this.logger.debug("no UIDs above watermark — skipping");
      }
    } catch (err) {
      this.logger.warn("search failed — triggering agent as fallback", { error: String(err) });
      await this.onExists();
    } finally {
      this.checking = false;
    }
  }

  // ── Event handler ──────────────────────────────────────────────────────────

  private async onExists(): Promise<void> {
    const qh = this.config.quietHours;
    if (qh.enabled && isInQuietHours(qh.start, qh.end, qh.timezone)) {
      this.logger.debug("Email arrived during quiet hours — catch-up queued");
      this.pendingCatchUp = true;
      return;
    }

    await this.triggerAgent();
  }

  // ── Agent triggers ─────────────────────────────────────────────────────────

  private replyToMeta(): Record<string, string> {
    return this.config.replyTo
      ? { replyChannel: this.config.replyTo.channel, replyChatId: this.config.replyTo.chatId }
      : {};
  }

  /** Tells the agent a new email has arrived; agent uses imap_mail list_new to fetch it. */
  private async triggerAgent(): Promise<void> {
    this.logger.info("Triggering agent for new email");
    const vars = { mailbox: this.config.mailbox };
    const content =
      getPrompt("imap-idle-trigger", vars) ??
      `New email arrived in ${this.config.mailbox}. Use imap_mail with command=list_new, mailbox="${this.config.mailbox}" to retrieve new messages.`;
    await this.handleMessage({
      senderId: this.config.senderId,
      chatId: this.config.chatId,
      content,
      metadata: { source: "imap-idle", mailbox: this.config.mailbox, ...this.replyToMeta() }
    });
  }

  /** Sent when quiet hours end; agent uses imap_mail list_new to catch up on missed mail. */
  private async triggerCatchUp(): Promise<void> {
    this.logger.info("Quiet hours ended — triggering catch-up");
    const vars = { mailbox: this.config.mailbox };
    const content =
      getPrompt("imap-idle-catchup", vars) ??
      `Quiet hours have ended. Use imap_mail with command=list_new, mailbox="${this.config.mailbox}" to check for emails that arrived during quiet hours.`;
    await this.handleMessage({
      senderId: this.config.senderId,
      chatId: this.config.chatId,
      content,
      metadata: { source: "imap-idle", mailbox: this.config.mailbox, catchUp: true, ...this.replyToMeta() }
    });
  }

  // ── Quiet hours transition ─────────────────────────────────────────────────

  private async checkQuietHoursTransition(): Promise<void> {
    const qh = this.config.quietHours;
    if (!this.pendingCatchUp) return;
    if (isInQuietHours(qh.start, qh.end, qh.timezone)) return;

    // Quiet hours just ended and at least one email arrived while they were active.
    this.pendingCatchUp = false;
    await this.triggerCatchUp();
  }
}
