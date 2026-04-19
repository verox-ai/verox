import { Component, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ApiService } from '../../../core/api.service';

interface DebugResult {
  systemPrompt: string;
  estimatedTokens: number;
  toolDefsTokens: number;
  totalEstimatedTokens: number;
  toolCount: number;
  toolNames: string[];
  sections: { title: string; chars: number }[];
}

@Component({
  selector: 'app-debug',
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h2>Debug — System Prompt</h2>
          <p class="subtitle">Renders the exact system prompt the agent would send to the LLM right now.</p>
        </div>
        <div class="header-actions">
          <button class="btn" (click)="copy()" [disabled]="!result()">{{ copied() ? '✓ Copied' : 'Copy' }}</button>
          <button class="btn btn-primary" [disabled]="loading()" (click)="load()">
            {{ loading() ? 'Loading…' : '⟳ Refresh' }}
          </button>
        </div>
      </div>

      @if (error()) {
        <div class="error-box">{{ error() }}</div>
      }

      @if (result()) {
        <div class="total-banner">
          <span class="total-label">Total overhead per request (before history)</span>
          <span class="total-value">~{{ result()!.totalEstimatedTokens.toLocaleString() }} tokens</span>
        </div>

        <div class="stats-row">
          <div class="stat">
            <span class="stat-label">System prompt</span>
            <span class="stat-value">{{ result()!.estimatedTokens.toLocaleString() }}</span>
            <span class="stat-sub">tokens</span>
          </div>
          <div class="stat">
            <span class="stat-label">Tool definitions</span>
            <span class="stat-value" [class.warn]="result()!.toolDefsTokens > 3000">{{ result()!.toolDefsTokens.toLocaleString() }}</span>
            <span class="stat-sub">tokens · {{ result()!.toolCount }} tools</span>
          </div>
          <div class="stat">
            <span class="stat-label">Prompt chars</span>
            <span class="stat-value">{{ result()!.systemPrompt.length.toLocaleString() }}</span>
            <span class="stat-sub">characters</span>
          </div>
          <div class="stat">
            <span class="stat-label">Sections</span>
            <span class="stat-value">{{ result()!.sections.length }}</span>
            <span class="stat-sub">&nbsp;</span>
          </div>
        </div>

        <!-- Tool list -->
        <details class="tool-details">
          <summary>Tools loaded ({{ result()!.toolCount }})</summary>
          <div class="tool-list">
            @for (t of result()!.toolNames; track t) {
              <span class="tool-chip">{{ t }}</span>
            }
          </div>
        </details>

        <!-- Section breakdown -->
        <div class="breakdown">
          <div class="breakdown-title">Size by section</div>
          @for (s of result()!.sections; track s.title) {
            <div class="section-row" (click)="scrollTo(s.title)">
              <span class="section-name">{{ s.title }}</span>
              <div class="section-bar-wrap">
                <div class="section-bar" [style.width.%]="pct(s.chars)"></div>
              </div>
              <span class="section-chars">{{ s.chars.toLocaleString() }} ch</span>
              <span class="section-pct">{{ pct(s.chars) | number:'1.0-0' }}%</span>
            </div>
          }
        </div>

        <pre class="prompt-box" #promptBox>{{ result()!.systemPrompt }}</pre>
      } @else if (!loading()) {
        <div class="empty">Click Refresh to load the current system prompt.</div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; max-width: 960px; }
    .page-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; gap: 16px; }
    .header-actions { display: flex; gap: 8px; flex-shrink: 0; }
    h2 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
    .subtitle { margin: 0; font-size: 13px; color: var(--text-muted); }

    .total-banner {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 16px; margin-bottom: 12px;
    }
    .total-label { font-size: 13px; color: var(--text-muted); }
    .total-value { font-size: 18px; font-weight: 700; color: var(--accent); }

    .stats-row { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
    .stat { display: flex; flex-direction: column; gap: 1px; }
    .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
    .stat-value { font-size: 20px; font-weight: 600; }
    .stat-value.warn { color: #f59e0b; }
    .stat-sub { font-size: 11px; color: var(--text-muted); }

    .tool-details { margin-bottom: 16px; font-size: 13px; }
    .tool-details summary { cursor: pointer; color: var(--text-muted); padding: 4px 0; }
    .tool-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .tool-chip {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-family: monospace;
      background: var(--hover-bg); color: var(--text-muted); border: 1px solid var(--border);
    }

    .breakdown {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;
    }
    .breakdown-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); margin-bottom: 10px; }
    .section-row {
      display: grid; grid-template-columns: 220px 1fr 80px 40px;
      align-items: center; gap: 10px; padding: 4px 0;
      cursor: pointer; border-radius: 4px;
    }
    .section-row:hover { background: var(--hover-bg); }
    .section-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .section-bar-wrap { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .section-bar { height: 100%; background: var(--accent); border-radius: 3px; }
    .section-chars { font-size: 11px; color: var(--text-muted); text-align: right; }
    .section-pct { font-size: 11px; color: var(--text-muted); text-align: right; }

    .prompt-box {
      white-space: pre-wrap; word-break: break-word;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px; font-size: 12px;
      font-family: monospace; line-height: 1.6;
      max-height: 65vh; overflow-y: auto;
    }

    .error-box {
      background: var(--danger-bg, #2d1b1b); color: var(--danger, #f87171);
      border: 1px solid var(--danger, #f87171); border-radius: 6px;
      padding: 12px 16px; font-size: 13px; margin-bottom: 16px;
    }
    .empty { color: var(--text-muted); font-size: 13px; padding: 40px 0; text-align: center; }

    .btn { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 13px; cursor: pointer; }
    .btn:hover { background: var(--hover-bg); }
    .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn-primary:hover { opacity: .9; }
    .btn:disabled { opacity: .5; cursor: default; }
  `],
  imports: [DecimalPipe],
})
export class DebugComponent {
  result = signal<DebugResult | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  copied = signal(false);

  constructor(private api: ApiService) {}

  load() {
    this.loading.set(true);
    this.error.set(null);
    this.api.getDebugPrompt().subscribe({
      next: data => { this.result.set(data as DebugResult); this.loading.set(false); },
      error: err => { this.error.set(String(err?.error?.error ?? err)); this.loading.set(false); },
    });
  }

  pct(chars: number): number {
    const total = this.result()?.systemPrompt.length;
    return total ? Math.round((chars / total) * 100) : 0;
  }

  scrollTo(title: string) {
    const box = document.querySelector('.prompt-box');
    if (!box) return;
    const text = box.textContent ?? '';
    const idx = text.indexOf(title);
    if (idx < 0) return;
    // Approximate scroll position by char ratio
    const ratio = idx / text.length;
    box.scrollTop = ratio * box.scrollHeight;
  }

  copy() {
    const text = this.result()?.systemPrompt;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }
}
