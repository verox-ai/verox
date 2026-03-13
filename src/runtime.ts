if (process.getuid?.() === 0) {
  console.error("Error: Verox must not be run as root. Exiting.");
  process.exit(1);
}

import "reflect-metadata";
import "./container.js";
import { container } from "tsyringe";
import { Logger } from "./utils/logger.js";
import { ConfigService } from "./config/service.js";
import { Agent } from "./agent/agent.js";
import { ChannelManager } from "./channels/channelmanager.js";
import { ShutdownService } from "./shutdown/service.js";
import { MemoryExtractionCron } from "./agent/memory-cron.js";
import { HeartbeatService } from "./heartbeat/service.js";
import { CronService } from "./cron/service.js";
import { ProviderManager } from "./provider/manager.js";
import { VERSION } from "./version.js";
import { APIService } from "./api/apiservice.js";
import { WebChatChannel } from "./channels/webchat.js";
import { McpService } from "./mcp/service.js";
import { RssService } from "./rss/service.js";


// Direct-message mode: process one message and exit, no channels/heartbeat/cron.
if (process.env["VEROX_DIRECT_MESSAGE"]) {
  const text = process.env["VEROX_DIRECT_MESSAGE"];
  const sessionKey = process.env["VEROX_DIRECT_MESSAGE"] ?? "cli:direct";
  process.env["LOG_LEVEL"] = "WARN";
  container.resolve(ConfigService).load();
  const agent = container.resolve(Agent);
  const cronService = container.resolve(CronService);
  cronService.setAgent(agent);
  agent.registerCronTool(cronService);
  cronService.load();
  const mcpService = container.resolve(McpService);
  await agent.connectMcp(mcpService);
  const response = await agent.processDirect({ content: text, sessionKey, channel: "cli", chatId: "direct" });
  console.log(response);
  await mcpService.disconnect();
  process.exit(0);
}

process.env.LOG_LEVEL = "DEBUG"

const logger = new Logger("Main");

logger.info(`Verox Version: ${VERSION}`);

// Load config files and start file watchers before anything else touches config
container.resolve(ConfigService).load();

const shutdownService = container.resolve(ShutdownService);
shutdownService.register();

const providerManager = container.resolve(ProviderManager);
const isOnboarding = !providerManager.hasActiveProvider();

if (isOnboarding) {
  logger.info("No LLM provider configured — starting in onboarding mode (wizard only).");
} else {
  const agent = container.resolve(Agent);
  const channelManager = container.resolve(ChannelManager);
  const memoryCron = container.resolve(MemoryExtractionCron);
  const heartbeat = container.resolve(HeartbeatService);

  const cronService = container.resolve(CronService);
  cronService.setAgent(agent);
  agent.registerCronTool(cronService);
  cronService.load();

  const rssService = container.resolve(RssService);
  agent.registerRssService(rssService);
  rssService.load();

  const mcpService = container.resolve(McpService);
  await agent.connectMcp(mcpService);

  agent.run();
  memoryCron.start();

  channelManager.startAll()
    .then(() => shutdownService.resumeFromLastShutdown())
    .catch((err: unknown) => {
      logger.error("Error during startup resume", { error: String(err) });
    });

  heartbeat.start().then(() => {
    logger.info("Heartbeat started");
  });

  logger.info("Starting WebAPI");

  const apiService = container.resolve(APIService);
  apiService.start().then(server => {
    if (server) {
      channelManager.setHttpServer(server);
      const webChat = channelManager.getChannel("webchat") as WebChatChannel;
      if (webChat) {
        webChat.connectWebChat(server);
      }
    }
  });
}

if (isOnboarding) {
  // In onboarding mode start the API server so the wizard SPA is reachable.
  const apiService = container.resolve(APIService);
  apiService.start();
}