import { DAVClient } from "tsdav";
import { Logger } from "src/utils/logger.js";
import { randomUUID } from "node:crypto";

export interface CalDavConfig {
  serverUrl: string;
  username: string;
  password: string;
  defaultCalendar?: string;
}

export interface CalEvent {
  uid: string;
  url: string;
  etag?: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  allDay: boolean;
}

// ── iCal utilities ──────────────────────────────────────────────────────────

function parseICalDate(val: string): { date: string; allDay: boolean } {
  if (!val) return { date: "", allDay: false };
  // Strip params like VALUE=DATE or TZID=...
  const raw = val.includes(":") ? val.split(":").pop()! : val;
  if (raw.length === 8) {
    // DATE only — all-day
    return { date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, allDay: true };
  }
  // DATETIME
  const d = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const t = `${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}`;
  const utc = raw.endsWith("Z") ? "Z" : "";
  return { date: `${d}T${t}${utc}`, allDay: false };
}

function parseVEvent(icalStr: string): Omit<CalEvent, "url" | "etag"> | null {
  // Unfold continuation lines (RFC 5545 §3.1)
  const unfolded = icalStr.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  let inEvent = false;
  const props: Record<string, string> = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { inEvent = true; continue; }
    if (line === "END:VEVENT") { break; }
    if (!inEvent) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    // Strip property parameters (e.g. DTSTART;TZID=America/New_York)
    const propKey = line.slice(0, colon).split(";")[0].toUpperCase();
    const propVal = line.slice(colon + 1);
    props[propKey] = propVal;
  }

  if (!props["UID"] && !props["SUMMARY"]) return null;

  const startRaw = props["DTSTART"] ?? "";
  const endRaw = props["DTEND"] ?? props["DUE"] ?? "";
  const { date: start, allDay } = parseICalDate(startRaw);
  const { date: end } = parseICalDate(endRaw);

  return {
    uid: props["UID"] ?? "",
    summary: props["SUMMARY"] ?? "(no title)",
    start,
    end,
    description: props["DESCRIPTION"]?.replace(/\\n/g, "\n").replace(/\\,/g, ",") || undefined,
    location: props["LOCATION"] || undefined,
    allDay,
  };
}

function toICalDate(iso: string): { prop: string; value: string } {
  if (iso.length === 10) {
    // all-day: 2024-01-15 → DTSTART;VALUE=DATE:20240115
    return { prop: "VALUE=DATE", value: iso.replace(/-/g, "") };
  }
  // datetime: strip dashes/colons; keep trailing Z if present
  const clean = iso.replace(/[-:]/g, "").replace("T", "T");
  return { prop: "", value: clean };
}

