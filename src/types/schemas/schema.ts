import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { applySensitiveHints, buildBaseHints, mapSensitivePaths, type ConfigUiHints } from "./hints.js";
import { expandHome, getPackageVersion } from "src/utils/util.js";
import { DEFAULT_WORKSPACE_PATH } from "src/constants.js";
 
export const WhatsAppConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).default([]),
  policy: z.enum(["none", "restricted"]).default("restricted"),
});

export const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(""),
  allowFrom: z.array(z.string()).default([]),
  policy:z.enum(["none", "restricted"]).default("restricted"),
  proxy: z.string().nullable().default(null)
});

export const SlackDMSchema = z.object({
  enabled: z.boolean().default(true),
  policy: z.enum(["none", "restricted"]).default("restricted"),
  allowFrom: z.array(z.string()).default([]),
  channelid: z.string().default('')
});

export const SlackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.string().default("socket"),
  webhookPath: z.string().default("/slack/events"),
  botToken: z.string().default(""),
  appToken: z.string().default(""),
  userTokenReadOnly: z.boolean().default(true),
  groupPolicy: z.enum(["none", "mention",'restricted']).default("restricted"),
  groupAllowFrom: z.array(z.string()).default([]),
  dm: SlackDMSchema.default({})
});
 

export const WebChatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().default(3000),
  host: z.string().default("0.0.0.0"),
  allowFrom: z.array(z.string()).default([]),
  policy: z.enum(["none", "restricted"]).default("restricted"),
  uiToken: z.string().optional(),
});

export const WebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().default(3001),
  host: z.string().default("0.0.0.0"),
  path: z.string().default("/webhook"),
  jwtSecret: z.string().default(""),
  allowFrom: z.array(z.string()).default([]),
});

const ImapIdleChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mailbox: z.string().default("INBOX"),
  chatId: z.string().default("imap"),
  senderId: z.string().default("imap"),
  allowFrom: z.array(z.string()).default([]),
  /** "none" = allow all senders (internal trigger); "restricted" = use allowFrom list. */
  policy: z.enum(["none", "restricted"]).default("none"),
  replyTo: z.object({
    channel: z.string(),
    chatId: z.string(),
  }).optional(),
  quietHours: z.object({
    enabled: z.boolean().default(false),
    start: z.string().default("22:00"),
    end: z.string().default("07:00"),
    timezone: z.string().default("UTC"),
  }).default({}),
});

export const ChannelsConfigSchema = z.object({
  whatsapp: WhatsAppConfigSchema.default({}),
  telegram: TelegramConfigSchema.default({}),
  slack: SlackConfigSchema.default({}),
  webchat: WebChatConfigSchema.default({}),
  webhook: WebhookConfigSchema.default({}),
  imapIdle: ImapIdleChannelConfigSchema.default({})
});

export const AgentDefaultsSchema = z.object({
  workspace: z.string().default(DEFAULT_WORKSPACE_PATH),
  provider: z.string().default(""),
  maxTokens: z.number().int().default(8192),
  temperature: z.number().default(0.7),
  maxToolIterations: z.number().int().default(20)
});

export const ContextBootstrapSchema = z.object({
  files: z
    .array(z.string())
    .default([
      "AGENTS.md",
      "SOUL.md",
      "USER.md",
      "IDENTITY.md",
      "TOOLS.md",
      "BOOT.md",
      "BOOTSTRAP.md",
      "HEARTBEAT.md"
    ]),
  minimalFiles: z.array(z.string()).default(["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"]),
  heartbeatFiles: z.array(z.string()).default(["HEARTBEAT.md"]),
  perFileChars: z.number().int().default(4000),
  totalChars: z.number().int().default(12000)
});

export const ContextMemorySchema = z.object({
  enabled: z.boolean().default(true),
  maxChars: z.number().int().default(8000)
});

export const ContextConfigSchema = z.object({
  bootstrap: ContextBootstrapSchema.default({}),
  memory: ContextMemorySchema.default({})
});

