import { injectable, inject } from "tsyringe";
import { ProviderManager } from "src/provider/manager.js";
import { SessionManager } from "src/session/manager.js";
import { MemoryService } from "src/memory/service.js";
import { extractMemoriesFromMessages } from "src/agent/extraction.js";
import { Logger } from "src/utils/logger.js";
import { ConfigService } from "src/config/service.js";

/** Session kind prefixes that should not be processed for memory extraction. */
const SKIP_PREFIXES = ["cron:", "hook:", "subagent:", "node:", "system:"];

/**
 * Periodic memory extraction job.
 *
 * Scans all `main` sessions (i.e. real user↔agent conversations) and extracts
 * durable facts from sessions that have been idle long enough and contain
 * unprocessed messages (those after the `memory_extracted_at` watermark).
 *
 * ### First-time sessions
 * If a session has no `memory_extracted_at` watermark the job sets it to the
 * current time and skips extraction — this is the **no-backfill** policy.
 * Only messages arriving after the first cron run are ever extracted.
 *
 * ### Wiring
 * Instantiate this class and call {@link start} to run it on a fixed interval,
 * or call {@link runOnce} from your own scheduler / cron system.
 *
 * ```typescript
 * const memoryCron = new MemoryExtractionCron({ sessions, providerManager, memoryStore, config });
 * memoryCron.start();           // runs immediately and then every `intervalMs`
 * // ... on shutdown:
 * memoryCron.stop();
 * ```
 */
@injectable()
export class MemoryExtractionCron {
  private logger = new Logger(MemoryExtractionCron.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private options: {
    sessions: SessionManager;
    providerManager: ProviderManager;
    memoryStore: MemoryService;
    staleHours?: number;
    channelOverrides?: Record<string, number>;
    minMessages?: number;
    intervalMs?: number;
    pruning?: {
      enabled: boolean;
      maxAgeDays: number;
      minConfidence: number;
      maxEntries: number;
      maxDerivedEntries: number;
      graceDays: number;
    };
  };

  constructor(
    @inject(SessionManager) sessions: SessionManager,
    @inject(ProviderManager) providerManager: ProviderManager,
    @inject(MemoryService) memoryStore: MemoryService,
    @inject(ConfigService) configService: ConfigService
  ) {
    const cfg = configService.app.agents.memoryExtraction;
    const pruning = configService.app.agents.memoryPruning;
    this.options = {
      sessions,
      providerManager,
      memoryStore,
      staleHours: cfg.staleHours,
      channelOverrides: cfg.channelOverrides,
      minMessages: cfg.minMessages,
      pruning
    };
  }

  /**
   * Starts the cron job on a recurring interval.
   * Runs one pass immediately, then repeats every `intervalMs`.
   */
  start(): void {
    if (this.timer) return;
    const staleHours = this.options.staleHours ?? 4;
    const intervalMs = this.options.intervalMs ?? staleHours * 60 * 60 * 1000;
    this.runOnce().catch((err) =>
      this.logger.warn("Memory extraction cron error", { error: String(err) })
    );
    this.timer = setInterval(() => {
      this.runOnce().catch((err) =>
        this.logger.warn("Memory extraction cron error", { error: String(err) })
      );
    }, intervalMs);
    this.logger.info("Memory extraction cron started", {
      intervalMs,
      staleHours
    });
  }

  /** Stops the recurring interval. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("Memory extraction cron stopped");
    }
  }

  /**
   * Runs a single extraction pass across all eligible sessions.
   * Safe to call manually at any time (e.g. from an existing cron/heartbeat system).
   *
   * @returns Total number of memory entries written across all sessions.
   */
  async runOnce(): Promise<number> {
    const staleHours = this.options.staleHours ?? 4;
    const minMessages = this.options.minMessages ?? 3;
    const channelOverrides = this.options.channelOverrides ?? {};
    const now = Date.now();
    let totalWritten = 0;

    const allSessions = this.options.sessions.listSessions();

    for (const entry of allSessions) {
      const key = String(entry.key ?? "");

      // Only process main (user↔agent) sessions.
      if (SKIP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;

      // Determine per-channel staleness threshold.
      const channel = key.includes(":") ? key.split(":", 2)[0] : null;
      const effectiveStaleHours =
        channel && channelOverrides[channel] != null
          ? channelOverrides[channel]
          : staleHours;
      const staleMs = effectiveStaleHours * 60 * 60 * 1000;

      // Skip sessions that are still active.
      const updatedAt = entry.updated_at as string | undefined;
      if (updatedAt) {
        const updatedMs = Date.parse(updatedAt);
        if (Number.isFinite(updatedMs) && now - updatedMs < staleMs) continue;
      }

      // Load the full session from disk/cache.
      const session = this.options.sessions.getIfExists(key);
      if (!session) continue;

      const watermark = session.metadata.memory_extracted_at as string | undefined;

      // First-time session: initialise watermark and skip (no backfill).
      if (!watermark) {
        session.metadata.memory_extracted_at = new Date().toISOString();
        this.options.sessions.save(session);
        this.logger.debug("Initialised watermark for session (no backfill)", { key });
        continue;
      }

      // Extract facts from messages after the watermark.
      try {
        const written = await extractMemoriesFromMessages({
          session,
          sessions: this.options.sessions,
          providerManager: this.options.providerManager,
          memoryStore: this.options.memoryStore,
          minMessages
        });
        if (written > 0) {
          this.logger.info("Extracted memories from stale session", { key, written });
          totalWritten += written;
        }
      } catch (err) {
        this.logger.warn("Failed to extract from session", { key, error: String(err) });
      }
    }

    if (totalWritten > 0) {
      this.logger.info("Memory cron pass complete", { totalWritten });
    }

    // Run pruning after extraction so newly extracted facts survive the current pass.
    const p = this.options.pruning;
    if (p?.enabled) {
      try {
        const pruned = this.options.memoryStore.prune({
          maxAgeDays: p.maxAgeDays,
          minConfidence: p.minConfidence,
          maxEntries: p.maxEntries,
          maxDerivedEntries: p.maxDerivedEntries,
          graceDays: p.graceDays
        });
        const total = pruned.byAge + pruned.byConfidence + pruned.byCount + pruned.expired;
        if (total > 0) {
          this.logger.info("Memory pruning complete", pruned);
        }
      } catch (err) {
        this.logger.warn("Memory pruning failed", { error: String(err) });
      }
    }

    return totalWritten;
  }
}
