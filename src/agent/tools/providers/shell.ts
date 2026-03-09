import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { ExecTool } from "../shell.js";
import { SpawnTool } from "../spawn.js";
import { SubagentsTool } from "../subagents.js";

/** Shell execution tools: exec, spawn, subagents. Always enabled. */
export class ShellProvider implements ToolProvider {
  readonly id = "shell";

  isEnabled(_config: Config): boolean {
    return true;
  }

  createTools(config: Config, services: AgentServices): Tool[] {
    const execTool = new ExecTool(
      {
        workingDir: services.workspace,
        timeout: config.tools?.exec?.timeout ?? 60,
        restrictToWorkspace: config.tools?.restrictExecToWorkspace ?? false,
        usePidNamespace: config.tools?.exec?.usePidNamespace ?? false,
        runAs: config.tools?.exec?.runAs ?? null,
      },
      services.configService,
      services.vaultService,
      services.skillsLoader,
      services.isSecManagerEnabled ? services.manifestService : undefined
    );

    return [
      execTool,
      new SpawnTool(services.subagents),
      new SubagentsTool(services.subagents),
    ];
  }
}
