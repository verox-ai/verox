import { Logger } from "src/utils/logger.js";
import type { Browser, Page } from "playwright";

export interface BrowserConfig {
  headless?: boolean;
  timeout?: number;
  /** When non-empty, only URLs whose hostname matches one of these entries (or a subdomain) are allowed. */
  allowedDomains?: string[];
}

/**
 * Manages a single shared Playwright Chromium instance.
 *
 * The browser is lazily launched on first use and kept alive between tool
 * calls so navigation state (cookies, local storage) persists within a session.
 * Call `close()` on agent shutdown.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private logger = new Logger(BrowserManager.name);
  private config: BrowserConfig;

  constructor(config: BrowserConfig = {}) {
    this.config = config;
  }

  /**
   * Returns the active page, launching the browser if it hasn't started yet.
   * Creates a new page if the previous one was closed.
   */
  async getPage(): Promise<Page> {
    if (!this.browser) {
      // Dynamic import so Playwright isn't resolved at build-time if not installed.
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: this.config.headless ?? true });
      this.logger.info("Chromium browser launched");
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage();
      this.page.setDefaultTimeout(this.config.timeout ?? 30_000);
      this.logger.debug("New browser page created");
    }
    return this.page;
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

  /** Updates config settings. Timeout changes apply to the next new page. */
  updateConfig(config: BrowserConfig): void {
    this.config = config;
    if (this.page && !this.page.isClosed()) {
      this.page.setDefaultTimeout(config.timeout ?? 30_000);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.logger.info("Chromium browser closed");
    }
  }
}
