import { Router } from "express";
import type { DocStore } from "src/docs/store.js";
import type { EmailStore } from "src/email/store.js";
import type { ConfigService } from "src/config/service.js";

export function createDocsRouter(
  getDocStore: () => DocStore | undefined,
  getEmailStore?: () => EmailStore | undefined,
  configService?: ConfigService,
): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const docStore = getDocStore();
    if (!docStore) { res.json([]); return; }
    res.json(docStore.listFiles());
  });

  router.post("/index", async (_req, res) => {
    const docStore = getDocStore();
    if (!docStore) { res.status(503).json({ error: "docs not enabled" }); return; }
    try {
      const indexEmails = configService?.app.tools?.docs?.indexEmails;
      const emailStore = indexEmails && getEmailStore ? getEmailStore() : undefined;
      const result = await docStore.indexAll(false, emailStore);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/", (req, res) => {
    const docStore = getDocStore();
    if (!docStore) { res.status(503).json({ error: "docs not enabled" }); return; }
    const { path } = req.body as { path?: string };
    if (!path) { res.status(400).json({ error: "path is required" }); return; }
    const removed = docStore.removeFile(path);
    if (!removed) { res.status(404).json({ error: "file not found in index" }); return; }
    res.json({ removed: true, path });
  });

  return router;
}
