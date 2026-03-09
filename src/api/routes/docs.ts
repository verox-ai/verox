import { Router } from "express";
import type { DocStore } from "src/docs/store.js";

export function createDocsRouter(getDocStore: () => DocStore | undefined): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const docStore = getDocStore();
    if (!docStore) {
      res.json([]);
      return;
    }
    res.json(docStore.listFiles());
  });

  return router;
}
