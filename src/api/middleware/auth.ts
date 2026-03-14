import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { ConfigService } from "src/config/service.js";
import type { VaultService } from "src/vault/credentials.js";
import { VAULT_KEY } from "../constants";

export function createAuthMiddleware(configService: ConfigService, vaultService: VaultService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const uiToken = vaultService.get(VAULT_KEY) ?? configService.app.channels.webchat.uiToken;
    if (!uiToken) {
      res.status(503).json({ error: "API not ready — uiToken not configured" });
      return;
    }
    const auth = req.headers.authorization ?? "";
    // SSE clients can't set headers — allow ?token= query param as fallback
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.query["token"] ?? "");
    // Use timing-safe comparison to prevent timing-based token enumeration
    const tokenBuf = Buffer.from(token);
    const expected = Buffer.from(uiToken);
    const valid = tokenBuf.length === expected.length && timingSafeEqual(tokenBuf, expected);
    if (!valid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
