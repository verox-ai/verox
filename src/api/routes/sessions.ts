import { Router } from "express";
import type { SessionManager } from "src/session/manager.js";

export function createSessionsRouter(sessionManager: SessionManager): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const headers = sessionManager.listSessions();
    res.json(headers);
  });

  function decodeKey(raw: string): string | null {
    try {
      const key = decodeURIComponent(raw);
      if (key.includes("\0") || key.includes("/") || key.includes("\\")) return null;
      return key;
    } catch { return null; }
  }

  router.get("/:key/messages", (req, res) => {
    const key = decodeKey(req.params.key);
    if (!key) { res.status(400).json({ error: "Invalid session key" }); return; }
    const session = sessionManager.getIfExists(key);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session.messages);
  });

  router.post("/merge", (req, res) => {
    const { groupKey, memberKeys } = req.body as { groupKey?: string; memberKeys?: string[] };
    if (!groupKey || !Array.isArray(memberKeys) || memberKeys.length === 0) {
      res.status(400).json({ error: "groupKey and memberKeys[] required" });
      return;
    }
    const merged = sessionManager.mergeIntoGroup(groupKey, memberKeys);
    res.json({ ok: true, merged });
  });

  router.delete("/:key", (req, res) => {
    const key = decodeKey(req.params.key);
    if (!key) { res.status(400).json({ error: "Invalid session key" }); return; }
    const deleted = sessionManager.delete(key!);
    if (!deleted) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
