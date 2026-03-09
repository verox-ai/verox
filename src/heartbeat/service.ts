import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { injectable, inject } from "tsyringe";
import { Agent } from "src/agent/agent.js";
import { getPrompt } from "src/prompts/loader.js";
import { Logger } from "src/utils/logger";

export const DEFAULT_HEARTBEAT_INTERVAL_S = 30 * 60;
export const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";

function getHeartbeatPrompt(): string {
  return (
    getPrompt("heartbeat") ??
    "Read HEARTBEAT.md in your workspace (if it exists).\nFollow any instructions or tasks listed there.\nIf nothing needs attention, reply with just: HEARTBEAT_OK"
  );
}

function isHeartbeatEmpty(content?: string | null): boolean {
  if (!content) {
    return true;
  }
  const skipPatterns = new Set(["- [ ]", "* [ ]", "- [x]", "* [x]"]);
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--") || skipPatterns.has(trimmed)) {
      continue;
    }
    return false;
  }
  return true;
}

@injectable()
export class HeartbeatService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly logger = new Logger(HeartbeatService.name);
  constructor(
    @inject("workspace") private workspace: string,
    @inject(Agent) private agent: Agent
  ) { }

  get heartbeatFile(): string {
    return join(this.workspace, "HEARTBEAT.md");
  }

  private readHeartbeatFile(): string | null {
    if (existsSync(this.heartbeatFile)) {
      try {
        return readFileSync(this.heartbeatFile, "utf-8");
      } catch {
        return null;
      }
    }
    return null;
  }

  async start(): Promise<void> {
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, DEFAULT_HEARTBEAT_INTERVAL_S * 1000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    const content = this.readHeartbeatFile();
    if (isHeartbeatEmpty(content)) {
      this.logger.debug("Heartbeat is empty");
      return;
    }
    const response = await this.agent.processDirect({ content: getHeartbeatPrompt(), sessionKey: "heartbeat" });
    if (response.toUpperCase().replace(/_/g, "").includes(HEARTBEAT_OK_TOKEN.replace(/_/g, ""))) {
      return;
    }
  }

  async triggerNow(): Promise<string> {
    return this.agent.processDirect({ content: getHeartbeatPrompt(), sessionKey: "heartbeat" });
  }
}
