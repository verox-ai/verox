import { injectable, inject } from "tsyringe";
import { SessionManager } from "src/session/manager.js";
import { ContextManager } from "./context.js";
import { MessageBus } from "src/messagebus/queue.js";
import { InboundMessage, OutboundMessage } from "src/messagebus/events.js";
import { ToolRegistry } from "./tools/registry.js";
import { isSilentReplyText, NO_REPLY_TOKEN, extractTopicShift } from "./tokens.js";
import { MessageTool } from "./tools/message.js";
import { ProviderManager } from "src/provider/manager.js";
import { Config } from "src/types/schemas/schema.js";
import { MemoryService } from "src/memory/service.js";
import { compactSessionIfNeeded } from "./compaction.js";
import { Session } from "src/session/manager.js";
import { Logger } from "src/utils/logger.js";
import { SpawnTool } from "./tools/spawn.js";
import { DocStore } from "src/docs/store.js";
import { SubagentManager } from "./subagent.js";
import { ConfigService } from "src/config/service.js";
import { CronTool } from "./tools/cron.js";
import type { CronService } from "src/cron/service.js";
import { runLLMLoop, stripOrphanedToolCalls } from "./llm-loop.js";
import { PersonalityService } from "./personality.js";
import { VaultService } from "src/vault/credentials.js";
import { SkillManifestService } from "src/vault/manifest.js";
import { OutputSanitizer } from "./sanitizer.js";
import { SecurityManager } from "./security.js";
import { UsageService } from "src/usage/service.js";
import { McpService } from "src/mcp/service.js";
import type { AgentServices } from "./tools/tool-provider.js";
import { ToolSearchTool } from "./tools/tool-search.js";
import { CoreProvider } from "./tools/providers/core.js";
import { FilesystemProvider } from "./tools/providers/filesystem.js";
import { ShellProvider } from "./tools/providers/shell.js";
import { WebProvider } from "./tools/providers/web.js";
import { DocsProvider } from "./tools/providers/docs.js";
import { ImapProvider } from "./tools/providers/imap.js";
import { CalDavProvider } from "./tools/providers/caldav.js";
import { BrowserProvider } from "./tools/providers/browser.js";
import { CalendarAwareness } from "src/calendar/awareness.js";
import { ContactsProvider } from "./tools/providers/contacts.js";
import { KnowledgeProvider } from "./tools/providers/knowledge.js";
import { SmtpProvider } from "./tools/providers/smtp.js";
import { WorkflowService } from "./workflow.js";
import { WorkflowActivateTool, WorkflowCancelTool, WorkflowListTool, WorkflowPlanTool, WorkflowSaveTool } from "./tools/workflow.js";
import type { RssService } from "src/rss/service.js";
import { RssFetchTool, RssSubscribeTool, RssUnsubscribeTool, RssListTool, RssCheckTool } from "./tools/rss.js";


/**
 * Resolves additional tool hints for the message tool based on the current session context.
 * Hints are injected into the system prompt to guide tool usage.
 */
type MessageToolHintsResolver = (params: {
    sessionKey: string;
    channel: string;
    chatId: string;
    accountId?: string | null;
}) => string[];


/**
 * Core agent that drives the LLM ↔ tool loop.
 *
 * Responsibilities:
 * - Consuming inbound messages from the bus
 * - Building and maintaining conversation history per session
 * - Running the iterative LLM call + tool execution cycle
 * - Publishing outbound responses back to the bus
 * - Compacting long sessions to stay within context limits
 */
@injectable()
export class Agent {
    /** Exposed for the REST API — only set when tools.docs.enabled = true. */
    public docStore?: DocStore;
    private calendarAwareness?: CalendarAwareness;
    private context: ContextManager;
    private sessions: SessionManager;
    private memory: MemoryService;
    private running = false;
    private tools: ToolRegistry;
    private logger = new Logger(Agent.name);
    private subagents: SubagentManager;
    private configService: ConfigService;
    private personalityService: PersonalityService;
    private vaultService: VaultService;
    private manifestService: SkillManifestService;
    private sanitizer: OutputSanitizer;
    private workspace: string;
    private usageService: UsageService;
    private isSecManagerEnabled: boolean;
    private workflowService: WorkflowService;
    /** Services bundle passed to every ToolProvider. */
    private agentServices: AgentServices;
    
