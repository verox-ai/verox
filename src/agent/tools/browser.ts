import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Tool, type ToolContentPart } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import type { BrowserManager } from "src/browser/manager.js";

// ─── helpers ───────────────────────────────────────────────────────────────

function screenshotsDir(workspace: string): string {
  const dir = join(workspace, "screenshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── browser_navigate ──────────────────────────────────────────────────────

/**
 * Navigates to a URL and returns the page title, final URL, and a short
 * text snapshot of the visible body content.
 *
 * outputRisk = High  — the page content is external/attacker-controlled.
 * maxRisk    = High  — allowed in any context so multi-step browser automation
 *                      (fill form → navigate → check email → confirm) runs
 *                      without security holds. The real protection is that
 *                      exec/spawn stay at maxRisk=None, so no shell commands
 *                      can be triggered from a tainted browser session.
 */
export class BrowserNavigateTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_navigate"; }
  get description() { return "Open a URL in the browser and return the page title and visible text content."; }
  get outputRisk() { return RiskLevel.High; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to (must include http:// or https://)" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "When to consider navigation done. Default: domcontentloaded" }
      },
      required: ["url"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const url = String(params["url"] ?? "");
    if (!this.browser.isUrlAllowed(url)) {
      return `Error: URL not in allowedDomains list: ${url}`;
    }
    const waitUntil = (params["waitUntil"] as "load" | "domcontentloaded" | "networkidle") ?? "domcontentloaded";
    const page = await this.browser.getPage();
    await page.goto(url, { waitUntil });
    const title = await page.title();
    const finalUrl = page.url();
    // Grab visible text (trim to 4000 chars so it fits in context)
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const snippet = bodyText.slice(0, 4000);
    return `URL: ${finalUrl}\nTitle: ${title}\n\n--- Page content (truncated) ---\n${snippet}`;
  }
}

// ─── browser_screenshot ────────────────────────────────────────────────────

export class BrowserScreenshotTool extends Tool {
  constructor(private browser: BrowserManager, private workspace: string) { super(); }

  get name() { return "browser_screenshot"; }
  get description() { return "Take a screenshot of the current browser page. The image is returned inline so you can see the page state. Also saved to screenshots/ folder."; }
  get outputRisk() { return RiskLevel.High; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        filename: { type: "string", description: "Optional filename (without extension). Defaults to a timestamp." },
        fullPage: { type: "boolean", description: "Capture the full scrollable page. Default: false." }
      },
      required: []
    };
  }

  async execute(params: Record<string, unknown>): Promise<ToolContentPart[]> {
    const page = await this.browser.getPage();
    const dir = screenshotsDir(this.workspace);
    const name = String(params["filename"] ?? `screenshot-${Date.now()}`).replace(/[^a-z0-9_-]/gi, "_");
    const path = join(dir, `${name}.png`);
    await page.screenshot({ path, fullPage: Boolean(params["fullPage"] ?? false) });
    const b64 = readFileSync(path).toString("base64");
    return [
      { type: "text", text: `Screenshot saved to: ${path}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
    ];
  }
}

// ─── browser_get_content ──────────────────────────────────────────────────

export class BrowserGetContentTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_get_content"; }
  get description() { return "Get the text content of the current page or a specific element (CSS selector)."; }
  get outputRisk() { return RiskLevel.High; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to read. Omit for the full page body." },
        maxChars: { type: "integer", description: "Maximum characters to return. Default: 8000." }
      },
      required: []
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const page = await this.browser.getPage();
    const selector = params["selector"] ? String(params["selector"]) : null;
    const maxChars = Number(params["maxChars"] ?? 8000);
    let text: string;
    if (selector) {
      const el = page.locator(selector).first();
      text = await el.innerText().catch(() => "Element not found or has no text");
    } else {
      text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    }
    return text.slice(0, maxChars);
  }
}

// ─── browser_click ────────────────────────────────────────────────────────

export class BrowserClickTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_click"; }
  get description() { return "Click an element identified by a CSS selector or visible text."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click." },
        text: { type: "string", description: "Visible text of the element to click (used when selector is not provided)." }
      },
      required: []
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const page = await this.browser.getPage();
    if (params["selector"]) {
      await page.locator(String(params["selector"])).first().click();
      return `Clicked element: ${params["selector"]}`;
    } else if (params["text"]) {
      await page.getByText(String(params["text"]), { exact: false }).first().click();
      return `Clicked element with text: ${params["text"]}`;
    }
    return "Error: provide either selector or text";
  }
}

// ─── browser_type ─────────────────────────────────────────────────────────

export class BrowserTypeTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_type"; }
  get description() { return "Type text into an input field identified by a CSS selector."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the input element." },
        text: { type: "string", description: "Text to type." },
        clear: { type: "boolean", description: "Clear the field before typing. Default: true." },
        pressEnter: { type: "boolean", description: "Press Enter after typing. Default: false." }
      },
      required: ["selector", "text"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const page = await this.browser.getPage();
    const selector = String(params["selector"]);
    const text = String(params["text"]);
    const clear = params["clear"] !== false;
    const locator = page.locator(selector).first();
    if (clear) await locator.clear();
    await locator.fill(text);
    if (params["pressEnter"]) await locator.press("Enter");
    return `Typed into ${selector}`;
  }
}

// ─── browser_select ───────────────────────────────────────────────────────

export class BrowserSelectTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_select"; }
  get description() { return "Select an option in a <select> dropdown by value or visible label."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the <select> element." },
        value: { type: "string", description: "Option value attribute to select." },
        label: { type: "string", description: "Visible option label to select (used when value is not provided)." }
      },
      required: ["selector"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const page = await this.browser.getPage();
    const selector = String(params["selector"]);
    if (params["value"]) {
      await page.selectOption(selector, { value: String(params["value"]) });
      return `Selected value "${params["value"]}" in ${selector}`;
    } else if (params["label"]) {
      await page.selectOption(selector, { label: String(params["label"]) });
      return `Selected label "${params["label"]}" in ${selector}`;
    }
    return "Error: provide either value or label";
  }
}

// ─── browser_wait ─────────────────────────────────────────────────────────

export class BrowserWaitTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_wait"; }
  get description() { return "Wait for an element to appear or for the URL to match a pattern."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for." },
        urlContains: { type: "string", description: "Wait until the page URL contains this string." },
        timeout: { type: "integer", description: "Max wait time in milliseconds. Default: 10000." }
      },
      required: []
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const page = await this.browser.getPage();
    const timeout = Number(params["timeout"] ?? 10_000);
    if (params["selector"]) {
      await page.locator(String(params["selector"])).first().waitFor({ state: "visible", timeout });
      return `Element visible: ${params["selector"]}`;
    } else if (params["urlContains"]) {
      await page.waitForURL(new RegExp(String(params["urlContains"])), { timeout });
      return `URL now: ${page.url()}`;
    }
    return "Error: provide selector or urlContains";
  }
}

// ─── browser_evaluate ─────────────────────────────────────────────────────

export class BrowserEvaluateTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_evaluate"; }
  get description() { return "Run JavaScript in the current page context and return the result as JSON."; }
  get outputRisk() { return RiskLevel.High; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript expression or statement block to evaluate. Return a value with `return` or as the last expression." }
      },
      required: ["script"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const page = await this.browser.getPage();
    const script = String(params["script"]);
    // Wrap in function so `return` statements work
    const result = await page.evaluate(new Function(script) as () => unknown);
    return JSON.stringify(result, null, 2) ?? "undefined";
  }
}

// ─── browser_session_save ─────────────────────────────────────────────────

/**
 * Saves the current browser session (cookies, localStorage) to a named file
 * so it can be reloaded in a future agent run. Useful after completing a login
 * flow — save the session and load it in subsequent workflows to skip re-auth.
 */
export class BrowserSessionSaveTool extends Tool {
  constructor(private browser: BrowserManager, private workspace: string) { super(); }

  get name() { return "browser_session_save"; }
  get description() { return "Save the current browser session (cookies, localStorage) to a named file. Load it later with browser_session_load to skip re-authentication in future runs."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name (e.g. 'github', 'shopify-staging'). Used as the filename." }
      },
      required: ["name"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name = String(params["name"] ?? "").trim();
    if (!name) return "Error: name is required";
    try {
      const path = await this.browser.saveSession(name, this.workspace);
      return `Session "${name}" saved to: ${path}`;
    } catch (err) {
      return `Error saving session: ${String(err)}`;
    }
  }
}

// ─── browser_session_load ─────────────────────────────────────────────────

export class BrowserSessionLoadTool extends Tool {
  constructor(private browser: BrowserManager, private workspace: string) { super(); }

  get name() { return "browser_session_load"; }
  get description() { return "Load a previously saved browser session by name. Restores cookies and localStorage so you are already logged in. Use browser_session_save to persist a session after a successful login."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name to load (must have been saved with browser_session_save)." }
      },
      required: ["name"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name = String(params["name"] ?? "").trim();
    if (!name) return "Error: name is required";
    const available = this.browser.listSessions(this.workspace);
    try {
      await this.browser.loadSession(name, this.workspace);
      return `Session "${name}" loaded. You are now using the saved cookies and storage state.`;
    } catch (err) {
      const hint = available.length
        ? `Available sessions: ${available.join(", ")}`
        : "No saved sessions found.";
      return `Error loading session "${name}": ${String(err)}. ${hint}`;
    }
  }
}

// ─── browser_session_clear ────────────────────────────────────────────────

export class BrowserSessionClearTool extends Tool {
  constructor(private browser: BrowserManager, private workspace: string) { super(); }

  get name() { return "browser_session_clear"; }
  get description() { return "Delete a saved browser session file. Use this when credentials have changed or the session has expired."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name to delete." }
      },
      required: ["name"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name = String(params["name"] ?? "").trim();
    if (!name) return "Error: name is required";
    const deleted = this.browser.clearSession(name, this.workspace);
    return deleted
      ? `Session "${name}" deleted.`
      : `No saved session found with name "${name}". Available: ${this.browser.listSessions(this.workspace).join(", ") || "none"}`;
  }
}

// ─── browser_close ────────────────────────────────────────────────────────

export class BrowserCloseTool extends Tool {
  constructor(private browser: BrowserManager) { super(); }

  get name() { return "browser_close"; }
  get description() { return "Close the browser session and release all resources."; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.High; }
  get parameters(): Record<string, unknown> { return { type: "object", properties: {} }; }

  async execute(): Promise<string> {
    await this.browser.close();
    return "Browser closed.";
  }
}