function buildICalString(fields: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
}): string {
  const now = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const dtStart = toICalDate(fields.start);
  const dtEnd = toICalDate(fields.end);
  const startProp = dtStart.prop ? `DTSTART;${dtStart.prop}:${dtStart.value}` : `DTSTART:${dtStart.value}`;
  const endProp = dtEnd.prop ? `DTEND;${dtEnd.prop}:${dtEnd.value}` : `DTEND:${dtEnd.value}`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Verox//CalDAV Tool//EN",
    "BEGIN:VEVENT",
    `UID:${fields.uid}`,
    `DTSTAMP:${now}`,
    startProp,
    endProp,
    `SUMMARY:${fields.summary}`,
  ];
  if (fields.description) lines.push(`DESCRIPTION:${fields.description.replace(/\n/g, "\\n")}`);
  if (fields.location) lines.push(`LOCATION:${fields.location}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

// ── CalDAV client wrapper ───────────────────────────────────────────────────

export class CalDavClient {
  private dav: DAVClient | null = null;
  private logger = new Logger(CalDavClient.name);
  private config: CalDavConfig;

  constructor(config: CalDavConfig) {
    this.config = config;
  }

  /**
   * Updates credentials/URL and drops the current connection so the next
   * operation reconnects with the new values.
   */
  updateConfig(config: CalDavConfig): void {
    const changed =
      config.serverUrl !== this.config.serverUrl ||
      config.username !== this.config.username ||
      config.password !== this.config.password;
    this.config = config;
    if (changed) {
      this.dav = null;
      this.logger.info("CalDAV config changed — will reconnect on next use");
    }
  }

  private async getClient(): Promise<DAVClient> {
    if (this.dav) return this.dav;
    this.logger.info("CalDAV connecting", {
      serverUrl: this.config.serverUrl,
      username: this.config.username,
      hasPassword: !!this.config.password,
    });
    if (!this.config.serverUrl) throw new Error("CalDAV serverUrl is not configured");
    if (!this.config.username) throw new Error("CalDAV username is not configured");
    if (!this.config.password) throw new Error("CalDAV password is not configured");

    const client = new DAVClient({
      serverUrl: this.config.serverUrl,
      credentials: { username: this.config.username, password: this.config.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    try {
      await client.login();
    } catch (err) {
      this.logger.error("CalDAV login failed", {
        serverUrl: this.config.serverUrl,
        username: this.config.username,
        error: String(err),
      });
      throw err;
    }
    this.logger.info("CalDAV login successful", { serverUrl: this.config.serverUrl });
    this.dav = client;
    return client;
  }

  async listCalendars(): Promise<Array<{ name: string; url: string; color?: string }>> {
    const client = await this.getClient();
    this.logger.debug("CalDAV fetching calendars");
    const cals = await client.fetchCalendars();
    this.logger.info(`CalDAV found ${cals.length} calendar(s)`, {
      names: cals.map((c) => (typeof c.displayName === "string" ? c.displayName : c.url)),
    });
    return cals.map((c) => ({
      name: typeof c.displayName === "string" ? c.displayName : (c.displayName as Record<string, unknown>)?._cdata as string ?? c.url,
      url: c.url,
      color: c.calendarColor,
    }));
  }

  /** Get events within a time range. Optionally filter by calendar display name. */
  async getEvents(start: Date, end: Date, calendarName?: string): Promise<CalEvent[]> {
    const client = await this.getClient();
    const allCals = await client.fetchCalendars();
    this.logger.debug(`CalDAV getEvents: ${allCals.length} calendar(s), range ${start.toISOString()} → ${end.toISOString()}, filter="${calendarName ?? "*"}"`);

    const targetCals = calendarName
      ? allCals.filter((c) => {
          const name = typeof c.displayName === "string" ? c.displayName : "";
          return name.toLowerCase().includes(calendarName.toLowerCase());
        })
      : allCals;

    if (calendarName && targetCals.length === 0) {
      this.logger.warn(`CalDAV: no calendar matched name filter "${calendarName}". Available: ${allCals.map(c => typeof c.displayName === "string" ? c.displayName : c.url).join(", ")}`);
    }

    const events: CalEvent[] = [];
    for (const cal of targetCals) {
      const calName = typeof cal.displayName === "string" ? cal.displayName : cal.url;
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start: start.toISOString(), end: end.toISOString() },
        });
        this.logger.debug(`CalDAV "${calName}": ${objects.length} object(s) in range`);
        for (const obj of objects) {
          const parsed = parseVEvent(obj.data ?? "");
          if (parsed) {
            events.push({ ...parsed, url: obj.url, etag: obj.etag });
          } else {
            this.logger.debug(`CalDAV "${calName}": skipped unparseable object ${obj.url}`);
          }
        }
      } catch (err) {
        this.logger.warn(`CalDAV could not fetch events from "${calName}": ${String(err)}`);
      }
    }

    this.logger.info(`CalDAV getEvents: returning ${events.length} event(s)`);
    return events.sort((a, b) => a.start.localeCompare(b.start));
  }

  async createEvent(fields: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    calendarName?: string;
  }): Promise<string> {
    const client = await this.getClient();
    this.logger.debug("CalDAV createEvent", { summary: fields.summary, start: fields.start, end: fields.end });
    const allCals = await client.fetchCalendars();
    const targetName = fields.calendarName ?? this.config.defaultCalendar;
    const cal = targetName
      ? allCals.find((c) => {
          const n = typeof c.displayName === "string" ? c.displayName : "";
          return n.toLowerCase().includes(targetName.toLowerCase());
        }) ?? allCals[0]
      : allCals[0];

    if (!cal) {
      this.logger.error("CalDAV createEvent: no calendar found", {
        targetName: fields.calendarName ?? this.config.defaultCalendar,
        available: allCals.map(c => typeof c.displayName === "string" ? c.displayName : c.url),
      });
      throw new Error("No calendar found");
    }

    const uid = `${randomUUID()}@verox`;
    const ical = buildICalString({ ...fields, uid });
    this.logger.debug("CalDAV createEvent: writing to calendar", { calendar: cal.url, uid });
    await client.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString: ical });
    this.logger.info("CalDAV event created", { uid, summary: fields.summary });
    return uid;
  }

  async updateEvent(uid: string, changes: {
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
  }): Promise<void> {
    const client = await this.getClient();
    this.logger.debug("CalDAV updateEvent", { uid, changes });
    const allCals = await client.fetchCalendars();
    for (const cal of allCals) {
      const objects = await client.fetchCalendarObjects({ calendar: cal });
      const target = objects.find((o) => o.data?.includes(`UID:${uid}`));
      if (!target) continue;

      const existing = parseVEvent(target.data ?? "");
      if (!existing) throw new Error("Could not parse existing event");

      const merged = {
        uid,
        summary: changes.summary ?? existing.summary,
        start: changes.start ?? existing.start,
        end: changes.end ?? existing.end,
        description: changes.description ?? existing.description,
        location: changes.location ?? existing.location,
      };
      const ical = buildICalString(merged);
      await client.updateCalendarObject({ calendarObject: { url: target.url, etag: target.etag, data: ical } });
      this.logger.info("CalDAV event updated", { uid });
      return;
    }
    this.logger.warn(`CalDAV updateEvent: UID not found across ${allCals.length} calendar(s)`, { uid });
    throw new Error(`Event with UID ${uid} not found`);
  }

  async deleteEvent(uid: string): Promise<void> {
    const client = await this.getClient();
    this.logger.debug("CalDAV deleteEvent", { uid });
    const allCals = await client.fetchCalendars();
    for (const cal of allCals) {
      const objects = await client.fetchCalendarObjects({ calendar: cal });
      const target = objects.find((o) => o.data?.includes(`UID:${uid}`));
      if (!target) continue;
      await client.deleteCalendarObject({ calendarObject: { url: target.url, etag: target.etag } });
      this.logger.info("CalDAV event deleted", { uid });
      return;
    }
    this.logger.warn(`CalDAV deleteEvent: UID not found across ${allCals.length} calendar(s)`, { uid });
    throw new Error(`Event with UID ${uid} not found`);
  }
}