    // Internal options object rebuilt from DI params — keeps the rest of the class unchanged.
    private options: {
        bus: MessageBus;
        providerManager: ProviderManager;
        workspace: string;
        maxIterations?: number;
        toolConfig?: Config["tools"];
        cronService?: any;
        sessionManager?: SessionManager;
        contextConfig?: Config["agents"]["context"];
        gatewayController?: null;
        config?: Config;
        extensionRegistry?: null;
        resolveMessageToolHints?: MessageToolHintsResolver;
        compactConfig?: {
            enabled?: boolean;
            thresholdTokens?: number;
            keepRecentMessages?: number;
        };
    };

    constructor(
        @inject(MessageBus) bus: MessageBus,
        @inject(ProviderManager) providerManager: ProviderManager,
        @inject("workspace") workspace: string,
        @inject(SessionManager) sessionManager: SessionManager,
        @inject(MemoryService) memoryStore: MemoryService,
        @inject(ConfigService) configService: ConfigService,
        @inject(PersonalityService) personalityService: PersonalityService,
        @inject(VaultService) vaultService: VaultService,
        @inject(SkillManifestService) manifestService: SkillManifestService,

    ) {
        this.configService = configService;
        this.vaultService = vaultService;
        this.manifestService = manifestService;
        const appConfig = configService.app;

        this.options = {
            bus,
            providerManager,
            workspace,
            sessionManager,
            config: appConfig,
            maxIterations: appConfig.agents.defaults.maxToolIterations,
            toolConfig: appConfig.tools,
            contextConfig: appConfig.agents.context,
            compactConfig: appConfig.agents.compaction
        };
        this.workspace = workspace;
        this.isSecManagerEnabled = process.env.VEROX_DISABLE_SECURITY === 'true' ? false : true;
        this.usageService = new UsageService(workspace);
        this.workflowService = new WorkflowService(workspace, sessionManager);
        this.context = new ContextManager(workspace, this.options.contextConfig, memoryStore);
        this.sessions = sessionManager;
        this.memory = memoryStore;
        this.tools = new ToolRegistry();
        this.subagents = new SubagentManager({
            providerManager,
            workspace,
            bus,
            toolConfig: this.options.toolConfig,
            usageService: this.usageService
        });
        this.personalityService = personalityService;
        this.sanitizer = new OutputSanitizer();

        // Build the services bundle used by all providers.
        this.agentServices = {
            workspace,
            providerManager,
            bus,
            sessions: sessionManager,
            memory: memoryStore,
            configService,
            vaultService,
            manifestService,
            skillsLoader: this.context.getSkillsLoader(),
            subagents: this.subagents,
            usageService: this.usageService,
            isSecManagerEnabled: this.isSecManagerEnabled,
        };

        // Register all built-in providers and do the initial sync.
        this.tools.addProvider(new CoreProvider());
        this.tools.addProvider(new FilesystemProvider());
        this.tools.addProvider(new ShellProvider());
        this.tools.addProvider(new WebProvider());
        this.tools.addProvider(new DocsProvider());
        this.tools.addProvider(new ImapProvider());
        this.tools.addProvider(new CalDavProvider());
        this.tools.addProvider(new BrowserProvider());
        this.tools.addProvider(new ContactsProvider());
        this.tools.addProvider(new KnowledgeProvider());
        this.tools.addProvider(new SmtpProvider());

        // Workflow tools registered directly (not via provider — they need the
        // WorkflowService instance which is agent-scoped, not config-driven).
        this.tools.register(new WorkflowPlanTool(this.workflowService));
        this.tools.register(new WorkflowActivateTool(this.workflowService));
        this.tools.register(new WorkflowSaveTool(this.workflowService));
        this.tools.register(new WorkflowListTool(this.workflowService));
        this.tools.register(new WorkflowCancelTool(this.workflowService));
        this.tools.syncAllProviders(appConfig, this.agentServices);

        // ToolSearchTool needs a reference to the registry itself — register after sync.
        this.tools.register(new ToolSearchTool(this.tools));

        // Expose docStore for the REST API.
        this.docStore = this.tools.getProvider<DocsProvider>("docs")?.docStore;

        // Start calendar awareness if CalDAV is configured.
        void this.syncCalendarAwareness();

        // Subscribe to config file changes and hot-reload all providers.
        configService.onConfigChange((newConfig) => this.reloadFromConfig(newConfig));

        this.logger.debug("Agent init is done");
        if (!this.isSecManagerEnabled) {
            this.logger.warn("Enhanced Security Manager is disabled. Your agent may break or leak some data.");
        }
    }

