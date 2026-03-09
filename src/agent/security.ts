import { Logger } from "src/utils/logger.js";
import type { Tool } from "./tools/toolbase.js";

/**
 * Context risk levels for the security manager.
 *
 * Levels accumulate as the agent consumes external data — once raised, the
 * context level stays elevated until the next user message resets it.
 *
 *   None (0) — user-initiated context; no external data consumed yet.
 *   Low  (1) — external metadata seen (email subjects, search snippets, dir listings).
 *   High (2) — external body content seen (email body, web page, exec output).
 */
export enum RiskLevel {
  None = 0,
  Low = 1,
  High = 2,
}

/**
 * Converts a config string value to a RiskLevel. Unrecognised values fall
 * back to `None` (most restrictive) rather than silently allowing too much.
 */
export function riskLevelFromString(s: string): RiskLevel {
  if (s === "low") return RiskLevel.Low;
  if (s === "high") return RiskLevel.High;
  return RiskLevel.None;
}

/**
 * Tracks the current context risk level and gates tool execution based on
 * each tool's declared `maxRisk` threshold.
 *
 * Lifecycle within a single user message:
 *  1. `reset()` — called at the start of every new user message (→ None).
 *  2. `check(tool)` — before each tool call; blocks if context > tool.maxRisk.
 *  3. `recordOutput(tool)` — after each tool execution; raises context level.
 *  4. `decay()` — called at the end of each LLM iteration once all tool calls
 *     in that round are complete. High → Low. This represents the LLM acting
 *     as a semantic firewall: the untrusted data has been processed and the
 *     model's next output is its own, not raw attacker-controlled text.
 *     Low stays Low — only a new user message resets to None.
 *
 * Config overrides can be passed to `check` and `recordOutput` to override
 * the per-tool defaults at deployment time.
 */
export class SecurityManager {
  private currentLevel = RiskLevel.None;
  private logger = new Logger(SecurityManager.name);
  private isSecManagerEnabled: boolean;
  constructor() {
    this.isSecManagerEnabled = process.env.VEROX_DISABLE_SECURITY === 'true' ? false : true;
  }

  /** Resets context to trusted. Call at the start of every new user message. */
  reset(): void {
    this.currentLevel = RiskLevel.None;
  }

  /** Current accumulated context risk level. */
  get level(): RiskLevel {
    return this.isSecManagerEnabled ? this.currentLevel : RiskLevel.None;
  }

  isEnabled() {
    return this.isSecManagerEnabled
  }

  /**
   * Returns `{ allowed: false }` when the current context risk level exceeds
   * the tool's maximum allowed context (`tool.maxRisk` or `overrideMaxRisk`).
   */
  check(tool: Tool, overrideMaxRisk?: RiskLevel): { allowed: boolean } {
    const max = overrideMaxRisk ?? tool.maxRisk;
    return this.isSecManagerEnabled ? { allowed: this.currentLevel <= max } : { allowed: true };
  }

  /**
   * Decays context risk by one step after the LLM has processed tainted input
   * and generated a response: High → Low. Low stays Low.
   *
   * Call this at the end of each LLM iteration (after all tool results for
   * that round have been collected). The LLM's response acts as a semantic
   * checkpoint — untrusted external content has been digested by the model,
   * so subsequent tool calls are less likely to be directly controlled by
   * attacker-supplied data. This allows verified skills (maxRisk=Low) to run
   * after reading emails or web pages, while raw exec (maxRisk=None) remains
   * blocked.
   */
  decay(): void {
    if (!this.isSecManagerEnabled) return;
    if (this.currentLevel === RiskLevel.High) {
      this.currentLevel = RiskLevel.Low;
      this.logger.debug("Risk level decayed: High → Low (LLM mediation checkpoint)");
    }
  }

  /**
   * Raises the context risk level to reflect that a tool's output has been
   * consumed. Has no effect if the tool's output risk is lower than or equal
   * to the current level.
   */
  recordOutput(tool: Tool, overrideOutputRisk?: RiskLevel): void {
    if (!this.isSecManagerEnabled) {
      return;
    }
    const risk = overrideOutputRisk ?? tool.outputRisk;
    if (risk > this.currentLevel) {
      this.logger.debug(`raising Risk Level to ${RiskLevel[risk]}`);
      this.currentLevel = risk;
    }
  }
}
