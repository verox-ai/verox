import { randomUUID } from "node:crypto";
import { getPrompt } from "src/prompts/loader.js";
import { ToolRegistry } from "./tools/registry.js";
import { ReadFileTool, WriteFileTool, ListDirTool } from "./tools/filesystem.js";
import { ExecTool } from "./tools/shell.js";
import { ProviderManager } from "src/provider/manager.js";
import { MessageBus } from "src/messagebus/queue.js";
import { InboundMessage } from "src/messagebus/events.js";
import { WebCrawlTool, WebFetchTool, WebSearchTool } from "./tools/web.js";
import { Logger } from "src/utils/logger.js";
import { Config } from "src/types/schemas/schema.js";
import { ImapMailTool, ImapMailReadTool, ImapMailUpdateTool } from "./tools/imap.js";
import { runLLMLoop } from "./llm-loop.js";
import { UsageService } from "src/usage/service.js";

/**
 * Manages background subagent tasks spawned by the main agent.
 *
 * Each subagent runs an independent `runLLMLoop` in a detached Promise with
 * its own `ToolRegistry`. When done (or on error), the subagent publishes a
 * `system` channel message back to the origin session so the main agent can
 * summarise the result for the user.
 *
 * Callers can interact with running subagents via:
 * - `steerRun(id, note)` — inject a steering note into the next iteration
 * - `cancelRun(id)` — set the cancelled flag (checked by `isCancelled`)
 * - `listRuns()` — inspect status of all spawned tasks
 */
export class SubagentManager {
  private logger = new Logger(SubagentManager.name);
  private runningTasks = new Map<string, Promise<void>>();
  private runs = new Map<
    string,
    {
      id: string;
      label: string;
      task: string;
      origin: { channel: string; chatId: string };
      replyChannel?: string;
      replyChatId?: string;
      startedAt: string;
      status: "running" | "done" | "error" | "cancelled";
      cancelled: boolean;
      doneAt?: string;
    }
  >();
  private steerQueue = new Map<string, string[]>();

  constructor(
    private options: {
      providerManager: ProviderManager;
      workspace: string;
      bus: MessageBus;
      toolConfig?: Config["tools"];
      usageService?: UsageService;
    }
  ) { }

