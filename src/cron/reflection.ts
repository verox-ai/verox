import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { MemoryEntry, MemoryService } from "src/memory/service";
import { ProviderManager } from "src/provider/manager";
import { Logger } from "src/utils/logger";
import { inject, injectable } from "tsyringe";

// Maximum entries shown per topic in a topic-summary doc.
const TOPIC_MAX_ENTRIES = 15;
// Topics with fewer entries than this are not worth summarising.
const TOPIC_MIN_ENTRIES = 2;
// How many topics to summarise (by frequency).
const TOPIC_MAX_TOPICS = 25;

@injectable()
export class ReflectionService {
    private logger = new Logger(ReflectionService.name);

    constructor(
        @inject("workspace") private workspace: string,
        @inject(ProviderManager) private providerManager: ProviderManager,
        @inject(MemoryService) private memoryStore: MemoryService
    ) { }

    /** Returns the timestamp of the last completed reflection, defaulting to 24 hours ago if not recorded. */
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

    /** Persists `date` as the last reflection timestamp to `{workspace}/memory/metadata.json`. */
    setLastReflectionDate(date: Date) {
        const persist = join(this.workspace, "memory", "metadata.json");
        const cache = existsSync(persist) ? JSON.parse(readFileSync(persist, "utf8")) : {};
        cache.lastReflectionDate = date.toISOString()
        writeFileSync(persist, JSON.stringify(cache), "utf8");
    }

    /**
     * Uses the LLM to derive new knowledge from memory entries created since `lastReflectionDate`.
     * Skips entries already in memory to avoid duplication. Returns the newly appended derived entries.
     */
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

    /** Runs the full nightly job: LLM reflection → persist timestamp → topic summaries → atlas. */
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

        // Always regenerate the atlas — it's fast (no LLM) and keeps it fresh.
        try {
            this.generateTopicSummaries();
            this.generateAtlas();
        } catch (err) {
            this.logger.error("Atlas generation failed", { error: String(err) });
        }
    }

    /**
     * Generates a knowledge doc per top tag containing all entries for that topic.
     * Stored as `_topic_summary_<tag>` — injected into system prompt when the
     * current message mentions that topic.
     */
    generateTopicSummaries(): void {
        const tags = this.memoryStore.listTagsWithCounts()
            .filter(t => !t.tag.startsWith("_"))
            .slice(0, TOPIC_MAX_TOPICS);

        let generated = 0;
        for (const { tag, count } of tags) {
            if (count < TOPIC_MIN_ENTRIES) continue;

            const entries = this.memoryStore.searchSmart(undefined, [tag], true, 0, undefined, TOPIC_MAX_ENTRIES + 5, 0)
                .filter(e => e.risk_level < 2);
            if (entries.length < TOPIC_MIN_ENTRIES) continue;

            const lines = entries
                .slice(0, TOPIC_MAX_ENTRIES)
                .map(e => {
                    const date = e.created_at.slice(0, 10);
                    const typePart = e.memory_type ? ` _(${e.memory_type})_` : "";
                    return `- ${e.content}${typePart} · ${date}`;
                })
                .join("\n");

            const overflow = entries.length > TOPIC_MAX_ENTRIES
                ? `\n_[+${entries.length - TOPIC_MAX_ENTRIES} more — use memory_search to find them]_`
                : "";

            const lastUpdated = entries
                .map(e => e.created_at)
                .sort()
                .reverse()[0]
                .slice(0, 10);

            this.memoryStore.knowledgeWrite({
                slug: `_topic_summary_${tag}`,
                title: `Topic: ${tag} (${count} entries)`,
                content: [
                    `# Topic: ${tag}`,
                    `${count} memories · last updated ${lastUpdated}`,
                    "",
                    lines + overflow,
                    "",
                    `_Use \`memory_search ${tag}\` for full-text search within this topic._`,
                ].join("\n"),
                tags: ["_reflection", `_topic_${tag}`],
            });
            generated++;
        }
        this.logger.debug(`[Atlas] Generated ${generated} topic summaries`);
    }

    /**
     * Generates the top-level `_memory_atlas` knowledge doc — a structured
     * overview of everything stored in memory. Injected at the top of every
     * system prompt so the agent always knows what it knows.
     */
    generateAtlas(): void {
        const km = this.memoryStore.getKnowledgeMap();
        const date = new Date().toISOString().slice(0, 10);

        // Top topics (excluding internal _reflection tags)
        const topTopics = km.byTag
            .filter(t => !t.tag.startsWith("_"))
            .slice(0, 15)
            .map(t => `${t.tag}(${t.count})`)
            .join(" · ");

        const typeBreakdown = km.byType.length
            ? km.byType.map(t => `${t.type}:${t.count}`).join(" · ")
            : "";

        const recentFocus = km.recentTags
            .filter(t => !t.startsWith("_"))
            .slice(0, 8)
            .join(", ");

        // Topics with summaries available
        const summarisedTags = this.memoryStore.listTagsWithCounts()
            .filter(t => !t.tag.startsWith("_") && t.count >= TOPIC_MIN_ENTRIES)
            .slice(0, TOPIC_MAX_TOPICS)
            .map(t => t.tag)
            .join(", ");

        const lines = [
            `# Memory Atlas — ${km.total} memories · generated ${date}`,
            "",
            topTopics ? `**Topics:** ${topTopics}` : "",
            typeBreakdown ? `**By type:** ${typeBreakdown}` : "",
            recentFocus ? `**Recent focus (7 days):** ${recentFocus}` : "",
            "",
            `**Topic summaries available for:** ${summarisedTags || "none yet"}`,
            `→ Use \`knowledge_read _topic_summary_<tag>\` to load a full topic digest.`,
            `→ Use \`memory_search <keywords>\` for detailed entry search.`,
        ].filter(l => l !== undefined);

        this.memoryStore.knowledgeWrite({
            slug: "_memory_atlas",
            title: `Memory Atlas (${km.total} memories)`,
            content: lines.join("\n"),
            tags: ["_reflection"],
        });
        this.logger.debug(`[Atlas] Generated atlas: ${km.total} memories, ${km.byTag.length} topics`);
    }

}