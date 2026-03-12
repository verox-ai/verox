import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import {
  KnowledgeWriteTool,
  KnowledgeReadTool,
  KnowledgeSearchTool,
  KnowledgeListTool,
  KnowledgeDeleteTool,
  KnowledgeClipTool,
} from "../knowledge.js";

/** Knowledge document tools — always enabled, backed by memory.db. */
export class KnowledgeProvider implements ToolProvider {
  readonly id = "knowledge";

  isEnabled(_config: Config): boolean {
    return true;
  }

  createTools(_config: Config, services: AgentServices): Tool[] {
    return [
      new KnowledgeWriteTool(services.memory),
      new KnowledgeReadTool(services.memory),
      new KnowledgeSearchTool(services.memory),
      new KnowledgeListTool(services.memory),
      new KnowledgeDeleteTool(services.memory),
      new KnowledgeClipTool(services.memory),
    ];
  }

  onConfigChange(_config: Config): void {}
}