export const CompactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  thresholdTokens: z.number().int().default(6000),
  keepRecentMessages: z.number().int().default(10)
});

export const MemoryExtractionConfigSchema = z.object({
  /** Global staleness threshold in hours. Sessions inactive longer than this are eligible for extraction. */
  staleHours: z.number().default(4),
  /** Minimum number of non-tool messages required before running extraction on a session. */
  minMessages: z.number().int().default(3),
  /** Per-channel staleness overrides. Key is the channel name (e.g. "slack", "telegram"). */
  channelOverrides: z.record(z.number()).default({})
});

export const AssistantPersonalitySchema = z.object({
  evolutionEnabled: z.boolean().default(true),
  evolutionRate: z.number().default(0.5),
  maxDeltaPerCompaction: z.number().default(0.05)
});

export const MemoryPruningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Prune non-pinned entries older than this many days. 0 = disabled. */
  maxAgeDays: z.number().int().default(90),
  /** Prune entries with confidence below this threshold (0–1). 0 = disabled. */
  minConfidence: z.number().default(0.3),
  /** If active non-derived entry count exceeds this, remove oldest/lowest-confidence entries first. 0 = disabled. */
  maxEntries: z.number().int().default(1000),
  /** Cap for derived (reflected/synthesised) entries independently of maxEntries. 0 = disabled. */
  maxDerivedEntries: z.number().int().default(500),
  /** Never prune entries newer than this many days regardless of other rules. */
  graceDays: z.number().int().default(7),
});

export const AgentsConfigSchema = z.object({
  defaults: AgentDefaultsSchema.default({}),
  context: ContextConfigSchema.default({}),
  compaction: CompactionConfigSchema.default({}),
  memoryExtraction: MemoryExtractionConfigSchema.default({}),
  memoryPruning: MemoryPruningConfigSchema.default({}),
  personality:AssistantPersonalitySchema.default({})
});

export const ProviderConfigSchema = z.object({
  apiKey: z.string().default(""),
  apiBase: z.string().nullable().default(null),
  model: z.string().default(""),
  utilityModel: z.string().nullable().default(null),
  extraHeaders: z.record(z.string()).nullable().default(null),
  wireApi: z.enum(["auto", "chat", "responses"]).default("auto"),
  promptCaching: z.boolean().default(false),
  /** Reasoning effort for o-series models. "low" is fastest, "high" is most thorough. */
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().default(null),
  /**
   * When true, reasoning effort escalates automatically during a single turn:
   * starts at reasoningEffort (or "low") and steps up to "high" as iterations
   * accumulate. Allows fast responses for simple tasks and deep thinking for
   * hard ones without manual switching.
   */
  adaptiveReasoning: z.boolean().default(false)
});

export const ProvidersConfigSchema = z.object({
  anthropic: ProviderConfigSchema.default({apiBase:"https://api.openai.com/v1"}),
  openai: ProviderConfigSchema.default({apiBase:"https://api.openai.com/v1"}),
  gemini: ProviderConfigSchema.default({apiBase:"https://generativelanguage.googleapis.com/v1beta/openai"}),
  openrouter: ProviderConfigSchema.default({apiBase:"https://openrouter.ai/api/v1"}),
});

export const PluginEntrySchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional()
});

export const PluginsLoadSchema = z.object({
  paths: z.array(z.string()).optional()
});

export const PluginInstallRecordSchema = z.object({
  source: z.enum(["npm", "archive", "path"]),
  spec: z.string().optional(),
  sourcePath: z.string().optional(),
  installPath: z.string().optional(),
  version: z.string().optional(),
  installedAt: z.string().optional()
});

export const PluginsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  load: PluginsLoadSchema.optional(),
  entries: z.record(PluginEntrySchema).optional(),
  installs: z.record(PluginInstallRecordSchema).optional()
});
 
export const WebSearchConfigSchema = z.object({
  apiKey: z.string().default(""),
  strUrl: z.string().default(""),
  maxResults: z.number().int().default(5)
});