    /**
     * Called whenever the config file changes on disk.
     * Syncs all providers (load/unload/update) and refreshes agent-level options.
     */
    private reloadFromConfig(cfg: Config): void {
        this.logger.info("Hot-reloading agent config");

        this.options.config = cfg;
        this.options.maxIterations = cfg.agents.defaults.maxToolIterations;
        this.options.toolConfig = cfg.tools;
        this.options.compactConfig = cfg.agents.compaction;
        this.options.contextConfig = cfg.agents.context;
        this.context.updateContextConfig(cfg.agents.context);

        this.tools.syncAllProviders(cfg, this.agentServices);

        // Keep docStore in sync (DocsProvider may have been loaded/unloaded).
        this.docStore = this.tools.getProvider<DocsProvider>("docs")?.docStore;

        // Re-sync calendar awareness (CalDAV may have been enabled/disabled).
        void this.syncCalendarAwareness();

        this.logger.info("Agent config hot-reload complete");
    }

    private async syncCalendarAwareness(): Promise<void> {
        const calDavProvider = this.tools.getProvider<CalDavProvider>("caldav");
        const client = calDavProvider?.getClient();
        if (client) {
            if (!this.calendarAwareness) {
                this.calendarAwareness = new CalendarAwareness(client);
                this.context.setCalendarAwareness(() => this.calendarAwareness!.getSection());
                await this.calendarAwareness.start();
                this.logger.info("Calendar awareness started");
            } else {
                this.calendarAwareness.updateClient(client);
            }
        } else if (this.calendarAwareness) {
            this.calendarAwareness.stop();
            this.calendarAwareness = undefined;
            this.context.clearCalendarAwareness();
            this.logger.info("Calendar awareness stopped (CalDAV disabled)");
        }
    }

    /** Registers the cron tool. Call after container is fully resolved to avoid circular DI. */
    registerCronTool(cronService: CronService): void {
        this.tools.register(new CronTool(cronService));
    }

    /** Registers RSS tools. Call after container is fully resolved to avoid circular DI. */
    registerRssService(rssService: RssService): void {
        this.tools.register(new RssFetchTool(rssService));
        this.tools.register(new RssSubscribeTool(rssService));
        this.tools.register(new RssUnsubscribeTool(rssService));
        this.tools.register(new RssListTool(rssService));
        this.tools.register(new RssCheckTool(rssService));
    }

    /**
     * Connects to all configured MCP servers and registers their tools.
     * Call after container is fully resolved, before `run()`.
     */
    async connectMcp(mcpService: McpService): Promise<void> {
        const mcpConfig = this.options.config?.mcp;
        if (!mcpConfig) return;
        await mcpService.connect(mcpConfig, this.vaultService);
        await mcpService.registerTools(this.tools, mcpConfig);
    }

