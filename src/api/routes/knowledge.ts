import { Router } from "express";
import type { MemoryService } from "src/memory/service.js";

export function createKnowledgeRouter(memoryService: MemoryService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(memoryService.knowledgeList());
  });

  router.get("/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) { res.status(400).json({ error: "q is required" }); return; }
    const limit = parseInt(String(req.query.limit ?? "10"), 10) || 10;
    res.json(memoryService.knowledgeSearch(q, limit));
  });

  router.get("/:slug", (req, res) => {
    const doc = memoryService.knowledgeGet(req.params.slug);
    if (!doc) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc);
  });

  router.post("/", (req, res) => {
    const { slug, title, content, tags } = req.body as Record<string, unknown>;
    if (!slug || !title || !content) {
      res.status(400).json({ error: "slug, title, and content are required" });
      return;
    }
    const doc = memoryService.knowledgeWrite({
      slug: String(slug),
      title: String(title),
      content: String(content),
      tags: Array.isArray(tags) ? tags.map(String) : [],
    });
    res.json(doc);
  });

  router.put("/:slug", (req, res) => {
    const existing = memoryService.knowledgeGet(req.params.slug);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    const { title, content, tags } = req.body as Record<string, unknown>;
    const doc = memoryService.knowledgeWrite({
      slug: req.params.slug,
      title: String(title ?? existing.title),
      content: String(content ?? existing.content),
      tags: Array.isArray(tags) ? tags.map(String) : existing.tags,
    });
    res.json(doc);
  });

  router.delete("/:slug", (req, res) => {
    const deleted = memoryService.knowledgeDelete(req.params.slug);
    if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true });
  });

  return router;
}
