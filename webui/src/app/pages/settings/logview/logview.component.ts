import { Component, OnInit, OnDestroy, signal, computed, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';

interface LogLine {
  raw: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'other';
  text: string;
}

function parseLine(raw: string): LogLine {
  const lower = raw.toLowerCase();
  let level: LogLine['level'] = 'other';
  if (lower.includes('"level":"error"') || lower.includes(' error ') || lower.includes('[error]')) level = 'error';
  else if (lower.includes('"level":"warn"') || lower.includes(' warn ') || lower.includes('[warn]')) level = 'warn';
  else if (lower.includes('"level":"info"') || lower.includes(' info ') || lower.includes('[info]')) level = 'info';
  else if (lower.includes('"level":"debug"') || lower.includes(' debug ') || lower.includes('[debug]')) level = 'debug';

  // Pretty-print JSON log lines
  let text = raw;
  try {
    const obj = JSON.parse(raw);
    const ts = obj.timestamp ? new Date(obj.timestamp).toLocaleTimeString() : '';
    const lvl = (obj.level ?? '').toUpperCase().padEnd(5);
    const msg = obj.message ?? obj.msg ?? raw;
    const ctx = { ...obj };
    delete ctx['timestamp']; delete ctx['level']; delete ctx['message']; delete ctx['msg'];
    const extra = Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
    text = `${ts} ${lvl} ${msg}${extra}`;
    if (obj.level) level = (obj.level.toLowerCase() as LogLine['level']) || 'other';
  } catch { /* not JSON, show raw */ }

  return { raw, level, text };
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
          <div class="log-line {{ line.level }}">{{ line.text }}</div>
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
    .log-wrap { flex: 1; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.6; padding: 12px; background: #0a0c12; border-radius: 8px; }
    .log-line { white-space: pre-wrap; word-break: break-all; padding: 1px 0; }
    .log-line.error { color: #f87171; }
    .log-line.warn  { color: #fbbf24; }
    .log-line.info  { color: #e2e8f0; }
    .log-line.debug { color: #64748b; }
    .log-line.other { color: #94a3b8; }
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
      (!ft || l.text.toLowerCase().includes(ft))
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
