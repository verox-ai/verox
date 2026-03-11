export type InboundMessage = {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: Date;
  media: string[];
  metadata: Record<string, unknown>;
  /** Optional callback invoked for each streamed token from the LLM. */
  onTokenDelta?: (token: string) => void;
  /** Optional callback invoked when a tool call begins executing. */
  onToolCall?: (toolName: string) => void;
};

export function inboundSessionKey(msg: InboundMessage): string {
  return `${msg.channel}:${msg.chatId}`;
}

export type OutboundMessage = {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string | null;
  media: string[];
  metadata: Record<string, unknown>;
  /** Optional interactive buttons (rendered as Block Kit in Slack, ignored elsewhere). */
  buttons?: { text: string; value: string }[];
};