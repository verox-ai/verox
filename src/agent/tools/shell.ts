import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Tool } from "./toolbase";
import { Logger } from "src/utils/logger";
import type { ConfigService } from "src/config/service.js";
import type { VaultService } from "src/vault/credentials.js";
import type { SkillManifestService } from "src/vault/manifest.js";
import type { SkillExecEntry, SkillsLoader } from "src/agent/skills.js";
import { RiskLevel } from "../security.js";

const execAsync = promisify(exec);

/**
 * Exposes a shell `exec` command to the LLM with multiple layers of safety:
 *
 * 1. **Deny-list patterns** — blocks destructive operations like `rm -rf`,
 *    `dd if=`, and fork bombs by default. Configurable via `denyPatterns`.
 * 2. **Allow-list patterns** — when non-empty, only commands matching at
 *    least one pattern are allowed.
 * 3. **Dangerous-command guard** — always blocks `format`, `diskpart`, and
 *    `mkfs.*` regardless of the pattern lists.
 * 4. **Workspace restriction** — when `restrictToWorkspace` is true, absolute
 *    paths outside `workingDir` and `../` traversals are blocked.
 * 5. **User switching** — when `runAs` is set, commands are wrapped in
 *    `sudo -u <user>` to run under a less-privileged OS account.
 * 6. **Environment sanitisation** — strips `VEROX_VAULT_PASSWORD` and
 *    injects per-skill vault credentials instead.
 * 7. **Skill command resolution** — bare skill names (e.g. `homeassistant …`)
 *    are expanded to their full entry-point invocation via `SkillsLoader`.
 * 8. **Integrity check** — when a `SkillManifestService` is provided, the
 *    skill entry-point file is hashed and compared against the signed manifest
 *    immediately before every exec. Tampered files are blocked.
 */
export class ExecTool extends Tool {
  private denyPatterns: RegExp[];
  private allowPatterns: RegExp[];
  private dangerousCommands: string[];
  private logger = new Logger(ExecTool.name);

  constructor(
    private options: {
      timeout?: number;
      workingDir?: string | null;
      denyPatterns?: string[];
      allowPatterns?: string[];
      restrictToWorkspace?: boolean;
      usePidNamespace?: boolean;
      runAs?: string | null;
    } = {},
    private configService?: ConfigService,
    private vaultService?: VaultService,
    private skillsLoader?: SkillsLoader,
    private manifestService?: SkillManifestService
  ) {
    super();
    this.denyPatterns = (options.denyPatterns ?? [
      "\\brm\\s+-[rf]{1,2}\\b",
      "\\bdel\\s+/[fq]\\b",
      "\\brmdir\\s+/s\\b",
      "\\bdd\\s+if=",
      ">\\s*/dev/sd",
      "\\b(shutdown|reboot|poweroff)\\b",
      ":\\(\\)\\s*\\{.*\\};\\s*:"
    ]).map((pattern) => new RegExp(pattern, "i"));
    this.allowPatterns = (options.allowPatterns ?? []).map((pattern) => new RegExp(pattern, "i"));
    this.dangerousCommands = ["format", "diskpart", "mkfs"];
  }

  get name(): string { return "exec"; }

  // exec produces high-risk output and must only run from a trusted (user-initiated) context.
  get outputRisk(): RiskLevel { return RiskLevel.High; }
  get maxRisk(): RiskLevel { return RiskLevel.Low; }

