# Verox

A self-hosted AI agent you can talk to via Telegram, Slack, WebChat, or HTTP webhooks. It remembers things, runs scheduled tasks, executes code, searches the web, and can be extended with custom skills and plugins — all driven by a single config file with a built-in web UI for configuration and management.

---

## Features

- **Multi-channel** — Telegram, Slack (DMs + groups), WebChat, HTTP Webhooks, Email, WhatsApp (native, QR scan)
- **Web UI** — browser-based chat, visual config editor, memory browser, sessions, cron, skills, vault, log viewer, and WhatsApp pairing
- **Onboarding wizard** — guided first-run setup via the browser: vault key generation, WebUI password, provider and model selection; no manual config editing required
- **Long-term memory** — searchable, taggable, pinnable facts that persist across conversations and channels; proactive retrieval against incoming messages
- **Contact memory** — store who people are across channels (name, aliases, notes); senders are recognised automatically across Telegram, WhatsApp, and WebChat
- **Calendar awareness** — CalDAV events for today and tomorrow are injected into every system prompt so the agent is always aware of the current schedule
- **Local document RAG** — index local notes, markdown files, and PDFs; agent searches them semantically
- **Streaming responses** — token-by-token streaming in the web chat interface
- **Scheduled tasks** — UNIX cron expressions *and* natural language ("in 2 hours", "next Monday at 9am") with a friendly table UI
- **Sub-agents** — spawn parallel agents for complex or time-consuming tasks
- **Skills** — extend the agent with Markdown-driven skill modules (shell scripts, Python, etc.); activate/deactivate per skill via UI or agent chat
- **MCP client** — connect to any Model Context Protocol server (stdio, SSE, or HTTP); auto-detects StreamableHTTP with SSE fallback; vault references in env and headers
- **Browser automation** — Playwright-based browser control (navigate, click, type, screenshot, evaluate JS, and more)
- **CalDAV calendar** — read and write calendar events on any CalDAV server (Nextcloud, Radicale, etc.)
- **Dynamic tool registry** — tool groups are self-contained providers; enable/disable/reload without restart; MCP tools filtered by relevance to save tokens
- **Plugins** — load custom tools and channels dynamically at runtime
- **Context files** — personality, identity, and task files injected into every session; `BOOTSTRAP.md` triggers a guided self-introduction conversation on first contact
- **Provider agnostic** — Anthropic Claude, OpenAI GPT, Gemini, OpenRouter, any OpenAI-compatible API
- **Reasoning models** — first-class support for o-series models with adaptive reasoning effort escalation
- **Session compaction** — automatic summarisation of long conversations to stay within token limits
- **Config + channel hot-reload** — save config via the Web UI and providers, channels, and tools reload instantly without a restart
- **Prompt injection protection** — context-aware security manager blocks high-risk tool calls triggered by external content
- **Skill integrity signing** — SHA-256 manifest ensures skill files are not tampered with before credentials are injected

---

## Requirements

- **Node.js** 20+
- **pnpm**
- An API key for at least one LLM provider (Anthropic, OpenAI, Gemini, or any OpenAI-compatible endpoint)

---

## Installation

### Quick install (Linux)

```bash
git clone https://github.com/youruser/verox.git
cd verox
./install.sh
```

The script will:
1. Install dependencies with pnpm
2. Build the server and web UI
3. Create an `verox` symlink in `/usr/local/bin` (falls back to `~/.local/bin`)

### Manual install

```bash
pnpm install
pnpm run build
pnpm run build:ui
chmod +x dist/index.js
sudo ln -s "$(pwd)/dist/index.js" /usr/local/bin/verox
```

### Update

```bash
cd verox
./update.sh
```

Stops the service (if running), pulls latest code, rebuilds, and restarts.

---

## Configuration

On first start, Verox creates `~/.verox/` with a default workspace and an example config:

```
~/.verox/
├── config.json          # Main configuration
├── config.example.json  # Reference / template
└── workspace/           # Context files, memory, skills, cron jobs
```

