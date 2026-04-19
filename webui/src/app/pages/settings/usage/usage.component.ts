import { Component, OnInit, signal, computed } from '@angular/core';
import { DecimalPipe, CurrencyPipe } from '@angular/common';
import { ApiService, UsageStats, UsageDayRow } from '../../../core/api.service';

type Period = 'today' | 'week' | 'month' | 'all';

@Component({
  selector: 'app-usage',
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Token Usage</h2>
        <div class="period-tabs">
          @for (p of periods; track p.value) {
            <button class="tab" [class.active]="period() === p.value" (click)="setPeriod(p.value)">{{ p.label }}</button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="empty">Loading…</div>
      } @else if (stats()) {
        <div class="summary-cards">
          <div class="card">
            <div class="card-label">Total Tokens</div>
            <div class="card-value">{{ stats()!.total_tokens | number }}</div>
          </div>
          <div class="card">
            <div class="card-label">Prompt</div>
            <div class="card-value">{{ stats()!.prompt_tokens | number }}</div>
          </div>
          <div class="card">
            <div class="card-label">Completion</div>
            <div class="card-value">{{ stats()!.completion_tokens | number }}</div>
          </div>
          @if (hasCosts()) {
            <div class="card card-cost">
              <div class="card-label">Est. Cost</div>
              <div class="card-value">{{ totalCost() | currency:'USD':'symbol':'1.4-4' }}</div>
            </div>
          } @else {
            <div class="card">
              <div class="card-label">Days</div>
              <div class="card-value">{{ uniqueDays().length }}</div>
            </div>
          }
        </div>

        @if (!hasCosts()) {
          <div class="hint">
            💡 Add <strong>Cost per 1M tokens</strong> to your provider settings to see cost estimates.
          </div>
        }

        @if (stats()!.by_day.length === 0) {
          <div class="empty">No usage data for this period.</div>
        } @else {
          <table class="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Model</th>
                <th>Prompt</th>
                <th>Completion</th>
                <th>Total</th>
                @if (hasCosts()) { <th>Est. Cost</th> }
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (row of stats()!.by_day; track row.date + row.model) {
                <tr>
                  <td>{{ row.date }}</td>
                  <td><span class="badge">{{ row.model || 'unknown' }}</span></td>
                  <td>{{ row.prompt_tokens | number }}</td>
                  <td>{{ row.completion_tokens | number }}</td>
                  <td>{{ row.prompt_tokens + row.completion_tokens | number }}</td>
                  @if (hasCosts()) {
                    <td class="cost-cell">
                      @if (rowCost(row) !== null) {
                        {{ rowCost(row) | currency:'USD':'symbol':'1.4-4' }}
                      } @else {
                        <span class="text-muted">—</span>
                      }
                    </td>
                  }
                  <td>
                    <div class="bar-wrap">
                      <div class="bar" [style.width.%]="barWidth(row.prompt_tokens + row.completion_tokens)"></div>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; max-width: 960px; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    h2 { margin: 0; font-size: 17px; font-weight: 600; }

    .period-tabs { display: flex; gap: 4px; }
    .tab {
      padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px;
      background: none; color: var(--text-muted); font-size: 13px; cursor: pointer;
      transition: background .12s, color .12s;
    }
    .tab:hover { background: var(--hover-bg); color: var(--text); }
    .tab.active { background: var(--badge-blue-bg); color: var(--accent); border-color: var(--accent); }

    .summary-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px;
    }
    .card-cost { border-color: var(--success); }
    .card-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
    .card-value { font-size: 22px; font-weight: 600; }

    .hint {
      font-size: 12px; color: var(--text-muted); margin-bottom: 16px;
      padding: 8px 12px; background: var(--hover-bg); border-radius: 6px;
    }

    .table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .table th { text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--border); }
    .table td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
    .table tr:last-child td { border-bottom: none; }

    .badge {
      display: inline-block; padding: 2px 7px; border-radius: 4px;
      background: var(--hover-bg); font-size: 11px; color: var(--text-muted);
    }
    .cost-cell { font-variant-numeric: tabular-nums; color: var(--success); }
    .text-muted { color: var(--text-muted); }

    .bar-wrap { width: 80px; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .bar { height: 100%; background: var(--accent); border-radius: 3px; transition: width .3s; }

    .empty { color: var(--text-muted); font-size: 13px; padding: 40px 0; text-align: center; }
  `],
  imports: [DecimalPipe, CurrencyPipe],
})
export class UsageComponent implements OnInit {
  stats = signal<UsageStats | null>(null);
  loading = signal(true);
  period = signal<Period>('month');

  hasCosts = computed(() => {
    const s = this.stats();
    return s != null && Object.keys(s.costs).length > 0;
  });

  totalCost = computed(() => {
    const s = this.stats();
    if (!s) return 0;
    return s.by_day.reduce((sum, row) => sum + (this.rowCost(row) ?? 0), 0);
  });

  periods: { value: Period; label: string }[] = [
    { value: 'today', label: 'Today' },
    { value: 'week',  label: '7 days' },
    { value: 'month', label: '30 days' },
    { value: 'all',   label: 'All time' },
  ];

  constructor(private api: ApiService) {}

  ngOnInit() { this.load(); }

  setPeriod(p: Period) {
    this.period.set(p);
    this.load();
  }

  uniqueDays() {
    const s = this.stats();
    if (!s) return [];
    return [...new Set(s.by_day.map(r => r.date))];
  }

  rowCost(row: UsageDayRow): number | null {
    const s = this.stats();
    if (!s) return null;
    const cost = s.costs[row.model];
    if (!cost) return null;
    return (row.prompt_tokens / 1_000_000) * cost.input
         + (row.completion_tokens / 1_000_000) * cost.output;
  }

  barWidth(total: number): number {
    const s = this.stats();
    if (!s || s.by_day.length === 0) return 0;
    const max = Math.max(...s.by_day.map(r => r.prompt_tokens + r.completion_tokens));
    return max === 0 ? 0 : Math.round((total / max) * 100);
  }

  private load() {
    this.loading.set(true);
    this.api.getUsageStats(this.period()).subscribe({
      next: data => { this.stats.set(data); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }
}