export const HttpToolConfigSchema = z.object({
  /** When non-empty, only requests to these hostnames (or their subdomains) are allowed. */
  allowedHosts: z.array(z.string()).default([]),
  /** Maximum response body size in bytes before truncation. Default: 100 KB. */
  maxResponseBytes: z.number().int().default(100_000),
});

export const WebToolsConfigSchema = z.object({
  search: WebSearchConfigSchema.default({}),
  crawl : z.string().default(""),
  http: HttpToolConfigSchema.default({}),
});

export const ExecToolConfigSchema = z.object({
  timeout: z.number().int().default(60),
  /** Wrap exec'd commands in a PID namespace (Linux only). Blocks /proc traversal
   *  without requiring a separate OS user. Needs unprivileged user namespaces enabled
   *  (kernel.unprivileged_userns_clone=1, default on most modern distros). */
  usePidNamespace: z.boolean().default(false),
  /** Run exec'd commands as this OS user via sudo. Fallback when usePidNamespace is
   *  unavailable (hardened kernels). Requires passwordless sudo config — see README. */
  runAs: z.string().nullable().default(null)
});

export const ImapToolConfigSchema = z.object({
  host: z.string().default(""),
  port: z.number().int().default(993),
  user: z.string().default(""),
  password: z.string().default(""),
  tls: z.boolean().default(true),
  trashPath: z.string().default("Trash"),
});

export const ToolSecurityOverrideSchema = z.object({
  maxRisk:    z.enum(["none", "low", "high"]).optional(),
  outputRisk: z.enum(["none", "low", "high"]).optional(),
});

export const DocStorePathSchema = z.object({
  name: z.string(),
  path: z.string()
});

export const DocStoreConfigSchema = z.object({
  enabled:        z.boolean().default(false),
  paths:          z.array(DocStorePathSchema).default([]),
  embeddingModel: z.string().default("text-embedding-3-small"),
  /** Dimensions of the embedding vectors — must match the model output (1536 for text-embedding-3-small/ada-002, 3072 for text-embedding-3-large). */
  embeddingDims:  z.number().int().default(1536),
  chunkSize:      z.number().int().default(800),
  chunkOverlap:   z.number().int().default(100),
  maxResults:     z.number().int().default(5),
  /** Override API base URL for embeddings — use when the chat provider doesn't support embeddings. */
  embeddingApiBase: z.string().optional(),
  /** Override API key for embeddings — use when the embedding provider differs from the chat provider. */
  embeddingApiKey:  z.string().optional(),
});

export const CalDavConfigSchema = z.object({
  enabled: z.boolean().default(false),
  serverUrl: z.string().default(""),
  username: z.string().default(""),
  password: z.string().default(""),
  /** Default calendar name (partial match) for create operations. */
  defaultCalendar: z.string().default(""),
});

export const BrowserToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  headless: z.boolean().default(true),
  timeout: z.number().int().default(30000),
  /** When non-empty, only URLs matching these hostnames (or their subdomains) are allowed. */
  allowedDomains: z.array(z.string()).default([]),
});

export const ToolsConfigSchema = z.object({
  web: WebToolsConfigSchema.default({}),
  exec: ExecToolConfigSchema.default({}),
  imap: ImapToolConfigSchema.default({}),
  docs: DocStoreConfigSchema.default({}),
  browser: BrowserToolConfigSchema.default({}),
  caldav: CalDavConfigSchema.default({}),
  restrictFilesToWorkspace: z.boolean().default(false),
  restrictExecToWorkspace: z.boolean().default(false),
  /** Per-tool security overrides. Keys are tool names (e.g. "exec", "imap_read"). */
  security: z.record(z.string(), ToolSecurityOverrideSchema).default({}),
  /**
   * Per-skill security overrides. Keys are skill names (e.g. "weathercheck").
   * Skills run through exec and inherit exec's defaults (maxRisk: none, trusted-only).
   * Only relax skills that are strictly read-only with no physical or data side-effects
   * (e.g. weather queries, calendar reads, status lookups).
   * NEVER relax skills that control physical devices, send messages, or modify data —
   * a prompt injection via email could otherwise trigger real-world actions.
   */
  skillSecurity: z.record(z.string(), ToolSecurityOverrideSchema).default({}),
});

