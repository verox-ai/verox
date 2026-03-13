import { resolve, join } from "node:path";
import { injectable, inject } from "tsyringe";
import { loadEncryptedFile, saveEncryptedFile, type VaultData } from "./crypto.js";

/**
 * Encrypted credential vault using AES-256-GCM with scrypt key derivation.
 *
 * All entries are stored in a single encrypted JSON blob at {dataPath}/vault.enc.
 * The decryption password is read from the VEROX_VAULT_PASSWORD environment variable.
 *
 * Key naming conventions:
 *   skill.{skillname}.{ENV_KEY}  — injected into every script inside a manifest-verified skill folder
 *   config.{path}.{key}         — used for config overrides via vault
 */
@injectable()
export class VaultService {
  private readonly vaultPath: string;
  private readonly password: string | null;

  constructor(@inject("dataPath") dataPath: string) {
    this.vaultPath = join(dataPath, "vault.enc");
    this.password = process.env["VEROX_VAULT_PASSWORD"] ?? null;

  }

  /** True when a vault password is configured. All read/write operations require this. */
  isAvailable(): boolean {
    return this.password !== null;
  }

  /** Stores or overwrites a vault entry. Throws if vault password is not set. */
  set(key: string, value: string): void {
    const data = this.load();
    data[key] = value;
    this.save(data);
  }

  /** Returns the value for `key`, or `undefined` if not found or vault is unavailable. */
  get(key: string): string | undefined {
    if (!this.isAvailable()) return undefined;
    try {
      return this.load()[key];
    } catch {
      return undefined;
    }
  }

  /** Removes `key` from the vault. Returns `true` if it existed, `false` otherwise. */
  delete(key: string): boolean {
    const data = this.load();
    if (!(key in data)) return false;
    delete data[key];
    this.save(data);
    return true;
  }

  /** Returns all stored key names. Returns an empty array when vault is unavailable. */
  list(): string[] {
    if (!this.isAvailable()) return [];
    try {
      return Object.keys(this.load());
    } catch {
      return [];
    }
  }

  /**
   * Returns env vars for skill.{skillName}.* entries.
   * All scripts inside a manifest-verified skill folder share the same set.
   * The prefix is stripped; only the env key name is returned.
   * Returns an empty object when vault is unavailable or on decryption error.
   */
  getSkillEnvs(skillName: string): Record<string, string> {
    if (!this.isAvailable()) return {};
    try {
      const data = this.load();
      const prefix = `skill.${skillName}.`;
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith(prefix)) {
          env[key.slice(prefix.length)] = value;
        }
      }
      return env;
    } catch {
      return {};
    }
  }

  /**
   * Returns all config.* vault entries as a flat dot-path record (prefix stripped).
   * e.g. vault key "config.providers.anthropic.apiKey" → "providers.anthropic.apiKey"
   * Returns an empty object when vault is unavailable or on decryption error.
   */
  getConfigOverrides(): Record<string, string> {
    if (!this.isAvailable()) return {};
    try {
      const data = this.load();
      const prefix = "config.";
      const overrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith(prefix)) {
          overrides[key.slice(prefix.length)] = value;
        }
      }
      return overrides;
    } catch {
      return {};
    }
  }

  /**
   * Resolves vault credentials for a command by scanning its tokens for a
   * skill script path inside `workingDir/skills/{name}/{script}.*`.
   *
   * Fallback for commands that aren't manifest-verified (e.g. unsigned skills).
   * Manifest-verified skills bypass this via `getSkillEnvs` directly in ExecTool.
   * Returns an empty object when no matching skill path is found.
   */
  resolveCommandEnvs(command: string, workingDir: string): Record<string, string> {
    if (!this.isAvailable()) return {};
    const skillsDir = resolve(workingDir, "skills");

    // Split the command into tokens, stripping surrounding quotes.
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (const token of tokens) {
      const cleaned = token.replace(/^["']|["']$/g, "");

      // Try both absolute and workingDir-relative resolution.
      const candidates = [resolve(cleaned), resolve(workingDir, cleaned)];
      for (const candidate of candidates) {
        if (!candidate.startsWith(skillsDir + "/")) continue;

        const relative = candidate.slice(skillsDir.length + 1); // e.g. "homeassistant/index.js"
        const slashIdx = relative.indexOf("/");
        if (slashIdx === -1) continue;

        const skillName = relative.slice(0, slashIdx);
        const scriptFile = relative.slice(slashIdx + 1);
        if (!skillName || !scriptFile || scriptFile.includes("/")) continue;

        return this.getSkillEnvs(skillName);
      }
    }
    return {};
  }

  private load(): VaultData {
    if (!this.password) throw new Error("VEROX_VAULT_PASSWORD is not set");
    return loadEncryptedFile(this.vaultPath, this.password);
  }

  private save(data: VaultData): void {
    if (!this.password) throw new Error("VEROX_VAULT_PASSWORD is not set");
    saveEncryptedFile(this.vaultPath, data, this.password);
  }
}
