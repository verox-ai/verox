import "reflect-metadata";
import { container } from "tsyringe";
import { join } from "node:path";
import { getDataPath, getWorkspacePath } from "src/utils/util.js";
import { DEFAULT_CONFIG_FILE } from "src/constants.js";
import { Workspace } from "src/workspace.js";
import { initPromptLoader, ensureWorkspacePrompts } from "src/prompts/loader.js";
import { ConfigService } from "src/config/service.js";
import { MessageBus } from "src/messagebus/queue.js";
import { SessionManager } from "src/session/manager.js";
import { MemoryService } from "src/memory/service.js";
import { ProviderManager } from "src/provider/manager.js";
import { Agent } from "src/agent/agent.js";
import { ChannelManager } from "src/channels/channelmanager.js";
import { ShutdownService } from "src/shutdown/service.js";
import { MemoryExtractionCron } from "src/agent/memory-cron.js";
import { HeartbeatService } from "src/heartbeat/service.js";
import { CronService } from "src/cron/service.js";
import { PersonalityService } from "./agent/personality";
import { VaultService } from "./vault/credentials.js";
import { SkillManifestService } from "./vault/manifest.js";
import { ReflectionService } from "./cron/reflection";
import { APIService } from "./api/apiservice";
import { McpService } from "./mcp/service.js";

const dataPath = getDataPath();
const workspace = getWorkspacePath();
const configFile = join(dataPath, DEFAULT_CONFIG_FILE);

// Ensure workspace directory structure exists, then seed prompt files
const ws = new Workspace();
ws.createWorkspaceTemplates(workspace);
initPromptLoader(workspace, ws.getTemplateDir());
ensureWorkspacePrompts();

// Value tokens
container.registerInstance("dataPath", dataPath);
container.registerInstance("workspace", workspace);
container.registerInstance("configFile", configFile);

// Services — registered in dependency order (tsyringe resolves lazily so order
// doesn't strictly matter, but explicit ordering improves readability)
container.registerSingleton(VaultService);
container.registerSingleton(SkillManifestService);
container.registerSingleton(ConfigService);
container.registerSingleton(MessageBus);
container.registerSingleton(SessionManager);
container.registerSingleton(MemoryService);
container.registerSingleton(ProviderManager);
container.registerSingleton(PersonalityService);
container.registerSingleton(Agent);
container.registerSingleton(ChannelManager);
container.registerSingleton(ShutdownService);
container.registerSingleton(MemoryExtractionCron);
container.registerSingleton(HeartbeatService);
container.registerSingleton(CronService);
container.registerSingleton(ReflectionService);
container.registerSingleton(McpService);
container.registerSingleton(APIService);


export { container };
