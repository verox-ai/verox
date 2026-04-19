import { Router } from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SavedWorkflow } from "src/agent/workflow.js";

export function createWorkflowsRouter(workspace: string): Router {
  const router = Router();
  const dir = join(workspace, "workflows");

  router.get("/", (_req, res) => {
    if (!existsSync(dir)) { res.json([]); return; }
    try {
      const workflows = readdirSync(dir)
        .filter(f => f.endsWith(".json"))
        .map(f => {
          try { return JSON.parse(readFileSync(join(dir, f), "utf8")) as SavedWorkflow; }
          catch { return null; }
        })
        .filter((w): w is SavedWorkflow => w !== null)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      res.json(workflows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/:name", (req, res) => {
    const oldName = req.params.name.replace(/[^a-z0-9_-]/gi, "_");
    const oldPath = join(dir, `${oldName}.json`);
    if (!existsSync(oldPath)) { res.status(404).json({ error: "Workflow not found" }); return; }
    try {
      const existing = JSON.parse(readFileSync(oldPath, "utf8")) as SavedWorkflow;
      const { name, description, summary, steps, tools_needed } = req.body as Partial<SavedWorkflow>;
      const updated: SavedWorkflow = {
        ...existing,
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(summary !== undefined && { summary }),
        ...(steps !== undefined && { steps }),
        ...(tools_needed !== undefined && { tools_needed }),
      };
      const newName = updated.name.replace(/[^a-z0-9_-]/gi, "_");
      const newPath = join(dir, `${newName}.json`);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(newPath, JSON.stringify(updated, null, 2), "utf8");
      if (newPath !== oldPath) unlinkSync(oldPath);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/:name", (req, res) => {
    const name = req.params.name.replace(/[^a-z0-9_-]/gi, "_");
    const path = join(dir, `${name}.json`);
    if (!existsSync(path)) { res.status(404).json({ error: "Workflow not found" }); return; }
    try {
      unlinkSync(path);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