### Onboarding wizard (recommended)

On a fresh install, just start the server — no config needed:

```bash
verox start
# → open http://localhost:3000/setup
```

The terminal will print the exact URL. The browser wizard guides you through:

1. **Vault key** — a random encryption key is generated for you; copy it and set it as `VEROX_VAULT_PASSWORD` in your environment or systemd unit, then restart. The wizard detects the key automatically and advances.
2. **WebUI password** — enter a password; it is stored in the encrypted vault. No config file editing required.
3. **Provider & model** — choose your LLM provider (Anthropic, OpenAI, Ollama, or any compatible endpoint), select or type a model name, and enter your API key. The key is stored in the vault, not in `config.json`. WebChat is enabled automatically.

Once all three steps are complete, the wizard redirects you to the chat interface. On subsequent starts the wizard is skipped entirely.

The Web UI includes:

| Page | Description |
|------|-------------|
| **Chat** | Talk to the agent with streaming responses and live tool-call progress |
| **Config** | Visual schema-driven config editor — all sections and fields rendered automatically from the schema |
| **Vault** | Browse and edit encrypted credentials |
| **Memory** | Search, browse, pin and delete memory entries |
| **Sessions** | View active sessions and conversation history |
| **Cron** | Schedule, view, and cancel cron jobs |
| **Skills** | Browse installed skills and their status |
| **Docs** | Document store status and indexed file listing |
| **Logs** | Live log tail with level and text filters |

The config editor is schema-driven — adding a new field to the Zod schema automatically adds it to the UI with the correct input type, label, help text, and sensitive-field masking. No frontend changes required.

**Config changes take effect immediately** without a restart. The agent watches `config.json` for changes and hot-reloads all settings — provider credentials, tool configs, CalDAV/browser connections, context window settings, and more. Stateful clients (CalDAV, browser) are updated in-place; providers that become enabled (e.g. `caldav.enabled` toggled to `true`) are loaded on the fly.

### Interactive CLI wizard

```bash
verox config wizard
```

Walks you through providers, channels, and agent settings with an interactive menu. Passwords are masked, current values are shown inline.

### CLI config

```bash
verox config set providers.openai.apiKey sk-...
verox config set agents.defaults.provider openai
verox config show
verox config edit   # opens in $EDITOR
```

### Config reference