export const AppConfigSchema = z.object({
  clientPath:z.string().default(""),
})

export const McpServerSchema = z.object({
  transport: z.enum(["stdio", "sse", "http"]).default("stdio"),
  // stdio transport
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  // sse / http transport
  url: z.string().default(""),
  headers: z.record(z.string()).default({}),
  /** When true, tools from this server bypass relevance filtering and are always sent to the LLM. */
  alwaysInclude: z.boolean().default(false),
});

export const McpConfigSchema = z.object({
  servers: z.record(McpServerSchema).default({}),
});

export const ConfigSchema = z.object({
  general:AppConfigSchema.default({}),
  agents: AgentsConfigSchema.default({}),
  channels: ChannelsConfigSchema.default({}),
  providers: ProvidersConfigSchema.default({}),
  plugins: PluginsConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  mcp: McpConfigSchema.default({}),
});

export type ConfigSchemaJson = Record<string, unknown>;

export type ConfigSchemaResponse = {
  schema: ConfigSchemaJson;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export type PluginUiMetadata = {
  id: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<
    string,
    {
      label?: string;
      help?: string;
      advanced?: boolean;
      sensitive?: boolean;
      placeholder?: string;
    }
  >;
};


type JsonSchemaNode = Record<string, unknown>;

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
};

function cloneSchema<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}



function resolveSchemaRoot(schema: ConfigSchemaJson): JsonSchemaObject | null {
  const root = asSchemaObject(schema);
  if (!root) {
    return null;
  }
  if (root.properties) {
    return root;
  }
  const ref = (root as Record<string, unknown>).$ref;
  if (typeof ref === "string" && ref.startsWith("#/definitions/")) {
    const definitionName = ref.slice("#/definitions/".length);
    const definitions = (root as Record<string, unknown>).definitions as Record<string, unknown> | undefined;
    if (definitions && definitionName in definitions) {
      return asSchemaObject(definitions[definitionName]);
    }
  }
  return root;
}
function isObjectSchema(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  if (type === "object") {
    return true;
  }
  if (Array.isArray(type) && type.includes("object")) {
    return true;
  }
  return Boolean(schema.properties || schema.additionalProperties);
}

function mergeObjectSchema(base: JsonSchemaObject, extension: JsonSchemaObject): JsonSchemaObject {
  const mergedRequired = new Set<string>([...(base.required ?? []), ...(extension.required ?? [])]);
  const merged: JsonSchemaObject = {
    ...base,
    ...extension,
    properties: {
      ...base.properties,
      ...extension.properties
    }
  };
  if (mergedRequired.size > 0) {
    merged.required = Array.from(mergedRequired);
  }
  const additional = extension.additionalProperties ?? base.additionalProperties;
  if (additional !== undefined) {
    merged.additionalProperties = additional;
  }
  return merged;
}

function applyPluginHints(hints: ConfigUiHints, plugins: PluginUiMetadata[]): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  for (const plugin of plugins) {
    const id = plugin.id.trim();
    if (!id) {
      continue;
    }
    const name = id;
    const basePath = `plugins.entries.${id}`;

    next[basePath] = {
      ...next[basePath],
      label: name,
      help: `Plugin entry for ${id}.`
    };
    next[`${basePath}.enabled`] = {
      ...next[`${basePath}.enabled`],
      label: `Enable ${name}`
    };
    next[`${basePath}.config`] = {
      ...next[`${basePath}.config`],
      label: `${name} Config`,
      help: `Plugin-defined config payload for ${id}.`
    };

    const uiHints = plugin.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) {
        continue;
      }
      const key = `${basePath}.config.${relPath}`;
      next[key] = {
        ...next[key],
        ...hint
      };
    }
  }
  return next;
}