  /**
   * Runs a subagent synchronously and returns its final text response.
   * Unlike `spawn()`, this awaits completion and returns the result directly
   * so the calling tool can pass it back to the LLM as a tool result.
   * Useful for delegation and parallel work (call multiple times in one response).
   */
  async run(params: {
    task: string;
    label?: string;
    maxIterations?: number;
  }): Promise<string> {
    const tools = new ToolRegistry();
    const allowedDir = this.options.toolConfig?.restrictFilesToWorkspace ? this.options.workspace : undefined;
    tools.register(new ReadFileTool(allowedDir));
    tools.register(new WriteFileTool(allowedDir));
    tools.register(new ListDirTool(allowedDir));

    const { apiKey, maxResults, strUrl } = this.options.toolConfig?.web.search ?? {};
    tools.register(new WebSearchTool(apiKey, maxResults, strUrl));
    tools.register(new WebFetchTool());

    if (this.options.toolConfig?.web.crawl) {
      tools.register(new WebCrawlTool(this.options.toolConfig.web.crawl));
    }
    if (this.options.toolConfig?.imap) {
      tools.register(new ImapMailTool(this.options.toolConfig.imap, this.options.workspace));
      tools.register(new ImapMailReadTool(this.options.toolConfig.imap));
      tools.register(new ImapMailUpdateTool(this.options.toolConfig.imap));
    }

    const systemPrompt = this.buildSubagentPrompt(params.task);
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: params.task }
    ];

    const result = await runLLMLoop({
      messages,
      tools,
      providerManager: this.options.providerManager,
      maxIterations: params.maxIterations ?? 15,
      onUsage: this.options.usageService
        ? (prompt, completion, model) => this.options.usageService!.record(prompt, completion, model)
        : undefined
    });

    return result ?? "Sub-agent completed but produced no output.";
  }

  /**
   * Spawns a new background subagent for `task`.
   * Returns immediately with a confirmation string; the subagent runs
   * asynchronously and posts its result back via the message bus.
   */
  async spawn(params: {
    task: string;
    label?: string;
    originChannel?: string;
    originChatId?: string;
    replyChannel?: string;
    replyChatId?: string;
  }): Promise<string> {
    const taskId = randomUUID().slice(0, 8);
    const displayLabel = params.label ?? `${params.task.slice(0, 30)}${params.task.length > 30 ? "..." : ""}`;
    const origin = {
      channel: params.originChannel ?? "cli",
      chatId: params.originChatId ?? "direct"
    };
    this.runs.set(taskId, {
      id: taskId,
      label: displayLabel,
      task: params.task,
      origin,
      replyChannel: params.replyChannel,
      replyChatId: params.replyChatId,
      startedAt: new Date().toISOString(),
      status: "running",
      cancelled: false
    });
    this.steerQueue.set(taskId, []);
    this.logger.debug("Subagent spawned", { taskId, origin, replyChannel: params.replyChannel, replyChatId: params.replyChatId });

    const background = this.runSubagent({
      taskId,
      task: params.task,
      label: displayLabel,
      origin,
      replyChannel: params.replyChannel,
      replyChatId: params.replyChatId
    });
    this.runningTasks.set(taskId, background);
    background.finally(() => {
      this.runningTasks.delete(taskId);
      const run = this.runs.get(taskId);
      if (run && run.status === "running") {
        run.status = run.cancelled ? "cancelled" : "done";
        run.doneAt = new Date().toISOString();
      }
      this.steerQueue.delete(taskId);
    });

    return `Subagent [${displayLabel}] started (id: ${taskId}). I'll notify you when it completes.`;
  }

  private async runSubagent(params: {
    taskId: string;
    task: string;
    label: string;
    origin: { channel: string; chatId: string };
    replyChannel?: string;
    replyChatId?: string;
  }): Promise<void> {
    try {
      const run = this.runs.get(params.taskId);
      if (run?.cancelled) {
        return;
      }
      const tools = new ToolRegistry();
      const allowedDir = this.options.toolConfig?.restrictFilesToWorkspace ? this.options.workspace : undefined;
      tools.register(new ReadFileTool(allowedDir));
      tools.register(new WriteFileTool(allowedDir));
      tools.register(new ListDirTool(allowedDir));
      tools.register(
        new ExecTool({
          workingDir: this.options.workspace,
          timeout: this.options.toolConfig?.exec.timeout ?? 60,
          restrictToWorkspace: this.options.toolConfig?.restrictExecToWorkspace ?? false
        })
      );

      const { apiKey, maxResults, strUrl } = this.options.toolConfig?.web.search ?? {};
      tools.register(new WebSearchTool(apiKey, maxResults, strUrl));
      tools.register(new WebFetchTool());

      if (this.options.toolConfig?.web.crawl) {
        tools.register(new WebCrawlTool(this.options.toolConfig?.web.crawl))
      }

      if (this.options.toolConfig?.imap) {
        tools.register(new ImapMailTool(this.options.toolConfig.imap, this.options.workspace));
        tools.register(new ImapMailReadTool(this.options.toolConfig.imap));
        tools.register(new ImapMailUpdateTool(this.options.toolConfig.imap));
      }

      const systemPrompt = this.buildSubagentPrompt(params.task);
      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.task }
      ];

      const finalResult = await runLLMLoop({
        messages,
        tools,
        providerManager: this.options.providerManager,
        maxIterations: 15,
        isCancelled: () => this.runs.get(params.taskId)?.cancelled ?? false,
        drainSteering: () => {
          const queued = this.steerQueue.get(params.taskId) ?? [];
          return queued.splice(0, queued.length).map((note) => `Steer: ${note}`);
        },
        onUsage: this.options.usageService
          ? (prompt, completion, model) => this.options.usageService!.record(prompt, completion, model)
          : undefined
      });

      const runAfter = this.runs.get(params.taskId);
      if (runAfter && !runAfter.cancelled) {
        runAfter.status = "done";
        runAfter.doneAt = new Date().toISOString();
        await this.announceResult({
          label: params.label,
          task: params.task,
          result: finalResult ?? "Task completed but no final response was generated.",
          origin: params.origin,
          replyChannel: params.replyChannel,
          replyChatId: params.replyChatId,
          status: "ok"
        });
      }
    } catch (err) {
      const runAfter = this.runs.get(params.taskId);
      if (runAfter && !runAfter.cancelled) {
        runAfter.status = "error";
        runAfter.doneAt = new Date().toISOString();
        await this.announceResult({
          label: params.label,
          task: params.task,
          result: `Error: ${String(err)}`,
          origin: params.origin,
          replyChannel: params.replyChannel,
          replyChatId: params.replyChatId,
          status: "error"
        });
      }
    }
  }

  private async announceResult(params: {
    label: string;
    task: string;
    result: string;
    origin: { channel: string; chatId: string };
    replyChannel?: string;
    replyChatId?: string;
    status: "ok" | "error";
  }): Promise<void> {
    const statusText = params.status === "ok" ? "completed successfully" : "failed";
    const announceContent = `[Subagent '${params.label}' ${statusText}]\n\nTask: ${params.task}\n\nResult:\n${params.result}\n\nSummarize this naturally for the user. Keep it brief (1-2 sentences). Do not mention technical details like "subagent" or task IDs.`;

    const metadata: Record<string, unknown> = {};
    if (params.replyChannel) {
      metadata.replyChannel = params.replyChannel;
      metadata.replyChatId = params.replyChatId;
    }

    const msg: InboundMessage = {
      channel: "system",
      senderId: "subagent",
      chatId: `${params.origin.channel}:${params.origin.chatId}`,
      content: announceContent,
      timestamp: new Date(),
      media: [],
      metadata
    };

    this.logger.debug("Subagent announceResult", { chatId: msg.chatId, metadata });
    await this.options.bus.publishInbound(msg);
  }

  private buildSubagentPrompt(task: string): string {
    return getPrompt("subagent", {
      task,
      workspace: this.options.workspace
    }) ?? `You are a subagent. Complete this task: ${task}`;
  }

  /** Number of subagents whose LLM loop has not yet resolved or rejected. */
  getRunningCount(): number {
    return this.runningTasks.size;
  }

  /** Returns a snapshot of all spawned task records (running, done, error, and cancelled). */
  listRuns(): Array<{ id: string; label: string; status: string; startedAt: string; doneAt?: string }> {
    return Array.from(this.runs.values()).map((run) => ({
      id: run.id,
      label: run.label,
      status: run.status,
      startedAt: run.startedAt,
      doneAt: run.doneAt
    }));
  }

  /**
   * Enqueues a steering note for a running subagent. The note is injected as
   * a user message at the start of the next LLM iteration.
   * Returns false if the run is not found, already finished, or cancelled.
   */
  steerRun(id: string, note: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.cancelled || run.status !== "running") {
      return false;
    }
    const queue = this.steerQueue.get(id);
    if (!queue) {
      return false;
    }
    queue.push(note);
    return true;
  }

  /**
   * Marks a run as cancelled so the `isCancelled` check in its LLM loop
   * exits at the next iteration boundary. Returns false if not found.
   */
  cancelRun(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) {
      return false;
    }
    run.cancelled = true;
    run.status = "cancelled";
    run.doneAt = new Date().toISOString();
    this.steerQueue.delete(id);
    return true;
  }
}
