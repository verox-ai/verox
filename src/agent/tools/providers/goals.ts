import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { GoalsService } from "src/goals/service.js";
import { GoalCreateTool, GoalUpdateTool, GoalGetTool, GoalListTool } from "../goals.js";

/** Goal tracking tools — always enabled. Exposed via goalsService for context injection + REST API. */
export class GoalsProvider implements ToolProvider {
  readonly id = "goals";
  goalsService?: GoalsService;

  isEnabled(_config: Config): boolean {
    return true;
  }

  createTools(_config: Config, services: AgentServices): Tool[] {
    this.goalsService = new GoalsService(services.workspace);
    return [
      new GoalCreateTool(this.goalsService),
      new GoalUpdateTool(this.goalsService),
      new GoalGetTool(this.goalsService),
      new GoalListTool(this.goalsService),
    ];
  }

  onConfigChange(_config: Config): void {}
}
