import { Logger } from "src/utils/logger.js";
import { Tool } from "./toolbase.js";
import { UsageService, UsagePeriod } from "src/usage/service.js";

const VALID_PERIODS: UsagePeriod[] = ["today", "date", "week", "month", "all"];

/**
 * Read-only tool that returns token usage statistics.
 * The agent can use this to answer cost-estimation questions from the owner.
 * No risk — reads only from the local usage database, never from external sources.
 */
export class UsageStatsTool extends Tool {
  private logger = new Logger(UsageStatsTool.name);
  constructor(private service: UsageService) {
    super();
  }

  get name(): string { return "usage_stats"; }

  get description(): string {
    return (
      "Returns token usage statistics (prompt tokens, completion tokens, total) " +
      "aggregated from all LLM calls. Use this to answer questions about API usage " +
      "and estimated costs. Period options: today, week, month (default), all."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: VALID_PERIODS,
          description: "Time range to aggregate.Use 'date' with the additional parameter date for fetching a specific date. Defaults to 'month' (last 30 days)."
        },
        date: {
          type: "string",
          description: "A specific date as ISO String."
        }
      },
      required: []
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    this.logger.debug(`execute ${JSON.stringify(params)}`);
    const period = (VALID_PERIODS.includes(params.period as UsagePeriod)
      ? params.period
      : "month") as UsagePeriod;
    let date = undefined;
    if (period === 'date') {
      date = new Date(params.date as string);
    }
    const stats = this.service.getStats(period, date);
    return JSON.stringify(stats, null, 2);
  }
}
