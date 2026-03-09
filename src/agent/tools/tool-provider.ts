import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "./toolbase.js";
import type { ProviderManager } from "src/provider/manager.js";
import type { MessageBus } from "src/messagebus/queue.js";
import type { SessionManager } from "src/session/manager.js";
import type { MemoryService } from "src/memory/service.js";
import type { ConfigService } from "src/config/service.js";
import type { VaultService } from "src/vault/credentials.js";
import type { SkillManifestService } from "src/vault/manifest.js";
import type { SkillsLoader } from "src/agent/skills.js";
import type { SubagentManager } from "src/agent/subagent.js";
import type { UsageService } from "src/usage/service.js";

/** Services made available to every ToolProvider at load time. */
export type AgentServices = {
  workspace: string;
  providerManager: ProviderManager;
  bus: MessageBus;
  sessions: SessionManager;
  memory: MemoryService;
  configService: ConfigService;
  vaultService: VaultService;
  manifestService: SkillManifestService;
  skillsLoader: SkillsLoader;
  subagents: SubagentManager;
  usageService: UsageService;
  isSecManagerEnabled: boolean;
};

/**
 * A ToolProvider is a self-contained unit that owns one logical group of tools.
 *
 * The ToolRegistry calls `createTools()` when the provider becomes enabled and
 * `onConfigChange()` (if defined) when config changes while the provider is already
 * active. Providers without `onConfigChange` have their tools re-created automatically.
 */
export interface ToolProvider {
  readonly id: string;
  /** Whether this provider should be active given the current config. */
  isEnabled(config: Config): boolean;
  /** Instantiate and return the tools for this provider. */
  createTools(config: Config, services: AgentServices): Tool[];
  /**
   * Optional in-place update when config changes and the provider stays enabled.
   * Use this for stateful providers (e.g. CalDAV, Browser) where re-creating the
   * underlying client would be expensive. If omitted, `createTools()` is called
   * again and all tools are re-registered (overwriting by name).
   */
  onConfigChange?(config: Config): void;
}
