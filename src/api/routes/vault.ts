import { Router } from "express";
import type { VaultService } from "src/vault/credentials.js";

export function createVaultRouter(vaultService: VaultService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    if (!vaultService.isAvailable()) {
      res.json({ available: false, keys: [] });
      return;
    }
    res.json({ available: true, keys: vaultService.list() });
  });

  router.post("/", (req, res) => {
    if (!vaultService.isAvailable()) {
      res.status(503).json({ error: "Vault not available (no password configured)" });
      return;
    }
    const { key, value } = req.body as { key?: string; value?: string };
    if (!key || !value) {
      res.status(400).json({ error: "key and value are required" });
      return;
    }
    vaultService.set(key, value);
    res.json({ ok: true });
  });

  router.delete("/:key", (req, res) => {
    if (!vaultService.isAvailable()) {
      res.status(503).json({ error: "Vault not available" });
      return;
    }
    const deleted = vaultService.delete(req.params.key);
    if (!deleted) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