    /**
     * Starts the agent's main message loop.
     * Blocks until `stop()` is called. Errors on individual messages are caught
     * and returned to the user as an error reply rather than crashing the loop.
     */
    async run(): Promise<void> {
        this.running = true;
        this.logger.info("Agent started");
        while (this.running) {
            const msg = await this.options.bus.consumeInbound();
            try {
                this.logger.debug("Incoming message", { channel: msg.channel, chatId: msg.chatId, content: msg.content });

                // check for credentials the user sent
                const sanitizationResult = this.sanitizer.sanitize(msg.content);
                if (sanitizationResult.isSafe) {
                    const response = await this.processMessage(msg);
                    if (response) {
                        const responseResult = this.sanitizer.sanitize(response.content ?? "");
                        this.logger.debug("LLM response", { channel: response.channel, chatId: response.chatId, content: responseResult.sanitizedText });
                        await this.options.bus.publishOutbound({ ...response, content: responseResult.sanitizedText });
                    }
                } else {
                    await this.options.bus.publishOutbound({
                        channel: msg.channel,
                        chatId: msg.chatId,
                        content: `Sorry, ⚠️ Your input appears to contain credentials. Please remove them. Your message  will not be delivered to the Agent.`,
                        media: [],
                        metadata: {}
                    });
                }
            } catch (err) {
                await this.options.bus.publishOutbound({
                    channel: msg.channel,
                    chatId: msg.chatId,
                    content: `Sorry, I encountered an error: ${String(err)}`,
                    media: [],
                    metadata: {}
                });
            }
        }
    }

    /** Signals the agent to exit the message loop after the current message is processed. */
    stop(): void {
        this.running = false;
    }

    private async compactSessionIfNeeded(session: Session): Promise<void> {
        await compactSessionIfNeeded({
            session,
            sessions: this.sessions,
            context: this.context,
            providerManager: this.options.providerManager,
            memory: this.memory,
            personalityService: this.personalityService,
            config: this.options.compactConfig
        });
    }

    /** Force-compacts a session regardless of token count (used on topic-shift detection). */
    private async compactSessionIfNeededForced(session: Session): Promise<void> {
        await compactSessionIfNeeded({
            session,
            sessions: this.sessions,
            context: this.context,
            providerManager: this.options.providerManager,
            memory: this.memory,
            personalityService: this.personalityService,
            config: this.options.compactConfig,
            force: true
        });
    }

    /**
     * Updates stateful tools (message, spawn, cron) with the current channel/chatId
     * so they deliver replies and spawned agents to the right destination.
     */
    private prepareToolContext(channel: string, chatId: string, replyChannel?: string, replyChatId?: string): void {
        const messageTool = this.tools.get("message");
        if (messageTool instanceof MessageTool) messageTool.setContext(channel, chatId);
        const spawnTool = this.tools.get("spawn");
        if (spawnTool instanceof SpawnTool) spawnTool.setContext(channel, chatId, replyChannel, replyChatId);
    }

