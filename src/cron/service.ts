import { injectable, inject } from "tsyringe";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import { Logger } from "src/utils/logger.js";
import { Agent } from "src/agent/agent.js";
import { MessageBus } from "src/messagebus/queue.js";
import { MemoryService } from "src/memory/service";
import { ProviderManager } from "src/provider/manager";
import { ReflectionService } from "./reflection";

export type CronTarget = { channel: string; chatId: string };

type CronEntry = {
  id: string;
  schedule: string;
  prompt: string;
  targets: CronTarget[];
  recurring: boolean;
  job: CronJob;
};

type PersistedEntry = Omit<CronEntry, "job">;

@injectable()
export class CronService {
  private entries = new Map<string, CronEntry>();
  private readonly logger = new Logger(CronService.name);
  private readonly persistPath: string;

  constructor(
    @inject(Agent) private agent: Agent,
    @inject(MessageBus) private bus: MessageBus,
    @inject(MemoryService) private memoryStore: MemoryService,
    @inject("workspace") private workspace: string,
    @inject(ReflectionService) private reflectionService: ReflectionService
  ) {
    this.logger.info("Cron Service is initialized");
    this.persistPath = join(workspace, "cron", "jobs.json");
    //this.runReflection().catch();
  }

  /** Restores persisted jobs from disk and starts them. Call once at startup. */
  load(): void {
    if (!existsSync(this.persistPath)) return;
    this.schedule({ id: '_reflection', schedule: "0 0 * * *", prompt: "NO_REPLY", targets: [], recurring: true }, false);
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, "utf-8")) as PersistedEntry[];
      for (const entry of raw) {
        this.schedule(entry, false);
      }
      this.logger.info("Cron jobs restored", { count: raw.length });
    } catch (err) {
      this.logger.warn("Failed to restore cron jobs", { error: String(err) });
    }
  }

  schedule(
    params: { id: string; schedule: string; prompt: string; targets: CronTarget[]; recurring?: boolean },
    persist = true
  ): void {
    if (this.entries.has(params.id)) {
      this.cancel(params.id, false);
    }

    const job = new CronJob(params.schedule, () => {
      void this.tick(params.id);
    });

    this.entries.set(params.id, { ...params, recurring: params.recurring ?? true, job });
    job.start();
    this.logger.info("Cron job scheduled", { id: params.id, schedule: params.schedule, recurring: params.recurring ?? true });

    if (persist) this.save();
  }

  cancel(id: string, persist = true): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.job.stop();
    this.entries.delete(id);
    this.logger.info("Cron job cancelled", { id });
    if (persist) this.save();
    return true;
  }

  listEntries(): Array<Omit<CronEntry, "job"> & { nextRun: string }> {
    return [...this.entries.values()].map(({ job, ...rest }) => ({
      ...rest,
      nextRun: job.nextDate().toISO() ?? "unknown",
    }));
  }

  stopAll(): void {
    for (const entry of this.entries.values()) {
      entry.job.stop();
    }
    this.entries.clear();
    this.logger.info("All cron jobs stopped");
  }

  private save(): void {
    try {
      mkdirSync(join(this.persistPath, ".."), { recursive: true });
      // remove the reflection job cause it will loaded by the service
      const data: PersistedEntry[] = [...this.entries.values()].map(({ job: _job, ...rest }) => rest).filter(job=>job.id!=='_reflection');

      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      this.logger.warn("Failed to persist cron jobs", { error: String(err) });
    }
  }

  private async runReflection() {
    await this.reflectionService.runJob();
  }

  private async tick(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.logger.debug("Cron tick", { id, recurring: entry.recurring });

    if (id === '_reflection') {
      await this.runReflection();
    }

    // Cancel one-shot jobs before executing so they don't fire again if execution is slow
    if (!entry.recurring) {
      this.cancel(id);
    }

    try {
      const firstTarget = entry.targets[0];
      this.logger.debug(`Running direct Message to the agent ${entry.prompt}`);
      const response = await this.agent.processDirect({
        content: entry.prompt,
        channel: firstTarget?.channel ?? "system",
        chatId: firstTarget?.chatId ?? "cron",
        sessionKey: `cron:${id}`,
        metadata: { sessionless: true }
      });
      if (!response) return;
      this.logger.debug(`routing this to the outbound ${JSON.stringify(entry.targets)}`)
      for (const target of entry.targets) {
        await this.bus.publishOutbound({
          channel: target.channel,
          chatId: target.chatId,
          content: response,
          media: [],
          metadata: { source: "cron", cronId: id }
        });
      }
    } catch (err) {
      this.logger.error("Cron tick failed", { id, error: String(err) });
    }
  }
}
