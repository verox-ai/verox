import type { Command } from "commander";
import { chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { VaultService } from "src/vault/credentials.js";
import { getDataPath, getWorkspacePath } from "../utils/paths.js";

function getVaultService(): VaultService {
  return new VaultService(getDataPath());
}

/**
 * For skill.{skillname}.{scriptname}.{KEY}, locate and return the script path
 * by scanning for common extensions inside workspace/skills/{skillname}/.
 */
function findSkillScript(skillName: string, scriptName: string): string | null {
  const skillDir = join(getWorkspacePath(), "skills", skillName);
  if (!existsSync(skillDir)) return null;
  const extensions = [".js", ".ts", ".sh", ".py", ".mjs"];
  for (const ext of extensions) {
    const candidate = resolve(skillDir, `${scriptName}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parses a skill key of the form skill.{skillname}.{scriptname}.{ENV_KEY}.
 * Returns null when the key does not match the expected format.
 */
function parseSkillKey(key: string): { skillName: string; scriptName: string } | null {
  const parts = key.split(".");
  if (parts.length < 4 || parts[0] !== "skill") return null;
  return { skillName: parts[1]!, scriptName: parts[2]! };
}

export function registerVault(program: Command): void {
  const cmd = program
    .command("vault")
    .description("Manage encrypted skill credentials");

  cmd
    .command("set <key> <value>")
    .description(
      "Store a credential in the vault. For skill.* keys the script is automatically set to readonly (chmod 444)."
    )
    .action((key: string, value: string) => {
      const vault = getVaultService();
      if (!vault.isAvailable()) {
        console.error("Error: VEROX_VAULT_PASSWORD is not set. Export it before using vault commands.");
        process.exit(1);
      }
      vault.set(key, value);

      // Auto-chmod for skill credentials.
      const parsed = parseSkillKey(key);
      if (parsed) {
        const scriptPath = findSkillScript(parsed.skillName, parsed.scriptName);
        if (scriptPath) {
          try {
            chmodSync(scriptPath, 0o444);
            console.log(`✓ Credential stored. Script set to readonly: ${scriptPath}`);
          } catch (err) {
            console.warn(`Credential stored but could not chmod script: ${String(err)}`);
          }
        } else {
          console.log(`✓ Credential stored. (Script not found — chmod it to 444 manually when you create it.)`);
        }
      } else {
        console.log(`✓ Credential stored.`);
      }
    });

  cmd
    .command("get <key>")
    .description("Retrieve and print a credential value from the vault.")
    .action((key: string) => {
      const vault = getVaultService();
      if (!vault.isAvailable()) {
        console.error("Error: VEROX_VAULT_PASSWORD is not set.");
        process.exit(1);
      }
      const value = vault.get(key);
      if (value === undefined) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(value);
    });

  cmd
    .command("list")
    .description("List all keys stored in the vault.")
    .action(() => {
      const vault = getVaultService();
      if (!vault.isAvailable()) {
        console.error("Error: VEROX_VAULT_PASSWORD is not set.");
        process.exit(1);
      }
      const keys = vault.list();
      if (!keys.length) {
        console.log("Vault is empty.");
        return;
      }
      for (const key of keys) {
        console.log(key);
      }
    });

  cmd
    .command("delete <key>")
    .description("Remove a credential from the vault.")
    .action((key: string) => {
      const vault = getVaultService();
      if (!vault.isAvailable()) {
        console.error("Error: VEROX_VAULT_PASSWORD is not set.");
        process.exit(1);
      }
      const deleted = vault.delete(key);
      if (!deleted) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(`✓ Deleted: ${key}`);
    });
}
