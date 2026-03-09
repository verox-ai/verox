import { Router } from "express";
import type { MemoryService } from "src/memory/service.js";

const PAGE_SIZE = 50;

export function createMemoryRouter(memoryService: MemoryService): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const page = Math.max(0, parseInt(String(req.query.page ?? "0"), 10) || 0);
    const limit = PAGE_SIZE;
    const offset = page * PAGE_SIZE;

    const entries = memoryService.search(q, tag ? [tag] : undefined, limit, offset);
    // Fetch one extra to know if there's a next page without a separate count query
    const hasMore = entries.length === limit;
    res.json({ entries, page, hasMore });
  });

  router.delete("/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = memoryService.hardDelete(id);
    if (result === "not_found") {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    if (result === "protected") {
      res.status(403).json({ error: "Memory is protected" });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/tags", (_req, res) => {
    res.json(memoryService.listTags());
  });

  return router;
}