  get description(): string {
    return "Execute a shell command and return its output. Use with caution.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        workingDir: { type: "string", description: "Optional working directory for the command" },
        length: { type: "number", description: "Optional the max size of the result." }
      },
      required: ["command"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    this.logger.debug(`execute ${JSON.stringify(params)}`);
    const raw = String(params.command ?? "");
    const command = this.skillsLoader?.resolveSkillCommand(raw) ?? raw;
    if (command !== raw) this.logger.debug(`Skill alias resolved: "${raw}" → "${command}"`);
    const cwd = String(params.workingDir ?? this.options.workingDir ?? process.cwd());
    const length = String(params.length ?? "10000");
    const guardError = this.guardCommand(command, cwd);
    if (guardError) {
      return guardError;
    }

    // Resolve skill entry once — reused for both the integrity check and
    // credential injection below, avoiding a redundant filesystem lookup.
    //
    // Two cases:
    //   (a) Agent used skill alias ("homeassistant turn_off") which
    //       resolveSkillCommand expanded to the full invocation.
    //   (b) Agent passed the full path directly
    //       ("node /workspace/skills/homeassistant/index.js turn_off").
    let skillEntry: SkillExecEntry | null = null;
    let manifestVerified: boolean | undefined;
    if (this.skillsLoader) {
      if (command !== raw) {
        // Case (a): alias was resolved — getMatchingSkillEntry on the original token.
        skillEntry = this.skillsLoader.getMatchingSkillEntry(raw);
        this.logger.debug("skill detection case(a): alias lookup", { raw, found: !!skillEntry, path: skillEntry?.path });
      } else if (this.options.workingDir) {
        // Case (b): absolute path in command tokens ("node /workspace/skills/ha/index.js …").
        const detected = this.detectSkillEntryInCommand(command, this.options.workingDir);
        if (detected) skillEntry = detected;
        this.logger.debug("skill detection case(b): absolute path scan", { found: !!skillEntry, path: skillEntry?.path });

        // Case (c): relative command run from inside a skill directory
        // ("node index.js …" with cwd="/workspace/skills/ha"). The agent
        // didn't use the alias and didn't pass an absolute path, but the cwd
        // itself sits inside the skill folder — resolve the script token
        // against cwd to get the absolute entry point.
        if (!skillEntry) {
          const detected2 = this.detectSkillEntryFromCwd(command, cwd, this.options.workingDir);
          if (detected2) skillEntry = detected2;
          this.logger.debug("skill detection case(c): cwd resolution", { cwd, found: !!skillEntry, path: skillEntry?.path });
        }
      }

      if (skillEntry && this.manifestService) {
        manifestVerified = this.manifestService.verify(skillEntry.path);
        this.logger.debug("skill manifest verification", { path: skillEntry.path, verified: manifestVerified });
        if (manifestVerified === false) {
          this.logger.warn(`Skill integrity check failed: ${skillEntry.path}`);
          return `Error: Skill integrity check failed — "${raw}" entry point has been modified since it was signed. Re-sign it with: verox skills sign ${raw.split(" ")[0]}`;
        }
      } else if (skillEntry && !this.manifestService) {
        this.logger.debug("skill detected but no manifestService — skipping integrity check", { path: skillEntry.path });
      }
    } else {
      this.logger.debug("no skillsLoader — skipping skill detection");
    }

    try {
      const skillEnv = this.configService?.getAllSkillEnvs() ?? {};

      // Credential injection strategy:
      //  • Manifest-verified skill (verified === true): call getSkillEnvs() directly,
      //    bypassing the readonly-file guard in resolveCommandEnvs. The hash check is
      //    a stronger guarantee than a chmod bit.
      //  • All other cases (unregistered skill, plain command): use resolveCommandEnvs
      //    which enforces the readonly guard before injecting.
      let vaultEnv: Record<string, string> = {};
      if (this.vaultService) {
        if (skillEntry && manifestVerified === true && this.options.workingDir) {
          const skillsDir = resolve(this.options.workingDir, "skills");
          const relative = skillEntry.path.slice(skillsDir.length + 1); // e.g. "myskill/index.js"
          const slashIdx = relative.indexOf("/");
          if (slashIdx !== -1) {
            const skillName = relative.slice(0, slashIdx);
            this.logger.debug("credential injection: manifest-verified path", { skillName, envKeys: Object.keys(this.vaultService.getSkillEnvs(skillName)) });
            vaultEnv = this.vaultService.getSkillEnvs(skillName);
          }
        } else if (this.options.workingDir) {
          // When we already resolved a skill entry (e.g. via cwd detection, Case c),
          // use its absolute path so resolveCommandEnvs can identify the skill even
          // when the original command used a relative script name that resolveCommandEnvs
          // cannot locate on its own (it resolves tokens against workingDir, not cwd).
          const effectiveCmd = skillEntry ? skillEntry.path : command;
          this.logger.debug("credential injection: resolveCommandEnvs fallback", { effectiveCmd, hadSkillEntry: !!skillEntry });
          vaultEnv = this.vaultService.resolveCommandEnvs(effectiveCmd, this.options.workingDir);
        }
        this.logger.debug("credential injection result", { injectedKeys: Object.keys(vaultEnv) });
      } else {
        this.logger.debug("no vaultService — skipping credential injection");
      }
      // Isolation precedence: pid-namespace > runAs > none.
      // usePidNamespace: new PID + user namespace hides /proc of parent process.
      //   No extra OS user needed, but requires unprivileged_userns_clone (most modern distros).
      // runAs: sudo -u fallback for hardened kernels where namespaces are restricted.
      const isolation = this.options.usePidNamespace ? "pid-namespace"
        : this.options.runAs ? `runAs(${this.options.runAs})`
          : "none";
      const finalCommand = this.options.usePidNamespace
        ? `unshare --user --pid --fork --mount-proc sh -c ${shellQuote(command)}`
        : this.options.runAs
          ? `sudo -u ${this.options.runAs} -- sh -c ${shellQuote(command)}`
          : command;

      this.logger.debug("exec start", { command: raw, cwd, isolation, timeout: this.options.timeout ?? 60 });

      const { stdout, stderr } = await execAsync(finalCommand, {
        cwd,
        timeout: (this.options.timeout ?? 60) * 1000,
        maxBuffer: 10_000_000,
        env: { ...sanitizeParentEnv(process.env), ...skillEnv, ...vaultEnv }
      });

      const outputParts: string[] = [];
      if (stdout) outputParts.push(stdout);
      if (stderr?.trim()) {
        this.logger.debug("exec stderr", { command: raw, stderr: stderr.slice(0, 500) });
        outputParts.push(`STDERR:\n${stderr}`);
      }
      const result = outputParts.length ? outputParts.join("\n") : "(no output)";
      this.logger.debug("exec done", { command: raw, outputLen: result.length });
      return truncateOutput(result, parseInt(length));
    } catch (err) {
      const e = err as Error & { code?: number | string; killed?: boolean; signal?: string; stderr?: string };
      const timedOut = e.killed === true;
      // e.message from execAsync is "Command failed: <full command>\n<stderr>" — the command
      // is already logged separately and stderr is captured explicitly, so skip e.message here.
      const stderrSnippet = e.stderr?.trim().slice(0, 300) ?? "";
      const summary = timedOut
        ? `timed out after ${this.options.timeout ?? 60}s`
        : `exit ${e.code ?? "?"}${stderrSnippet ? `: ${stderrSnippet.split("\n")[0]}` : ""}`;

      this.logger.error(`exec failed — ${summary}`, {
        command: raw,
        cwd,
        exitCode: e.code ?? null,
        timedOut,
        signal: e.signal ?? null,
        ...(stderrSnippet ? { stderr: stderrSnippet } : {})
      });

      if (timedOut) {
        return `Error: Command timed out after ${this.options.timeout ?? 60}s`;
      }
      return `Error: exit code ${e.code ?? "unknown"}${stderrSnippet ? `\nSTDERR: ${stderrSnippet}` : ""}`;
    }
  }

