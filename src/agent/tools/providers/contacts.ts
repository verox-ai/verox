import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { ContactStore } from "src/contacts/store.js";
import { ContactSaveTool, ContactSearchTool, ContactDeleteTool } from "../contacts.js";

export class ContactsProvider implements ToolProvider {
  readonly id = "contacts";
  public store?: ContactStore;

  isEnabled(_config: Config): boolean { return true; }

  createTools(_config: Config, services: AgentServices): Tool[] {
    this.store = new ContactStore(services.workspace);
    return [
      new ContactSaveTool(this.store),
      new ContactSearchTool(this.store),
      new ContactDeleteTool(this.store),
    ];
  }
}
