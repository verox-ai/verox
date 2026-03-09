import { Router } from "express";
import type { ConfigService } from "src/config/service.js";
import type { SessionManager } from "src/session/manager.js";
import type { VaultService } from "src/vault/credentials.js";
import type { MemoryService } from "src/memory/service.js";
import type { CronService } from "src/cron/service.js";
import type { DocStore } from "src/docs/store.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createConfigRouter } from "./routes/config.js";
import { createVaultRouter } from "./routes/vault.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createCronRouter } from "./routes/cron.js";
import { createDocsRouter } from "./routes/docs.js";
import { createSkillsRouter } from "./routes/skills.js";
import { createLogsRouter } from "./routes/logs.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createWhatsAppRouter } from "./routes/whatsapp.js";
import { createOnboardingRouter } from "./routes/onboarding.js";
import type { McpServerStatus } from "src/mcp/service.js";
import type { OnboardingService } from "src/onboarding/service.js";

export type ApiServices = {
  configService: ConfigService;
  sessionManager: SessionManager;
  vaultService: VaultService;
  memoryService: MemoryService;
  cronService: CronService;
  getDocStore: () => DocStore | undefined;
  getMcpStatus: () => McpServerStatus[];
  getWhatsAppStatus: () => { enabled: boolean; authenticated: boolean; qr: string | null };
  workspace: string;
  onboardingService: OnboardingService;
};

export function createApiRouter(services: ApiServices): Router {
  const router = Router();

  // Onboarding endpoints are unauthenticated — mount BEFORE auth middleware.
  router.use("/onboarding", createOnboardingRouter(services.onboardingService));

  router.use(createAuthMiddleware(services.configService, services.vaultService));

  router.use("/config",   createConfigRouter(services.configService));
  router.use("/vault",    createVaultRouter(services.vaultService));
  router.use("/sessions", createSessionsRouter(services.sessionManager));
  router.use("/memory",   createMemoryRouter(services.memoryService));
  router.use("/cron",     createCronRouter(services.cronService));
  router.use("/docs",     createDocsRouter(services.getDocStore));
  router.use("/skills",   createSkillsRouter(services.workspace));
  router.use("/logs",     createLogsRouter());
  router.use("/mcp",       createMcpRouter(services.getMcpStatus));
  router.use("/whatsapp",  createWhatsAppRouter(services.getWhatsAppStatus));

  return router;
}
