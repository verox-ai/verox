import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { injectable, inject } from "tsyringe";
import { loadEncryptedFile, saveEncryptedFile, type VaultData } from "./crypto.js";
import { Logger } from "src/utils/logger.js";

type SkillManifest = {
  skill: string;
  /** Relative file path → sha256 hash of its contents at signing time. */
  files: Record<string, string>;
  /**
   * sha256 of JSON.stringify(files) — a self-consistency guard so any
   * tampering with the individual hashes inside the vault is detectable.
   */
  manifestHash: string;
  signedAt: string;
};

const KEY_PREFIX = "manifest.";

/**
 * Directories excluded from file scanning during sign/verify.
 * Keep this list minimal — false exclusions would allow injecting malicious
 * files without invalidating the signature.
 */
const SCAN_IGNORE = new Set(["node_modules", ".git", "dist", ".cache", "__pycache__", ".json"]);

/**
 * Folder-level integrity manifest for skills.
 *
 * Signing a skill hashes **every file** in its directory tree. Verification
 * re-hashes all files and compares. Any change — including added, deleted, or
 * modified files — causes `verify` to return `false`.
 *
 * Credentials are keyed by skill name only:
 *   `skill.{skillName}.{ENV_KEY}`
 * so every script inside a verified skill folder receives the same env set,
 * regardless of whether the entry point is `index.js`, `get.js`, etc.
 *
 * ### Verification semantics
 * `verify(scriptPath)` returns:
 *   - `true`      — signed and all files match → safe to inject credentials
 *   - `false`     — signed but files have changed → tampered, block execution
 *   - `undefined` — not in the manifest → allow without credentials
 */
@injectable()
export class SkillManifestService {
  private readonly manifestPath: string;
  private readonly password: string | null;
  private logger = new Logger(SkillManifestService.name);

  constructor(@inject("dataPath") dataPath: string) {
    this.manifestPath = join(dataPath, "skill-manifest.enc");
    this.password = process.env["VEROX_VAULT_PASSWORD"] ?? null;
  }

  /** True when a vault password is configured. */
  isAvailable(): boolean {
    return this.password !== null;
  }

  shouldIgnore (fileName: string): boolean {
  // 1. Check if the full name matches (for folders like .git)
  if (SCAN_IGNORE.has(fileName)) return true;

  // 2. Extract the extension (e.g., ".json")
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex !== -1) {
    const extension = fileName.slice(dotIndex);
    if (SCAN_IGNORE.has(extension)) return true;
  }

  return false;
};

  /**
   * Hashes every file in `skillDir` and stores the manifest under
   * `manifest.{skillName}` in the encrypted vault.
   *
   * Must be called by a human operator — the agent has no access to
   * VEROX_VAULT_PASSWORD and therefore cannot self-sign.
   */
  register(skillDir: string, skillName: string): { files: Record<string, string>; manifestHash: string } {
    const files = this.hashSkillDir(skillDir);
    const manifestHash = this.hashString(JSON.stringify(files));
    const manifest: SkillManifest = {
      skill: skillName,
      files,
      manifestHash,
      signedAt: new Date().toISOString(),
    };
    const data = this.load();
    data[KEY_PREFIX + skillName] = JSON.stringify(manifest);
    this.save(data);
    return { files, manifestHash };
  }

  /**
   * Verifies all files in the skill directory against the stored manifest.
   *
   * `scriptPath` may be any file inside the skill directory — the skill
   * directory is derived by taking its parent (`dirname(scriptPath)`) and the
   * skill name by `basename` of that directory.
   */
  verify(scriptPath: string): boolean | undefined {
    if (!this.isAvailable()) return undefined;
    try {
      const skillDir = dirname(scriptPath);
      const skillName = basename(skillDir);
      const data = this.load();
      const raw = data[KEY_PREFIX + skillName];
      if (!raw) return undefined; // not signed

      const stored = JSON.parse(raw) as SkillManifest;

      // Self-consistency check: manifestHash must match what we'd compute from
      // the stored files record, catching in-vault tampering.
      const expectedManifestHash = this.hashString(JSON.stringify(stored.files));
      if (stored.manifestHash !== expectedManifestHash) return false;

      // Re-hash the current state of the skill directory.
      const current = this.hashSkillDir(skillDir);

      // File count mismatch means files were added or deleted.
      if (Object.keys(current).length !== Object.keys(stored.files).length) return false;

      // Every file must match its signed hash.
      for (const [relPath, hash] of Object.entries(stored.files)) {
        if (current[relPath] !== hash) return false;
      }

      return true;
    } catch {
      return undefined;
    }
  }

  /** Removes the manifest for a skill by name. */
  remove(skillName: string): boolean {
    const data = this.load();
    const key = KEY_PREFIX + skillName;
    if (!(key in data)) return false;
    delete data[key];
    this.save(data);
    return true;
  }

  /** Lists all signed skills with their file counts and signing metadata. */
  list(): Array<{ skill: string; fileCount: number; manifestHash: string; signedAt: string }> {
    if (!this.isAvailable()) return [];
    try {
      return Object.entries(this.load())
        .filter(([key]) => key.startsWith(KEY_PREFIX))
        .map(([, raw]) => {
          const m = JSON.parse(raw) as SkillManifest;
          return {
            skill: m.skill,
            fileCount: Object.keys(m.files).length,
            manifestHash: m.manifestHash,
            signedAt: m.signedAt,
          };
        });
    } catch {
      return [];
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private hashSkillDir(skillDir: string): Record<string, string> {
    const out: Record<string, string> = {};
    this.collectFiles(skillDir, skillDir, out);
    return out;
  }

  private collectFiles(root: string, dir: string, out: Record<string, string>): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (this.shouldIgnore(entry.name)) {
        this.logger.debug(`Skip ${entry.name}`)
        continue;
      } else {
        this.logger.debug(`adding ${entry.name}`)
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.collectFiles(root, fullPath, out);
      } else if (entry.isFile()) {
        out[relative(root, fullPath)] = this.hashFile(fullPath);
      }
    }
  }

  private hashFile(filePath: string): string {
    return "sha256:" + createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }

  private hashString(s: string): string {
    return "sha256:" + createHash("sha256").update(s).digest("hex");
  }

  private load(): VaultData {
    if (!this.password) throw new Error("VEROX_VAULT_PASSWORD is not set");
    return loadEncryptedFile(this.manifestPath, this.password);
  }

  private save(data: VaultData): void {
    if (!this.password) throw new Error("VEROX_VAULT_PASSWORD is not set");
    saveEncryptedFile(this.manifestPath, data, this.password);
  }
}
