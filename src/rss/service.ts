import { injectable, inject } from "tsyringe";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Parser from "rss-parser";
import { Logger } from "src/utils/logger.js";
import { Agent } from "src/agent/agent.js";
import { MessageBus } from "src/messagebus/queue.js";
import { CronJob } from "cron";

export type RssTarget = { channel: string; chatId: string };

export type RssSubscription = {
  id: string;
  url: string;
  name: string;
  targets: RssTarget[];
  /** ISO string of last successful check */
  lastChecked?: string;
  /** Set of GUIDs already seen (stored as array on disk) */
  seenGuids: string[];
  /** Cron schedule. Empty string or omitted = manual-only (no auto-check). */
  schedule: string;
  /** If true, no cron job is started — agent triggers checks manually via rss_check. */
  manual?: boolean;
};

type PersistedSubscription = RssSubscription;

@injectable()
export class RssService {
  private readonly logger = new Logger(RssService.name);
  private readonly persistPath: string;
  private subscriptions = new Map<string, RssSubscription>();
  private jobs = new Map<string, CronJob>();
  private readonly parser = new Parser({ timeout: 10_000 });

  constructor(
    @inject(Agent) private agent: Agent,
    @inject(MessageBus) private bus: MessageBus,
    @inject("workspace") private workspace: string,
  ) {
    this.persistPath = join(workspace, "rss", "subscriptions.json");
  }

