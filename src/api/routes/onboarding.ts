import { Router } from "express";
import type { OnboardingService } from "src/onboarding/service.js";

/** Unauthenticated endpoints — mounted BEFORE auth middleware. */
export function createOnboardingRouter(onboarding: OnboardingService): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    const step = onboarding.getStep();
    if (step === "vault_key") {
      res.json({ step, vaultKey: onboarding.getOrCreateVaultKeySuggestion() });
    } else {
      onboarding.clearVaultKeySuggestion();
      res.json({ step });
    }
  });

  router.post("/set-webui-token", (req, res) => {
    const step = onboarding.getStep();
    if (step !== "webui_token") {
      res.status(400).json({ error: `Not at webui_token step (current: ${step})` });
      return;
    }
    const token = String(req.body?.token ?? "").trim();
    if (!token) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    if (!onboarding.setWebUiToken(token)) {
      res.status(500).json({ error: "Vault not available" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
