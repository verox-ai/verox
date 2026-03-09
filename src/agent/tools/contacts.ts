import { Tool } from "./toolbase.js";
import type { ContactStore } from "src/contacts/store.js";

export class ContactSaveTool extends Tool {
  constructor(private store: ContactStore) { super(); }

  get name() { return "contact_save"; }
  get description() {
    return (
      "Save or update a contact. Provide name and aliases (phone numbers, Telegram IDs, WhatsApp JIDs, emails, etc.). " +
      "Use this when you learn who someone is so you can recognise them in future conversations. " +
      "Aliases are identifiers like '14155552671', '14155552671@s.whatsapp.net', 'telegram:12345', 'thomas@example.com'."
    );
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name:    { type: "string", description: "Full name or display name." },
        aliases: { type: "array", items: { type: "string" }, description: "List of identifiers for this person." },
        notes:   { type: "string", description: "Optional free-text notes about this person." },
        id:      { type: "string", description: "Contact ID to update (omit to auto-generate from name)." },
      },
      required: ["name", "aliases"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name = String(params.name ?? "").trim();
    if (!name) return "Error: name is required";
    const aliases = Array.isArray(params.aliases) ? (params.aliases as string[]).map(String) : [];
    const notes   = params.notes ? String(params.notes) : undefined;
    const id      = params.id ? String(params.id) : undefined;
    const saved = this.store.upsert({ id, name, aliases, notes });
    return `Contact saved: **${saved.name}** (${saved.aliases.join(", ")})`;
  }
}

export class ContactSearchTool extends Tool {
  constructor(private store: ContactStore) { super(); }

  get name() { return "contact_search"; }
  get description() {
    return "Search contacts by name, alias, or notes. Returns matching contacts with their identifiers.";
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, phone number, or keyword to search for." },
      },
      required: ["query"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const query = String(params.query ?? "").trim();
    if (!query) return "Error: query is required";
    const results = this.store.search(query);
    if (!results.length) return `No contacts found matching "${query}".`;
    return results.map(c => {
      const aliases = c.aliases.join(", ") || "—";
      const notes   = c.notes ? `\n  notes: ${c.notes}` : "";
      return `• **${c.name}** (id: ${c.id})\n  aliases: ${aliases}${notes}`;
    }).join("\n\n");
  }
}

export class ContactDeleteTool extends Tool {
  constructor(private store: ContactStore) { super(); }

  get name() { return "contact_delete"; }
  get description() { return "Delete a contact by ID."; }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { id: { type: "string", description: "Contact ID to delete." } },
      required: ["id"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const id = String(params.id ?? "").trim();
    return this.store.delete(id) ? `Contact '${id}' deleted.` : `No contact found with id '${id}'.`;
  }
}
