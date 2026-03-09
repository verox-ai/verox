import { readFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "src/utils/logger";

export type SkillExecEntry = {
  /** Absolute path to the entry point script. */
  path: string;
  /** Runtime to invoke it with (e.g. "node", "python3"), or "" to run directly. */
  runner: string;
};

const RUNNERS: Record<string, string> = {
  ".js": "node",
  ".mjs": "node",
  ".ts": "tsx",
  ".py": "python3",
  ".sh": ""
};

export const SKILL_METADATA_KEY = "verox";

const _dirname = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

const BUILTIN_SKILLS_DIR = join(_dirname, "skills");

export type SkillInfo = {
  name: string;
  path: string;
  source: "workspace" | "builtin";
  active: boolean;
};

/**
 * Discovers and loads skills from the workspace and the built-in skills
 * directory bundled with the application.
 *
 * A skill is a directory that contains at least a `SKILL.md` file. The file
 * may have a YAML front-matter block with metadata fields:
 *   - `description`  — one-line summary shown in the skills listing
 *   - `always`       — when `"true"`, the skill's instructions are always
 *                      injected into the system prompt (no need to load it)
 *   - `exec`         — explicit entry-point filename (falls back to index.*)
 *   - `metadata`     — JSON blob with `verox.requires.bins/env` for
 *                      availability gating
 *
 * Workspace skills take precedence over built-in skills with the same name.
 */
export class SkillsLoader {
  private workspaceSkills: string;
  private builtinSkills: string;
  private logger = new Logger(SkillsLoader.name);

  constructor(private workspace: string, builtinSkillsDir?: string) {
    this.workspaceSkills = join(workspace, "skills");
    this.builtinSkills = builtinSkillsDir ?? BUILTIN_SKILLS_DIR;
  }

  /**
   * Lists all discovered skills. When `filterUnavailable` is true (default),
   * skills whose `requires.bins` or `requires.env` conditions are not met
   * are excluded.
   */
  listSkills(filterUnavailable = true): SkillInfo[] {
    const skills: SkillInfo[] = [];

    if (existsSync(this.workspaceSkills)) {
      for (const entry of readdirSync(this.workspaceSkills, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile   = join(this.workspaceSkills, entry.name, "SKILL.md");
        const inactiveFile = join(this.workspaceSkills, entry.name, "SKILL.md.inactive");
        if (existsSync(skillFile)) {
          skills.push({ name: entry.name, path: skillFile, source: "workspace", active: true });
        } else if (existsSync(inactiveFile)) {
          skills.push({ name: entry.name, path: inactiveFile, source: "workspace", active: false });
        }
      }
    }

    if (existsSync(this.builtinSkills)) {
      for (const entry of readdirSync(this.builtinSkills, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(this.builtinSkills, entry.name, "SKILL.md");
        if (existsSync(skillFile) && !skills.some((s) => s.name === entry.name)) {
          skills.push({ name: entry.name, path: skillFile, source: "builtin", active: true });
        }
      }
    }

    // Inactive skills are excluded from the agent; filterUnavailable also strips unmet requirements.
    const active = skills.filter(s => s.active);
    if (filterUnavailable) {
      return active.filter((skill) => this.checkRequirements(this.getSkillMeta(skill.name)));
    }

    return skills; // return all including inactive when not filtering
  }

  /**
   * Activates a workspace skill by renaming SKILL.md.inactive → SKILL.md.
   * Returns false if the skill is not found or already active.
   */
  activateSkill(name: string): boolean {
    const inactive = join(this.workspaceSkills, name, "SKILL.md.inactive");
    const active   = join(this.workspaceSkills, name, "SKILL.md");
    if (!existsSync(inactive)) return false;
    renameSync(inactive, active);
    this.logger.info(`Skill activated: ${name}`);
    return true;
  }

  /**
   * Deactivates a workspace skill by renaming SKILL.md → SKILL.md.inactive.
   * Returns false if the skill is not found, already inactive, or is builtin-only.
   */
  deactivateSkill(name: string): boolean {
    const active   = join(this.workspaceSkills, name, "SKILL.md");
    const inactive = join(this.workspaceSkills, name, "SKILL.md.inactive");
    if (!existsSync(active)) return false;
    renameSync(active, inactive);
    this.logger.info(`Skill deactivated: ${name}`);
    return true;
  }

  /** Loads the raw `SKILL.md` content for a named skill (workspace first, then builtin). Returns null if not found. */
  loadSkill(name: string): string | null {
    const workspaceSkill = join(this.workspaceSkills, name, "SKILL.md");
    if (existsSync(workspaceSkill)) {
      return readFileSync(workspaceSkill, "utf-8");
    }
    const builtinSkill = join(this.builtinSkills, name, "SKILL.md");
    if (existsSync(builtinSkill)) {
      return readFileSync(builtinSkill, "utf-8");
    }
    return null;
  }

  /**
   * Loads and concatenates SKILL.md content for the given skill names,
   * stripping front-matter from each. Used to inline skill instructions into
   * the system prompt.
   */
  loadSkillsForContext(skillNames: string[]): string {
    const parts: string[] = [];
    for (const name of skillNames) {
      const content = this.loadSkill(name);
      if (content) {
        parts.push(`### Skill: ${name}\n\n${this.stripFrontmatter(content)}`);
      }
    }
    return parts.length ? parts.join("\n\n---\n\n") : "";
  }

  /**
   * Builds a one-line-per-skill summary listing (for the system prompt's
   * "# Skills" section). Includes the skill path, description, invocation
   * hint, and any unmet requirements for unavailable skills.
   */
  buildSkillsSummary(): string {
    const allSkills = this.listSkills(false);
    if (!allSkills.length) return "";

    const lines: string[] = [];
    for (const skill of allSkills) {
      const desc = this.getSkillDescription(skill.name);
      const meta = this.getSkillMeta(skill.name);
      const available = this.checkRequirements(meta);
      const entry = this.getSkillExecEntry(skill.name);
      const invokePart = entry ? ` — invoke: exec("${skill.name} [args]")` : "";
      if (available) {
        lines.push(`- ${skill.name}: ${desc}${invokePart} — ${skill.path}`);
      } else {
        const missing = this.getMissingRequirements(meta);
        const tag = missing ? `unavailable, needs: ${missing}` : "unavailable";
        lines.push(`- ${skill.name} [${tag}]: ${desc} — ${skill.path}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * If `command` starts with a known skill name that has an executable entry
   * point, returns that entry so the caller can verify the file's integrity
   * before execution. Returns `null` when no skill matches the command.
   *
   * Used by ExecTool to obtain the file path for hash verification immediately
   * before exec — this must be called on every execution, never cached.
   */
  getMatchingSkillEntry(command: string): SkillExecEntry | null {
    const trimmed = command.trim();
    for (const skill of this.listSkills(true)) {
      if (trimmed !== skill.name && !trimmed.startsWith(skill.name + " ")) continue;
      const entry = this.getSkillExecEntry(skill.name);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * If `command` starts with a known skill name that has an executable entry
   * point, rewrites it to the full invocation.
   * e.g. "homeassistant turn_on light.x" → "node /workspace/skills/homeassistant/index.js turn_on light.x"
   * Returns the command unchanged when no match is found.
   */
  resolveSkillCommand(command: string): string {
    const trimmed = command.trim();
    for (const skill of this.listSkills(true)) {
      if (trimmed !== skill.name && !trimmed.startsWith(skill.name + " ")) continue;
      const entry = this.getSkillExecEntry(skill.name);
      if (!entry) continue;
      const args = trimmed.slice(skill.name.length); // leading space preserved
      const invoke = entry.runner ? `${entry.runner} ${entry.path}` : entry.path;
      return `${invoke}${args}`;
    }
    return command;
  }

  /**
   * Returns the executable entry point for a skill, or null if none exists.
   * Checks the `exec` frontmatter field first, then scans for common filenames.
   */
  getSkillExecEntry(name: string): SkillExecEntry | null {
    const meta = this.getSkillMetadata(name);
    const execFile = meta?.exec ?? null;
    const candidates = execFile
      ? [execFile]
      : ["index.js", "index.mjs", "index.ts", "index.sh", "index.py"];

    const dirs = [
      join(this.workspaceSkills, name),
      join(this.builtinSkills, name)
    ];

    for (const dir of dirs) {
      for (const candidate of candidates) {
        const fullPath = join(dir, candidate);
        if (existsSync(fullPath)) {
          const runner = RUNNERS[extname(candidate)] ?? "";
          return { path: fullPath, runner };
        }
      }
    }
    return null;
  }

  /** Returns the names of all available skills that have `always: "true"` in their front-matter. */
  getAlwaysSkills(): string[] {
    const result: string[] = [];
    for (const skill of this.listSkills(true)) {
      const meta = this.getSkillMetadata(skill.name) ?? {};
      const parsed = this.parseSkillMetadata(meta.metadata ?? "");
      if (parsed.always || (meta as { always?: string }).always === "true") {
        result.push(skill.name);
      }
    }
    return result;
  }

  /**
   * Parses the YAML front-matter of a skill's SKILL.md into a flat string
   * record. Returns null if the skill has no front-matter.
   */
  getSkillMetadata(name: string): Record<string, string> | null {
    const content = this.loadSkill(name);
    if (!content || !content.startsWith("---")) {
      return null;
    }
    const match = content.match(/^---\n(.*?)\n---/s);
    if (!match) {
      return null;
    }
    const metadata: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (!key || rest.length === 0) {
        continue;
      }
      metadata[key.trim()] = rest.join(":").trim().replace(/^['"]|['"]$/g, "");
    }
    return metadata;
  }

  private getSkillDescription(name: string): string {
    const meta = this.getSkillMetadata(name);
    if (meta?.description) {
      return meta.description;
    }
    return name;
  }

  private stripFrontmatter(content: string): string {
    if (content.startsWith("---")) {
      const match = content.match(/^---\n.*?\n---\n/s);
      if (match) {
        return content.slice(match[0].length).trim();
      }
    }
    return content;
  }

  private parseSkillMetadata(raw: string): Record<string, unknown> {
    try {
      const data = JSON.parse(raw);
      if (typeof data !== "object" || !data) {
        return {};
      }
      const meta = (data as Record<string, unknown>)[SKILL_METADATA_KEY];
      if (typeof meta === "object" && meta) {
        return meta as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private getSkillMeta(name: string): Record<string, unknown> {
    const meta = this.getSkillMetadata(name) ?? {};
    return this.parseSkillMetadata(meta.metadata ?? "");
  }

  private checkRequirements(skillMeta: Record<string, unknown>): boolean {
    return this.getMissingRequirements(skillMeta).length === 0;
  }

  private getMissingRequirements(skillMeta: Record<string, unknown>): string {
    const missing: string[] = [];
    const requires = (skillMeta.requires ?? {}) as { bins?: string[]; env?: string[] };
    for (const bin of requires.bins ?? []) {
      if (!this.which(bin)) missing.push(`CLI: ${bin}`);
    }
    for (const env of requires.env ?? []) {
      if (!process.env[env]) missing.push(`ENV: ${env}`);
    }
    return missing.join(", ");
  }

  private which(binary: string): boolean {
    const paths = (process.env.PATH ?? "").split(":");
    for (const dir of paths) {
      const full = join(dir, binary);
      if (existsSync(full)) {
        return true;
      }
    }
    return false;
  }
}