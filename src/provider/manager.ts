import { injectable, inject } from "tsyringe";
import { AIProvider } from "./provider.js";
import { OpenAICompatibleProvider } from "./openaicompatible.js";
import { ConfigService } from "src/config/service.js";
import { matchProvider, ProvidersConfigSchema, type Config } from "src/types/schemas/schema.js";
import { Logger } from "src/utils/logger.js";

export type ProviderInfo = {
  name: string;
  displayName: string;
  active: boolean;
};

@injectable()
export class ProviderManager {
  private providers = new Map<string, AIProvider>();
  private activeName: string;
  private logger = new Logger(ProviderManager.name);

  constructor(@inject(ConfigService) configService: ConfigService) {
    this.reload(configService.app);
    configService.onConfigChange(cfg => this.reload(cfg));
  }

  private reload(cfg: Config): void {
    const schemaDefaults = ProvidersConfigSchema.parse({});
    const next = new Map<string, AIProvider>();

    for (const name of Object.keys(cfg.providers)) {
      const provCfg = (cfg.providers as Record<string, typeof cfg.providers.openai>)[name];
      if (!provCfg?.apiKey) continue;
      const defaultApiBase = schemaDefaults[name as keyof typeof schemaDefaults]?.apiBase;
      next.set(name, new OpenAICompatibleProvider({
        apiKey: provCfg.apiKey,
        apiBase: provCfg.apiBase ?? defaultApiBase,
        defaultModel: provCfg.model || "",
        utilityModel: provCfg.utilityModel ?? null,
        extraHeaders: provCfg.extraHeaders ?? undefined,
        wireApi: provCfg.wireApi,
        promptCaching: provCfg.promptCaching,
        reasoningEffort: provCfg.reasoningEffort ?? null,
      }));
    }

    this.providers = next;
    const { name } = matchProvider(cfg);
    const first = next.keys().next().value as string | undefined;
    this.activeName = (name && next.has(name) ? name : first) ?? "";
    this.logger.info("Providers reloaded", { available: [...next.keys()], active: this.activeName });
  }

  /** Returns true if at least one provider is configured with an API key. */
  hasActiveProvider(): boolean {
    return this.activeName !== "" && this.providers.has(this.activeName);
  }

  /** Returns the currently active provider. */
  get(name?:string): AIProvider {
    this.logger.debug(`get Provider ${name ?? this.activeName}`);
    const provider = this.providers.get(name ?? this.activeName);
    if (!provider) throw new Error(`No active provider (${name ?? this.activeName})`);
    return provider;
  }

  /** Returns the name of the currently active provider. */
  getActiveName(): string {
    return this.activeName;
  }

  /**
   * Returns the utility model for the active provider (used for compaction and memory extraction).
   * Falls back to the provider's default model if no utility model is configured.
   */
  getUtilityModel(): string {
    const provider = this.providers.get(this.activeName);
    if (!provider) throw new Error(`No active provider (${this.activeName})`);
    return provider.getUtilityModel() ?? provider.getDefaultModel();
  }

  /**
   * Calls the active provider's /embeddings endpoint.
   * Used by DocStore for local document RAG.
   */
  async embed(texts: string[], model: string): Promise<number[][]> {
    const provider = this.providers.get(this.activeName);
    if (!provider) throw new Error(`No active provider (${this.activeName})`);
    return (provider as OpenAICompatibleProvider).embed(texts, model);
  }

  /**
   * Switches the active provider.
   * Optionally updates the default model for that provider.
   * Returns `true` on success, `false` if the provider is not configured.
   */
  switch(name: string, model?: string): boolean {
    if (!this.providers.has(name)) return false;
    this.activeName = name;
    if (model) {
      (this.providers.get(name) as OpenAICompatibleProvider).setDefaultModel(model);
    }
    this.logger.info("Switched provider", { name, model });
    return true;
  }

  /** Lists all configured providers with their active state. */
  list(): ProviderInfo[] {
    return [...this.providers.entries()].map(([name, provider]) => {
      return {
        name,
        displayName: name,
        active: name === this.activeName,
        model: provider.getDefaultModel()
      };
    }) as unknown as ProviderInfo[];
  }
}
