import { injectable, inject } from "tsyringe";
import express from "express";
import { join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { createApiRouter } from ".";
import { ConfigService } from "src/config/service";
import { VaultService } from "src/vault/credentials";
import { MemoryService } from "src/memory/service";
import { CronService } from "src/cron/service";
import { Agent } from "src/agent/agent";
import { SessionManager } from "src/session/manager";
import { Logger } from "src/utils/logger";
import http from "node:http";
import { FALLBACK_HTML, VAULT_KEY } from "./constants";
import { McpService } from "src/mcp/service";
import { ChannelManager } from "src/channels/channelmanager";
import { OnboardingService } from "src/onboarding/service";
import { SkillManifestService } from "src/vault/manifest";
import { RssService } from "src/rss/service";

@injectable()
export class APIService {

  private logger = new Logger(APIService.name);

  private server: http.Server | null = null;

  constructor(
    @inject(ConfigService) private readonly configService: ConfigService,
    @inject(VaultService) private readonly vaultService: VaultService,
    @inject(MemoryService) private readonly memoryService: MemoryService,
    @inject(CronService) private readonly cronService: CronService,
    @inject("workspace") private readonly workspace: string,
    @inject(SessionManager) private readonly sessionManager: SessionManager,
    @inject(Agent) private readonly agent: Agent,
    @inject(McpService) private readonly mcpService: McpService,
    @inject(ChannelManager) private readonly channelManager: ChannelManager,
    @inject("dataPath") private readonly dataPath: string,
    @inject(SkillManifestService) private readonly manifestService: SkillManifestService,
    @inject(RssService) private readonly rssService: RssService,
  ) {

  }

  async start(): Promise<http.Server> {

    const onboardingService = new OnboardingService(
      this.dataPath,
      this.vaultService,
      this.configService,
    );

    // Auto-generate a UI token only when onboarding is complete (provider configured).
    // During the wizard flow the user sets the token explicitly in the webui_token step.
    if (onboardingService.getStep() === "complete") {
      const hasToken = !!this.vaultService.get(VAULT_KEY) || !!this.configService.app.channels.webchat.uiToken;
      if (!hasToken) {
        const token = randomBytes(32).toString("hex");
        if (this.vaultService.isAvailable()) {
          this.vaultService.set(VAULT_KEY, token);
          this.logger.info("Generated API token and stored in vault.");
        } else {
          this.configService.saveAppConfig({ channels: { webchat: { uiToken: token } } });
          this.logger.info(`Generated API token (vault unavailable, stored in config): ${token}`);
        }
      } else {
        this.logger.info(`Using stored webtoken`);
      }
    }

    const app = express();
    app.use(express.json());

    // REST API
    app.use("/api", createApiRouter({
      configService: this.configService,
      sessionManager: this.sessionManager!,
      vaultService: this.vaultService,
      memoryService: this.memoryService,
      cronService: this.cronService,
      workspace: this.workspace,
      getDocStore: () => this.agent.docStore,
      getMcpStatus: () => this.mcpService.getStatus(),
      getWhatsAppStatus: () => this.channelManager.getWhatsAppStatus(),
      onboardingService,
      manifestService: this.manifestService,
      rssService: this.rssService,
    }));

    // Angular SPA static files — resolve relative to this compiled file so the
    // path is correct whether the server is started from the project root, a
    // different directory, or as a systemd service.

    const configuredDistDir = this.configService.app.general.clientPath;
    this.logger.debug(configuredDistDir)
    const distDir = configuredDistDir !== '' ? configuredDistDir: join(fileURLToPath(new URL(".", import.meta.url)), "..", "public", "webui", "browser");
    this.logger.debug(`Checking Path ${distDir}`);
    if (existsSync(distDir)) {
      app.use(express.static(distDir));
      // SPA catch-all: serve index.html for all non-API routes
      app.get(/^(?!\/api).*/, (_req, res) => {
        res.sendFile(join(distDir, "index.html"));
      });
    } else {
      this.logger.warn("Angular UI not built — serving fallback page. Run: pnpm run build:ui");
      app.get(/^(?!\/api).*/, (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(FALLBACK_HTML);
      });
    }

    this.server = http.createServer(app);

    const config = this.configService.app.channels.webchat;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(config.port, config.host, () => resolve());
      this.server!.once("error", reject);
    });
    this.logger.info("WebChat started", { host: config.host, port: config.port });

    if (onboardingService.getStep() !== "complete") {
      const host = config.host === "0.0.0.0" ? "localhost" : config.host;
      this.logger.info(`\n\n  ✦ Setup wizard: http://${host}:${config.port}/setup\n`);
    }

    return this.server;
  }

  async stop() {
     await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server) resolve();
    });
  }

  getServer():http.Server | null  {
    return this.server;
  }
  
}