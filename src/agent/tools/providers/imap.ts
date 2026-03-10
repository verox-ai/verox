import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { ImapAttachmentsTool, ImapDraftTool, ImapMailReadTool, ImapMailTool, ImapMailUpdateTool } from "../imap.js";

/** IMAP email tools. Enabled when tools.imap is configured. */
export class ImapProvider implements ToolProvider {
  readonly id = "imap";

  isEnabled(config: Config): boolean {
    const imap = config.tools?.imap;
    return !!(imap?.host && imap?.user);
  }

  createTools(config: Config, services: AgentServices): Tool[] {
    const imap = config.tools!.imap!;
    return [
      new ImapMailTool(imap, services.workspace),
      new ImapMailReadTool(imap),
      new ImapMailUpdateTool(imap),
      new ImapDraftTool(imap),
      new ImapAttachmentsTool(imap, services.workspace),
    ];
  }
}
