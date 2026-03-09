import { Router } from "express";
import type { SessionManager } from "src/session/manager.js";

export function createSessionsRouter(sessionManager: SessionManager): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const headers = sessionManager.listSessions();
    res.json(headers);
  });

  router.get("/:key/messages", (req, res) => {
    const key = decodeURIComponent(req.params.key);
    const session = sessionManager.getIfExists(key);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session.messages);
  });

  router.delete("/:key", (req, res) => {
    const key = decodeURIComponent(req.params.key);
    const deleted = sessionManager.delete(key);
    if (!deleted) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
