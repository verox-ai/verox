import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { MemoryEntry, MemoryService } from "src/memory/service";
import { ProviderManager } from "src/provider/manager";
import { Logger } from "src/utils/logger";
import { inject, injectable } from "tsyringe";

@injectable()
export class ReflectionService {
    private logger = new Logger(ReflectionService.name);

    constructor(
        @inject("workspace") private workspace: string,
        @inject(ProviderManager) private providerManager: ProviderManager,
        @inject(MemoryService) private memoryStore: MemoryService
    ) { }

    getLastReflectionDate(): Date {
        const persist = join(this.workspace, "memory", "metadata.json");
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (!existsSync(persist)) return yesterday;
        try {
            const cache = JSON.parse(readFileSync(persist, "utf8"));
            const d = new Date(cache.lastReflectionDate);
            return isNaN(d.getTime()) ? yesterday : d;
        } catch {
            return yesterday;
        }
    }

    setLastReflectionDate(date: Date) {
        const persist = join(this.workspace, "memory", "metadata.json");
        const cache = existsSync(persist) ? JSON.parse(readFileSync(persist, "utf8")) : {};
        cache.lastReflectionDate = date.toISOString()
        writeFileSync(persist, JSON.stringify(cache), "utf8");
    }

    async runReflection(lastReflectionDate: Date) {
        // Only reflect on active, non-derived memory
        const recent = this.memoryStore.getRecentEntries(lastReflectionDate)
            .filter(f => f.type !== "derived");

        if (recent.length === 0) return [];

        const facts = recent.map(f => `- ${f.content} [tags: ${f.tag_list ?? ""}]`).join("\n");

        const response = await this.providerManager.get().chat({
            messages: [
                {
                    role: "system",
                    content: "You are an assistant that generates derived, persistent world knowledge from memory entries. Extract only NEW patterns, transitions, or relationships. Do not duplicate facts already present in memory. Return a JSON array: [{\"content\": \"derived fact\", \"tags\": [\"derived\"]}]. Return empty array [] if nothing can be derived."
                },
                {
                    role: "user",
                    content: `Analyze the following facts and derive new knowledge:\n\n${facts}`
                }
            ],
            model: this.providerManager.getUtilityModel()
        });

        const raw = (response.content ?? "[]").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        let derived: Array<{ content: string; tags: string[] }> = [];

        try { derived = JSON.parse(raw); } catch (err) { /* ignore malformed */ }

        this.logger.debug("LLM is back from reflecting over the day");
        this.logger.debug(JSON.stringify(derived));

        const recentIds = recent.map(f => f.id);

        const appended: MemoryEntry[] = [];
        for (const fact of derived) {
            // Skip if content already exists
            const exists = this.memoryStore.searchSmart(fact.content, undefined, true).length > 0;
            if (exists) continue;

            const entry = this.memoryStore.appendWithSupersedes({
                content: fact.content,
                tags: fact.tags ?? ["derived"],
                type: "derived",
                confidence: 0.8,
                related_ids: recentIds
            });
            if (typeof entry !== "number") {
                appended.push(entry);
            }
        }

        return appended;
    }

    async runJob() {
        try {
            const lastReflectionDate = this.getLastReflectionDate();

            const derived = await this.runReflection(lastReflectionDate);

            // Optional: prune low-confidence derived facts older than 30 days
            // pruneMemory(this.memoryStore);

            this.setLastReflectionDate(new Date());
            this.logger.debug(`[Reflection] Completed ${derived.length} derived facts`);
        } catch (err) {
            this.logger.error("Reflection job failed", {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
        }
    }

}