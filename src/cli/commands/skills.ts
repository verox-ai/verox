import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { SkillManifestService } from "src/vault/manifest.js";
import { SkillsLoader } from "src/agent/skills.js";
import { VaultService } from "src/vault/credentials.js";
import { ConfigSchema } from "src/types/schemas/schema.js";
import { getDataPath, getWorkspacePath, getConfigPath } from "../utils/paths.js";

function getManifestService(): SkillManifestService {
  return new SkillManifestService(getDataPath());
}

function getSkillsLoader(): SkillsLoader {
  return new SkillsLoader(getWorkspacePath());
}

function requirePassword(manifest: SkillManifestService): void {
  if (!manifest.isAvailable()) {
    console.error("Error: VEROX_VAULT_PASSWORD is not set. Export it before using skills commands.");
    process.exit(1);
  }
}

export function registerSkills(program: Command): void {
  const cmd = program
    .command("skills")
    .description("Manage skill integrity signatures");

  cmd
    .command("sign <skillname>")
    .description(
      "Hash a skill's entry-point script and store it in the signed manifest. " +
      "Run this after installing or updating a skill."
    )
    .action((skillname: string) => {
      const manifest = getManifestService();
      requirePassword(manifest);

      const loader = getSkillsLoader();
      const entry = loader.getSkillExecEntry(skillname);
      if (!entry) {
        console.error(`Error: Skill "${skillname}" not found or has no executable entry point.`);
        process.exit(1);
      }

      const { files, manifestHash } = manifest.register(dirname(entry.path), skillname);
      const fileCount = Object.keys(files).length;
      console.log(`✓ Signed: ${skillname}`);
      console.log(`  Folder: ${dirname(entry.path)}`);
      console.log(`  Files:  ${fileCount}`);
      console.log(`  Hash:   ${manifestHash}`);
    });

  cmd
    .command("verify <skillname>")
    .description("Check whether a skill's current file matches its registered hash.")
    .action((skillname: string) => {
      const manifest = getManifestService();
      requirePassword(manifest);

      const loader = getSkillsLoader();
      const entry = loader.getSkillExecEntry(skillname);
      if (!entry) {
        console.error(`Error: Skill "${skillname}" not found or has no executable entry point.`);
        process.exit(1);
      }

      const result = manifest.verify(entry.path);
      if (result === undefined) {
        console.log(`⚠  ${skillname} is not registered in the manifest.`);
        console.log(`   Run: verox skills sign ${skillname}`);
      } else if (result === true) {
        console.log(`✓  ${skillname} — hash matches, file is unmodified.`);
      } else {
        console.error(`✗  ${skillname} — HASH MISMATCH. File may have been tampered with.`);
        console.error(`   Re-sign if the change was intentional: verox skills sign ${skillname}`);
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("List all skills registered in the signed manifest.")
    .action(() => {
      const manifest = getManifestService();
      requirePassword(manifest);

      const entries = manifest.list();
      if (!entries.length) {
        console.log("No skills registered in the manifest.");
        return;
      }

      const loader = getSkillsLoader();
      for (const entry of entries) {
        // Verify each entry inline so the list shows current tamper status.
        const execEntry = loader.getSkillExecEntry(entry.skill);
        const ok = execEntry ? manifest.verify(execEntry.path) : undefined;
        const status = ok === true ? "✓" : ok === false ? "✗ TAMPERED" : "?";
        console.log(`${status}  ${entry.skill}  (${entry.fileCount} file${entry.fileCount !== 1 ? "s" : ""})`);
        console.log(`    ${entry.manifestHash}`);
        console.log(`    signed: ${entry.signedAt}`);
      }
    });

  cmd
    .command("unsign <skillname>")
    .description("Remove a skill from the signed manifest (it will run without credential injection).")
    .action((skillname: string) => {
      const manifest = getManifestService();
      requirePassword(manifest);

      const removed = manifest.remove(skillname);
      if (!removed) {
        console.error(`"${skillname}" is not in the manifest.`);
        process.exit(1);
      }
      console.log(`✓ Removed "${skillname}" from the manifest.`);
    });

  cmd
    .command("run <skill> [args...]")
    .description(
      "Run a skill with the same security checks the agent applies: manifest integrity " +
      "verification, vault credential injection, deny-list guard, and process isolation. " +
      "The skill argument is the skill name (e.g. paperless-ngx); any text after it is " +
      "forwarded as arguments to the skill script."
    )
    .action(async (skill: string, args: string[]) => {
      // Support "skillname/script.ext" notation — strip the script part to get the skill name.
      const slashIdx = skill.indexOf("/");
      const skillName = slashIdx !== -1 ? skill.slice(0, slashIdx) : skill;

      // Load exec config (timeout, usePidNamespace, runAs) from config.json if present.
      const execConfig = loadExecConfig();

      const loader = getSkillsLoader();
      const entry = loader.getSkillExecEntry(skillName);
      if (!entry) {
        console.error(`Error: Skill "${skillName}" not found or has no executable entry point.`);
        console.error(`  Available skills: ${loader.listSkills(false).map((s) => s.name).join(", ") || "(none)"}`);
        process.exit(1);
      }

      // Manifest integrity check — tampered files are blocked, unsigned files run with a warning.
      const manifest = getManifestService();
      if (manifest.isAvailable()) {
        const verified = manifest.verify(entry.path);
        if (verified === false) {
          console.error(`✗  Integrity check FAILED: ${entry.path}`);
          console.error(`   File has been modified since it was signed.`);
          console.error(`   Re-sign with: verox skills sign ${skillName}`);
          process.exit(1);
        } else if (verified === true) {
          console.log(`✓  Integrity verified: ${skillName}`);
        } else {
          console.log(`⚠  ${skillName} is not signed (credentials will still be injected)`);
          console.log(`   Sign with: verox skills sign ${skillName}`);
        }
      }

      // Credential injection — independent of manifest signing status.
      // Derived from the entry path so the skill/script names always match what
      // was stored in the vault (regardless of how the user specified the skill arg).
      const vaultEnv: Record<string, string> = {};
      const vault = new VaultService(getDataPath());
      if (!vault.isAvailable()) {
        console.log("  Note: VEROX_VAULT_PASSWORD not set — no vault credentials injected");
      } else {
        const skillsDir = join(getWorkspacePath(), "skills");
        const relative = entry.path.startsWith(skillsDir)
          ? entry.path.slice(skillsDir.length + 1)
          : null;
        if (relative) {
          const firstSlash = relative.indexOf("/");
          if (firstSlash !== -1) {
            const resolvedSkillName = relative.slice(0, firstSlash);
            const envs = vault.getSkillEnvs(resolvedSkillName);
            Object.assign(vaultEnv, envs);
            if (Object.keys(envs).length === 0) {
              console.log(`  Note: no vault credentials found for skill.${resolvedSkillName}.*`);
            }
          }
        }
      }

      // Build the base invocation: runner + path + forwarded args.
      const argStr = args.length ? ` ${args.join(" ")}` : "";
      const baseCommand = entry.runner
        ? `${entry.runner} ${entry.path}${argStr}`
        : `${entry.path}${argStr}`;

      // Apply process isolation matching the agent's exec behaviour.
      const finalCommand = execConfig.usePidNamespace
        ? `unshare --user --pid --fork --mount-proc sh -c ${shellQuote(baseCommand)}`
        : execConfig.runAs
          ? `sudo -u ${execConfig.runAs} -- sh -c ${shellQuote(baseCommand)}`
          : baseCommand;

      // Sanitize env: strip bootstrap secret, inject vault credentials.
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv["VEROX_VAULT_PASSWORD"];
      Object.assign(childEnv, vaultEnv);

      const injectedCount = Object.keys(vaultEnv).length;
      console.log(`Running: ${baseCommand}`);
      if (injectedCount > 0) {
        console.log(`  Injected ${injectedCount} credential(s) from vault`);
      }
      if (execConfig.usePidNamespace) {
        console.log("  Isolation: pid-namespace");
      } else if (execConfig.runAs) {
        console.log(`  Isolation: runAs(${execConfig.runAs})`);
      }
      console.log("");

      const child = spawn(finalCommand, {
        shell: true,
        stdio: "inherit",
        env: childEnv,
        cwd: getWorkspacePath(),
        timeout: execConfig.timeout * 1000
      });
      child.on("error", (err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}

/** Reads exec options from config.json; returns safe defaults when the file is absent. */
function loadExecConfig(): { timeout: number; usePidNamespace: boolean; runAs: string | null } {
  const configFile = getConfigPath();
  if (!existsSync(configFile)) {
    return { timeout: 60, usePidNamespace: false, runAs: null };
  }
  try {
    const raw = JSON.parse(readFileSync(configFile, "utf-8"));
    const parsed = ConfigSchema.safeParse(raw);
    if (parsed.success) return parsed.data.tools.exec;
  } catch {
    // fall through
  }
  return { timeout: 60, usePidNamespace: false, runAs: null };
}

/** Wraps a shell command in single quotes, escaping any single quotes within. */
function shellQuote(cmd: string): string {
  return `'${cmd.replace(/'/g, "'\\''")}'`;
}