  /**
   * Runs all safety checks on `command`. Returns an error string if the
   * command should be blocked, or `null` if it is allowed to proceed.
   */
  private guardCommand(command: string, cwd: string): string | null {
    const normalized = command.trim().toLowerCase();
    if (this.isDangerousCommand(normalized)) {
      return "Error: Command blocked by safety guard (dangerous pattern detected)";
    }
    for (const pattern of this.denyPatterns) {
      if (pattern.test(normalized)) {
        return "Error: Command blocked by safety guard (dangerous pattern detected)";
      }
    }
    if (this.allowPatterns.length && !this.allowPatterns.some((pattern) => pattern.test(normalized))) {
      return "Error: Command blocked by safety guard (not in allowlist)";
    }
    if (this.options.restrictToWorkspace) {
      if (command.includes("../") || command.includes("..\\")) {
        return "Error: Command blocked by safety guard (path traversal detected)";
      }
      const cwdPath = resolve(cwd);
      const matches = [...command.matchAll(/(?<![:\w])\/[^\s;|&<>"'`$\\(]{2,}/g)];
      for (const match of matches) {
        const resolved = resolve(match[0]);
        if (!resolved.startsWith(cwdPath)) {
          return "Error: Command blocked by safety guard (path outside working dir)";
        }
      }
    }
    return null;
  }

  /**
   * Scans command tokens for an absolute path that lives inside
   * `{workingDir}/skills/{name}/{script}` and returns it as a minimal
   * SkillExecEntry. Used when the agent passes the full entry-point path
   * instead of the bare skill alias.
   */
  private detectSkillEntryInCommand(command: string, workingDir: string): SkillExecEntry | null {
    const skillsDir = resolve(workingDir, "skills");
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (const token of tokens) {
      const cleaned = token.replace(/^["']|["']$/g, "");
      for (const candidate of [resolve(cleaned), resolve(workingDir, cleaned)]) {
        if (!candidate.startsWith(skillsDir + "/")) continue;
        const relative = candidate.slice(skillsDir.length + 1);
        const slashIdx = relative.indexOf("/");
        if (slashIdx === -1) continue;
        const scriptFile = relative.slice(slashIdx + 1);
        if (!scriptFile || scriptFile.includes("/")) continue;
        return { path: candidate, runner: "" };
      }
    }
    return null;
  }

  /**
   * Detects a skill entry when the agent passed a relative script name while
   * cwd points inside the skill's directory (e.g. command = "node index.js …",
   * cwd = "/workspace/skills/homeassistant").
   *
   * Resolves the first non-runner, non-flag token against cwd; if the
   * resulting absolute path falls under {workingDir}/skills/{name}/ it is
   * returned as a SkillExecEntry so the manifest check and credential
   * injection can proceed normally.
   */
  private detectSkillEntryFromCwd(command: string, cwd: string, workingDir: string): SkillExecEntry | null {
    const skillsDir = resolve(workingDir, "skills");
    // Resolve cwd to eliminate any "../" traversal before the containment check.
    const resolvedCwd = resolve(cwd);
    if (!resolvedCwd.startsWith(skillsDir + "/")) return null;

    const RUNNER_BINS = new Set(["node", "python3", "python", "tsx", "bun", "sh", "bash", "zsh"]);
    const tokens = command.trim().split(/\s+/);
    for (const token of tokens) {
      if (RUNNER_BINS.has(token) || token.startsWith("-")) continue;
      const candidate = resolve(resolvedCwd, token);
      if (candidate.startsWith(skillsDir + "/")) {
        return { path: candidate, runner: "" };
      }
      break; // first non-runner non-flag token didn't resolve into skills → give up
    }
    return null;
  }

  /**
   * Splits a piped/chained command into segments and checks whether any
   * segment starts with a hard-blocked binary (format, diskpart, mkfs.*).
   */
  private isDangerousCommand(command: string): boolean {
    const segments = command.split(/\s*(?:\|\||&&|;|\|)\s*/);
    for (const segment of segments) {
      const match = segment.trim().match(/^(?:sudo\s+)?([^\s]+)/i);
      if (!match) {
        continue;
      }
      const token = match[1]?.toLowerCase() ?? "";
      if (!token) {
        continue;
      }
      if (this.dangerousCommands.includes(token)) {
        return true;
      }
      if (token.startsWith("mkfs")) {
        return true;
      }
    }
    return false;
  }
}

/** Wraps a shell command in single quotes, escaping any single quotes within. */
function shellQuote(cmd: string): string {
  return `'${cmd.replace(/'/g, "'\\''")}'`;
}

/**
 * Strips sensitive bootstrap secrets from the environment before passing it
 * to child processes managed by the agent.  The agent must not be able to
 * recover these values via `exec("echo $VAR")`.
 */
const BLOCKED_ENV_KEYS = new Set(["VEROX_VAULT_PASSWORD"]);

function sanitizeParentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!BLOCKED_ENV_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Truncates command output to `maxLen` characters and appends a note
 * indicating how many characters were dropped. Prevents the LLM context
 * from being flooded by unexpectedly large command outputs.
 */
function truncateOutput(result: string, maxLen = 10000): string {
  if (result.length <= maxLen) {
    return result;
  }
  return `${result.slice(0, maxLen)}\n... (truncated, ${result.length - maxLen} more chars)`;
}


export class SecurityCheckTool extends Tool {
  constructor() {
    super();
  }

  get name(): string {
    return "security_check";
  }

  get maxRisk(): RiskLevel { return RiskLevel.None; }

  get description(): string {
    return (
      "This will just return if the enhanced Skill security is enabled or not"
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {}
    }
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    return process.env.VEROX_DISABLE_SECURITY === 'true' ? "disabled" : "enabled";
  }
}
