import { Router } from "express";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
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
