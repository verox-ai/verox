import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import type { RssService, RssTarget } from "src/rss/service.js";

// ── rss_fetch ────────────────────────────────────────────────────────────────

export class RssFetchTool extends Tool {
  constructor(private rss: RssService) { super(); }

  get name() { return "rss_fetch"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  get description() {
    return (
      "Fetch and return the latest items from any RSS or Atom feed URL. " +
      "No subscription is created — this is a one-off read. " +
      "Use this to preview a feed before subscribing, or to do ad-hoc research."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "RSS/Atom feed URL" },
        limit: { type: "number", description: "Max items to return (default 10, max 20)" },
      },
      required: ["url"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const url = String(params.url ?? "").trim();
    if (!url) return "Error: url is required";
    const limit = Math.min(Number(params.limit ?? 10), 20);
    try {
      const items = await this.rss.fetch(url, limit);
      if (items.length === 0) return "Feed returned no items.";
      const lines = items.map((item, i) =>
        `${i + 1}. **${item.title}**\n   ${item.link}${item.pubDate ? `  (${item.pubDate})` : ""}${item.summary ? `\n   ${item.summary.slice(0, 200)}` : ""}`
      );
      return `Fetched ${items.length} items:\n\n${lines.join("\n\n")}`;
    } catch (err) {
      return `Error fetching feed: ${String(err)}`;
    }
  }
}

// ── rss_subscribe ────────────────────────────────────────────────────────────

export class RssSubscribeTool extends Tool {
  constructor(private rss: RssService) { super(); }

  get name() { return "rss_subscribe"; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return (
      "Subscribe to an RSS or Atom feed. " +
      "Set manual=true (or omit schedule) to create a manual-only subscription — " +
      "no auto-check; use rss_check to fetch new items on demand (good for morning briefings). " +
      "Set a schedule to auto-deliver new items to the target channel. " +
      "Returns the subscription id. Use rss_unsubscribe to cancel."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "RSS/Atom feed URL" },
        name: { type: "string", description: "Human-readable name for this subscription (e.g. 'Hacker News')" },
        channel: { type: "string", description: "Delivery channel (e.g. 'slack', 'telegram', 'webchat'). Optional for manual subscriptions." },
        chatId: { type: "string", description: "Delivery chat ID. Optional for manual subscriptions." },
        schedule: {
          type: "string",
          description: "Cron schedule for auto-checking (e.g. '*/15 * * * *'). Omit for manual-only.",
        },
        manual: {
          type: "boolean",
          description: "If true, no cron job is created. Use rss_check to pull new items on demand. channel/chatId not required.",
        },
      },
      required: ["url", "name"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const url = String(params.url ?? "").trim();
    const name = String(params.name ?? "").trim();
    if (!url || !name) return "Error: url and name are required";

    const channel = String(params.channel ?? "").trim();
    const chatId = String(params.chatId ?? "").trim();
    const schedule = params.schedule ? String(params.schedule) : undefined;
    const manual = params.manual === true || !schedule;

    if (!manual && (!channel || !chatId)) {
      return "Error: channel and chatId are required for auto-monitored subscriptions (or set manual: true)";
    }

    const targets: RssTarget[] = channel && chatId ? [{ channel, chatId }] : [];
    const id = this.rss.subscribe({ url, name, targets, schedule, manual });
    return manual
      ? `Subscribed to "${name}" (${url}) as manual. Id: ${id}. Use rss_check with id or name to fetch new items on demand.`
      : `Subscribed to "${name}" (${url}). Id: ${id}. Auto-check schedule: ${schedule}.`;
  }
}

// ── rss_unsubscribe ──────────────────────────────────────────────────────────

export class RssUnsubscribeTool extends Tool {
  constructor(private rss: RssService) { super(); }

  get name() { return "rss_unsubscribe"; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return "Cancel an RSS subscription by id. Use rss_list to find the id.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        id: { type: "string", description: "Subscription id returned by rss_subscribe" },
      },
      required: ["id"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const id = String(params.id ?? "").trim();
    if (!id) return "Error: id is required";
    const ok = this.rss.unsubscribe(id);
    return ok ? `Unsubscribed from ${id}.` : `No subscription found with id: ${id}`;
  }
}

// ── rss_check ────────────────────────────────────────────────────────────────

export class RssCheckTool extends Tool {
  constructor(private rss: RssService) { super(); }

  get name() { return "rss_check"; }
  get outputRisk(): RiskLevel { return RiskLevel.High; }

  get description() {
    return (
      "Immediately check one or all RSS subscriptions for new items. " +
      "Returns new items as text so you can include them in a briefing or summary. " +
      "New items are marked as seen (they won't appear again unless reset). " +
      "Use id=\"all\" to check every subscription at once — great for morning briefings. " +
      "Works for both auto-monitored and manual (schedule-free) subscriptions."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Subscription id to check, or \"all\" to check every subscription.",
        },
        name: {
          type: "string",
          description: "Subscription name to check (case-insensitive alternative to id).",
        },
      },
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const id = String(params.id ?? "").trim();
    const name = String(params.name ?? "").trim();
    const lookup = id || name;
    if (!lookup) return "Error: provide id, name, or id=\"all\"";
    try {
      return await this.rss.checkNow(lookup);
    } catch (err) {
      return `Error checking feed: ${String(err)}`;
    }
  }
}

// ── rss_list ─────────────────────────────────────────────────────────────────

export class RssListTool extends Tool {
  constructor(private rss: RssService) { super(); }

  get name() { return "rss_list"; }
  get outputRisk(): RiskLevel { return RiskLevel.None; }

  get description() {
    return "List all active RSS subscriptions — id, name, URL, schedule, targets, and last check time.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  async execute(_params: Record<string, unknown>): Promise<string> {
    const subs = this.rss.list();
    if (subs.length === 0) return "No RSS subscriptions active.";
    const lines = subs.map(s =>
      `**${s.name}** (id: ${s.id})\n  URL: ${s.url}\n  Schedule: ${s.schedule}\n  Targets: ${s.targets.map(t => `${t.channel}:${t.chatId}`).join(", ")}\n  Last checked: ${s.lastChecked ?? "never"}`
    );
    return `${subs.length} active subscription(s):\n\n${lines.join("\n\n")}`;
  }
}
