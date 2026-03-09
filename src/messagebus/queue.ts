import type { OutboundMessage } from "./events.js";
import type { InboundMessage } from "./events.js";
import { Logger } from "src/utils/logger.js";
import { injectable } from "tsyringe";

 
/**
 * A simple unbounded async queue.
 *
 * Callers that `dequeue()` when the queue is empty suspend until an item
 * is enqueued. Callers that `enqueue()` when there is already a suspended
 * dequeuer hand the item directly to that waiter without buffering.
 */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  async dequeue(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift() as T;
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  size(): number {
    return this.items.length;
  }
}

/**
 * In-process message bus that decouples message producers (channels) from the
 * agent consumer, and the agent from outbound channel adapters.
 *
 * Flow:
 *   Channel adapters  →  publishInbound  →  Agent (via consumeInbound)
 *   Agent             →  publishOutbound →  Channel adapters (via dispatchOutbound)
 *
 * Outbound delivery uses a subscriber model: channel adapters call
 * `subscribeOutbound(channel, fn)` once at startup, then `dispatchOutbound()`
 * runs a loop that fans each outbound message out to the matching subscribers.
 */
@injectable()
export class MessageBus {
  private inboundQueue = new AsyncQueue<InboundMessage>();
  private outboundQueue = new AsyncQueue<OutboundMessage>();
  /** Per-channel outbound listeners registered by channel adapters. */
  private outboundSubscribers: Record<string, Array<(msg: OutboundMessage) => Promise<void>>> = {};
  private running = false;
  private logger = new Logger(MessageBus.name);

  /** Enqueues an inbound message for the agent to consume. */
  async publishInbound(msg: InboundMessage): Promise<void> {
    this.inboundQueue.enqueue(msg);
  }

  /** Blocks until the next inbound message is available, then returns it. */
  async consumeInbound(): Promise<InboundMessage> {
    return this.inboundQueue.dequeue();
  }

  /** Enqueues an outbound message to be delivered to the appropriate channel adapter. */
  async publishOutbound(msg: OutboundMessage): Promise<void> {
    this.outboundQueue.enqueue(msg);
  }

  /** Blocks until the next outbound message is available, then returns it. */
  async consumeOutbound(): Promise<OutboundMessage> {
    return this.outboundQueue.dequeue();
  }

  /**
   * Registers a callback that receives outbound messages for a specific channel.
   * Multiple subscribers per channel are supported (all are called in order).
   */
  subscribeOutbound(channel: string, callback: (msg: OutboundMessage) => Promise<void>): void {
    if (!this.outboundSubscribers[channel]) {
      this.outboundSubscribers[channel] = [];
    }
    this.outboundSubscribers[channel].push(callback);
  }

  /**
   * Runs the outbound dispatch loop — blocks indefinitely, delivering each
   * outbound message to any subscribers registered for its channel.
   * Call `stop()` to exit the loop.
   */
  async dispatchOutbound(): Promise<void> {
    this.running = true;
    while (this.running) {
      const msg = await this.consumeOutbound();
      const subscribers = this.outboundSubscribers[msg.channel] ?? [];
      for (const callback of subscribers) {
        try {
          await callback(msg);
        } catch (err) {
          this.logger.error(`Error dispatching to ${msg.channel}`, { error: String(err) });
        }
      }
    }
  }

  /** Signals `dispatchOutbound` to exit after the current message is delivered. */
  stop(): void {
    this.running = false;
  }

  get inboundSize(): number {
    return this.inboundQueue.size();
  }

  get outboundSize(): number {
    return this.outboundQueue.size();
  }
}