import { Router } from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, normalize, sep } from "node:path";

const ALLOWED_EXTENSIONS = new Set([".md", ".json"]);

function safePromptPath(promptsDir: string, filename: string): string | null {
  if (!filename || filename.includes("\0") || filename.includes("/") || filename.includes("\\")) return null;
  const resolved = resolve(join(promptsDir, normalize(filename)));
  if (!resolved.startsWith(resolve(promptsDir) + sep)) return null;
  return resolved;
}

export function createPromptsRouter(workspace: string): Router {
  const router = Router();
  const promptsDir = join(workspace, "prompts");

  router.get("/", (_req, res) => {
    try {
      mkdirSync(promptsDir, { recursive: true });
      const files = readdirSync(promptsDir, { withFileTypes: true })
        .filter(e => e.isFile() && ALLOWED_EXTENSIONS.has(e.name.slice(e.name.lastIndexOf("."))))
        .map(e => e.name)
        .sort((a, b) => {
          // required prompts first, then alphabetical
          const order = ["agent-identity.md", "agent-identity-system.md", "subagent.md", "memory-extraction.md", "compaction.md", "heartbeat.md", "tool-descriptions.json"];
          const ai = order.indexOf(a), bi = order.indexOf(b);
          if (ai !== -1 && bi !== -1) return ai - bi;
          if (ai !== -1) return -1;
          if (bi !== -1) return 1;
          return a.localeCompare(b);
        });
      res.json(files);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/:filename", (req, res) => {
    const filePath = safePromptPath(promptsDir, req.params.filename);
    if (!filePath) { res.status(400).json({ error: "Invalid filename" }); return; }
    if (!existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }
    try {
      res.json({ filename: req.params.filename, content: readFileSync(filePath, "utf-8") });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/:filename", (req, res) => {
    const { content } = req.body as { content?: string };
    if (content === undefined) { res.status(400).json({ error: "content is required" }); return; }
    const filename = req.params.filename;
    const filePath = safePromptPath(promptsDir, filename);
    if (!filePath) { res.status(400).json({ error: "Invalid filename" }); return; }
    if (filename.endsWith(".json")) {
      try { JSON.parse(content); } catch { res.status(400).json({ error: "Invalid JSON" }); return; }
    }
    try {
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  return router;
}
