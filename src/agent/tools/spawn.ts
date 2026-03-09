import { SubagentManager } from "../subagent";
import { Tool } from "./toolbase";
import { RiskLevel } from "../security.js";

export class SpawnTool extends Tool {
  private channel = "cli";
  private chatId = "direct";
  private replyChannel?: string;
  private replyChatId?: string;

  constructor(private manager: SubagentManager) {
    super();
  }

  get name(): string { return "spawn"; }

  // Spawning a subagent with attacker-controlled instructions is dangerous.
  get outputRisk(): RiskLevel { return RiskLevel.High; }
  get maxRisk():    RiskLevel { return RiskLevel.None; }

  get description(): string {
    return "Spawn a background subagent to handle a task";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task: { type: "string", description: "Task for the subagent" },
        label: { type: "string", description: "Optional label" }
      },
      required: ["task"]
    };
  }

  setContext(channel: string, chatId: string, replyChannel?: string, replyChatId?: string): void {
    this.channel = channel;
    this.chatId = chatId;
    this.replyChannel = replyChannel;
    this.replyChatId = replyChatId;
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const task = String(params.task ?? "");
    const label = params.label ? String(params.label) : undefined;
    return this.manager.spawn({
      task,
      label,
      originChannel: this.channel,
      originChatId: this.chatId,
      replyChannel: this.replyChannel,
      replyChatId: this.replyChatId
    });
  }
}