    /**
     * Core LLM ↔ tool execution loop shared by all message handlers.
     *
     * Each iteration calls the LLM. If the response contains tool calls, each tool
     * is executed and its result is appended to both the in-flight `messages` array
     * and the persistent session. The loop continues until the LLM returns a plain
     * text response (no tool calls) or `maxIterations` is reached.
     *
     * On a 400 "orphaned tool_calls" error from the API the session history is
     * sanitized and the request is retried once before re-throwing.
     *
     * @returns The final text content from the LLM, or null if max iterations were exhausted.
     */
    private async runIterationLoop(
        messages: Array<Record<string, unknown>>,
        session: Session,
        sessionless = false,
        onTokenDelta?: (token: string) => void,
        onToolCall?: (toolName: string) => void,
        toolContext?: string
    ): Promise<string | null> {
        // Reset per-turn contextual tool activations (done by ToolSearchTool).
        this.tools.resetActivations();
        // Bind workflow service to this session so tools can read/write its metadata.
        this.workflowService.setSession(session);

        // Fresh instance per turn — risk level must never bleed across turns or
        // between concurrent sessions (cron, multi-channel).
        const securityManager = new SecurityManager();

        // Build reasoning effort escalation schedule when adaptiveReasoning is enabled.
        const reasoningEffortLevels = buildReasoningEffortLevels(
            this.options.config?.providers
                ? (() => {
                    const provCfgs = this.options.config.providers as Record<string, { reasoningEffort?: string | null; adaptiveReasoning?: boolean }>;
                    const active = Object.values(provCfgs).find((p) => p?.reasoningEffort !== undefined || p?.adaptiveReasoning);
                    return { effort: active?.reasoningEffort ?? null, adaptive: active?.adaptiveReasoning ?? false };
                })()
                : { effort: null, adaptive: false }
        );

        // Inject active/pending workflow state into the system prompt.
        const activeWorkflow  = this.workflowService.getActive();
        const pendingWorkflow = this.workflowService.getPending();
        if (activeWorkflow || pendingWorkflow) {
            const sysMsg = messages.find(m => m.role === "system");
            if (sysMsg && typeof sysMsg.content === "string") {
                if (activeWorkflow) {
                    sysMsg.content += `\n\n---\n\n## Active Workflow: "${activeWorkflow.name}"\n`
                        + `Goal: ${activeWorkflow.summary}\n`
                        + `Approved tools (no security holds): ${activeWorkflow.tools_needed.join(", ")}\n`
                        + `Proceed with the task — security holds are suspended for these tools.`;
                } else if (pendingWorkflow) {
                    sysMsg.content += `\n\n---\n\n## Pending Workflow: "${pendingWorkflow.name}"\n`
                        + `Goal: ${pendingWorkflow.summary}\n`
                        + `This plan is awaiting user confirmation. Present it and ask the user to confirm, then call workflow_activate.`;
                }
            }
        }

        return runLLMLoop({
            messages,
            tools: this.tools,
            providerManager: this.options.providerManager,
            maxIterations: this.options.maxIterations ?? 20,
            reasoningEffortLevels,
            securityManager,
            toolContext,
            workflowApprovedTools: this.workflowService.getApprovedTools(),
            securityOverrides: this.options.toolConfig?.security ?? {},
            skillSecurityOverrides: this.options.toolConfig?.skillSecurity ?? {},
            isSkillSigned: (command: string) => {
                const loader = this.context.getSkillsLoader();
                if (!loader) return undefined;
                const entry = loader.getMatchingSkillEntry(command);
                if (!entry) return undefined;
                return this.manifestService.verify(entry.path);
            },
            onUsage: (prompt, completion, model) => {
                this.usageService.record(prompt, completion, model);
            },
            onAssistantMessage: sessionless ? undefined : (content, toolCalls, reasoningContent) => {
                this.sessions.addMessage(session, "assistant", content ?? "", {
                    tool_calls: toolCalls,
                    reasoning_content: reasoningContent
                });
            },
            onToolResult: sessionless ? undefined : (callId, name, result, riskLevel) => {
                // Annotate with effective output risk so memory extraction can propagate
                // taint from high-risk tool calls into extracted memory items.
                const extra: Record<string, unknown> = { tool_call_id: callId, name };
                if (riskLevel != null && riskLevel > 0) extra.risk_level = riskLevel;
                this.sessions.addMessage(session, "tool", result, extra);
            },
            onOrphanedToolCallError: () => {
                stripOrphanedToolCalls(session.messages as Array<Record<string, unknown>>);
                if (!sessionless) this.sessions.save(session);
                this.logger.warn("Stripped orphaned tool_calls from session, retrying");
            },
            onTokenDelta,
            onToolCall
        });
    }

