import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { MessageTool } from "../message.js";
import { SessionsHistoryTool, SessionsListTool, SessionsSendTool } from "../sessions.js";
import { MemoryDeleteTool, MemoryListTagsTool, MemorySearchTool, MemoryWriteTool } from "../memory.js";
import { UsageStatsTool } from "../usage.js";
import { ProviderListTool, ProviderSwitchTool } from "../provider.js";
import { SecurityCheckTool } from "../shell.js";
import { SkillToggleTool } from "../skill-toggle.js";

/** Core always-on tools: messaging, sessions, memory, usage, provider management. */
export class CoreProvider implements ToolProvider {
  readonly id = "core";

  isEnabled(_config: Config): boolean {
    return true;
  }

  createTools(_config: Config, services: AgentServices): Tool[] {
    return [
      new SecurityCheckTool(),
      new MessageTool((msg) => services.bus.publishOutbound(msg)),
      new SessionsListTool(services.sessions),
      new SessionsHistoryTool(services.sessions),
      new SessionsSendTool(services.sessions, services.bus),
      new MemorySearchTool(services.memory),
      new MemoryWriteTool(services.memory),
      new MemoryListTagsTool(services.memory),
      new MemoryDeleteTool(services.memory),
      new UsageStatsTool(services.usageService),
      new ProviderListTool(services.providerManager),
      new ProviderSwitchTool(services.providerManager),
      new SkillToggleTool(services.skillsLoader),
    ];
  }
}
