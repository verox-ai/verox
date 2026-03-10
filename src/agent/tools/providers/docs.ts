import { join } from "node:path";
import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { DocGetTool, DocsIndexTool, DocsListTool, DocsSearchTool, DocsUploadTool } from "../docs.js";
import { DocStore, buildEmbedFn } from "src/docs/store.js";

/** Document-store tools. Enabled when tools.docs.enabled = true. */
export class DocsProvider implements ToolProvider {
  readonly id = "docs";

  /** Exposed so the REST API (agent.docStore) can access the store. */
  docStore?: DocStore;

  isEnabled(config: Config): boolean {
    return config.tools?.docs?.enabled === true;
  }

  createTools(config: Config, services: AgentServices): Tool[] {
    const docsCfg = config.tools!.docs!;
    const embedFn = buildEmbedFn(
      docsCfg,
      (texts, model) => services.providerManager.embed(texts, model)
    );
    this.docStore = new DocStore(services.workspace, embedFn, docsCfg);
    const uploadPath = docsCfg.uploadPath ?? join(services.workspace, "uploads");
    return [
      new DocsIndexTool(this.docStore),
      new DocsSearchTool(this.docStore),
      new DocsListTool(this.docStore),
      new DocGetTool(this.docStore),
      new DocsUploadTool(this.docStore, uploadPath, services.workspace),
    ];
  }

  onConfigChange(_config: Config): void {
    // DocStore is initialised once; config changes don't require reconnection.
  }
}
