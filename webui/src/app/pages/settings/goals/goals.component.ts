import { Component, OnInit, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, Goal, GoalStatus } from '../../../core/api.service';

const STATUS_ICONS: Record<GoalStatus, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
  failed: '✗',
  cancelled: '–',
};

const STEP_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
  failed: '✗',
  skipped: '–',
};

@Component({
  selector: 'app-goals',
  imports: [DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Goals</h2>
        <p>Persistent multi-step goals tracked by the agent across sessions.</p>
        <div class="filter-row">
          @for (f of filters; track f.value) {
            <button class="btn-sm" [class.active]="filter() === f.value" (click)="setFilter(f.value)">
              {{ f.label }}
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="empty-state">Loading…</div>
      } @else if (!filtered().length) {
        <div class="empty-state">No goals found. Ask the agent to create one with <code>goal_create</code>.</div>
      } @else {
        @for (goal of filtered(); track goal.id) {
          <div class="card goal-card" [class.expanded]="expanded() === goal.id">
            <div class="goal-header" (click)="toggle(goal.id)">
              <span class="status-icon" [attr.data-status]="goal.status">{{ statusIcon(goal.status) }}</span>
              <div class="goal-meta">
                <strong>{{ goal.title }}</strong>
                <span class="goal-desc">{{ goal.description }}</span>
              </div>
              <div class="goal-right">
                <span class="step-count">{{ doneCount(goal) }}/{{ goal.steps.length }} steps</span>
                <span class="goal-date">{{ goal.updatedAt | date:'dd MMM HH:mm' }}</span>
                <button class="btn-icon danger" title="Delete goal" (click)="$event.stopPropagation(); remove(goal)">✕</button>
              </div>
            </div>

            @if (expanded() === goal.id) {
              <div class="goal-detail">
                @if (goal.result) {
                  <div class="goal-result">{{ goal.result }}</div>
                }
                <div class="steps">
                  @for (step of goal.steps; track step.id) {
                    <div class="step" [attr.data-status]="step.status">
                      <span class="step-icon">{{ stepIcon(step.status) }}</span>
                      <span class="step-title">{{ step.title }}</span>
                      @if (step.notes) {
                        <span class="step-notes">{{ step.notes }}</span>
                      }
                    </div>
                  }
                </div>
                <div class="goal-actions">
                  @if (goal.status === 'in_progress' || goal.status === 'pending') {
                    <button class="btn-sm danger" (click)="cancel(goal)">Cancel</button>
                  }
                  <span class="goal-id">ID: {{ goal.id }}</span>
                </div>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .filter-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .btn-sm { background: var(--surface2, #2a2a2a); border: 1px solid var(--border, #444); color: var(--text, #eee); padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn-sm.active { background: var(--accent, #4a9eff); color: #fff; border-color: var(--accent, #4a9eff); }
    .btn-sm.danger { border-color: var(--danger, #c0392b); color: var(--danger, #c0392b); }
    .btn-sm:hover:not(.active) { background: var(--hover-bg); }
    .btn-icon { background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--text-muted); }
    .btn-icon.danger:hover { background: var(--danger, #c0392b); color: #fff; }
    .empty-state { padding: 32px; text-align: center; color: var(--text-muted); font-size: 14px; }
    .goal-card { margin-bottom: 8px; padding: 0; overflow: hidden; }
    .goal-header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; }
    .goal-header:hover { background: var(--hover-bg); }
    .status-icon { font-size: 14px; flex-shrink: 0; }
    [data-status="completed"] { color: var(--success, #27ae60); }
    [data-status="in_progress"] { color: var(--accent, #4a9eff); }
    [data-status="failed"] { color: var(--danger, #c0392b); }
    [data-status="cancelled"] { color: var(--text-muted); }
    .goal-meta { flex: 1; min-width: 0; }
    .goal-meta strong { display: block; font-size: 14px; }
    .goal-desc { font-size: 12px; color: var(--text-muted); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .goal-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .step-count { font-size: 12px; color: var(--text-muted); }
    .goal-date { font-size: 11px; color: var(--text-muted); }
    .goal-detail { padding: 0 14px 14px 38px; border-top: 1px solid var(--border, #333); }
    .goal-result { font-size: 13px; color: var(--text-muted); margin: 10px 0; font-style: italic; }
    .steps { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
    .step { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; }
    .step-icon { flex-shrink: 0; margin-top: 1px; }
    .step-title { flex: 1; }
    .step-notes { font-size: 11px; color: var(--text-muted); }
    .goal-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
    .goal-id { font-size: 11px; color: var(--text-muted); font-family: monospace; }
  `]
})
export class GoalsComponent implements OnInit {
  goals = signal<Goal[]>([]);
  filter = signal<GoalStatus | 'all'>('all');
  expanded = signal<string | null>(null);
  loading = signal(true);

  filters: { label: string; value: GoalStatus | 'all' }[] = [
    { label: 'All', value: 'all' },
    { label: 'Active', value: 'in_progress' },
    { label: 'Pending', value: 'pending' },
    { label: 'Completed', value: 'completed' },
    { label: 'Failed', value: 'failed' },
    { label: 'Cancelled', value: 'cancelled' },
  ];

  filtered = computed(() => {
    const f = this.filter();
    return f === 'all' ? this.goals() : this.goals().filter(g => g.status === f);
  });

  constructor(private api: ApiService) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.getGoals().subscribe({ next: g => { this.goals.set(g); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  setFilter(f: GoalStatus | 'all') {
    this.filter.set(f);
    this.expanded.set(null);
  }

  toggle(id: string) {
    this.expanded.update(e => e === id ? null : id);
  }

  statusIcon(s: GoalStatus) { return STATUS_ICONS[s] ?? '?'; }
  stepIcon(s: string) { return STEP_ICONS[s] ?? '?'; }
  doneCount(g: Goal) { return g.steps.filter(s => s.status === 'completed').length; }

  cancel(goal: Goal) {
    if (!confirm(`Cancel goal "${goal.title}"?`)) return;
    this.api.updateGoal(goal.id, { status: 'cancelled' }).subscribe(() => this.load());
  }

  remove(goal: Goal) {
    if (!confirm(`Delete goal "${goal.title}"?`)) return;
    this.api.deleteGoal(goal.id).subscribe(() => this.goals.update(gs => gs.filter(g => g.id !== goal.id)));
  }
}
