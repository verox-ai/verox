import { extname, join } from "path";
import { existsSync, readFileSync } from "fs";
import type { Config } from "src/types/schemas/schema.js";
import { SkillsLoader } from "./skills.js";
import { MemoryService } from "src/memory/service.js";
import { BootstrapLoader } from "./bootstrap.js";
import { APP_NAME } from "src/constants.js";
import { Logger } from "src/utils/logger.js";
import { getPrompt } from "src/prompts/loader.js";
import { DEFAULT_PERSONALITY } from "./personality.js";
import { TOPIC_SHIFT_TOKEN } from "./tokens.js";

export type Message = Record<string, unknown>;

type ContextConfig = Config["agents"]["context"];

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

export class ContextManager {
  private memory: MemoryService;
  private skills: SkillsLoader;
  private bootstrap: BootstrapLoader;
  private contextConfig: ContextConfig;
  private logger = new Logger(ContextManager.name);
  private calendarSectionFn?: () => string;

  constructor(private workspace: string, contextConfig: ContextConfig | undefined, memory: MemoryService) {
    this.memory = memory;
    this.skills = new SkillsLoader(workspace);
    // contextConfig always has defaults applied by zod; the fallback is only
    // for callers that construct ContextManager without a DI container (tests etc.)
    this.contextConfig = contextConfig ?? {
      bootstrap: {
        files: ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "BOOT.md", "BOOTSTRAP.md", "HEARTBEAT.md"],
        minimalFiles: ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"],
        heartbeatFiles: ["HEARTBEAT.md"],
        perFileChars: 4000,
        totalChars: 12000
      },
      memory: { enabled: true, maxChars: 8000 }
    };
    this.bootstrap = new BootstrapLoader(workspace, this.contextConfig.bootstrap);
  }

  /** Returns the underlying SkillsLoader so the Agent can wire it to the ExecTool. */
  getSkillsLoader(): SkillsLoader {
    return this.skills;
  }

  /** Hot-updates the context config (memory limits, bootstrap) without restart. */
  updateContextConfig(contextConfig: ContextConfig): void {
    this.contextConfig = contextConfig;
  }

  /** Registers a callback that returns a formatted calendar section for the system prompt. */
  setCalendarAwareness(fn: () => string): void {
    this.calendarSectionFn = fn;
  }

  clearCalendarAwareness(): void {
    this.calendarSectionFn = undefined;
  }

  bootstrapCompleted(): boolean {
    return existsSync(join(this.workspace, "bootstrap.ok"));
  }

  /**
   * Assembles the full system prompt for a conversation turn.
   *
   * Sections (in order):
   * 1. Agent identity — persona, current date/time, tool list, channel/session hints
   * 2. Workspace context — content from bootstrap markdown files (AGENTS.md, SOUL.md, …)
   * 3. Memory — pinned and recent entries from the memory store
   * 4. Always-on skill instructions — injected for skills marked `always: "true"`
   * 5. Requested skill instructions — injected for explicitly named skills
   * 6. Skills directory listing — summarises all available/unavailable skills
   */
  buildSystemPrompt(skillNames?: string[], sessionKey?: string, messageToolHints?: string[], toolNames?: string[], personality?: string, currentMessage?: string): string {
    const sysSession = isSystemSession(sessionKey);
    const parts: string[] = [];

    // Bootstrap mode: BOOTSTRAP.md present and bootstrap.ok absent means first-run setup is incomplete.
    // Inject BEFORE the identity block so it overrides the "casual messages → reply directly" rule.
    if (!sysSession && existsSync(join(this.workspace, "BOOTSTRAP.md")) && !this.bootstrapCompleted()) {
      const okPath = join(this.workspace, "bootstrap.ok");
      parts.push(
        `**BOOTSTRAP MODE ACTIVE**\n\n` +
        `BOOTSTRAP.md is present in your workspace. This means first-run setup has not been completed yet.\n` +
        `Regardless of what the user just said — even if it is just "hi" or a greeting — ` +
        `you MUST proactively start the bootstrap conversation described in BOOTSTRAP.md. ` +
        `Do not respond generically. Do not wait for them to ask. ` +
        `Initiate the flow immediately: introduce yourself, then begin the questions listed in BOOTSTRAP.md.\n\n` +
        `When you have fully completed the bootstrap routine, create the file \`${okPath}\` ` +
        `(e.g. using the exec tool: \`touch ${okPath}\`) to mark setup as done and prevent this mode from activating again on future restarts.`
      );
    }

    parts.push(this.getIdentity(messageToolHints, toolNames, sysSession,personality));

    const bootstrapContent = this.bootstrap.load(sessionKey);
    if (bootstrapContent) {
      parts.push(`# Workspace Context\n\n${bootstrapContent}`);
    }

    const calendarSection = this.calendarSectionFn?.();
    if (calendarSection) {
      parts.push(calendarSection);
    }

    const memorySection = this.buildMemorySection(currentMessage);
    if (memorySection) {
      parts.push(memorySection);
    }

    const alwaysSkills = this.skills.getAlwaysSkills();
    if (alwaysSkills.length) {
      const content = this.skills.loadSkillsForContext(alwaysSkills);
      if (content) parts.push(`# Active Skills\n\n${content}`);
    }

    if (skillNames?.length) {
      const content = this.skills.loadSkillsForContext(skillNames);
      if (content) parts.push(`# Requested Skills\n\n${content}`);
    }

    // Skip skills directory listing only for heartbeat sessions — cron jobs are
    // user-defined tasks that may well invoke skills.
    if (!isHeartbeatSession(sessionKey)) {
      const skillsSummary = this.skills.buildSkillsSummary();
      if (skillsSummary) {
        parts.push(
          `# Skills\n\nRead a skill's path with read_file to load its instructions. Unavailable skills need their listed dependencies installed first.\n\n${skillsSummary}`
        );
      }
    }

    // Inject topic-shift detection instruction for interactive sessions only.
    // Cron / heartbeat / system sessions are automated tasks — topic tracking doesn't apply.
    if (!sysSession && !isHeartbeatSession(sessionKey)) {
      parts.push(
        `## Context Optimization\n\n` +
        `If the user's message is clearly about a **new, unrelated topic** compared to the previous conversation ` +
        `(not a follow-up, clarification, or related question), append the token \`${TOPIC_SHIFT_TOKEN}\` ` +
        `at the very end of your response — after all other content. ` +
        `Do not explain it, do not add it for follow-up messages, only when the topic genuinely changes.`
      );
    }

    return parts.join("\n\n---\n\n");
  }

  /**
   * Builds the full messages array to send to the LLM for a single turn.
   *
   * Structure:
   * - `[system]` — full system prompt (identity + context + memory + skills)
   * - `[…history]` — previous turns loaded from the session
   * - `[user]` — the current incoming message (with optional inline images)
   *
   * The compact summary (if present) is appended to the system prompt so the
   * LLM has a condensed view of the older conversation without the full history.
   */
  buildMessages(params: {
    history: Message[];
    currentMessage: string;
    skillNames?: string[];
    media?: string[];
    channel?: string;
    chatId?: string;
    sessionKey?: string;
    messageToolHints?: string[];
    compactSummary?: string;
    toolNames?: string[];
    personality?: string;
    knownSender?: { name: string; notes?: string };
  }): Message[] {
    const messages: Message[] = [];
    let systemPrompt = this.buildSystemPrompt(params.skillNames, params.sessionKey, params.messageToolHints, params.toolNames, params.personality, params.currentMessage);

    if (params.channel && params.chatId) {
      let sessionInfo = `\n\n## Current Session\nChannel: ${params.channel}\nChat ID: ${params.chatId}`;
      if (params.knownSender) {
        sessionInfo += `\nSpeaking with: **${params.knownSender.name}**`;
        if (params.knownSender.notes) sessionInfo += ` — ${params.knownSender.notes}`;
      }
      systemPrompt += sessionInfo;
    }
    if (params.sessionKey) {
      // Expose session key for sessions_send/sessions_history only.
      // IMPORTANT: this is an internal identifier — never use it as a chatId in the message tool.
      systemPrompt += `\nSession key (internal, use only with sessions_send/sessions_history): ${params.sessionKey}`;
    }
    if (params.compactSummary) {
      systemPrompt += `\n\n---\n\n## Previous Conversation Summary\n\n${params.compactSummary}`;
    }

    messages.push({ role: "system", content: systemPrompt });
    messages.push(...params.history);
    messages.push({ role: "user", content: this.buildUserContent(params.currentMessage, params.media ?? []) });

    this.logger.debug(`prompt is with ${messages.length} entries`);
    this.logger.debug(`estimated token length is now ${this.estimateTokens(messages)}`);
    return messages;
  }

  /** Appends a tool result message to `messages` in the OpenAI wire format. */
  addToolResult(messages: Message[], toolCallId: string, toolName: string, result: string): Message[] {
    messages.push({ role: "tool", tool_call_id: toolCallId, name: toolName, content: result });
    return messages;
  }

  /** Appends an assistant message (with optional tool_calls / reasoning_content) to `messages`. */
  addAssistantMessage(
    messages: Message[],
    content: string | null,
    toolCalls?: Message[] | null,
    reasoningContent?: string | null
  ): Message[] {
    const msg: Message = { role: "assistant", content: content ?? "" };
    if (toolCalls?.length) msg.tool_calls = toolCalls;
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    messages.push(msg);
    return messages;
  }

  /**
   * Rough token estimate for a messages array using the "4 chars ≈ 1 token"
   * heuristic plus 4 tokens of per-message overhead. Used by the compaction
   * logic to decide when to summarise old history.
   */
  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // per-message overhead
      const content = msg.content;
      if (typeof content === "string") {
        total += Math.ceil(content.length / 4);
      } else if (Array.isArray(content)) {
        total += Math.ceil(JSON.stringify(content).length / 4);
      }
      if (Array.isArray(msg.tool_calls)) {
        total += Math.ceil(JSON.stringify(msg.tool_calls).length / 4);
      }
    }
    return total;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private getIdentity(messageToolHints?: string[], toolNames?: string[], systemSession = false,personality = DEFAULT_PERSONALITY): string {
    const now = new Date().toLocaleString();
    const toolList = toolNames?.length
      ? toolNames.map((n) => `- ${n}`).join("\n")
      : "- (no tools registered)";
    const vars = {
      appName: APP_NAME,
      now,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      workspace: this.workspace,
      toolList,
      messageToolHints: "",
      personality
    };

    if (systemSession) {
      // Use the minimal system-session identity (no messaging/reply-tag sections).
      // Falls back to the full identity if the template file isn't present.
      return getPrompt("agent-identity-system", vars) ?? getPrompt("agent-identity", vars) ?? "";
    }

    const sanitized = (messageToolHints ?? []).map((h) => h.trim()).filter(Boolean);
    vars.messageToolHints = sanitized.length
      ? `### message tool hints\n${sanitized.map((h) => `- ${h}`).join("\n")}`
      : "";
    return getPrompt("agent-identity", vars) ?? "";
  }

  private buildMemorySection(currentMessage?: string): string {
    const { enabled, maxChars } = this.contextConfig.memory;
    if (!enabled) return "";

    const totalCount = this.memory.count();
    const parts: string[] = [];
    const injectedIds = new Set<number>();

    // ── 1. Pinned ──────────────────────────────────────────────────────────
    const pinned = this.memory.searchSmart(undefined, undefined, true, 0)
      .filter(e => e.pinned && e.risk_level < 2);
    let pinnedChars = 0;
    const maxPinChars = Math.floor(maxChars * 0.25);
    const pinnedLines: string[] = [];
    for (const e of pinned) {
      const line = this.memory["formatMemoryLine"](e);
      if (pinnedChars + line.length > maxPinChars) break;
      pinnedLines.push(line);
      pinnedChars += line.length;
      injectedIds.add(e.id);
    }
    if (pinnedLines.length) parts.push(`## Pinned\n${pinnedLines.join("\n")}`);

    // ── 2. Contextually relevant (keyword + tag-boosted search) ───────────
    if (currentMessage) {
      // Keyword search on message content
      const kwResults = this.memory.contextualSearch(currentMessage, 12, injectedIds);
      const relevantMap = new Map<number, typeof kwResults[0]>();
      for (const e of kwResults) relevantMap.set(e.id, e);

      // Tag-boosted: find tags from the stored taxonomy that appear in the message,
      // then surface memories carrying those tags. This catches cases where keyword
      // overlap is low but the topic tag is a direct word in the user's message
      // (e.g. "billing" → pulls memories tagged "billing" even if content differs).
      const allTags = this.memory.listTags();
      const msgLower = currentMessage.toLowerCase();
      const matchingTags = allTags.filter(tag => msgLower.includes(tag.toLowerCase()));
      if (matchingTags.length) {
        const tagResults = this.memory.searchSmart(undefined, matchingTags, true, 0, undefined, 12, 0)
          .filter(e => !injectedIds.has(e.id) && e.risk_level < 2 && !relevantMap.has(e.id));
        // Prepend tag-matched results (higher precision signal)
        for (const e of tagResults) relevantMap.set(e.id, e);
      }

      const relevant = [...relevantMap.values()].slice(0, 14);
      const maxRelChars = Math.floor(maxChars * 0.50);
      let relChars = 0;
      const relLines: string[] = [];
      for (const e of relevant) {
        const line = this.memory["formatMemoryLine"](e);
        if (relChars + line.length > maxRelChars) break;
        relLines.push(line);
        relChars += line.length;
        injectedIds.add(e.id);
      }
      if (relLines.length) parts.push(`## Relevant to this message\n${relLines.join("\n")}`);
    }

    // ── 3. Recent (last 7 days, not already shown) ─────────────────────────
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = this.memory.searchSmart(undefined, undefined, true, 0)
      .filter(e => !e.pinned && e.created_at > cutoff && e.risk_level < 2 && !injectedIds.has(e.id));
    const maxRecentChars = Math.floor(maxChars * 0.25);
    let recentChars = 0;
    const recentLines: string[] = [];
    for (const e of recent) {
      const line = this.memory["formatMemoryLine"](e);
      if (recentChars + line.length > maxRecentChars) break;
      recentLines.push(line);
      recentChars += line.length;
    }
    if (recentLines.length) parts.push(`## Recent (last 7 days)\n${recentLines.join("\n")}`);

    // ── Knowledge map (topic index) ───────────────────────────────────────
    const km = this.memory.getKnowledgeMap();
    let knowledgeMap = "";
    if (km.total > 0 || km.knowledgeDocs.length > 0) {
      const heading = km.knowledgeDocs.length > 0
        ? `**Knowledge index** (${km.total} memories · ${km.knowledgeDocs.length} knowledge docs)`
        : `**Knowledge index** (${km.total} memories)`;
      const tagLine = km.byTag.length
        ? km.byTag.map(t => `${t.tag}(${t.count})`).join(" · ")
        : "";
      const typeLine = km.byType.length
        ? km.byType.map(t => `${t.type}(${t.count})`).join(" · ")
        : "";
      const recentLine = km.recentTags.length
        ? `Recent topics: ${km.recentTags.join(", ")}`
        : "";
      const docsLine = km.knowledgeDocs.length
        ? `Knowledge docs: ${km.knowledgeDocs.map(d => `${d.slug} ("${d.title}")`).join(", ")} — use knowledge_read to load content`
        : "";
      const lines = [heading];
      if (tagLine) lines.push(`Memory topics: ${tagLine}`);
      if (typeLine) lines.push(`Types: ${typeLine}`);
      if (recentLine) lines.push(recentLine);
      if (docsLine) lines.push(docsLine);
      knowledgeMap = lines.join("\n");
    }

    // ── Instructions + count hint ─────────────────────────────────────────
    const countHint = totalCount > 0
      ? `You have **${totalCount}** memories stored.`
      : "No memories stored yet.";

    const instructions =
      `${countHint} ` +
      `Use \`memory_search\` when a topic, person, or project is mentioned that may have prior context — older memories are not shown above. ` +
      `Use \`memory_write\` immediately when you learn a fact worth keeping: preferences, decisions, names, deadlines, technical choices.`;

    if (!parts.length && !knowledgeMap) {
      return `# Memory\n\n_${countHint} No entries to show._ ${instructions}`;
    }

    const allParts = [instructions];
    if (knowledgeMap) allParts.push(knowledgeMap);
    allParts.push(...parts);
    return `# Memory\n\n${allParts.join("\n\n")}`;
  }

  private buildUserContent(text: string, media: string[]): string | Message[] {
    if (!media.length) return text;
    const images: Message[] = [];
    for (const path of media) {
      const mime = MIME_TYPES[extname(path).toLowerCase()];
      if (!mime) continue;
      try {
        const b64 = readFileSync(path).toString("base64");
        images.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
      } catch {
        continue;
      }
    }
    return images.length ? [...images, { type: "text", text }] : text;
  }
}

/** Returns true for internal sessions that don't need the full user-facing prompt. */
function isSystemSession(sessionKey?: string): boolean {
  if (!sessionKey) return false;
  if (sessionKey === "heartbeat") return true;
  return ["cron:", "subagent:"].some((prefix) => sessionKey.startsWith(prefix));
}

/** Returns true only for heartbeat sessions — the simplest recurring tasks. */
function isHeartbeatSession(sessionKey?: string): boolean {
  return sessionKey === "heartbeat";
}
