import { Router } from "express";
import type { UsageService, UsagePeriod } from "src/usage/service.js";
import type { ConfigService } from "src/config/service.js";
import type { ProviderConfig } from "src/types/schemas/schema.js";

export function createUsageRouter(usageService: UsageService, configService: ConfigService): Router {
  const router = Router();

  router.get("/", (req, res) => {
    try {
      const period = (req.query.period as UsagePeriod) || "month";
      const stats = usageService.getStats(period);

      // Build model → cost map from provider configs
      const costs: Record<string, { input: number; output: number }> = {};
      const providers = configService.app.providers as Record<string, ProviderConfig>;
      for (const provider of Object.values(providers)) {
        const model = provider.model?.trim();
        if (model && provider.costPer1MInput != null && provider.costPer1MOutput != null) {
          costs[model] = { input: provider.costPer1MInput, output: provider.costPer1MOutput };
        }
      }

      res.json({ ...stats, costs });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
