import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { CalDavClient } from "src/calendar/client.js";
import {
  CalendarCreateEventTool,
  CalendarDeleteEventTool,
  CalendarGetEventsTool,
  CalendarListTool,
  CalendarUpdateEventTool,
} from "../calendar.js";

/** CalDAV calendar tools. Stateful — updates the client in-place on config change. */
export class CalDavProvider implements ToolProvider {
  readonly id = "caldav";
  private client?: CalDavClient;

  getClient(): CalDavClient | undefined {
    return this.client;
  }

  isEnabled(config: Config): boolean {
    return config.tools?.caldav?.enabled === true;
  }

  createTools(config: Config, _services: AgentServices): Tool[] {
    const cfg = config.tools!.caldav!;
    this.client = new CalDavClient({
      serverUrl: cfg.serverUrl,
      username: cfg.username,
      password: cfg.password,
      defaultCalendar: cfg.defaultCalendar || undefined,
    });
    return [
      new CalendarListTool(this.client),
      new CalendarGetEventsTool(this.client),
      new CalendarCreateEventTool(this.client),
      new CalendarUpdateEventTool(this.client),
      new CalendarDeleteEventTool(this.client),
    ];
  }

  onConfigChange(config: Config): void {
    if (!this.client) return;
    const cfg = config.tools!.caldav!;
    this.client.updateConfig({
      serverUrl: cfg.serverUrl,
      username: cfg.username,
      password: cfg.password,
      defaultCalendar: cfg.defaultCalendar || undefined,
    });
  }
}
