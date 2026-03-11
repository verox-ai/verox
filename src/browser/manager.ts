import { Logger } from "src/utils/logger.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";

export interface BrowserConfig {
  headless?: boolean;
  timeout?: number;
  /** When non-empty, only URLs whose hostname matches one of these entries (or a subdomain) are allowed. */
  allowedDomains?: string[];
}

/**
 * Manages a single shared Playwright Chromium instance.
 *
 * Uses a BrowserContext so cookies, localStorage, and session storage persist
 * across all page navigations within the same agent turn. Named sessions can be
 * saved to / loaded from disk (saveSession / loadSession) to persist login state
 * across agent restarts.
 *
 * Call `close()` on agent shutdown.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private logger = new Logger(BrowserManager.name);
  private config: BrowserConfig;

  constructor(config: BrowserConfig = {}) {
    this.config = config;
  }

  /**
   * Returns the active page, launching the browser + context if needed.
   * Creates a new page if the previous one was closed.
   */
  async getPage(): Promise<Page> {
    if (!this.browser) {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: this.config.headless ?? true });
      this.logger.info("Chromium browser launched");
    }
    if (!this.context) {
      this.context = await this.browser.newContext();
      this.context.setDefaultTimeout(this.config.timeout ?? 30_000);
      this.logger.debug("New browser context created");
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      this.logger.debug("New browser page created");
    }
    return this.page;
  }

  /**
   * Saves the current browser context state (cookies, localStorage, sessionStorage)
   * to a named JSON file in `{workspace}/browser-sessions/`.
   */
  async saveSession(name: string, workspace: string): Promise<string> {
    if (!this.context) throw new Error("No active browser context to save.");
    const dir = join(workspace, "browser-sessions");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${sanitizeName(name)}.json`);
    const state = await this.context.storageState();
    writeFileSync(filePath, JSON.stringify(state, null, 2));
    return filePath;
  }

  /**
   * Loads a previously saved session by name, replacing the current context.
   * The current page is closed and a new one opened in the restored context.
   */
  async loadSession(name: string, workspace: string): Promise<void> {
    const filePath = join(workspace, "browser-sessions", `${sanitizeName(name)}.json`);
    if (!existsSync(filePath)) throw new Error(`Session file not found: ${filePath}`);
    const state = JSON.parse(readFileSync(filePath, "utf-8"));

    if (!this.browser) {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: this.config.headless ?? true });
      this.logger.info("Chromium browser launched");
    }
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});

    this.context = await this.browser.newContext({ storageState: state });
    this.context.setDefaultTimeout(this.config.timeout ?? 30_000);
    this.page = null;
    this.logger.info(`Browser session loaded: ${name}`);
  }

  /** Deletes a named session file. Returns false if not found. */
  clearSession(name: string, workspace: string): boolean {
    const filePath = join(workspace, "browser-sessions", `${sanitizeName(name)}.json`);
    if (!existsSync(filePath)) return false;
    rmSync(filePath);
    return true;
  }

  /** Lists all saved session names in the workspace. */
  listSessions(workspace: string): string[] {
    const dir = join(workspace, "browser-sessions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => f.slice(0, -5));
  }

  /**
   * Checks whether a URL is permitted by the allowedDomains list.
   * When the list is empty all URLs are allowed.
   */
  isUrlAllowed(url: string): boolean {
    const allowed = this.config.allowedDomains ?? [];
    if (allowed.length === 0) return true;
    try {
      const { hostname } = new URL(url);
      return allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    } catch {
      return false;
    }
  }

  /** Updates config settings. Timeout changes apply to the current context if active. */
  updateConfig(config: BrowserConfig): void {
    this.config = config;
    if (this.context) {
      this.context.setDefaultTimeout(config.timeout ?? 30_000);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info("Chromium browser closed");
    }
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}
