import { Component, OnInit, OnDestroy, signal, computed, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';

interface LogLine {
  raw: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'other';
  time: string;
  lvl: string;
  className: string;
  message: string;
  extra: { key: string; value: string }[];
}

function parseExtra(obj: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ({
      key: k,
      value: typeof v === 'object' ? JSON.stringify(v) : String(v),
    }));
}

function parseLine(raw: string): LogLine {
  const blank: LogLine = { raw, level: 'other', time: '', lvl: '', className: '', message: raw, extra: [] };
  try {
    const obj = JSON.parse(raw);
    const level = ((obj.level ?? '') as string).toLowerCase();
    const lvl = level.toUpperCase();
    const time = obj.timestamp ? new Date(obj.timestamp).toLocaleTimeString() : '';
    const message = String(obj.message ?? obj.msg ?? '');
    const className = String(obj.className ?? '');
    const ctx: Record<string, unknown> = { ...obj };
    for (const k of ['timestamp', 'level', 'message', 'msg', 'className']) delete ctx[k];
    const extra = parseExtra(ctx);
    return {
      raw,
      level: (['debug','info','warn','error'].includes(level) ? level : 'other') as LogLine['level'],
      time, lvl, className, message, extra,
    };
  } catch {
    // Plain text fallback — detect level from content
    const lower = raw.toLowerCase();
    let level: LogLine['level'] = 'other';
    if (lower.includes(' error ') || lower.includes('[error]')) level = 'error';
    else if (lower.includes(' warn ')  || lower.includes('[warn]'))  level = 'warn';
    else if (lower.includes(' info ')  || lower.includes('[info]'))  level = 'info';
    else if (lower.includes(' debug ') || lower.includes('[debug]')) level = 'debug';
    return { ...blank, level, extra: [] };
  }
}

@Component({
  selector: 'app-logs',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <h2>Logs</h2>
          <p>Live tail of the latest log file.</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="input" style="width:auto;padding:4px 8px;font-size:12px" [(ngModel)]="filterLevel">
            <option value="">All levels</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
          <input class="input" style="width:180px;padding:4px 8px;font-size:12px" placeholder="Filter…" [(ngModel)]="filterText" />
          <button class="btn" [class.btn-primary]="autoScroll" (click)="autoScroll = !autoScroll" title="Toggle auto-scroll">
            {{ autoScroll ? '⬇ Auto' : '⏸ Paused' }}
          </button>
          <button class="btn" (click)="clear()">Clear</button>
        </div>
      </div>

      <div class="log-wrap card" #logWrap>
        @if (visible().length === 0) {
          <div class="empty-state">No log lines{{ filterText || filterLevel ? ' matching filter' : '' }}.</div>
        }
        @for (line of visible(); track $index) {
          <div class="log-line {{ line.level }}">
            @if (line.time) { <span class="ll-time">{{ line.time }}</span> }
            @if (line.lvl) {
              <span class="ll-lvl ll-lvl-{{ line.level }}">{{ line.lvl }}</span>
            }
            @if (line.className) {
              <span class="ll-sep">|</span><span class="ll-class">{{ line.className }}</span><span class="ll-sep">|</span>
            }
            @if (line.time) {
              <span class="ll-msg">{{ line.message }}</span>
              @for (e of line.extra; track e.key) {
                <span class="ll-tag"><span class="ll-tag-key">{{ e.key }}</span><span class="ll-tag-val">{{ e.value }}</span></span>
              }
            } @else {
              <span class="ll-raw">{{ line.message }}</span>
            }
          </div>
        }
      </div>

      <div class="status-bar">
        <span>{{ lines().length }} lines</span>
        @if (streaming) { <span class="live">● live</span> }
      </div>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; height: 100vh; padding: 20px; box-sizing: border-box; gap: 12px; }
    .page-header { flex-shrink: 0; }
    .page-header h2 { margin: 0 0 4px; font-size: 18px; }
    .page-header p { margin: 0; color: var(--text-muted); font-size: 13px; }
    .log-wrap { flex: 1; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.7; padding: 12px; background: #0a0c12; border-radius: 8px; }
    .log-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; padding: 1px 0; word-break: break-all; }
    .ll-time  { color: #475569; flex-shrink: 0; }
    .ll-sep   { color: #334155; }
    .ll-lvl   { flex-shrink: 0; font-weight: 600; min-width: 38px; }
    .ll-lvl-error { color: #f87171; }
    .ll-lvl-warn  { color: #fbbf24; }
    .ll-lvl-info  { color: #60a5fa; }
    .ll-lvl-debug { color: #475569; }
    .ll-lvl-other { color: #64748b; }
    .ll-class { color: #a78bfa; flex-shrink: 0; }
    .ll-msg   { color: #e2e8f0;min-width: 0; }
    .ll-tag { display: inline-flex; align-items: center; background: #1e293b; border-radius: 4px; font-size: 11px; overflow: hidden; flex-shrink: 0; }
    .ll-tag-key { color: #64748b; padding: 0 4px; }
    .ll-tag-val { color: #94a3b8; padding: 0 5px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100vw;}
    .ll-raw   { color: #94a3b8; }
    .log-line.error .ll-msg { color: #f87171; }
    .log-line.warn  .ll-msg { color: #fbbf24; }
    .log-line.debug .ll-msg { color: #94a3b8; }
    .status-bar { flex-shrink: 0; display: flex; gap: 16px; font-size: 11px; color: var(--text-muted); }
    .live { color: #22c55e; }
    .btn { padding: 4px 10px; font-size: 12px; }
  `],
})
export class LogsComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('logWrap') logWrapRef!: ElementRef<HTMLDivElement>;

  lines = signal<LogLine[]>([]);
  filterText = '';
  filterLevel = '';
  autoScroll = true;
  streaming = false;

  visible = computed(() => {
    const ft = this.filterText.toLowerCase();
    const fl = this.filterLevel;
    return this.lines().filter(l =>
      (!fl || l.level === fl) &&
      (!ft || l.raw.toLowerCase().includes(ft))
    );
  });

  private es: EventSource | null = null;
  private shouldScroll = false;

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getLogs(500).subscribe(r => {
      this.lines.set(r.lines.map(parseLine));
      this.shouldScroll = true;
      this.startStream();
    });
  }

  ngAfterViewChecked() {
    if (this.shouldScroll && this.autoScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    }
  }

  startStream() {
    const token = localStorage.getItem('verox_token') ?? '';
    // SSE doesn't support custom headers — pass token as query param
    this.es = new EventSource(`/api/logs/stream?token=${encodeURIComponent(token)}`);
    this.streaming = true;
    this.es.onmessage = (e) => {
      try {
        const { line } = JSON.parse(e.data);
        if (!line) return;
        this.lines.update(ls => [...ls.slice(-2000), parseLine(line)]);
        this.shouldScroll = true;
      } catch { /* ignore */ }
    };
    this.es.onerror = () => { this.streaming = false; };
  }

  clear() { this.lines.set([]); }

  scrollToBottom() {
    const el = this.logWrapRef?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  ngOnDestroy() {
    this.es?.close();
  }
}