```jsonc
{
  "agents": {
    "defaults": {
      "workspace": "~/.verox/workspace",
      "provider": "openai",       // Preferred provider name
      "maxTokens": 8192,
      "temperature": 0.7,
      "maxToolIterations": 20
    },
    "context": {
      "memory": {
        "enabled": true,
        "maxChars": 8000          // Characters of memory injected per turn
      }
    },
    "compaction": {
      "enabled": true,
      "thresholdTokens": 6000,
      "keepRecentMessages": 10
    },
    "memoryExtraction": {
      "staleHours": 4,            // Extract from sessions idle longer than this
      "minMessages": 3
    },
    "memoryPruning": {
      "enabled": true,
      "maxAgeDays": 90,
      "minConfidence": 0.3,
      "maxEntries": 1000
    }
  },

  "providers": {
    "openai": {
      "apiKey": "sk-...",
      "apiBase": "https://api.openai.com/v1",
      "model": "gpt-4o",
      "utilityModel": null,       // Lighter model for compaction/extraction
      "wireApi": "auto",          // auto | chat | responses
      "promptCaching": false,
      "reasoningEffort": null,    // low | medium | high (o-series only)
      "adaptiveReasoning": false  // Escalate effort as iterations increase
    },
    "anthropic": {
      "apiKey": "sk-ant-...",
      "apiBase": "https://api.anthropic.com/v1",
      "model": "claude-opus-4-6",
      "promptCaching": true       // Anthropic cache_control for system prompt
    },
    "gemini": {
      "apiKey": "...",
      "apiBase": "https://generativelanguage.googleapis.com/v1beta/openai",
      "model": "gemini-2.0-flash"
    },
    "openrouter": {
      "apiKey": "...",
      "apiBase": "https://openrouter.ai/api/v1",
      "model": "anthropic/claude-opus-4-6"
    }
  },

  "channels": {
    "webchat": {
      "enabled": true,
      "port": 3000,
      "host": "0.0.0.0",
      "uiToken": ""               // Auto-generated and stored in vault if blank
    },
    "telegram": {
      "enabled": false,
      "token": "...",
      "policy": "restricted",     // none | restricted
      "allowFrom": ["123456789"]
    },
    "slack": {
      "enabled": false,
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "mode": "socket",           // socket | http
      "groupPolicy": "mention"    // none | mention | restricted
    },
    "email": {
      "enabled": false,
      "imapHost": "", "imapPort": 993, "imapUsername": "", "imapPassword": "",
      "smtpHost": "", "smtpPort": 587, "smtpUsername": "", "smtpPassword": "",
      "fromAddress": "",
      "pollIntervalSeconds": 30
    },
    "webhook": {
      "enabled": false,
      "port": 3001,
      "path": "/webhook",
      "jwtSecret": "..."
    }
  },

  "tools": {
    "web": {
      "search": {
        "apiKey": "...",           // Brave Search / compatible API key
        "strUrl": "",              // Search provider URL
        "maxResults": 5
      },
      "crawl": "",                 // Crawl service URL (e.g. Jina)
      "http": {
        "allowedHosts": [],        // Empty = allow all hosts
        "maxResponseBytes": 100000
      }
    },
    "exec": {
      "timeout": 60,
      "usePidNamespace": false,    // Linux: isolate /proc (see security section)
      "runAs": null                // OS user to run commands as
    },
    "imap": {
      "host": "", "port": 993, "user": "", "password": "", "tls": true
    },
    "docs": {
      "enabled": false,
      "paths": [
        { "name": "Notes", "path": "/home/user/notes" }
      ],
      "embeddingModel": "text-embedding-3-small",
      "embeddingDims": 1536,
      "chunkSize": 800,
      "chunkOverlap": 100,
      "maxResults": 5,
      // Optional: separate embedding provider (e.g. when using OpenRouter for chat)
      "embeddingApiBase": "https://api.openai.com/v1",
      "embeddingApiKey": "sk-..."
    },
    "restrictFilesToWorkspace": false,
    "restrictExecToWorkspace": false,

    "caldav": {
      "enabled": false,
      "serverUrl": "https://nextcloud.example.com/remote.php/dav",
      "username": "",
      "password": "",           // Store in vault: config.tools.caldav.password
      "defaultCalendar": ""
    },

    "browser": {
      "enabled": false,
      "headless": true,
      "timeout": 30000,
      "allowedDomains": []      // Empty = allow all domains
    }
  },

  "mcp": {
    "servers": {
      "myserver": {
        "transport": "stdio",   // stdio | sse | http
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "env": {},
        "url": "",
        "headers": {},
        "alwaysInclude": false  // true = always send tools to LLM (bypasses keyword filter)
      }
    }
  }
}
```

---

## Running

### Start manually

```bash
verox start
```

### Run as a systemd service

```bash
verox service add          # user service (no sudo needed)
verox service add --system # system service (requires root)
```

Enables and starts the service immediately. To follow logs:

```bash
journalctl --user -u verox -f   # user service
journalctl -u verox -f          # system service
```

Remove the service:

```bash
verox service remove
```

---

## Workspace & context files

The workspace directory (`~/.verox/workspace/` by default) holds all the files the agent reads at startup:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Core behavioural rules and response style |
| `SOUL.md` | Personality and values |
| `IDENTITY.md` | Product/persona identity |
| `USER.md` | Facts about the user — name, preferences, timezone |
| `TOOLS.md` | Guidance on when and how to use tools |
| `BOOT.md` / `BOOTSTRAP.md` | Project or environment context |
| `HEARTBEAT.md` | Instructions for the periodic heartbeat task |

