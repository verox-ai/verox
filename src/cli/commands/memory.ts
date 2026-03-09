import type { Command } from "commander";
import { MemoryService } from "src/memory/service.js";
import { getWorkspacePath } from "../utils/paths.js";
import { prompt, printTable } from "../utils/ui.js";

function getMemoryService(): MemoryService {
  return new MemoryService(getWorkspacePath());
}

export function registerMemory(program: Command): void {
  const cmd = program.command("memory").description("Manage memory entries");

  cmd
    .command("list")
    .description("List memory entries")
    .option("-t, --tag <tag>", "Filter by tag")
    .option("-s, --search <query>", "Filter by content (case-insensitive)")
    .action((opts: { tag?: string; search?: string }) => {
      const svc = getMemoryService();
      const entries = svc.search(opts.search, opts.tag ? [opts.tag] : undefined);
      if (!entries.length) { console.log("No entries found."); return; }

      const termWidth = process.stdout.columns ?? 100;
      const maxTagsWidth = Math.max(4, ...entries.map((e) =>
        (e.tags.join(", ") + (e.protected ? " 🔒" : "")).length
      ));
      const idWidth = 6;
      const contentWidth = Math.max(7, termWidth - idWidth - 10 - maxTagsWidth - 8);

      printTable([
        ["ID", "DATE", "TAGS", "CONTENT"],
        ...entries.map((e) => {
          const tags = e.tags.join(", ") + (e.protected ? " 🔒" : "");
          return [
            String(e.id),
            e.created_at.slice(0, 10),
            tags,
            e.content.length > contentWidth ? e.content.slice(0, contentWidth - 1) + "…" : e.content
          ];
        })
      ]);
    });

  cmd
    .command("get <id>")
    .description("Show the full content of a memory entry by numeric ID")
    .action((id: string) => {
      const svc = getMemoryService();
      const entry = svc.getById(Number(id));
      if (!entry) { console.error(`No entry found with id: ${id}`); process.exit(1); }
      console.log(`ID:         ${entry.id}`);
      console.log(`Date:       ${entry.created_at.slice(0, 19)}`);
      console.log(`Type:       ${entry.type}`);
      console.log(`Tags:       ${entry.tags.join(", ")}${entry.protected ? " (protected)" : ""}`);
      console.log(`Confidence: ${entry.confidence}`);
      if (entry.supersedes != null) console.log(`Supersedes: ${entry.supersedes}`);
      console.log(`Content:\n${entry.content}`);
    });

  cmd
    .command("write")
    .description("Write a new memory entry interactively")
    .action(async () => {
      const content = await prompt("Content");
      if (!content) { console.error("Content is required"); process.exit(1); }
      const tagsRaw = await prompt("Tags (comma-separated, e.g. reminders,tasks)", "");
      const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      const protectedRaw = await prompt("Protected? (yes/no)", "no");
      const isProtected = protectedRaw.toLowerCase().startsWith("y");

      const svc = getMemoryService();
      const entry = svc.append({ content, tags, type: "manual", protected: isProtected });
      console.log(`✓ Memory entry saved (id: ${entry.id})`);
    });

  cmd
    .command("protect <id>")
    .description("Set or clear the protected flag on a memory entry")
    .option("--off", "Remove protection instead of setting it")
    .action((id: string, opts: { off?: boolean }) => {
      const svc = getMemoryService();
      const numId = Number(id);
      const entry = svc.getById(numId);
      if (!entry) { console.error(`No entry found with id: ${id}`); process.exit(1); }
      const protect = !opts.off;
      if (entry.protected === protect) {
        console.log(`Entry ${id} is already ${protect ? "protected" : "unprotected"}.`);
        return;
      }
      svc.setProtected(numId, protect);
      console.log(`✓ Entry ${id} ${protect ? "protected" : "unprotected"}.`);
    });

  cmd
    .command("delete <id>")
    .description("Permanently delete a memory entry by numeric ID.")
    .action(async (id: string) => {
      const svc = getMemoryService();
      const numId = Number(id);
      const entry = svc.getById(numId);
      if (!entry) { console.error(`No entry found with id: ${id}`); process.exit(1); }
      if (entry.protected) {
        const answer = await prompt(`Entry ${id} is protected. Remove protection and delete? (yes/no)`, "no");
        if (!answer.toLowerCase().startsWith("y")) { console.log("Aborted."); return; }
        svc.setProtected(numId, false);
      }
      svc.hardDelete(numId);
      console.log(`✓ Deleted entry ${id}`);
    });
}
