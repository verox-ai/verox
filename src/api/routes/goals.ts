import { Router } from "express";
import type { GoalsService, GoalStatus } from "src/goals/service.js";

export function createGoalsRouter(goalsService: GoalsService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const status = _req.query["status"] as GoalStatus | undefined;
    res.json(goalsService.list(status));
  });

  router.get("/active", (_req, res) => {
    res.json(goalsService.listActive());
  });

  router.get("/:id", (req, res) => {
    const goal = goalsService.get(req.params["id"]!);
    if (!goal) return res.status(404).json({ error: "Not found" });
    res.json(goal);
  });

  router.post("/", (req, res) => {
    const { title, description, steps } = req.body as { title?: string; description?: string; steps?: string[] };
    if (!title || !description || !Array.isArray(steps) || !steps.length) {
      return res.status(400).json({ error: "title, description, and steps[] are required" });
    }
    res.json(goalsService.create({ title, description, steps }));
  });

  router.put("/:id", (req, res) => {
    const body = req.body as { status?: GoalStatus; result?: string; stepUpdates?: Array<{ id: string; status?: string; notes?: string }> };
    const updated = goalsService.update(req.params["id"]!, body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    const deleted = goalsService.delete(req.params["id"]!);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  return router;
}
