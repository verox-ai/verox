import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "src/utils/logger.js";

const logger = new Logger("PromptLoader");

/** All prompt names that must be present. Each maps to <name>.md in the prompts dir. */
export const REQUIRED_PROMPTS = [
  "agent-identity",
  "subagent",
  "memory-extraction",
  "compaction",
  "heartbeat"
] as const;

export type PromptName = (typeof REQUIRED_PROMPTS)[number];

type Variables = Record<string, string | number | boolean | null | undefined>;

let _workspace: string | null = null;
let _templateDir: string | null = null;
let _toolDescriptions: Record<string, string> | null = null;

/**
 * Initialise the loader with paths it needs at read time.
 * `templateDir` is the project's `templates/` directory resolved by Workspace.
 * Call this once at startup, before any prompt is rendered.
 */
export function initPromptLoader(workspace: string, templateDir: string | null): void {
  _workspace = workspace;
  _templateDir = templateDir;
  _toolDescriptions = null; // reset so a re-init picks up updated files
}

/**
 * Ensure every required prompt exists in `workspace/prompts/`.
 * Files missing from the workspace are copied from `templateDir/prompts/`.
 * Logs a warning for any file that is also absent from the templates directory.
 *
 * Returns lists of what was copied and what is unresolvably missing.
 * Call this once at startup after `initPromptLoader`.
 */
export function ensureWorkspacePrompts(): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];

  if (!_workspace) {
    logger.warn("ensureWorkspacePrompts called before initPromptLoader");
    return { copied, missing };
  }

  const promptsDir = join(_workspace, "prompts");
  mkdirSync(promptsDir, { recursive: true });

  // Check each required .md prompt
  for (const name of REQUIRED_PROMPTS) {
    const dest = join(promptsDir, `${name}.md`);
    if (existsSync(dest)) continue;

    if (_templateDir) {
      const src = join(_templateDir, "prompts", `${name}.md`);
      if (existsSync(src)) {
        try {
          copyFileSync(src, dest);
          copied.push(`${name}.md`);
          logger.debug(`Copied prompt template: ${name}.md`);
          continue;
        } catch (err) {
          logger.warn(`Failed to copy prompt ${name}.md`, { error: String(err) });
        }
      }
    }

    logger.warn(`Required prompt missing and could not be seeded: ${name}.md`);
    missing.push(`${name}.md`);
  }

  // Check tool-descriptions.json
  const descDest = join(promptsDir, "tool-descriptions.json");
  if (!existsSync(descDest) && _templateDir) {
    const descSrc = join(_templateDir, "prompts", "tool-descriptions.json");
    if (existsSync(descSrc)) {
      try {
        copyFileSync(descSrc, descDest);
        copied.push("tool-descriptions.json");
        logger.debug("Copied prompt template: tool-descriptions.json");
      } catch (err) {
        logger.warn("Failed to copy tool-descriptions.json", { error: String(err) });
      }
    }
  }

  if (copied.length) {
    logger.info(`Seeded ${copied.length} prompt file(s) into workspace/prompts/`, { copied });
  }

  return { copied, missing };
}

/**
 * Replace `{{variable}}` placeholders in a template string.
 * Unknown placeholders are left unchanged.
 */
export function renderPrompt(template: string, vars: Variables = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in vars ? String(vars[key] ?? "") : match
  );
}

/**
 * Load and render a named prompt template.
 *
 * Read order:
 *   1. `<workspace>/prompts/<name>.md`   — user-editable copy
 *   2. `<templateDir>/prompts/<name>.md` — bundled default (fallback)
 *
 * Returns null if neither location has the file.
 */
export function getPrompt(name: string, vars: Variables = {}): string | null {
  const template = loadRawPrompt(name);
  if (template === null) return null;
  return renderPrompt(template, vars);
}

/**
 * Look up an overridden tool description by tool name.
 * Read order mirrors `getPrompt`: workspace override, then templateDir.
 * Returns null if no entry exists for this tool name.
 */
export function getToolDescription(toolName: string): string | null {
  const descs = loadToolDescriptions();
  return descs[toolName] ?? null;
}

// ── internals ────────────────────────────────────────────────────────────────

function loadRawPrompt(name: string): string | null {
  if (_workspace) {
    const p = join(_workspace, "prompts", `${name}.md`);
    if (existsSync(p)) {
      try { return readFileSync(p, "utf-8"); } catch { /* fall through */ }
    }
  }
  if (_templateDir) {
    const p = join(_templateDir, "prompts", `${name}.md`);
    if (existsSync(p)) {
      try { return readFileSync(p, "utf-8"); } catch { /* fall through */ }
    }
  }
  return null;
}

function loadToolDescriptions(): Record<string, string> {
  if (_toolDescriptions !== null) return _toolDescriptions;

  for (const base of [
    _workspace ? join(_workspace, "prompts") : null,
    _templateDir ? join(_templateDir, "prompts") : null
  ]) {
    if (!base) continue;
    const p = join(base, "tool-descriptions.json");
    if (existsSync(p)) {
      try {
        _toolDescriptions = JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
        return _toolDescriptions;
      } catch { /* fall through */ }
    }
  }

  _toolDescriptions = {};
  return _toolDescriptions;
}
