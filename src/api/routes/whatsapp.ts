import { Router } from "express";

export function createWhatsAppRouter(
  getStatus: () => { enabled: boolean; authenticated: boolean; qr: string | null }
): Router {
  const router = Router();

  router.get("/qr", (_req, res) => {
    const { enabled, authenticated, qr } = getStatus();
    if (!enabled) {
      res.json({ status: "disabled" });
      return;
    }
    if (authenticated) {
      res.json({ status: "authenticated" });
      return;
    }
    res.json({ status: "pending", qr });
  });

  return router;
}
