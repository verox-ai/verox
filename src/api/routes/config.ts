import { Router } from "express";
import type { ConfigService } from "src/config/service.js";
import { buildConfigSchema } from "src/types/schemas/schema.js";

const SENSITIVE_KEYS = /key|token|secret|password|apikey/i;

function maskSensitive(obj: unknown): unknown {
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitive);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(k) && typeof v === "string" && v.length > 0) {
        result[k] = "[configured]";
      } else {
        result[k] = maskSensitive(v);
      }
    }
    return result;
  }
  return obj;
}

export function createConfigRouter(configService: ConfigService): Router {
  const router = Router();

  router.get("/schema", (_req, res) => {
    res.json(buildConfigSchema());
  });

  router.get("/", (_req, res) => {
    const raw = configService.getRawConfig();
    res.json(maskSensitive(raw));
  });

  router.put("/", (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      configService.saveAppConfig(body);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
