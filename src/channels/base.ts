import { Agent } from "src/agent/agent";
import { InboundMessage, OutboundMessage } from "src/messagebus/events";
import { MessageBus } from "src/messagebus/queue";
import { SessionManager } from "src/session/manager";

export abstract class BaseChannel<TConfig extends Record<string, unknown>> {
  protected running = false;
  constructor(protected config: TConfig, protected bus: MessageBus,protected sessionManager?: SessionManager) {}
  private agent?: Agent;

  setAgent(agent: Agent) {
    this.agent = agent;
  }
  
  getAgent() {
    return this.agent;
  }

  abstract get name(): string;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(msg: OutboundMessage): Promise<void>;

  isAllowed(senderId: string): boolean {
    const allowList = (this.config as { allowFrom?: string[] }).allowFrom ?? [];
    const policy = this.config.policy;
    if (typeof senderId !== 'string') {
      senderId = String(senderId);
    }

    if (!allowList.length ) {
      return policy === 'none';
    }
    if (allowList.includes(senderId)) {
      return true;
    }
    
    if (senderId.includes("|")) {
      return senderId.split("|").some((part) => allowList.includes(part));
    }
    return false;
  }

  protected async handleMessage(params: {
    senderId: string;
    chatId: string;
    content: string;
    media?: string[];
    metadata?: Record<string, unknown>;
    onTokenDelta?: (token: string) => void;
    onToolCall?: (toolName: string) => void;
  }): Promise<void> {
    if (!this.isAllowed(params.senderId)) {
      return;
    }
    const msg: InboundMessage = {
      channel: this.name,
      senderId: params.senderId,
      chatId: params.chatId,
      content: params.content,
      timestamp: new Date(),
      media: params.media ?? [],
      metadata: params.metadata ?? {},
      onTokenDelta: params.onTokenDelta,
      onToolCall: params.onToolCall,
    };
    await this.bus.publishInbound(msg);
  }

  get isRunning(): boolean {
    return this.running;
  }
}