Edit these files to shape how the agent behaves. Changes take effect on the next conversation turn (no restart required).

---

## Memory

The agent maintains long-term memory in a SQLite database (`workspace/memory/memory.db`). Memories are tagged facts that persist across sessions and channels.

**Tags used by convention:** `preferences`, `decisions`, `people`, `tasks`, `technical`, `facts`, `reminders`, `pin`

The `pin` tag makes an entry always appear in the system prompt regardless of age. Use it sparingly for critical facts.

Memory is injected into every session automatically using a three-tier strategy:

1. **Pinned** — entries tagged `pin` always appear first
2. **Relevant** — entries whose content matches keywords in the incoming message (proactive retrieval — no prompt needed)
3. **Recent** — entries from the last 7 days not already shown

The system prompt also tells the agent how many total memories are stored, encouraging it to use `memory_search` for deeper recall. The agent can also search, write, and delete memories using its built-in tools.

### Risk-annotated memory

When the agent reads external content (email bodies, web pages), the session messages are annotated with the source risk level. The memory extraction pipeline inherits that risk level and stores it alongside each extracted fact.

**High-risk memory entries are never injected automatically into the system prompt.** They remain searchable and recallable via `memory_search` — but accessing them raises the security context level, so any subsequent dangerous tool calls (exec, imap_update, etc.) are blocked until the user explicitly confirms.

This prevents an attacker from poisoning the agent's long-term memory via a crafted email and then having that instruction silently appear in every future conversation.

### Manage memory via CLI

```bash
verox memory list
verox memory list --tag preferences
verox memory list --search "dark mode"
verox memory get <id>
verox memory write        # interactive
verox memory delete <id>
```

---

## Scheduled tasks (cron)

The agent can schedule and manage its own cron jobs using the `cron` tool. Jobs are persisted in `workspace/cron/jobs.json` and survive restarts.

> "Remind me every morning at 8 AM about my priorities for the day via Telegram"

The agent will call the `cron` tool with the appropriate schedule and target.

### Manage cron jobs via CLI

```bash
verox cron list
verox cron add
verox cron cancel <id>
```

---

## Heartbeat

The heartbeat runs every 30 minutes and sends the agent the contents of `HEARTBEAT.md` as a prompt. Use it for recurring light tasks — checking emails, sending a daily summary, monitoring a service.

Leave `HEARTBEAT.md` empty or comment everything out to disable it without touching config.

---

## Skills

Skills extend the agent with domain-specific capabilities. A skill is a directory under `workspace/skills/{name}/` containing:

```
workspace/skills/
└── homeassistant/
    ├── SKILL.md           # Description + tool usage guidance (YAML frontmatter)
    ├── config.json        # Skill-local config values
    └── config.schema.json # Schema + env export declarations
```

**`SKILL.md` frontmatter example:**

```yaml
---
description: Control Home Assistant devices and automations
always: false
requires:
  binaries: [curl]
  env: [HA_URL, HA_TOKEN]
---
```

**`config.schema.json` example:**

```json
{
  "properties": {
    "url":   { "type": "string", "envName": "HA_URL" },
    "token": { "type": "string", "envName": "HA_TOKEN" }
  }
}
```

Fields with `envName` are injected into the environment of any shell commands the skill runs, so secrets never appear in the global process environment.

Skills marked `always: true` are loaded into every session automatically.

### Skill integrity signing

Before a skill can receive vault credentials and be trusted to produce safe output, its entry-point file must be signed. Signing stores a SHA-256 hash in an encrypted manifest (`~/.verox/skill-manifest.enc`). The hash is verified immediately before every execution — if the file has been modified since signing, the call is blocked.

```bash
# After installing or updating a skill:
export VEROX_VAULT_PASSWORD="your-vault-password"
verox skills sign homeassistant

verox skills verify homeassistant
verox skills list
verox skills unsign homeassistant
```

**Security implications:**