    /**
     * Processes a message directly without going through the message bus.
     * Useful for programmatic invocation (CLI, tests, internal triggers).
     *
     * @returns The agent's text response.
     */
    async processDirect(params: {
        content: string;
        sessionKey?: string;
        channel?: string;
        chatId?: string;
        metadata?: Record<string, unknown>;
        messageToolHints?: string[];
    }): Promise<string> {
        const msg: InboundMessage = {
            channel: params.channel ?? "cli",
            senderId: "user",
            chatId: params.chatId ?? "direct",
            content: params.content,
            timestamp: new Date(),
            media: [],
            metadata: params.metadata ?? {}
        };
        this.logger.debug(`processDirect ${params.content}`);
        const response = await this.processMessage(msg, params.sessionKey, params.messageToolHints);
        this.logger.debug(`result of response ${response?.content}`);
        const responseResult = this.sanitizer.sanitize(response?.content ?? "");
        this.logger.debug(`sanatized : ${responseResult.sanitizedText}`);
        return responseResult.sanitizedText ?? "";
    }

    /**
     * Handles messages arriving on the `system` channel.
     * The chatId encodes the target session as `channel:chatId`; this is decoded
     * to route the reply back to the correct origin session.
     * Used by cron jobs, subagent callbacks, and internal triggers.
     */
    private async processSystemMessage(msg: InboundMessage): Promise<OutboundMessage | null> {
        const [originChannel, originChatId] = msg.chatId.includes(":")
            ? msg.chatId.split(":", 2)
            : ["cli", msg.chatId];

        const sessionKey = `${originChannel}:${originChatId}`;
        const session = this.sessions.getOrCreate(sessionKey);
        this.prepareToolContext(originChannel, originChatId);
        /*
                    const cronTool = this.tools.get("cron");
                    if (cronTool instanceof CronTool) {
                      cronTool.setContext(originChannel, originChatId);
                    }
                */
        const accountId =
            (msg.metadata?.account_id as string | undefined) ??
            (msg.metadata?.accountId as string | undefined) ??
            (typeof session.metadata.last_account_id === "string" ? (session.metadata.last_account_id as string) : undefined);
        if (accountId) {
            session.metadata.last_account_id = accountId;
        }

        const messageToolHints = this.options.resolveMessageToolHints?.({
            sessionKey,
            channel: originChannel,
            chatId: originChatId,
            accountId: accountId ?? null
        });

        await this.compactSessionIfNeeded(session);

        const messages = this.context.buildMessages({
            history: this.sessions.getHistory(session),
            currentMessage: msg.content,
            channel: originChannel,
            chatId: originChatId,
            sessionKey,
            messageToolHints,
            compactSummary: session.metadata.compact_summary as string | undefined,
            toolNames: this.tools.toolNames,
            personality: this.personalityService.buildPersonalityPrompt()
        });

        this.logger.debug(`Compacting threshold is ${this.options.compactConfig?.thresholdTokens ?? 6000}`);

        this.sessions.addMessage(session, "user", `[System: ${msg.senderId}] ${msg.content}`);

        const finalContent = await this.runIterationLoop(messages, session, false, undefined, undefined, msg.content) ?? "Background task completed.";
        const { content, replyTo } = parseReplyTags(finalContent, undefined);

        if (isSilentReplyText(content, NO_REPLY_TOKEN)) {
            this.sessions.save(session);
            return null;
        }

        this.sessions.addMessage(session, "assistant", content);
        this.sessions.save(session);

        const outChannel = (msg.metadata?.replyChannel as string) || originChannel;
        const outChatId = (msg.metadata?.replyChatId as string) || originChatId;

        // Mirror exchange to the destination session when routed cross-channel.
        if (outChannel !== originChannel || outChatId !== originChatId) {
            const replySession = this.sessions.getOrCreate(`${outChannel}:${outChatId}`);
            this.sessions.addMessage(replySession, "user", `[System: ${msg.senderId}] ${msg.content}`);
            this.sessions.addMessage(replySession, "assistant", content);
            this.sessions.save(replySession);
            this.logger.debug(`Mirrored exchange to ${outChannel}:${outChatId} session for cross-channel continuity`);
        }

        this.logger.debug("processSystemMessage outbound", {
            originChannel, originChatId,
            replyChannel: msg.metadata?.replyChannel, replyChatId: msg.metadata?.replyChatId,
            outChannel, outChatId
        });
        return { channel: outChannel, chatId: outChatId, content, replyTo, media: [], metadata: msg.metadata ?? {} };
    }