  /** Load persisted subscriptions and start their cron jobs. */
  load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, "utf-8")) as PersistedSubscription[];
      for (const entry of raw) {
        this.subscriptions.set(entry.id, entry);
        if (!entry.manual && entry.schedule) this.startJob(entry.id);
      }
      this.logger.info("RSS subscriptions loaded", { count: raw.length });
    } catch (err) {
      this.logger.warn("Failed to restore RSS subscriptions", { error: String(err) });
    }
  }

  /** Subscribe to an RSS feed. Returns the new subscription id. */
  subscribe(params: {
    id?: string;
    url: string;
    name: string;
    targets?: RssTarget[];
    schedule?: string;
    manual?: boolean;
  }): string {
    const id = params.id ?? `rss_${Date.now()}`;
    if (this.jobs.has(id)) this.stopJob(id);

    const manual = params.manual ?? !params.schedule;
    const sub: RssSubscription = {
      id,
      url: params.url,
      name: params.name,
      targets: params.targets ?? [],
      seenGuids: [],
      schedule: params.schedule ?? "",
      manual,
    };
    this.subscriptions.set(id, sub);
    if (!manual && sub.schedule) this.startJob(id);
    this.save();
    return id;
  }

  /** Update an existing subscription. Returns false if not found. */
  update(id: string, patch: Partial<Pick<RssSubscription, "url" | "name" | "targets" | "schedule" | "manual">>): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;
    if (patch.url !== undefined) sub.url = patch.url;
    if (patch.name !== undefined) sub.name = patch.name;
    if (patch.targets !== undefined) sub.targets = patch.targets;
    if (patch.manual !== undefined) sub.manual = patch.manual;
    if (patch.schedule !== undefined) sub.schedule = patch.schedule;
    // Restart cron job if schedule/manual changed
    this.stopJob(id);
    if (!sub.manual && sub.schedule) this.startJob(id);
    this.save();
    return true;
  }

  /** Unsubscribe from a feed. Returns true if found. */
  unsubscribe(id: string): boolean {
    if (!this.subscriptions.has(id)) return false;
    this.stopJob(id);
    this.subscriptions.delete(id);
    this.save();
    return true;
  }

  /** List all subscriptions (without seenGuids to keep it concise). */
  list(): Array<Omit<RssSubscription, "seenGuids">> {
    return [...this.subscriptions.values()].map(({ seenGuids: _sg, ...rest }) => rest);
  }

  /** Immediately fetch a feed and return the latest items (no side-effects, no filtering). */
  async fetch(url: string, limit = 10): Promise<Array<{ title: string; link: string; pubDate?: string; summary?: string }>> {
    const feed = await this.parser.parseURL(url);
    return (feed.items ?? []).slice(0, limit).map(item => ({
      title: item.title ?? "(no title)",
      link: item.link ?? "",
      pubDate: item.pubDate ?? item.isoDate,
      summary: item.contentSnippet ?? item.summary ?? "",
    }));
  }

  /**
   * Immediately checks a subscription for new items and returns them as a formatted
   * string — without publishing to the bus. Intended for agent-driven briefings.
   * Accepts an id, a name (case-insensitive), or "all" to aggregate all subscriptions.
   */
  async checkNow(idOrName: string): Promise<string> {
    if (idOrName === "all") {
      const results: string[] = [];
      for (const sub of this.subscriptions.values()) {
        const r = await this._checkReturn(sub.id);
        if (r) results.push(r);
      }
      return results.length ? results.join("\n\n---\n\n") : "No new items across all subscriptions.";
    }
    // Look up by id first, then by name (case-insensitive)
    const sub = this.subscriptions.get(idOrName)
      ?? [...this.subscriptions.values()].find(s => s.name.toLowerCase() === idOrName.toLowerCase());
    if (!sub) return `No subscription found with id or name: ${idOrName}`;
    const r = await this._checkReturn(sub.id);
    return r ?? `No new items in **${sub.name}**.`;
  }

  stopAll(): void {
    for (const id of this.jobs.keys()) this.stopJob(id);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private startJob(id: string): void {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    const job = new CronJob(sub.schedule, () => { void this.check(id); });
    this.jobs.set(id, job);
    job.start();
  }

  private stopJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) { job.stop(); this.jobs.delete(id); }
  }

  /** Auto-check triggered by cron — fetches new items and publishes via bus. */
  private async check(id: string): Promise<void> {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    try {
      const formatted = await this._checkReturn(id);
      if (!formatted) return; // no new items

      const prompt = `${formatted}\n\nBriefly notify the user about these new items. Keep it concise.`;
      const firstTarget = sub.targets[0];
      const response = await this.agent.processDirect({
        content: prompt,
        channel: firstTarget?.channel ?? "system",
        chatId: firstTarget?.chatId ?? "rss",
        sessionKey: `rss:${id}`,
        metadata: { sessionless: true },
      });
      if (!response) return;

      for (const target of sub.targets) {
        await this.bus.publishOutbound({
          channel: target.channel,
          chatId: target.chatId,
          content: response,
          media: [],
          metadata: { source: "rss", rssId: id },
        });
      }
    } catch (err) {
      this.logger.error("RSS check failed", { id, url: sub.url, error: String(err) });
    }
  }

  /**
   * Fetches new items for a subscription, marks them seen, and returns a formatted
   * summary string — or null if nothing new. Shared by check() and checkNow().
   */
  private async _checkReturn(id: string): Promise<string | null> {
    const sub = this.subscriptions.get(id);
    if (!sub) return null;

    const feed = await this.parser.parseURL(sub.url);
    const items = feed.items ?? [];

    const newItems = items.filter(item => {
      const guid = item.guid ?? item.link ?? item.title ?? "";
      return guid && !sub.seenGuids.includes(guid);
    });

    sub.lastChecked = new Date().toISOString();

    if (newItems.length === 0) {
      this.save();
      return null;
    }

    for (const item of newItems) {
      const guid = item.guid ?? item.link ?? item.title ?? "";
      if (guid) sub.seenGuids.push(guid);
    }
    if (sub.seenGuids.length > 2000) sub.seenGuids = sub.seenGuids.slice(-1000);
    this.save();

    const lines = newItems.slice(0, 10).map(item =>
      `- **${item.title ?? "(no title)"}**${item.link ? `\n  ${item.link}` : ""}`
    ).join("\n");

    return `New items in **${sub.name}** (${newItems.length} new):\n\n${lines}`;
  }

  private save(): void {
    try {
      mkdirSync(join(this.persistPath, ".."), { recursive: true });
      const data: PersistedSubscription[] = [...this.subscriptions.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      this.logger.warn("Failed to persist RSS subscriptions", { error: String(err) });
    }
  }
}
