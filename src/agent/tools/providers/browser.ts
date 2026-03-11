import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { BrowserManager } from "src/browser/manager.js";
import {
  BrowserClickTool,
  BrowserCloseTool,
  BrowserEvaluateTool,
  BrowserGetContentTool,
  BrowserNavigateTool,
  BrowserScreenshotTool,
  BrowserSelectTool,
  BrowserSessionClearTool,
  BrowserSessionLoadTool,
  BrowserSessionSaveTool,
  BrowserTypeTool,
  BrowserWaitTool,
} from "../browser.js";

/** Playwright browser automation tools. Stateful — updates the manager in-place on config change. */
export class BrowserProvider implements ToolProvider {
  readonly id = "browser";
  private manager?: BrowserManager;

  isEnabled(config: Config): boolean {
    return config.tools?.browser?.enabled === true;
  }

  createTools(config: Config, services: AgentServices): Tool[] {
    const cfg = config.tools!.browser!;
    this.manager = new BrowserManager({
      headless: cfg.headless,
      timeout: cfg.timeout,
      allowedDomains: cfg.allowedDomains,
    });
    return [
      new BrowserNavigateTool(this.manager),
      new BrowserScreenshotTool(this.manager, services.workspace),
      new BrowserGetContentTool(this.manager),
      new BrowserClickTool(this.manager),
      new BrowserTypeTool(this.manager),
      new BrowserSelectTool(this.manager),
      new BrowserWaitTool(this.manager),
      new BrowserEvaluateTool(this.manager),
      new BrowserCloseTool(this.manager),
      new BrowserSessionSaveTool(this.manager, services.workspace),
      new BrowserSessionLoadTool(this.manager, services.workspace),
      new BrowserSessionClearTool(this.manager, services.workspace),
    ];
  }

  onConfigChange(config: Config): void {
    if (!this.manager) return;
    const cfg = config.tools!.browser!;
    this.manager.updateConfig({
      headless: cfg.headless,
      timeout: cfg.timeout,
      allowedDomains: cfg.allowedDomains,
    });
  }
}
