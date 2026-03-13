import { injectable, inject } from "tsyringe";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, watch as fsWatch } from "node:fs";
import { join, dirname } from "node:path";
import { ConfigSchema, type Config } from "src/types/schemas/schema.js";
import { Logger } from "src/utils/logger.js";
import { VaultService } from "src/vault/credentials.js";

type SkillSchemaProperty = { type?: string; envName?: string };
type SkillSchema = { properties?: Record<string, SkillSchemaProperty> };

/**
 * Unified configuration service.
 *
 * Loads ~/.verox/config.json (the central app config that replaces .env)
 * and scans workspace/skills/*\/config.json for skill-local configs.
 *
 * File watching keeps both in-memory when changed on disk.
 *
 * Skill env injection: skills that shell out (curl, python, bash) can declare
 * which config fields should be exposed as env vars via config.schema.json:
 *   { "properties": { "token": { "type": "string", "envName": "HA_TOKEN" } } }
 *
 * ExecTool calls getAllSkillEnvs() and merges into the child process env option
 * so secrets never enter global process.env.
 */
@injectable()
export class ConfigService {
  private _app: Config;
  private skillConfigs = new Map<string, Record<string, unknown>>();
  private skillSchemas = new Map<string, SkillSchema>();
  private readonly logger = new Logger(ConfigService.name);
  private changeListeners: Array<(cfg: Config) => void> = [];