| Skill state | Vault credentials | Output risk |
|-------------|-------------------|-------------|
| Signed, hash matches | Injected | As configured |
| Not signed | Not injected | Forced to High |
| Signed, hash mismatch | Not injected | Execution blocked |

An unsigned skill always produces `RiskLevel.High` output — meaning any tool call the agent makes after running it is subject to the same restrictions as if it had read an email body.

---

## Prompt injection protection

When the agent reads external content — email bodies, web pages, crawled sites — an attacker can embed instructions directed at the agent. Verox counters this with a **context risk level** that rises as the agent consumes external data, and blocks dangerous tool calls once the context is contaminated.

### Risk levels

| Level | Set by | Meaning |
|-------|--------|---------|
| `None` | User message (reset every turn) | Trusted context — agent is acting on user intent |
| `Low` | Email metadata, search results, file reads | Some external data seen — low-impact tools still allowed |
| `High` | Email bodies, web pages, exec output, unsigned skills | Full external content — only safe read operations allowed |

### Default tool profiles

| Tool | Output risk | Max allowed context | Notes |
|------|-------------|---------------------|-------|
| `exec` | High | **None** | Only runs from user-initiated context |
| `spawn` | High | **None** | Subagent spawning requires user intent |
| `imap_update` | — | **None** | Write/delete/move requires user intent |
| `imap_read` | High | High | Body is attacker-controlled |
| `imap_mail` | Low | High | Metadata only (uid, subject, from, date) |
| `web_fetch` / `web_crawl` | High | High | Full page content |
| `web_search` | Low | High | Titles and snippets only |
| `read_file` | Low | High | Local file content |
| `write_file` / `edit_file` | — | High | Writing is safe from any context |
| `http_request` | High | High | External API response is untrusted |
| `docs_search` | Low | High | Local content, treat chunks as external |
| `docs_get` | Low | High | Full file content |

When a blocked tool call occurs, the agent receives a `[SECURITY_HOLD]` message and is instructed to surface the request to the user for confirmation. A new user message resets the context back to `None`.

### Config overrides

```json
"tools": {
  "security": {
    "imap_read":  { "maxRisk": "none" },
    "web_search": { "maxRisk": "none", "outputRisk": "none" }
  },
  "skillSecurity": {
    "weathercheck": { "maxRisk": "high", "outputRisk": "low" }
  }
}
```

**`tools.security`** — overrides for built-in tools. Keys are tool names.

**`tools.skillSecurity`** — overrides for individual skills. Only use this for skills that are **strictly read-only with no side effects**. Never relax skills that control physical devices, send messages, or modify data.

> Skill security overrides only apply to **signed** skills. An unsigned skill always produces `High` output risk regardless of config.

---

## Credential vault

Verox includes an encrypted credential vault that keeps sensitive secrets out of `config.json` and out of reach of the AI agent itself.

### How it works

The vault stores credentials as a single AES-256-GCM encrypted blob at `~/.verox/vault.enc`. The decryption key is derived at runtime from a password supplied as an environment variable — it is never written to disk.

| Key pattern | Effect |
|-------------|--------|
| `config.<dot.path>` | Overrides a field in `config.json` at parse time |
| `skill.<skillname>.<scriptname>.<ENV_VAR>` | Injected into the environment of a matching skill script |

`config.json` can be committed to version control or shared without exposing any secrets — the real values live only in the encrypted vault.

### Setup

```bash
export VEROX_VAULT_PASSWORD="your-strong-password"

# Store provider keys (replaces plaintext in config.json)
verox vault set config.providers.anthropic.apiKey  sk-ant-...
verox vault set config.providers.openai.apiKey     sk-...
verox vault set config.channels.telegram.token     1234567:abc...

# Store skill credentials
verox vault set skill.homeassistant.index.HA_TOKEN  your-ha-token
verox vault set skill.homeassistant.index.HA_URL    http://homeassistant.local:8123
```

### CLI reference

