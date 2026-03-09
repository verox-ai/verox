import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "src/types/schemas/schema.js";

type BootstrapConfig = Config["agents"]["context"]["bootstrap"];

/** Session key for heartbeat sessions — loads the heartbeat file set. */
const HEARTBEAT_SESSION_KEY = "heartbeat";

/** Session key prefixes that use the minimal file set (no user-facing files needed). */
const MINIMAL_CONTEXT_PREFIXES = ["cron:", "subagent:"];

/**
 * Loads workspace bootstrap files (AGENTS.md, SOUL.md, etc.) for injection
 * into the system prompt.
 *
 * Applies per-file and total character limits and selects the appropriate
 * file set based on the session type:
 * - Regular sessions: full file list
 * - Heartbeat sessions: minimal + heartbeat files
 * - Cron / subagent sessions: minimal files only
 */
export class BootstrapLoader {
  constructor(private workspace: string, private config: BootstrapConfig) {}

  /** Loads and returns the concatenated bootstrap content for the given session. */
  load(sessionKey?: string): string {
    const { perFileChars, totalChars } = this.config;
    const files = this.selectFiles(sessionKey);
    const totalLimit = totalChars > 0 ? totalChars : Number.POSITIVE_INFINITY;
    let remaining = totalLimit;
    const parts: string[] = [];

    for (const filename of files) {
      const filePath = join(this.workspace, filename);
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, "utf-8").trim();
      if (!raw) continue;
      const perFileLimit = perFileChars > 0 ? perFileChars : raw.length;
      const allowed = Math.min(perFileLimit, remaining);
      if (allowed <= 0) break;
      const content = truncate(raw, allowed);
      parts.push(`## ${filename}\n\n${content}`);
      remaining -= content.length;
      if (remaining <= 0) break;
    }

    return parts.join("\n\n");
  }

  private selectFiles(sessionKey?: string): string[] {
    const { files, minimalFiles, heartbeatFiles } = this.config;
    if (!sessionKey) return files;
    if (sessionKey === HEARTBEAT_SESSION_KEY) {
      return [...new Set([...minimalFiles, ...heartbeatFiles])];
    }
    if (MINIMAL_CONTEXT_PREFIXES.some((prefix) => sessionKey.startsWith(prefix))) {
      return minimalFiles;
    }
    return files;
  }
}

function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  const omitted = text.length - limit;
  const suffix = `\n\n...[truncated ${omitted} chars]`;
  if (suffix.length >= limit) return text.slice(0, limit).trimEnd();
  return `${text.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
}
