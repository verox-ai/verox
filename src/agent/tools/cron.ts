import { Tool } from "./toolbase";
import { CronService, type CronTarget } from "src/cron/service.js";
import { RiskLevel } from "../security.js";
import * as chrono from "chrono-node";

/** Convert a natural-language time string into a one-shot cron expression.
 *  e.g. "in 2 hours" → "35 14 8 3 *" (minute hour day month *)
 *  Returns null if the string cannot be parsed or resolves to the past.
 */
function naturalToCron(when: string): { schedule: string; date: Date } | null {
  const date = chrono.parseDate(when, new Date(), { forwardDate: true });
  if (!date || date <= new Date()) return null;
  const m = date.getMinutes();
  const h = date.getHours();
  const d = date.getDate();
  const mo = date.getMonth() + 1;
  return { schedule: `${m} ${h} ${d} ${mo} *`, date };
}

export class CronTool extends Tool {
  constructor(private cronService: CronService) {
    super();
  }

  get name(): string {
    return "cron";
  }

  get maxRisk(): RiskLevel { return RiskLevel.None; }

  get description(): string {
    return (
      "Manage scheduled cron jobs. " +
      "Use action=schedule to create a recurring task, action=cancel to remove one, action=list to see all active jobs. " +
      "For reminders use the 'when' parameter with natural language (e.g. 'in 2 hours', 'tomorrow at 9am') instead of a cron expression."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["schedule", "cancel", "list"],
          description: "Action to perform"
        },
        id: {
          type: "string",
          description: "Unique job identifier (required for schedule and cancel)"
        },
        schedule: {
          type: "string",
          description: "Cron expression e.g. '0 9 * * *' for every day at 09:00. Omit if using 'when'."
        },
        when: {
          type: "string",
          description: "Natural language time for one-shot reminders, e.g. 'in 2 hours', 'tomorrow at 9am', 'next Monday at 10:00'. Sets recurring=false automatically."
        },
        prompt: {
          type: "string",
          description: "The prompt sent to the agent on each tick"
        },
        targets: {
          type: "array",
          description: "Channels to deliver the result to. Each entry needs channel and chatId.",
          items: {
            type: "object",
            properties: {
              channel: { type: "string", description: "Channel name e.g. slack, telegram" },
              chatId: { type: "string", description: "Chat or user ID within that channel" }
            },
            required: ["channel", "chatId"]
          }
        },
        recurring: {
          type: "boolean",
          description: "true = repeat on schedule (default). false = fire once then remove automatically. Use false for 'remind me in X minutes' style requests."
        }
      },
      required: ["action"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const action = String(params.action ?? "");

    if (action === "list") {
      const entries = this.cronService.listEntries();
      if (!entries.length) return "No cron jobs scheduled.";
      return entries
        .map((e) => {
          const targetStr = e.targets.map((t) => `${t.channel}:${t.chatId}`).join(", ");
          const recurringLabel = e.recurring ? "recurring" : "one-shot";
          return `• ${e.id} | ${e.schedule} | ${recurringLabel} | next: ${e.nextRun}\n  prompt: ${e.prompt}\n  targets: ${targetStr}`;
        })
        .join("\n\n");
    }

    const id = String(params.id ?? "").trim();
    if (!id) return "Error: id is required";

    if (action === "cancel") {
      const ok = this.cronService.cancel(id);
      return ok ? `Cron job '${id}' cancelled.` : `Error: no job found with id '${id}'`;
    }

    if (action === "schedule") {
      // Natural language 'when' takes priority over raw cron expression
      const whenStr = String(params.when ?? "").trim();
      let schedule = String(params.schedule ?? "").trim();
      let recurring = typeof params.recurring === "boolean" ? params.recurring : true;
      let resolvedDate: Date | undefined;

      if (whenStr) {
        const parsed = naturalToCron(whenStr);
        if (!parsed) return `Error: could not parse time "${whenStr}". Try something like "in 2 hours" or "tomorrow at 9am".`;
        schedule = parsed.schedule;
        recurring = false;
        resolvedDate = parsed.date;
      }

      if (!schedule) return "Error: either 'schedule' (cron expression) or 'when' (natural language) is required";
      const prompt = String(params.prompt ?? "").trim();
      if (!prompt) return "Error: prompt is required";

      const rawTargets = Array.isArray(params.targets) ? params.targets : [];
      const targets: CronTarget[] = rawTargets
        .filter((t) => t && typeof t === "object")
        .map((t) => ({
          channel: String((t as Record<string, unknown>).channel ?? ""),
          chatId: String((t as Record<string, unknown>).chatId ?? "")
        }))
        .filter((t) => t.channel && t.chatId);

      this.cronService.schedule({ id, schedule, prompt, targets, recurring });
      const targetStr = targets.length
        ? targets.map((t) => `${t.channel}:${t.chatId}`).join(", ")
        : "no targets (internal only)";
      const recurringLabel = recurring ? "recurring" : "one-shot";
      const timeLabel = resolvedDate ? resolvedDate.toLocaleString() : schedule;
      return `Cron job '${id}' scheduled (${recurringLabel}): ${timeLabel} → ${targetStr}`;
    }

    return `Error: unknown action '${action}'`;
  }
}