```
verox vault set <key> <value>    Store a credential
verox vault get <key>            Print a stored value
verox vault list                 List all stored keys
verox vault delete <key>         Remove a credential
```

### Security properties

| Threat | Mitigation |
|--------|------------|
| Agent reads `config.json` via `read_file` | API keys are not in `config.json` — only in the encrypted vault |
| Agent runs a malicious script that reads the vault file | Vault is AES-256-GCM encrypted; useless without the password |
| Agent exfiltrates `VEROX_VAULT_PASSWORD` via `exec` | Password is stripped from all child process environments |
| Agent writes a malicious script to steal injected credentials | Unsigned/unreviewed scripts never receive vault credentials |
| Prompt injection modifies a skill file to exfiltrate credentials | SHA-256 hash checked immediately before exec — tampered files are blocked |
| Prompt injection via email triggers `exec` or physical device control | SecurityManager blocks high-risk tools when context is contaminated |

### Linux process isolation (recommended)

#### Option A — PID namespace (no extra user required)

Wraps each exec'd command in a new PID + user namespace using `unshare`. Inside the namespace the child gets its own `/proc` mount and cannot see any parent processes.

```json
"tools": { "exec": { "usePidNamespace": true } }
```

**Requirement:** Linux with unprivileged user namespaces enabled (default on Ubuntu 16.04+, Debian 10+, Fedora, Arch).

#### Option B — Dedicated OS user (fallback for hardened kernels)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin verox-exec
sudo visudo -f /etc/sudoers.d/verox
# Add: verox ALL=(verox-exec) NOPASSWD: /bin/sh
```

```json
"tools": { "exec": { "runAs": "verox-exec" } }
```

If both `usePidNamespace` and `runAs` are set, `usePidNamespace` takes precedence.

---

## Local document RAG

Index local notes, markdown files, and PDFs so the agent can search them semantically.

### How it works

**Indexing** (`docs_index`): Walks configured `paths`, hashes each file (skips unchanged), extracts text, splits into overlapping chunks, embeds via the configured embedding model, and stores float32 vectors in SQLite.

**Searching** (`docs_search`): Embeds the query with the same model, computes cosine similarity against all stored chunk vectors in-process, returns top-N chunks with source path and score.

### Setup

```json
"tools": {
  "docs": {
    "enabled": true,
    "paths": [
      { "name": "Personal Notes", "path": "/home/user/notes" },
      { "name": "Paperless",      "path": "/mnt/paperless/data" }
    ],
    "embeddingModel": "text-embedding-3-small"
  }
}
```

If your chat provider doesn't support `/embeddings` (e.g. OpenRouter), point the docs tool at a separate provider via `embeddingApiBase` and `embeddingApiKey`.

### CLI

```bash
verox docs index           # Index all configured paths (skips unchanged)
verox docs index --force   # Re-index everything
verox docs list            # List all indexed files
```

---

## HTTP requests

The `http_request` tool lets the agent call external HTTP APIs:

```json
"tools": {
  "web": {
    "http": {
      "allowedHosts": ["api.example.com"]  // Empty = allow all hosts
    }
  }
}
```

Supports GET, POST, PUT, PATCH, DELETE, HEAD with arbitrary headers and request bodies. Response bodies are truncated at the configured `maxResponseBytes` limit; JSON is pretty-printed automatically. Output risk: High.

---

## MCP (Model Context Protocol)

Verox can connect to any MCP server and expose its tools to the agent as native tools. Connections are established at startup before the agent begins processing.

### Config

```jsonc
"mcp": {
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      "env": {
        "SOME_KEY": "vault:config.mcp.servers.filesystem.somekey"
      }
    },
    "homeassistant": {
      "transport": "http",
      "url": "http://homeassistant.local:8123/mcp",
      "headers": {
        "Authorization": "Bearer $vault:config.mcp.servers.homeassistant.token"
      },
      "alwaysInclude": false
    }
  }
}
```

### Transports

| Transport | Field | Description |
|-----------|-------|-------------|
| `stdio` | `command`, `args`, `env` | Launches a local process (e.g. `npx`, `uvx`, `python`) |
| `sse` | `url`, `headers` | Server-Sent Events (legacy MCP) |
| `http` | `url`, `headers` | Streamable HTTP (current MCP spec) |

### Vault references in env and headers

Two syntaxes are supported for injecting secrets without storing them in `config.json`:

| Syntax | Effect |
|--------|--------|
| `vault:<key>` | Entire value replaced by vault entry; variable omitted if key not found |
| `$vault:<key>` | Inline substitution within a larger string (e.g. `Bearer $vault:mykey`) |

```bash
# Store secrets
verox vault set config.mcp.servers.homeassistant.token "Bearer eyJhb..."
```

### Tool filtering (contextual tools)

MCP servers can expose many tools that are irrelevant to most messages. By default, MCP tools are **contextual** — they are only sent to the LLM when the user message contains keywords matching their name or description. This keeps the token count low for unrelated requests.

When a needed tool isn't matched by keywords, the LLM can call the always-available **`tool_search`** meta-tool to discover and activate it on demand:

> "I need to control the lights" → LLM calls `tool_search("control smart home lights")` → HA tools activated for this turn

Set `alwaysInclude: true` on a server to bypass filtering and always include its tools (useful for small servers whose tools are frequently needed regardless of context).

### Connection status

The Web UI config page shows a live status badge on each MCP server card:
- **Green dot + tool count** — connected and tools registered
- **Red dot + "error"** — connection failed (hover for the error message)

Status is also available via `GET /api/mcp/status`.

---

## Browser automation

Verox includes a Playwright-based browser that the agent can control to interact with web pages programmatically.

### Setup

Install the browser binary (one-time):

```bash
npx playwright install chromium
```

Enable in config:

```jsonc
"tools": {
  "browser": {
    "enabled": true,
    "headless": true,
    "timeout": 30000,
    "allowedDomains": []  // Empty = allow all domains
  }
}
```

### Available tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_screenshot` | Take a screenshot (saved to workspace) |
| `browser_get_content` | Get the page's text content or HTML |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an input |
| `browser_select` | Select an option in a `<select>` element |
| `browser_wait` | Wait for an element to appear |
| `browser_evaluate` | Execute JavaScript in the page context |
| `browser_close` | Close the browser |

