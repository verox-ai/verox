import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { getConfigPath, getDataPath, getWorkspacePath } from "../utils/paths.js";
import { DocStore, buildEmbedFn } from "src/docs/store.js";
import { OpenAICompatibleProvider } from "src/provider/openaicompatible.js";
import { ConfigSchema, ProvidersConfigSchema } from "src/types/schemas/schema.js";
import { VaultService } from "src/vault/credentials.js";

/** Applies a dot-separated path override onto a nested object (same as ConfigService). */
function deepSet(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (typeof current[key] !== "object" || current[key] === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

function loadDocStore(): DocStore {
  // Load raw config
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
  } catch {
    console.error("Error: could not read config. Run 'verox config set' first.");
    process.exit(1);
  }

  // Apply vault config.* overrides — same logic as ConfigService.parseAppConfig()
  const vault = new VaultService(getDataPath());
  const overrides = vault.getConfigOverrides();
  for (const [dotPath, value] of Object.entries(overrides)) {
    deepSet(raw, dotPath, value);
  }

  const cfg = ConfigSchema.parse(raw);

  if (!cfg.tools.docs.enabled) {
    console.error("Error: docs tool is not enabled. Set tools.docs.enabled = true in config.");
    process.exit(1);
  }

  // Find the active provider (first one with an API key)
  const providersCfg = cfg.providers as Record<string, { apiKey?: string; apiBase?: string; model?: string }>;
  const schemaDefaults = ProvidersConfigSchema.parse({}) as Record<string, { apiBase?: string }>;

  const [providerName, providerCfg] = Object.entries(providersCfg).find(([, p]) => !!p.apiKey) ?? [];
  if (!providerName || !providerCfg?.apiKey) {
    console.error("Error: no provider with an API key found. Configure a provider first.");
    process.exit(1);
  }

  const defaultApiBase = schemaDefaults[providerName]?.apiBase;
  const provider = new OpenAICompatibleProvider({
    apiKey: providerCfg.apiKey,
    apiBase: providerCfg.apiBase ?? defaultApiBase,
    defaultModel: providerCfg.model ?? "",
    utilityModel: null,
    promptCaching: false,
    reasoningEffort: null,
    wireApi: "auto",
  });

  const embedFn = buildEmbedFn(
    cfg.tools.docs,
    (texts, model) => provider.embed(texts, model)
  );

  return new DocStore(
    getWorkspacePath(),
    embedFn,
    cfg.tools.docs
  );
}

export function registerDocs(program: Command): void {
  const cmd = program.command("docs").description("Manage local document index for RAG search");

  cmd
    .command("index [path]")
    .description("Index documents from configured paths (or a specific file/directory)")
    .option("-f, --force", "Re-index files even if unchanged")
    .action(async (path: string | undefined, opts: { force?: boolean }) => {
      const store = loadDocStore();
      const force = opts.force ?? false;

      if (path) {
        console.log(`Indexing: ${path}${force ? " (force)" : ""}`);
        const result = await store.indexFile(path, force);
        if (result.status === "indexed")  console.log(`✓ Indexed ${result.path} — ${result.chunks} chunks`);
        else if (result.status === "skipped") console.log(`— Skipped ${result.path} (unchanged)`);
        else { console.error(`✗ Error: ${result.error}`); process.exit(1); }
      } else {
        console.log(`Indexing all configured paths${force ? " (force)" : ""}...`);
        const { indexed, skipped, errors } = await store.indexAll(force);
        console.log(`✓ Indexed: ${indexed}  Skipped: ${skipped}  Errors: ${errors.length}`);
        for (const e of errors) console.error(`  ✗ ${e}`);
        if (errors.length) process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("List all indexed documents")
    .action(() => {
      const store = loadDocStore();
      const files = store.listFiles();
      if (!files.length) { console.log("No documents indexed yet. Run 'verox docs index'."); return; }
      console.log(`${"Path".padEnd(60)} ${"Chunks".padEnd(8)} Indexed At`);
      console.log("-".repeat(90));
      for (const f of files) {
        const path = f.path.length > 58 ? "…" + f.path.slice(-57) : f.path.padEnd(60);
        console.log(`${path} ${String(f.chunks).padEnd(8)} ${f.indexedAt.slice(0, 19)}`);
      }
    });
}
