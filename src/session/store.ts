import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getSessionsPath, safeFilename } from "src/utils/util.js";
import type { Session, SessionMessage } from "./manager.js";

/**
 * Lightweight metadata read from the first line of a session JSONL file.
 * Used for listing without loading full transcripts into memory.
 */
export type SessionHeader = {
  key: string;
  created_at: string;
  updated_at: string;
  path: string;
  metadata: Record<string, unknown>;
};

/**
 * Handles all JSONL file I/O for sessions.
 *
 * SessionManager delegates here so its own logic stays focused on
 * in-memory cache and session lifecycle rather than serialisation details.
 *
 * ### File format
 * ```
 * {"_type":"metadata","key":"telegram:123","created_at":"…","updated_at":"…","metadata":{…}}
 * {"role":"user","content":"hello","timestamp":"…"}
 * {"role":"assistant","content":"hi","timestamp":"…"}
 * ```
 * The `key` field in the metadata header was added in v2. Legacy files
 * without it fall back to filename-based key reconstruction in `listHeaders()`.
 */
export class JsonlSessionStore {
  private readonly sessionsDir: string;

  constructor() {
    this.sessionsDir = getSessionsPath();
  }

  getSessionsDir(): string {
    return this.sessionsDir;
  }

  getPath(key: string): string {
    const safeKey = safeFilename(key.replace(/:/g, "_"));
    return join(this.sessionsDir, `${safeKey}.jsonl`);
  }

  load(key: string): Session | null {
    const path = this.getPath(key);
    if (!existsSync(path)) return null;
    try {
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      const messages: SessionMessage[] = [];
      let metadata: Record<string, unknown> = {};
      let createdAt = new Date();
      let updatedAt = new Date();
      for (const line of lines) {
        const data = JSON.parse(line) as Record<string, unknown>;
        if (data._type === "metadata") {
          metadata = (data.metadata as Record<string, unknown>) ?? {};
          if (data.created_at) createdAt = new Date(String(data.created_at));
          if (data.updated_at) updatedAt = new Date(String(data.updated_at));
        } else {
          messages.push(data as SessionMessage);
        }
      }
      return { key, messages, createdAt, updatedAt, metadata };
    } catch {
      return null;
    }
  }

  save(session: Session): void {
    const path = this.getPath(session.key);
    const header = {
      _type: "metadata",
      key: session.key,
      created_at: session.createdAt.toISOString(),
      updated_at: session.updatedAt.toISOString(),
      metadata: session.metadata
    };
    const lines = [JSON.stringify(header), ...session.messages.map((m) => JSON.stringify(m))].join("\n");
    writeFileSync(path, `${lines}\n`);
  }

  delete(key: string): boolean {
    const path = this.getPath(key);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
    return false;
  }

  /**
   * Reads only the first line of each JSONL file — efficient for listing
   * without pulling full transcripts into memory.
   *
   * Uses the `key` field stored in the header when available (written since v2).
   * Falls back to filename-based reconstruction for legacy files.
   */
  listHeaders(): SessionHeader[] {
    const headers: SessionHeader[] = [];
    for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(this.sessionsDir, entry.name);
      try {
        const firstLine = readFileSync(path, "utf-8").split("\n")[0];
        if (!firstLine) continue;
        const data = JSON.parse(firstLine) as Record<string, unknown>;
        if (data._type !== "metadata") continue;
        const key = typeof data.key === "string"
          ? data.key
          : entry.name.replace(/\.jsonl$/, "").replace(/_/g, ":");
        headers.push({
          key,
          created_at: String(data.created_at ?? ""),
          updated_at: String(data.updated_at ?? ""),
          path,
          metadata: (data.metadata as Record<string, unknown>) ?? {}
        });
      } catch {
        continue;
      }
    }
    return headers;
  }
}
