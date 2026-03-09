import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { EditFileTool, ListDirTool, ReadFileTool, WriteFileTool } from "../filesystem.js";

/** File-system tools (read, write, edit, list). Always enabled. */
export class FilesystemProvider implements ToolProvider {
  readonly id = "filesystem";

  isEnabled(_config: Config): boolean {
    return true;
  }

  createTools(config: Config, services: AgentServices): Tool[] {
    const allowedDir = config.tools?.restrictFilesToWorkspace ? services.workspace : undefined;
    return [
      new ReadFileTool(allowedDir),
      new WriteFileTool(allowedDir),
      new EditFileTool(allowedDir),
      new ListDirTool(allowedDir),
    ];
  }
}