    /**
     * Main entry point for processing an inbound user message.
     * Resolves or creates the session, updates session metadata, builds the
     * context window, runs the iteration loop, and persists the result.
     *
     * Returns null if the LLM responded with a silent token (NO_REPLY).
     */
    private async processMessage(msg: InboundMessage, sessionKeyOverride?: string, messageToolHintsOverride?: string[]): Promise<OutboundMessage | null> {
        if (msg.channel === "system") {
            return this.processSystemMessage(msg);
        }

        this.logger.debug(`processMessage starting — fresh security context (RiskLevel.None)`);


        const sessionless = Boolean(msg.metadata?.sessionless);
        const sessionKey = sessionless
            ? `ephemeral:${Date.now()}-${Math.random().toString(36).slice(2)}`
            : (sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`);
        const session = this.sessions.getOrCreate(sessionKey);
        if (sessionless) {
             this.logger.debug("processMessage: sessionless mode, key=" + sessionKey);
        }
        const messageId = msg.metadata?.message_id as string | undefined;
        if (messageId) {
            session.metadata.last_message_id = messageId;
        }
        const sessionLabel = msg.metadata?.session_label as string | undefined;
        if (sessionLabel) {
            session.metadata.label = sessionLabel;
        }
        session.metadata.last_channel = msg.channel;
        session.metadata.last_to = msg.chatId;
        this.logger.debug("processMessage routing", {
            channel: msg.channel, chatId: msg.chatId,
            replyChannel: msg.metadata?.replyChannel, replyChatId: msg.metadata?.replyChatId
        });
        const inboundAccountId =
            (msg.metadata?.account_id as string | undefined) ??
            (msg.metadata?.accountId as string | undefined);
        const accountId =
            inboundAccountId && inboundAccountId.trim().length > 0
                ? inboundAccountId
                : typeof session.metadata.last_account_id === "string" && session.metadata.last_account_id.trim().length > 0
                    ? (session.metadata.last_account_id as string)
                    : undefined;
        if (accountId) {
            session.metadata.last_account_id = accountId;
        }
        this.logger.debug("Preparing Tool Context");
        this.prepareToolContext(
            msg.channel, msg.chatId,
            msg.metadata?.replyChannel as string | undefined,
            msg.metadata?.replyChatId as string | undefined
        );

        const messageToolHints = messageToolHintsOverride
            ?? this.options.resolveMessageToolHints?.({
                sessionKey,
                channel: msg.channel,
                chatId: msg.chatId,
                accountId: accountId ?? null
            });

        if (!sessionless) {
            await this.compactSessionIfNeeded(session);
        }
        this.logger.debug("Building MessageContext")
        const contactStore = this.tools.getProvider<ContactsProvider>("contacts")?.store;
        const knownSender = contactStore?.findByAlias(msg.senderId) ?? contactStore?.findByAlias(msg.chatId);

        const messages = this.context.buildMessages({
            history: sessionless ? [] : this.sessions.getHistory(session),
            currentMessage: msg.content,
            media: msg.media,
            channel: msg.channel,
            chatId: msg.chatId,
            sessionKey,
            messageToolHints,
            knownSender: knownSender ? { name: knownSender.name, notes: knownSender.notes } : undefined,
            compactSummary: sessionless ? undefined : session.metadata.compact_summary as string | undefined,
            toolNames: this.tools.toolNames,
            personality: this.personalityService.buildPersonalityPrompt()
        });

        if (!sessionless) this.sessions.addMessage(session, "user", msg.content);

        const finalContent = await this.runIterationLoop(messages, session, sessionless, msg.onTokenDelta, msg.onToolCall, msg.content)
            ?? "I've completed processing but have no response to give.";

        const { content: contentAfterTopicStrip, topicShift } = extractTopicShift(finalContent);
        const { content, replyTo } = parseReplyTags(contentAfterTopicStrip, messageId);
        if (isSilentReplyText(content, NO_REPLY_TOKEN)) {
            this.logger.debug("Its a silent replay discard it");
            if (sessionless) this.sessions.discard(sessionKey); else this.sessions.save(session);
            return null;
        }

        if (!sessionless) this.sessions.addMessage(session, "assistant", content);

        // Force-compact after a topic shift so the next turn doesn't carry stale context.
        if (topicShift && !sessionless) {
            this.logger.info("Topic shift detected — force-compacting session to clear stale context");
            await this.compactSessionIfNeededForced(session);
        } else {
            if (sessionless) this.sessions.discard(sessionKey); else this.sessions.save(session);
        }

        const outChannel = (msg.metadata?.replyChannel as string) || msg.channel;
        const outChatId = (msg.metadata?.replyChatId as string) || msg.chatId;

        // When the response is routed cross-channel (e.g. IMAP IDLE → Telegram),
        // mirror the exchange to the destination session so the user's follow-up
        // replies arrive with the full conversation context.
        if (!sessionless && (outChannel !== msg.channel || outChatId !== msg.chatId)) {
            const replySession = this.sessions.getOrCreate(`${outChannel}:${outChatId}`);
            this.sessions.addMessage(replySession, "user", msg.content);
            this.sessions.addMessage(replySession, "assistant", content);
            this.sessions.save(replySession);
            this.logger.debug(`Mirrored exchange to ${outChannel}:${outChatId} session for cross-channel continuity`);
        }
        this.logger.debug("processMessage outbound", {
            replyChannel: msg.metadata?.replyChannel, replyChatId: msg.metadata?.replyChatId,
            outChannel, outChatId
        });
        return { channel: outChannel, chatId: outChatId, content, replyTo, media: [], metadata: msg.metadata ?? {} };
    }
}


const EFFORT_ORDER = ["low", "medium", "high"] as const;

/**
 * Builds an ordered list of reasoning effort levels for progressive escalation.
 *
 * When adaptive mode is off: returns undefined (provider's configured effort is used as-is).
 * When adaptive mode is on:  returns the tail of EFFORT_ORDER starting at `effort` (or "low").
 * Example: effort="low",  adaptive=true  → ["low","medium","high"]
 *          effort="medium",adaptive=true  → ["medium","high"]
 *          effort="high", adaptive=true   → ["high"]  (no escalation possible)
 *          effort=null,   adaptive=false  → undefined
 */
function buildReasoningEffortLevels(opts: { effort: string | null; adaptive: boolean }): string[] | undefined {
    if (!opts.adaptive) return undefined;
    const start = EFFORT_ORDER.indexOf((opts.effort ?? "low") as typeof EFFORT_ORDER[number]);
    return [...EFFORT_ORDER.slice(start >= 0 ? start : 0)];
}

/**
 * Extracts `[[reply_to_current]]` and `[[reply_to:<id>]]` tags from the LLM response content.
 * Tags are stripped before sending; the extracted reply target is returned separately.
 */
function parseReplyTags(
    content: string,
    currentMessageId?: string
): { content: string; replyTo?: string } {
    let replyTo: string | undefined;
    const replyCurrent = /\[\[\s*reply_to_current\s*\]\]/gi;
    if (replyCurrent.test(content)) {
        replyTo = currentMessageId;
        content = content.replace(replyCurrent, "").trim();
    }
    const replyId = /\[\[\s*reply_to\s*:\s*([^\]]+?)\s*\]\]/i;
    const match = content.match(replyId);
    if (match && match[1]) {
        replyTo = match[1].trim();
        content = content.replace(replyId, "").trim();
    }
    return { content, replyTo };
}