All browser tools have `maxRisk = None` (require a clean context to run). `browser_get_content` and `browser_evaluate` produce `outputRisk = High` since they return page-controlled content.

---

## CalDAV calendar

Connect to any CalDAV server (Nextcloud, Radicale, Baikal, iCloud, etc.) to read and manage calendar events.

### Config

```jsonc
"tools": {
  "caldav": {
    "enabled": true,
    "serverUrl": "https://nextcloud.example.com/remote.php/dav",
    "username": "alice",
    "password": "",       // Leave blank and store in vault instead
    "defaultCalendar": "Personal"  // Partial match; uses first calendar if blank
  }
}
```

Store the password securely:

```bash
verox vault set config.tools.caldav.password "app-specific-password"
```

### Available tools

| Tool | Description |
|------|-------------|
| `calendar_list` | List all available calendars |
| `calendar_get_events` | Get events for a calendar (with optional date range) |
| `calendar_create_event` | Create a new event |
| `calendar_update_event` | Update an existing event by UID |
| `calendar_delete_event` | Delete an event by UID |

---

## Plugins

Plugins can add custom tools and channels at runtime:

```json
{
  "plugins": {
    "enabled": true,
    "load": { "paths": ["/path/to/my-plugin.js"] }
  }
}
```

A plugin exports a default object with optional `tools` and `channels` factories. Plugin config schemas are automatically merged into the Web UI config editor.

---

## CLI reference