function applyPluginSchemas(schema: ConfigSchemaJson, plugins: PluginUiMetadata[]): ConfigSchemaJson {
  const next = cloneSchema(schema);
  const root = resolveSchemaRoot(next);
  const pluginsNode = asSchemaObject(root?.properties?.plugins);
  const entriesNode = asSchemaObject(pluginsNode?.properties?.entries);
  if (!entriesNode) {
    return next;
  }

  const entryBase = asSchemaObject(entriesNode.additionalProperties);
  const entryProps = entriesNode.properties ?? {};
  entriesNode.properties = entryProps;

  for (const plugin of plugins) {
    if (!plugin.configSchema) {
      continue;
    }

    const entrySchema = entryBase ? cloneSchema(entryBase) : ({ type: "object" } as JsonSchemaObject);
    const entryObject = asSchemaObject(entrySchema) ?? ({ type: "object" } as JsonSchemaObject);
    const baseConfig = asSchemaObject(entryObject.properties?.config);
    const pluginConfig = asSchemaObject(plugin.configSchema);
    const nextConfig =
      baseConfig && pluginConfig && isObjectSchema(baseConfig) && isObjectSchema(pluginConfig)
        ? mergeObjectSchema(baseConfig, pluginConfig)
        : cloneSchema(plugin.configSchema);

    entryObject.properties = {
      ...entryObject.properties,
      config: nextConfig
    };

    entryProps[plugin.id] = entryObject;
  }

  return next;
}
export function getWorkspacePathFromConfig(config: Config): string {
  return expandHome(config.agents.defaults.workspace);
}

export function matchProvider(config: Config, model?: string): { provider: ProviderConfig | null; name: string | null } {
  // Explicit provider preference takes priority (when no model override is given).
  const preferred = config.agents.defaults.provider;

  if (preferred && !model) {
    const p = (config.providers as Record<string, ProviderConfig>)[preferred];
    if (p?.apiKey) return { provider: p, name: preferred };
  }
  // Model keyword matching — used by external callers that pass a specific model string.
  const modelLower = (model ?? "").toLowerCase();
  if (modelLower) {
    for (const name of Object.keys(config.providers)) {
      const provider = (config.providers as Record<string, ProviderConfig>)[name];
      if (provider?.apiKey) {
        return { provider, name: name };
      }
    }
  }
  // Fall back to first configured provider.
   for (const name of Object.keys(config.providers)) {
    const provider = (config.providers as Record<string, ProviderConfig>)[name];
    if (provider?.apiKey) return { provider, name: name };
  }
  return { provider: null, name: null };
}

export function getProvider(config: Config, model?: string): ProviderConfig | null {
  return matchProvider(config, model).provider;
}

export function getProviderName(config: Config, model?: string): string | null {
  return matchProvider(config, model).name;
}

export function getApiKey(config: Config, model?: string): string | null {
  const provider = getProvider(config, model);
  return provider?.apiKey ?? null;
}

 

export function getApiBase(config: Config, model?: string): string | null {
  const { provider, name } = matchProvider(config, model);
  if (provider?.apiBase) {
    return provider.apiBase;
  }
  if (name) {
    const providers:any = config.providers;
    const spec = providers[name];
    if (spec?.apiBase) {
      return spec.apiBase;
    }
  }
  return null;
}

export function buildConfigSchema(options?: { version?: string; plugins?: PluginUiMetadata[] }): ConfigSchemaResponse {
  const baseSchema = zodToJsonSchema(ConfigSchema, {
    name: "VeroxConfig",
    target: "jsonSchema7"
  }) as ConfigSchemaJson;
  if (baseSchema && typeof baseSchema === "object") {
    baseSchema.title = "VeroxConfig";
  }

  const plugins = options?.plugins ?? [];
  const baseHints = mapSensitivePaths(ConfigSchema, "", buildBaseHints());
  const mergedHints = applySensitiveHints(applyPluginHints(baseHints, plugins));
  const mergedSchema = applyPluginSchemas(baseSchema, plugins);

  return {
    schema: mergedSchema,
    uiHints: mergedHints,
    version: options?.version ?? getPackageVersion(),
    generatedAt: new Date().toISOString()
  };
}