import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import type { CalDavClient, CalEvent } from "src/calendar/client.js";

function formatEvent(e: CalEvent): string {
  const parts = [`• [${e.uid}] ${e.summary}`, `  When: ${e.start}${e.end ? ` → ${e.end}` : ""}`];
  if (e.location) parts.push(`  Where: ${e.location}`);
  if (e.description) parts.push(`  Note: ${e.description.slice(0, 200)}`);
  return parts.join("\n");
}

// ── calendar_list_calendars ────────────────────────────────────────────────

export class CalendarListTool extends Tool {
  constructor(private client: CalDavClient) { super(); }

  get name() { return "calendar_list_calendars"; }
  get description() { return "List all available calendars on the CalDAV server."; }
  get outputRisk() { return RiskLevel.Low; }
  get parameters(): Record<string, unknown> { return { type: "object", properties: {} }; }

  async execute(): Promise<string> {
    const cals = await this.client.listCalendars();
    if (!cals.length) return "No calendars found.";
    return cals.map((c) => `• ${c.name}${c.color ? ` (${c.color})` : ""}\n  URL: ${c.url}`).join("\n");
  }
}

// ── calendar_get_events ────────────────────────────────────────────────────

export class CalendarGetEventsTool extends Tool {
  constructor(private client: CalDavClient) { super(); }

  get name() { return "calendar_get_events"; }
  get description() { return "Get calendar events in a date range. Returns uid, title, start/end time, location, description."; }
  get outputRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        start: { type: "string", description: "Start of range — ISO date or datetime (e.g. 2024-01-01 or 2024-01-01T00:00:00Z)" },
        end:   { type: "string", description: "End of range — ISO date or datetime" },
        calendar: { type: "string", description: "Filter by calendar name (partial match). Omit for all calendars." },
      },
      required: ["start", "end"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const start = new Date(String(params["start"]));
    const end   = new Date(String(params["end"]));
    const cal   = params["calendar"] ? String(params["calendar"]) : undefined;
    const events = await this.client.getEvents(start, end, cal);
    if (!events.length) return "No events found in this range.";
    return events.map(formatEvent).join("\n\n");
  }
}

// ── calendar_create_event ──────────────────────────────────────────────────

export class CalendarCreateEventTool extends Tool {
  constructor(private client: CalDavClient) { super(); }

  get name() { return "calendar_create_event"; }
  get description() { return "Create a new calendar event. Returns the event UID."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.Low; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        summary:     { type: "string", description: "Event title" },
        start:       { type: "string", description: "Start — ISO date (2024-01-15) for all-day or datetime (2024-01-15T10:00:00Z)" },
        end:         { type: "string", description: "End — ISO date or datetime" },
        description: { type: "string", description: "Optional description / notes" },
        location:    { type: "string", description: "Optional location" },
        calendar:    { type: "string", description: "Target calendar name (partial match). Uses default if omitted." },
      },
      required: ["summary", "start", "end"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const uid = await this.client.createEvent({
      summary:     String(params["summary"]),
      start:       String(params["start"]),
      end:         String(params["end"]),
      description: params["description"] ? String(params["description"]) : undefined,
      location:    params["location"]    ? String(params["location"])    : undefined,
      calendarName: params["calendar"]   ? String(params["calendar"])   : undefined,
    });
    return `Event created. UID: ${uid}`;
  }
}

// ── calendar_update_event ──────────────────────────────────────────────────

export class CalendarUpdateEventTool extends Tool {
  constructor(private client: CalDavClient) { super(); }

  get name() { return "calendar_update_event"; }
  get description() { return "Update an existing calendar event by UID. Only provided fields are changed."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.Low; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        uid:         { type: "string", description: "Event UID (from calendar_get_events)" },
        summary:     { type: "string", description: "New title" },
        start:       { type: "string", description: "New start" },
        end:         { type: "string", description: "New end" },
        description: { type: "string", description: "New description" },
        location:    { type: "string", description: "New location" },
      },
      required: ["uid"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    await this.client.updateEvent(String(params["uid"]), {
      summary:     params["summary"]     ? String(params["summary"])     : undefined,
      start:       params["start"]       ? String(params["start"])       : undefined,
      end:         params["end"]         ? String(params["end"])         : undefined,
      description: params["description"] ? String(params["description"]) : undefined,
      location:    params["location"]    ? String(params["location"])    : undefined,
    });
    return `Event ${params["uid"]} updated.`;
  }
}

// ── calendar_delete_event ──────────────────────────────────────────────────

export class CalendarDeleteEventTool extends Tool {
  constructor(private client: CalDavClient) { super(); }

  get name() { return "calendar_delete_event"; }
  get description() { return "Permanently delete a calendar event by UID."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.Low; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        uid: { type: "string", description: "Event UID to delete" },
      },
      required: ["uid"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    await this.client.deleteEvent(String(params["uid"]));
    return `Event ${params["uid"]} deleted.`;
  }
}
