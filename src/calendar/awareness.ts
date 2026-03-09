import type { CalDavClient, CalEvent } from "./client.js";
import { Logger } from "src/utils/logger.js";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetches today's (and tomorrow's) calendar events and caches them so the
 * ContextManager can inject them into every system prompt synchronously.
 *
 * Refreshes automatically every 30 minutes.
 */
export class CalendarAwareness {
  private section = "";
  private timer?: ReturnType<typeof setInterval>;
  private logger = new Logger(CalendarAwareness.name);

  constructor(private client: CalDavClient) {}

  /** Initial fetch + start the refresh timer. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.section = "";
  }

  /** Called when CalDAV config changes — update client reference and refresh. */
  updateClient(client: CalDavClient): void {
    this.client = client;
    void this.refresh();
  }

  /** Returns the cached calendar section for injection into the system prompt. */
  getSection(): string {
    return this.section;
  }

  private async refresh(): Promise<void> {
    try {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 2); // today + tomorrow

      const events = await this.client.getEvents(start, end);
      this.section = this.format(events, now);
      this.logger.debug("Calendar awareness refreshed", { count: events.length });
    } catch (err) {
      this.logger.warn("Calendar awareness refresh failed", { error: String(err) });
      // Keep the previous cached value rather than clearing it
    }
  }

  private format(events: CalEvent[], now: Date): string {
    if (!events.length) return "";

    const todayStr = toDateStr(now);
    const tomorrowStr = toDateStr(new Date(now.getTime() + 86400000));

    const today = events.filter(e => toDateStr(new Date(e.start)) === todayStr);
    const tomorrow = events.filter(e => toDateStr(new Date(e.start)) === tomorrowStr);

    const lines: string[] = [];

    if (today.length) {
      lines.push("**Today**");
      for (const e of today) lines.push(formatEvent(e));
    }
    if (tomorrow.length) {
      lines.push("**Tomorrow**");
      for (const e of tomorrow) lines.push(formatEvent(e));
    }

    if (!lines.length) return "";
    return `# Calendar\n\n${lines.join("\n")}`;
  }
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatEvent(e: CalEvent): string {
  const time = e.allDay ? "all day" : formatTime(e.start);
  const location = e.location ? ` @ ${e.location}` : "";
  const desc = e.description ? ` — ${e.description.slice(0, 80)}` : "";
  return `- ${time} **${e.summary}**${location}${desc}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}
