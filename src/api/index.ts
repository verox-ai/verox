import { Router } from "express";
import type { ConfigService } from "src/config/service.js";
import type { SessionManager } from "src/session/manager.js";
import type { VaultService } from "src/vault/credentials.js";
import type { MemoryService } from "src/memory/service.js";
import type { CronService } from "src/cron/service.js";
import type { DocStore } from "src/docs/store.js";
import type { EmailStore } from "src/email/store.js";
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
import { createWorkflowsRouter } from "./routes/workflows.js";
import { createKnowledgeRouter } from "./routes/knowledge.js";
import { createRssRouter } from "./routes/rss.js";
import { createPromptsRouter } from "./routes/prompts.js";
import { createGoalsRouter } from "./routes/goals.js";
import { createEmailRouter } from "./routes/email.js";
import type { McpServerStatus } from "src/mcp/service.js";
import type { OnboardingService } from "src/onboarding/service.js";
import type { SkillManifestService } from "src/vault/manifest.js";
import type { RssService } from "src/rss/service.js";
import type { GoalsService } from "src/goals/service.js";
import type { UsageService } from "src/usage/service.js";
import type { Agent } from "src/agent/agent.js";
import { createUsageRouter } from "./routes/usage.js";
import { createDebugRouter } from "./routes/debug.js";

export type ApiServices = {
  configService: ConfigService;
  sessionManager: SessionManager;
  vaultService: VaultService;
  memoryService: MemoryService;
  cronService: CronService;
  getDocStore: () => DocStore | undefined;
  getEmailStore: () => EmailStore | undefined;
  getMcpStatus: () => McpServerStatus[];
  getWhatsAppStatus: () => { enabled: boolean; authenticated: boolean; qr: string | null };
  workspace: string;
  onboardingService: OnboardingService;
  manifestService: SkillManifestService;
  rssService: RssService;
  goalsService?: GoalsService;
  usageService?: UsageService;
  getAgent?: () => Agent;
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
  router.use("/docs",     createDocsRouter(services.getDocStore, services.getEmailStore, services.configService));
  router.use("/skills",   createSkillsRouter(services.workspace, services.manifestService));
  router.use("/logs",     createLogsRouter());
  router.use("/mcp",       createMcpRouter(services.getMcpStatus));
  router.use("/whatsapp",   createWhatsAppRouter(services.getWhatsAppStatus));
  router.use("/workflows",  createWorkflowsRouter(services.workspace));
  router.use("/knowledge",  createKnowledgeRouter(services.memoryService));
  router.use("/rss",        createRssRouter(services.rssService));
  router.use("/prompts",    createPromptsRouter(services.workspace));
  if (services.goalsService) {
    router.use("/goals", createGoalsRouter(services.goalsService));
  }
  router.use("/email", createEmailRouter(services.getEmailStore));
  if (services.usageService) {
    router.use("/usage", createUsageRouter(services.usageService, services.configService));
  }
  if (services.getAgent) {
    router.use("/debug", createDebugRouter(services.getAgent));
  }

  return router;
}