  /**
   * Registers a callback invoked whenever the config file is reloaded.
   * Returns an unsubscribe function.
   */
  onConfigChange(listener: (cfg: Config) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const idx = this.changeListeners.indexOf(listener);
      if (idx >= 0) this.changeListeners.splice(idx, 1);
    };
  }

  constructor(
    @inject("configFile") private readonly configFile: string,
    @inject("workspace") private readonly workspace: string,
    @inject(VaultService) private readonly vaultService: VaultService
  ) {
    this._app = this.parseAppConfig();
  }

  /** The current application config, refreshed on file change. */
  get app(): Config {
    return this._app;
  }

  /**
   * Scans skill configs and starts file watchers.
   * Call once after the container is fully resolved.
   */
  load(): void {
    this.loadAllSkillConfigs();
    this.startWatching();
    this.logger.info("ConfigService ready", { configFile: this.configFile });
  }

  getSkillConfig(skillName: string): Record<string, unknown> | undefined {
    return this.skillConfigs.get(skillName);
  }

  /** Returns the raw config.json contents without vault overrides or schema defaults. */
  getRawConfig(): Record<string, unknown> {
    if (!existsSync(this.configFile)) return {};
    try {
      return JSON.parse(readFileSync(this.configFile, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Deep-merges a partial config update into config.json and writes it to disk.
   * Values equal to "[configured]" are skipped (preserved as-is from the current file).
   */
  saveAppConfig(partial: Record<string, unknown>): void {
    const current = this.getRawConfig();

    // Dynamic-record sections use user-defined keys (e.g. server names) — a key
    // absent from the incoming payload means the user deleted it. deepMergeInto
    // would silently preserve the old entry, so we replace these sections in full
    // before merging to honour deletions.
    for (const recordPath of DYNAMIC_RECORD_PATHS) {
      const parts = recordPath.split(".");
      let src: unknown = partial;
      let tgt: Record<string, unknown> = current;
      let valid = true;
      for (let i = 0; i < parts.length - 1; i++) {
        src = (src as Record<string, unknown> | undefined)?.[parts[i]];
        const next = tgt[parts[i]];
        if (!src || typeof src !== "object") { valid = false; break; }
        if (!next || typeof next !== "object") tgt[parts[i]] = {};
        tgt = tgt[parts[i]] as Record<string, unknown>;
      }
      if (valid && src !== undefined) {
        tgt[parts[parts.length - 1]] = (src as Record<string, unknown>)[parts[parts.length - 1]];
      }
    }

    deepMergeInto(current, partial);
    writeFileSync(this.configFile, JSON.stringify(current, null, 2) + "\n", "utf-8");
    this.logger.info("Config saved", { path: this.configFile });
  }

  /**
   * Returns env vars from ALL skills merged together.
   * Env var names are namespaced per-skill (e.g. HA_URL, GITHUB_TOKEN) so no
   * collision risk. Used by ExecTool to inject secrets into child processes.
   */
  getAllSkillEnvs(): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const skillName of this.skillConfigs.keys()) {
      Object.assign(merged, this.getSkillEnv(skillName));
    }
    return merged;
  }

  /** Returns env vars for a specific skill — only fields with `envName` in their schema. */
  getSkillEnv(skillName: string): Record<string, string> {
    const config = this.skillConfigs.get(skillName);
    const schema = this.skillSchemas.get(skillName);
    if (!config) return {};
    const env: Record<string, string> = {};
    for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
      if (prop.envName && config[key] !== undefined) {
        env[prop.envName] = String(config[key]);
      }
    }
    return env;
  }

  private parseAppConfig(): Config {
    let raw: Record<string, unknown> = {};
    if (!existsSync(this.configFile)) {
      this.logger.info("Config file not found, using defaults", { path: this.configFile });
      this.writeExampleConfig();
    } else {
      this.logger.info(`Loading app config at ${this.configFile}`);
      try {
        raw = JSON.parse(readFileSync(this.configFile, "utf-8")) as Record<string, unknown>;
      } catch (err) {
        this.logger.warn("Config parse failed, using defaults", { error: String(err) });
      }
    }

    // Apply vault config.* overrides before schema parsing so encrypted values
    // take precedence over any plaintext placeholders in config.json.
    const overrides = this.vaultService.getConfigOverrides();
    for (const [dotPath, value] of Object.entries(overrides)) {
      deepSet(raw, dotPath, value);
    }
    if (Object.keys(overrides).length) {
      this.logger.info("Applied vault config overrides", { count: Object.keys(overrides).length });
    }

    try {
      const parsed = ConfigSchema.parse(raw);
      this.logger.info("Config loaded", { path: this.configFile });
      return parsed;
    } catch (err) {
      this.logger.warn("Config schema validation failed, using defaults", { error: String(err) });
      return ConfigSchema.parse({});
    }
  }

  private writeExampleConfig(): void {
    const examplePath = join(dirname(this.configFile), "config.example.json");
    if (existsSync(examplePath)) return;

    // Start from schema defaults so the example stays in sync with the schema automatically.
    const defaults = ConfigSchema.parse({}) as Record<string, unknown>;

    // Overlay placeholder strings for fields that require user-supplied secrets.
    const example = {
      ...defaults,
      _vault: {
        _info: "Sensitive credentials can be stored in the encrypted vault instead of this file. Set VEROX_VAULT_PASSWORD in your environment, then use the CLI to manage secrets.",
        _password_env: "VEROX_VAULT_PASSWORD=your-strong-password",
        _commands: {
          set: "verox vault set <key> <value>",
          list: "verox vault list",
          delete: "verox vault delete <key>"
        },
        _key_patterns: {
          skill_credential: "skill.{skillname}.{scriptname}.{ENV_VAR}",
          skill_example: "skill.homeassistant.index.HA_TOKEN",
          config_override: "config.{dot.path.to.config.field}",
          config_example_anthropic: "config.providers.anthropic.apiKey",
          config_example_telegram: "config.channels.telegram.token"
        }
      },
      providers: {
        anthropic: { apiKey: "sk-ant-your-key-here", apiBase: null, extraHeaders: null, wireApi: "auto" },
        openai: { apiKey: "sk-your-openai-key-here", apiBase: null, extraHeaders: null, wireApi: "auto" }
      },
      channels: {
        ...(defaults.channels as Record<string, unknown>),
        telegram: {
          ...((defaults as { channels: { telegram: Record<string, unknown> } }).channels.telegram),
          token: "your-telegram-bot-token"
        },
        slack: {
          ...((defaults as { channels: { slack: Record<string, unknown> } }).channels.slack),
          botToken: "xoxb-your-bot-token",
          appToken: "xapp-your-app-token"
        },
        webhook: {
          ...((defaults as { channels: { webhook: Record<string, unknown> } }).channels.webhook),
          jwtSecret: "change-me-to-a-random-secret"
        },
      },
      tools: {
        ...(defaults.tools as Record<string, unknown>),
        web: {
          search: { apiKey: "your-search-api-key", maxResults: 5 }
        }
      }
    };
    try {
      mkdirSync(dirname(this.configFile), { recursive: true });
      writeFileSync(examplePath, JSON.stringify(example, null, 2) + "\n", "utf-8");
      this.logger.info("Example config written — copy to config.json and fill in your values", { path: examplePath });
    } catch (err) {
      this.logger.warn("Could not write example config", { error: String(err) });
    }
  }

  private loadAllSkillConfigs(): void {
    const skillsDir = join(this.workspace, "skills");
    if (!existsSync(skillsDir)) return;
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          this.loadSkillConfig(entry.name, join(skillsDir, entry.name));
        }
      }
    } catch (err) {
      this.logger.warn("Failed to scan skills directory", { error: String(err) });
    }
  }

  private loadSkillConfig(skillName: string, skillDir: string): void {
    const configPath = join(skillDir, "config.json");
    const schemaPath = join(skillDir, "config.schema.json");
    if (existsSync(configPath)) {
      try {
        this.skillConfigs.set(
          skillName,
          JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
        );
        this.logger.debug("Skill config loaded", { skill: skillName });
      } catch (err) {
        this.logger.warn("Failed to load skill config", { skill: skillName, error: String(err) });
      }
    }
    if (existsSync(schemaPath)) {
      try {
        this.skillSchemas.set(
          skillName,
          JSON.parse(readFileSync(schemaPath, "utf-8")) as SkillSchema
        );
      } catch {
        // Schema is optional — ignore parse errors
      }
    }
  }

  private startWatching(): void {
    if (existsSync(this.configFile)) {
      try {
        fsWatch(this.configFile, () => {
          this._app = this.parseAppConfig();
          this.logger.info("App config reloaded");
          for (const listener of this.changeListeners) {
            try { listener(this._app); } catch (err) {
              this.logger.warn("Config change listener error", { error: String(err) });
            }
          }
        }).on("error", (err) => this.logger.warn("Config watcher error", { error: String(err) }));
      } catch (err) {
        this.logger.warn("Could not watch config file", { error: String(err) });
      }
    }

    const skillsDir = join(this.workspace, "skills");
    if (existsSync(skillsDir)) {
      try {
        fsWatch(skillsDir, { recursive: true }, (_event, filename) => {
          if (typeof filename !== "string") return;
          // filename is like "homeassistant/config.json" on most OSes
          const parts = filename.split(/[/\\]/);
          const skillName = parts[0];
          if (skillName && filename.endsWith("config.json")) {
            this.loadSkillConfig(skillName, join(skillsDir, skillName));
            this.logger.debug("Skill config reloaded", { skill: skillName });
          }
        }).on("error", (err) =>
          this.logger.warn("Skills watcher error", { error: String(err) })
        );
      } catch (err) {
        this.logger.warn("Could not watch skills directory", { error: String(err) });
      }
    }
  }
}

/**
 * Recursively merges `source` into `target` in-place.
 * Skips values equal to "[configured]" so masked API responses don't overwrite secrets.
 */
/**
 * Sections whose keys are user-defined (dynamic records).
 * For these, the entire section is replaced on save so that removed keys
 * are deleted from the file rather than silently preserved by deepMergeInto.
 */
const DYNAMIC_RECORD_PATHS = [
  "mcp.servers",
];

function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === "[configured]") continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)
        && typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])) {
      deepMergeInto(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Sets a value on a nested object using a dot-separated path.
 * Intermediate objects are created if they don't exist.
 * e.g. deepSet(obj, "providers.anthropic.apiKey", "sk-...")
 */
function deepSet(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}