```
verox start                      Start the agent

verox config wizard              Interactive configuration wizard
verox config show                Print full config as JSON
verox config get <key>           Get a value (dot notation)
verox config set [key] [value]   Set a value (interactive if omitted)
verox config edit                Open config in $EDITOR

verox memory list [-t tag] [-s query]
verox memory get <id>
verox memory write
verox memory delete <id>

verox cron list
verox cron add
verox cron cancel <id>

verox service add [--system]
verox service remove [--system]

verox vault set <key> <value>
verox vault get <key>
verox vault list
verox vault delete <key>

verox skills sign <skillname>
verox skills verify <skillname>
verox skills list
verox skills unsign <skillname>

verox docs index [path] [--force]
verox docs list
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `VEROX_HOME` | Override the data directory (default: `~/.verox`) |
| `VEROX_VAULT_PASSWORD` | Password for the encrypted credential vault. Required for vault and skill-signing features. |

---

## Built-in tools

### Core (always available)

| Tool | Description |
|------|-------------|
| `memory_write` | Save a fact to long-term memory |
| `memory_search` | Search memory by text and/or tags |
| `memory_list_tags` | List all tags in use |
| `memory_delete` | Delete a memory entry |
| `cron` | Schedule, cancel, or list cron jobs |
| `message` | Send a message to a channel with optional file attachments |
| `sessions_list` | List active sessions |
| `sessions_history` | Get conversation history for a session |
| `sessions_send` | Send a message to another session |
| `usage_stats` | Show token usage statistics |
| `provider_list` | List configured LLM providers |
| `provider_switch` | Switch the active provider |
| `security_check` | Check current security context level |
| `tool_search` | Discover and activate contextual tools (e.g. MCP tools) not currently visible |

### Shell & filesystem

| Tool | Description |
|------|-------------|
| `exec` | Run a shell command |
| `spawn` | Create a sub-agent |
| `subagents` | List, steer, or kill sub-agents |
| `read_file` | Read a file |
| `write_file` | Write a file |
| `edit_file` | Edit a file by string replacement |
| `list_dir` | List directory contents |

### Web

| Tool | Description |
|------|-------------|
| `web_search` | Search the web |
| `web_fetch` | Fetch a web page |
| `web_crawl` | Crawl a URL via a configured crawl service |
| `http_request` | Make an HTTP request to an external API |

### Email (requires `tools.imap`)

| Tool | Description |
|------|-------------|
| `imap_mail` | List/search emails — metadata only (uid, subject, from, date) |
| `imap_read` | Read the full body of an email by uid |
| `imap_update` | Mutate email state: `mark_seen`, `mark_unseen`, `move`, `delete` |
| `imap_draft` | Compose and send an email via SMTP |

### Documents (requires `tools.docs.enabled`)

| Tool | Description |
|------|-------------|
| `docs_index` | Index local documents for semantic search |
| `docs_search` | Semantic search over indexed local documents |
| `docs_list` | List all indexed documents |
| `docs_get` | Read the full text of an indexed document |

### CalDAV (requires `tools.caldav.enabled`)

| Tool | Description |
|------|-------------|
| `calendar_list` | List available calendars |
| `calendar_get_events` | Get events for a calendar with optional date range |
| `calendar_create_event` | Create a new calendar event |
| `calendar_update_event` | Update an existing event by UID |
| `calendar_delete_event` | Delete an event by UID |

### Browser (requires `tools.browser.enabled` + `npx playwright install chromium`)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_screenshot` | Take a screenshot (saved to workspace) |
| `browser_get_content` | Get the page's text content or HTML |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an input field |
| `browser_select` | Select an option in a `<select>` element |
| `browser_wait` | Wait for an element to appear |
| `browser_evaluate` | Execute JavaScript in the page context |
| `browser_close` | Close the browser |

### MCP tools (dynamic — requires `mcp.servers` config)

MCP tools are registered at startup with names in the form `mcp__{serverName}__{toolName}`. They are **contextual** by default — only included in requests when the message contains matching keywords, or when activated via `tool_search`. Set `alwaysInclude: true` on the server to always include its tools.

---

## License

ISC
