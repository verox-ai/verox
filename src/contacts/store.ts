import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "src/utils/logger.js";

export interface Contact {
  id: string;
  name: string;
  /** Channel-specific identifiers: phone numbers, Telegram IDs, JIDs, emails, etc. */
  aliases: string[];
  notes?: string;
}

/**
 * Simple JSON-backed contact store persisted to {workspace}/contacts/contacts.json.
 *
 * Contacts are looked up by alias — any identifier the agent might see as a
 * senderId (e.g. "+49123456789", "14155552671@s.whatsapp.net", "telegram:12345").
 */
export class ContactStore {
  private contacts = new Map<string, Contact>();
  private readonly filePath: string;
  private logger = new Logger(ContactStore.name);

  constructor(workspace: string) {
    this.filePath = join(workspace, "contacts", "contacts.json");
    this.load();
  }

  list(): Contact[] {
    return [...this.contacts.values()];
  }

  findById(id: string): Contact | undefined {
    return this.contacts.get(id);
  }

  /** Find a contact whose alias list contains the given identifier (case-insensitive, strips @... suffix). */
  findByAlias(alias: string): Contact | undefined {
    const normalized = normalizeAlias(alias);
    for (const contact of this.contacts.values()) {
      if (contact.aliases.some(a => normalizeAlias(a) === normalized)) {
        return contact;
      }
    }
    return undefined;
  }

  /** Full-text search across name, aliases, and notes. */
  search(query: string): Contact[] {
    const q = query.toLowerCase();
    return [...this.contacts.values()].filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.aliases.some(a => a.toLowerCase().includes(q)) ||
      c.notes?.toLowerCase().includes(q)
    );
  }

  upsert(contact: Omit<Contact, "id"> & { id?: string }): Contact {
    const id = contact.id ?? slugify(contact.name);
    const existing = this.contacts.get(id);
    const merged: Contact = {
      id,
      name: contact.name,
      aliases: dedupe([...(existing?.aliases ?? []), ...contact.aliases]),
      notes: contact.notes ?? existing?.notes,
    };
    this.contacts.set(id, merged);
    this.save();
    return merged;
  }

  delete(id: string): boolean {
    const existed = this.contacts.has(id);
    this.contacts.delete(id);
    if (existed) this.save();
    return existed;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as Contact[];
      for (const c of raw) this.contacts.set(c.id, c);
      this.logger.debug("Contacts loaded", { count: this.contacts.size });
    } catch (err) {
      this.logger.warn("Failed to load contacts", { error: String(err) });
    }
  }

  private save(): void {
    try {
      mkdirSync(join(this.filePath, ".."), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify([...this.contacts.values()], null, 2));
    } catch (err) {
      this.logger.warn("Failed to save contacts", { error: String(err) });
    }
  }
}

/** Strip @domain suffix and normalize for alias comparison. */
function normalizeAlias(alias: string): string {
  return alias.toLowerCase().replace(/@[^@]+$/, "").replace(/^\+/, "");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map(a => a.trim()).filter(Boolean))];
}
