import { Component, OnInit, computed, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { forkJoin } from 'rxjs';
import { ApiService, ConfigSchemaResponse, McpServerStatus } from '../../../core/api.service';

// Convenience alias for untyped schema nodes
type S = Record<string, unknown>;

// ── UI tree types ─────────────────────────────────────────────────────────────

type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'kvtextarea';

interface FieldDef {
  path: string;       // dot-path; may contain {sub} or {key} placeholders
  label: string;
  help?: string;
  type: FieldType;
  options?: string[]; // select only
  nullable: boolean;
}
interface GroupDef  { label?: string; fields: FieldDef[]; }
interface CardDef   { title: string; enablePath?: string; groups: GroupDef[]; }
interface SectionDef {
  key: string; label: string; mode: 'normal' | 'subtabs' | 'dynamic-record';
  subKeys?: string[]; subLabels?: S; cards: CardDef[];
  /** For dynamic-record: dot-path to the record object (e.g. 'mcp.servers'). */
  recordPath?: string;
  /** For dynamic-record: field template with {key} placeholder in paths. */
  recordGroups?: GroupDef[];
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <div class="page">

      <div class="editor-header">
        <nav class="tabs">
          @for (sec of sections; track sec.key) {
            <button class="tab" [class.active]="activeTab()===sec.key" (click)="setTab(sec.key)">
              {{ sec.label }}
            </button>
          }
        </nav>
        <div class="save-row">
          @if (error()) { <span class="msg-err">{{ error() }}</span> }
          @if (saved()) { <span class="msg-ok">Saved — restart to apply</span> }
          <button class="btn btn-primary" (click)="save()" [disabled]="saving()">
            {{ saving() ? 'Saving…' : 'Save changes' }}
          </button>
        </div>
      </div>

      <div class="editor-body">
        @if (!loaded()) {
          <div class="loading">Loading configuration…</div>
        } @else {
          <div class="section-col">

            @if (activeSection() && activeSection()!.mode === 'subtabs') {
              <nav class="subtabs">
                @for (k of activeSection()!.subKeys!; track k) {
                  <button class="subtab" [class.active]="activeSub()===k" (click)="activeSub.set(k)">
                    {{ asStr(activeSection()!.subLabels?.[k]) || k }}
                  </button>
                }
              </nav>
            }

            @if (activeSection() && activeSection()!.mode === 'dynamic-record') {
              <!-- Add-entry row -->
              <div class="card add-record-card">
                <div class="add-record-row">
                  <input class="input add-record-input" type="text" placeholder="Server name (e.g. filesystem)"
                    [value]="newRecordName()" (input)="newRecordName.set(asInput($event))">
                  <button class="btn btn-primary" [disabled]="!newRecordName().trim()" (click)="addRecord()">Add server</button>
                </div>
              </div>
              @if (recordKeys().length === 0) {
                <div class="empty-hint">No MCP servers configured. Add one above.</div>
              }
              @for (key of recordKeys(); track key) {
                <div class="card">
                  <div class="card-title-row">
                    <span class="card-title-text">{{ key }}</span>
                    @if (mcpStatus().length > 0) {
                      @let status = mcpStatusFor(key);
                      @if (status) {
                        <span class="mcp-status-badge" [class.connected]="status.connected" [class.error]="!status.connected"
                              [title]="status.connected ? status.toolCount + ' tools: ' + status.tools.join(', ') : (status.error ?? 'not connected')">
                          <span class="mcp-dot"></span>
                          {{ status.connected ? status.toolCount + ' tools' : 'error' }}
                        </span>
                      }
                    }
                    <button class="btn-remove" (click)="removeRecord(key)">Remove</button>
                  </div>
                  <ng-container [ngTemplateOutlet]="fieldsTpl" [ngTemplateOutletContext]="{$implicit:recordGroupsFor(key)}"></ng-container>
                </div>
              }
            }

            @for (card of activeCards(); track card.title) {
              <div class="card">
                @if (card.enablePath) {
                  <div class="card-title-row">
                    <span class="card-title-text">{{ card.title }}</span>
                    <label class="toggle">
                      <input type="checkbox" [checked]="b(card.enablePath)" (change)="onBool(card.enablePath,$event)">
                      <span class="slider"></span>
                    </label>
                  </div>
                  @if (b(card.enablePath)) {
                    <ng-container [ngTemplateOutlet]="fieldsTpl" [ngTemplateOutletContext]="{$implicit:card.groups}"></ng-container>
                  }
                } @else {
                  <div class="card-title">{{ card.title }}</div>
                  <ng-container [ngTemplateOutlet]="fieldsTpl" [ngTemplateOutletContext]="{$implicit:card.groups}"></ng-container>
                }
              </div>
            }

          </div>
        }
      </div>
    </div>

    <ng-template #fieldsTpl let-groups>
      <div class="fields">
        @for (group of groups; track (group.label ?? '_')) {
          @if (group.label) { <div class="field-group-label">{{ group.label }}</div> }
          @for (field of group.fields; track field.path) {
            <div class="field" [class.field-bool]="field.type==='boolean'">
              <label>{{ field.label }}</label>
              @switch (field.type) {
                @case ('boolean') {
                  <label class="toggle">
                    <input type="checkbox" [checked]="b(field.path)" (change)="onBool(field.path,$event)">
                    <span class="slider"></span>
                  </label>
                }
                @case ('select') {
                  <select class="input" (change)="onSelect(field,$event)">
                    @if (field.nullable) { <option value="" [selected]="!s(field.path)">—</option> }
                    @for (opt of field.options!; track opt) {
                      <option [value]="opt" [selected]="s(field.path)===opt">{{ opt }}</option>
                    }
                  </select>
                }
                @case ('textarea') {
                  <textarea class="input" rows="3"
                    [value]="arr(field.path)" (input)="onArr(field.path,$event)"
                    placeholder="One value per line"></textarea>
                }
                @case ('kvtextarea') {
                  <textarea class="input" rows="3"
                    [value]="kv(field.path)" (input)="onKv(field.path,$event)"
                    placeholder="KEY=value (one per line)"></textarea>
                }
                @case ('number') {
                  <input class="input" type="number" [value]="n(field.path)" (input)="onNum(field.path,$event)">
                }
                @default {
                  <input class="input" [type]="field.type" [value]="s(field.path)"
                    (input)="onStr(field,$event)"
                    [placeholder]="field.nullable ? 'Blank to unset' : ''">
                }
              }
              @if (field.help) { <span class="hint">{{ field.help }}</span> }
            </div>
          }
        }
      </div>
    </ng-template>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
    .page { display: flex; flex-direction: column; height: 100%; }

    .editor-header {
      display: flex; align-items: center;
      padding: 0 20px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .tabs { display: flex; }
    .tab {
      padding: 14px 18px; font-size: 13px; font-weight: 500;
      border: none; background: none; cursor: pointer;
      color: var(--text-muted); border-bottom: 2px solid transparent;
      transition: color .15s, border-color .15s;
    }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    .save-row { display: flex; align-items: center; gap: 12px; margin-left: auto; padding: 10px 0; }
    .msg-err { color: var(--danger); font-size: 12px; }
    .msg-ok  { color: var(--success); font-size: 12px; }

    .editor-body { flex: 1; overflow-y: auto; padding: 20px; }
    .loading { color: var(--text-muted); font-size: 14px; padding: 40px; text-align: center; }

    .section-col { display: flex; flex-direction: column; gap: 16px; max-width: 740px; }

    .subtabs {
      display: flex; gap: 2px; padding: 4px;
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    }
    .subtab {
      flex: 1; padding: 7px 14px; font-size: 12px; font-weight: 500;
      border: none; background: none; cursor: pointer;
      color: var(--text-muted); border-radius: calc(var(--radius) - 3px);
      transition: background .15s, color .15s;
    }
    .subtab:hover { color: var(--text); }
    .subtab.active { background: var(--bg); color: var(--text); box-shadow: 0 1px 3px var(--border); }

    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .card-title {
      padding: 12px 16px; font-size: 13px; font-weight: 600;
      border-bottom: 1px solid var(--border); background: var(--table-header-bg);
    }
    .card-title-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--table-header-bg);
    }
    .card-title-text { font-size: 13px; font-weight: 600; }

    .field-group-label {
      padding: 8px 16px 4px; font-size: 11px; font-weight: 600;
      letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted);
      border-bottom: 1px solid var(--border);
    }

    .fields { padding: 0; }
    .field {
      display: flex; align-items: flex-start; flex-wrap: wrap; gap: 0 12px;
      padding: 10px 16px; border-bottom: 1px solid var(--border);
    }
    .field:last-child { border-bottom: none; }
    .field > label:first-child {
      width: 200px; flex-shrink: 0; font-size: 13px; font-weight: 500;
      color: var(--text); padding-top: 6px;
    }
    .field > .input   { flex: 1; min-width: 0; }
    .field > textarea { flex: 1; min-width: 0; resize: vertical; }
    .field .hint {
      flex-basis: 100%; padding-left: 212px;
      font-size: 11px; color: var(--text-muted); margin-top: 4px;
    }

    .field-bool { align-items: center; flex-wrap: nowrap; }
    .field-bool > label:first-child { padding-top: 0; }
    .field-bool > .toggle { flex-shrink: 0; }
    .field-bool > .hint { flex: 1; padding-left: 0; margin-top: 0; }

    .add-record-card { padding: 12px 16px; }
    .add-record-row { display: flex; gap: 8px; align-items: center; }
    .add-record-input { flex: 1; }
    .btn-remove {
      padding: 4px 10px; font-size: 12px; border-radius: 4px;
      border: 1px solid var(--danger); background: none;
      color: var(--danger); cursor: pointer;
    }
    .btn-remove:hover { background: var(--danger); color: white; }
    .empty-hint { color: var(--text-muted); font-size: 13px; padding: 20px; text-align: center; }
    .mcp-status-badge {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 12px; padding: 2px 8px; border-radius: 10px;
      cursor: default; white-space: nowrap;
      background: color-mix(in srgb, var(--text-muted) 15%, transparent);
      color: var(--text-muted);
    }
    .mcp-status-badge.connected { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }
    .mcp-status-badge.error     { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }
    .mcp-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: currentColor;
    }

    .toggle { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .slider {
      position: absolute; inset: 0; background: var(--border);
      border-radius: 10px; cursor: pointer; transition: background .2s;
    }
    .slider::before {
      content: ''; position: absolute; width: 14px; height: 14px;
      left: 3px; top: 3px; background: white; border-radius: 50%; transition: transform .2s;
    }
    .toggle input:checked + .slider { background: var(--accent); }
    .toggle input:checked + .slider::before { transform: translateX(16px); }
  `],
})
export class ConfigComponent implements OnInit {

  sections: SectionDef[] = [];
  activeTab     = signal<string>('');
  activeSub     = signal<string>('');
  loaded        = signal(false);
  saving        = signal(false);
  saved         = signal(false);
  error         = signal('');
  cfg           = signal<S>({});
  newRecordName = signal<string>('');
  mcpStatus     = signal<McpServerStatus[]>([]);

  private hints: Record<string, { label?: string; help?: string; sensitive?: boolean }> = {};

  activeSection = computed(() => this.sections.find(s => s.key === this.activeTab()) ?? this.sections[0]);

  recordKeys = computed(() => {
    const sec = this.activeSection();
    if (!sec?.recordPath) return [];
    const obj = this.get(sec.recordPath);
    return obj && typeof obj === 'object' ? Object.keys(obj as S) : [];
  });

  /** Cards with {sub} replaced by the active sub-key (for subtab sections). */
  activeCards = computed(() => {
    const sec = this.activeSection();
    if (!sec) return [];
    if (sec.mode !== 'subtabs') return sec.cards;
    const sub = this.activeSub();
    return sec.cards.map(card => ({
      ...card,
      enablePath: card.enablePath?.replace('{sub}', sub),
      groups: card.groups.map(g => ({
        ...g, fields: g.fields.map(f => ({ ...f, path: f.path.replace('{sub}', sub) })),
      })),
    }));
  });

  constructor(private api: ApiService) {}

  ngOnInit() {
    forkJoin([this.api.getConfig(), this.api.getConfigSchema()]).subscribe({
      next: ([config, schema]) => {
        this.cfg.set(JSON.parse(JSON.stringify(config)));
        this.hints = schema.uiHints;
        this.sections = this.buildSections(schema);
        if (this.sections.length) {
          this.activeTab.set(this.sections[0].key);
          const sub = this.sections.find(s => s.mode === 'subtabs');
          if (sub?.subKeys?.[0]) this.activeSub.set(sub.subKeys[0]);
        }
        this.loaded.set(true);
      },
      error: (e: unknown) => {
        this.error.set((e as { error?: { error?: string } })?.error?.error ?? String(e));
        this.loaded.set(true);
      },
    });
    // Load MCP connection status separately (best-effort — doesn't block the page).
    this.api.getMcpStatus().subscribe({ next: (s) => this.mcpStatus.set(s), error: () => {} });
  }

  mcpStatusFor(key: string): McpServerStatus | undefined {
    return this.mcpStatus().find(s => s.name === key);
  }

  setTab(key: string): void {
    this.activeTab.set(key);
    const sec = this.sections.find(s => s.key === key);
    if (sec?.mode === 'subtabs' && sec.subKeys?.length) this.activeSub.set(sec.subKeys[0]);
  }

  // ── template helpers ─────────────────────────────────────────────────────

  asStr(v: unknown): string { return v == null ? '' : String(v); }

  // ── read helpers ─────────────────────────────────────────────────────────

  s(path: string): string  { const v = this.get(path); return v == null ? '' : String(v); }
  n(path: string): number  { const v = this.get(path); return typeof v === 'number' ? v : 0; }
  b(path: string): boolean { return !!this.get(path); }
  arr(path: string): string {
    const v = this.get(path);
    return Array.isArray(v) ? (v as unknown[]).map(String).join('\n') : '';
  }

  // ── write helpers ────────────────────────────────────────────────────────

  onStr(field: FieldDef, e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.set(field.path, field.nullable && !v.trim() ? null : v);
  }
  onNum(path: string, e: Event): void {
    const v = parseFloat((e.target as HTMLInputElement).value);
    this.set(path, isNaN(v) ? 0 : v);
  }
  onBool(path: string, e: Event): void { this.set(path, (e.target as HTMLInputElement).checked); }
  onSelect(field: FieldDef, e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    this.set(field.path, field.nullable && !v ? null : v);
  }
  onArr(path: string, e: Event): void {
    const raw = (e.target as HTMLTextAreaElement).value;
    this.set(path, raw.split('\n').map(x => x.trim()).filter(Boolean));
  }

  kv(path: string): string {
    const v = this.get(path);
    if (!v || typeof v !== 'object') return '';
    return Object.entries(v as S).map(([k, val]) => `${k}=${val}`).join('\n');
  }
  onKv(path: string, e: Event): void {
    const raw = (e.target as HTMLTextAreaElement).value;
    const obj: S = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) obj[line.slice(0, idx).trim()] = line.slice(idx + 1);
    }
    this.set(path, obj);
  }

  asInput(e: Event): string { return (e.target as HTMLInputElement).value; }

  addRecord(): void {
    const name = this.newRecordName().trim();
    if (!name) return;
    const sec = this.activeSection();
    if (!sec?.recordPath) return;
    this.set(`${sec.recordPath}.${name}`, { transport: 'stdio', command: '', args: [], env: {}, url: '' });
    this.newRecordName.set('');
  }

  removeRecord(key: string): void {
    const sec = this.activeSection();
    if (!sec?.recordPath) return;
    this.cfg.update(root => {
      const next = JSON.parse(JSON.stringify(root)) as S;
      const parts = sec.recordPath!.split('.');
      let obj: S = next;
      for (const p of parts) {
        if (!obj[p] || typeof obj[p] !== 'object') return root;
        obj = obj[p] as S;
      }
      delete obj[key];
      return next;
    });
    this.saved.set(false);
  }

  recordGroupsFor(key: string): GroupDef[] {
    const sec = this.activeSection();
    if (!sec?.recordGroups) return [];
    return sec.recordGroups.map(g => ({
      ...g, fields: g.fields.map(f => ({ ...f, path: f.path.replace('{key}', key) })),
    }));
  }

  save(): void {
    this.saving.set(true); this.error.set('');
    this.api.saveConfig(this.cfg() as Record<string, unknown>).subscribe({
      next: () => { this.saving.set(false); this.saved.set(true); },
      error: (e: unknown) => {
        this.saving.set(false);
        this.error.set((e as { error?: { error?: string } })?.error?.error ?? String(e));
      },
    });
  }

  // ── config access ────────────────────────────────────────────────────────

  private get(path: string): unknown {
    const parts = path.split('.');
    let obj: unknown = this.cfg();
    for (const p of parts) {
      if (obj == null || typeof obj !== 'object') return undefined;
      obj = (obj as S)[p];
    }
    return obj;
  }

  private set(path: string, value: unknown): void {
    const parts = path.split('.');
    this.cfg.update(root => {
      const next = { ...root };
      let obj = next as S;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const child = obj[p];
        obj[p] = child && typeof child === 'object' && !Array.isArray(child)
          ? { ...(child as S) } : {};
        obj = obj[p] as S;
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
    this.saved.set(false);
  }

  // ── schema builder ────────────────────────────────────────────────────────

  private buildSections(schema: ConfigSchemaResponse): SectionDef[] {
    const raw = schema.schema as S;
    const defs = (raw['definitions'] as S) ?? {};
    const root = this.resolveRef(raw, defs);
    const topProps = (root?.['properties'] as S) ?? {};

    const order = ['agents', 'providers', 'channels', 'tools', 'mcp'];
    const labels: S = { agents: 'Agent', providers: 'Providers', channels: 'Channels', tools: 'Tools', mcp: 'MCP' };

    return order.filter(k => topProps[k]).map(k => {
      const ss = this.resolveRef(topProps[k], defs);
      const label = String(labels[k] ?? this.toLabel(k));
      if (k === 'providers') return this.buildSubtabSection(k, label, ss, defs);
      if (k === 'mcp') return this.buildMcpSection(label);
      return { key: k, label, mode: 'normal' as const, cards: this.buildCards(ss, k, defs) };
    });
  }

  private buildMcpSection(label: string): SectionDef {
    const recordGroups: GroupDef[] = [{
      fields: [
        { path: 'mcp.servers.{key}.transport', label: 'Transport', type: 'select',
          options: ['stdio', 'sse', 'http'], nullable: false,
          help: 'stdio = local process; sse / http = remote server' },
        { path: 'mcp.servers.{key}.command', label: 'Command', type: 'text', nullable: false,
          help: 'Executable for stdio transport (e.g. npx, uvx, python)' },
        { path: 'mcp.servers.{key}.args', label: 'Arguments', type: 'textarea', nullable: false,
          help: 'One argument per line (e.g. -y @modelcontextprotocol/server-filesystem /path)' },
        { path: 'mcp.servers.{key}.env', label: 'Environment', type: 'kvtextarea', nullable: false,
          help: 'Extra env vars for stdio — KEY=value, one per line. Full secret: API_KEY=vault:config.mcp.servers.myserver.apikey — Inline: TOKEN=Bearer $vault:config.mcp.servers.myserver.token' },
        { path: 'mcp.servers.{key}.url', label: 'URL', type: 'text', nullable: false,
          help: 'Server URL for sse or http transport (e.g. http://localhost:3001/sse)' },
        { path: 'mcp.servers.{key}.headers', label: 'HTTP Headers', type: 'kvtextarea', nullable: false,
          help: 'HTTP headers for sse/http — Header=value, one per line. Full secret: Authorization=vault:config.mcp.servers.myserver.token — Inline: Authorization=Bearer $vault:config.mcp.servers.myserver.token' },
        { path: 'mcp.servers.{key}.alwaysInclude', label: 'Always Include Tools', type: 'boolean', nullable: false,
          help: 'Off (default): tools only sent to the LLM when message keywords match — saves tokens. On: always included regardless of the message.' },
      ],
    }];
    return { key: 'mcp', label, mode: 'dynamic-record', cards: [], recordPath: 'mcp.servers', recordGroups };
  }

  /** Providers: subtabs per key, shared card template with {sub} placeholder in paths. */
  private buildSubtabSection(key: string, label: string, schema: S | null, defs: S): SectionDef {
    const props = (schema?.['properties'] as S) ?? {};
    const subKeys = Object.keys(props);
    const subLabels: S = Object.fromEntries(
      subKeys.map(k => [k, this.getHint(`${key}.${k}`).label ?? this.toLabel(k)])
    );
    const firstSchema = this.resolveRef(props[subKeys[0]], defs);
    const groups = this.buildGroups(firstSchema, `${key}.{sub}`, defs, new Set());
    return { key, label, mode: 'subtabs', subKeys, subLabels, cards: groups.length ? [{ title: 'Settings', groups }] : [] };
  }

  /** Build CardDef[] from a section's direct sub-objects. Flat primitives → "General" card. */
  private buildCards(schema: S | null, basePath: string, defs: S): CardDef[] {
    const props = (schema?.['properties'] as S) ?? {};
    const general: FieldDef[] = [];
    const cards: CardDef[] = [];

    for (const [key, val] of Object.entries(props)) {
      const path = `${basePath}.${key}`;
      const child = this.resolveRef(val, defs);
      if (this.skippable(child, defs)) continue;

      if (child?.['properties'] || child?.['type'] === 'object') {
        const title = this.getHint(path).label ?? this.toLabel(key);
        const childProps = (child?.['properties'] as S) ?? {};
        const hasEnabled = !!childProps['enabled'];
        const groups = this.buildGroups(child, path, defs, hasEnabled ? new Set(['enabled']) : new Set());
        if (groups.some(g => g.fields.length)) {
          cards.push({ title, enablePath: hasEnabled ? `${path}.enabled` : undefined, groups });
        }
      } else {
        const f = this.buildField(key, val, path, defs);
        if (f) general.push(f);
      }
    }

    if (general.length) cards.unshift({ title: 'General', groups: [{ fields: general }] });
    return cards;
  }

  /**
   * GroupDef[] from an object schema:
   * - Nested objects → named sub-group (fields flattened one level)
   * - Leaf fields → default unlabelled group
   */
  private buildGroups(schema: S | null, basePath: string, defs: S, skip: Set<string>): GroupDef[] {
    const props = (schema?.['properties'] as S) ?? {};
    const defaultFields: FieldDef[] = [];
    const subGroups: GroupDef[] = [];

    for (const [key, val] of Object.entries(props)) {
      if (skip.has(key)) continue;
      const path = `${basePath}.${key}`;
      const child = this.resolveRef(val, defs);
      if (this.skippable(child, defs)) continue;

      if (child?.['properties'] || child?.['type'] === 'object') {
        const groupLabel = this.getHint(path).label ?? this.toLabel(key);
        const fields = this.flatFields(child, path, defs);
        if (fields.length) subGroups.push({ label: groupLabel, fields });
      } else {
        const f = this.buildField(key, val, path, defs);
        if (f) defaultFields.push(f);
      }
    }

    const result: GroupDef[] = [];
    if (defaultFields.length) result.push({ fields: defaultFields });
    return result.concat(subGroups);
  }

  /** Flat FieldDef[] from a schema object — one level, no recursion into sub-objects. */
  private flatFields(schema: S | null, basePath: string, defs: S): FieldDef[] {
    const props = (schema?.['properties'] as S) ?? {};
    const fields: FieldDef[] = [];
    for (const [key, val] of Object.entries(props)) {
      const path = `${basePath}.${key}`;
      const child = this.resolveRef(val, defs);
      if (this.skippable(child, defs) || child?.['properties'] || child?.['type'] === 'object') continue;
      const f = this.buildField(key, val, path, defs);
      if (f) fields.push(f);
    }
    return fields;
  }

  /** Schema leaf → FieldDef. Returns null for unsupported types (object arrays, records). */
  private buildField(key: string, rawVal: unknown, path: string, defs: S): FieldDef | null {
    const s = this.resolveRef(rawVal, defs);
    if (!s) return null;

    const nullable = !!s['_nullable'];
    const hint     = this.getHint(path);
    const label    = hint.label ?? this.toLabel(key);
    const help     = hint.help;

    if (s['enum']) {
      const options = (s['enum'] as unknown[]).filter(v => v !== null).map(String);
      return { path, label, help, type: 'select', options, nullable };
    }
    if (s['type'] === 'boolean') return { path, label, help, type: 'boolean', nullable: false };
    if (s['type'] === 'number' || s['type'] === 'integer') return { path, label, help, type: 'number', nullable };
    if (s['type'] === 'array') {
      const items = this.resolveRef(s['items'], defs);
      return items?.['type'] === 'string' ? { path, label, help, type: 'textarea', nullable: false } : null;
    }
    if (s['type'] === 'string') return { path, label, help, type: hint.sensitive ? 'password' : 'text', nullable };
    return null;
  }

  // ── schema utilities ──────────────────────────────────────────────────────

  /** Resolve $ref. Unwrap anyOf/type-array with null → marks _nullable on result. */
  private resolveRef(val: unknown, defs: S): S | null {
    if (!val || typeof val !== 'object') return null;
    const s = val as S;

    if (typeof s['$ref'] === 'string') {
      return this.resolveRef(defs[s['$ref'].replace('#/definitions/', '')], defs);
    }
    if (Array.isArray(s['anyOf'])) {
      const nonNull = (s['anyOf'] as unknown[]).filter(x => (x as S)?.['type'] !== 'null');
      if (nonNull.length === 1) {
        const base = this.resolveRef(nonNull[0], defs);
        return base ? { ...base, _nullable: true } : null;
      }
    }
    if (Array.isArray(s['type'])) {
      const nonNull = (s['type'] as string[]).filter(t => t !== 'null');
      if (nonNull.length === 1) return { ...s, type: nonNull[0], _nullable: true };
    }
    return s;
  }

  /** True for types we can't edit: records (no fixed properties) or arrays of non-strings. */
  private skippable(s: S | null, defs: S): boolean {
    if (!s) return true;
    if (s['additionalProperties'] !== undefined && !s['properties']) return true;
    if (s['type'] === 'array' && s['items']) {
      const items = this.resolveRef(s['items'], defs);
      if (items && items['type'] !== 'string') return true;
    }
    return false;
  }

  /**
   * Look up UI hint with wildcard fallback.
   * "providers.openai.apiKey" → tries exact, then "providers.*.apiKey"
   * "providers.{sub}.apiKey" → same, since {sub} is replaced by * in fallback
   */
  private getHint(path: string): { label?: string; help?: string; sensitive?: boolean } {
    if (this.hints[path]) return this.hints[path];
    const parts = path.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const w = [...parts.slice(0, i), '*', ...parts.slice(i + 1)].join('.');
      if (this.hints[w]) return this.hints[w];
    }
    return {};
  }

  /** camelCase → "Title Case", with common acronyms uppercased. */
  private toLabel(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()
      .replace(/\b(Api|Imap|Smtp|Ssl|Tls|Url|Id|Http)\b/g, s => s.toUpperCase());
  }
}
