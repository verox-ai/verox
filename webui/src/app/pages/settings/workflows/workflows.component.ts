import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, SavedWorkflow } from '../../../core/api.service';

@Component({
  selector: 'app-workflows',
  imports: [DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Saved Workflows</h2>
        <p>Reusable multi-step plans confirmed by the user. Activate with <code>workflow_activate(name: "...")</code>.</p>
      </div>

      @if (workflows().length) {
        <div class="workflow-list">
          @for (w of workflows(); track w.id) {
            <div class="card workflow-card">
              <div class="workflow-header">
                <div>
                  <span class="workflow-name">{{ w.name }}</span>
                  <span class="workflow-date">{{ w.created_at | date:'dd MMM yyyy' }}</span>
                </div>
                <button class="btn-icon danger" title="Delete workflow"
                  [disabled]="deleting() === w.name"
                  (click)="remove(w)">
                  {{ deleting() === w.name ? '…' : '✕' }}
                </button>
              </div>
              <div class="workflow-summary">{{ w.description || w.summary }}</div>
              <div class="workflow-tools">
                @for (t of w.tools_needed; track t) {
                  <span class="tool-badge">{{ t }}</span>
                }
              </div>
              <ol class="workflow-steps">
                @for (s of w.steps; track $index) {
                  <li>{{ s }}</li>
                }
              </ol>
            </div>
          }
        </div>
      } @else {
        <div class="card">
          <div class="empty-state">
            No saved workflows yet.<br>
            Ask the agent to run a multi-step task using <code>workflow_plan</code>,
            confirm it, then save it with <code>workflow_save</code>.
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .workflow-list { display: flex; flex-direction: column; gap: 12px; }
    .workflow-card { padding: 16px; }
    .workflow-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .workflow-name { font-weight: 600; font-size: 14px; margin-right: 10px; }
    .workflow-date { font-size: 11px; color: var(--text-muted); }
    .workflow-summary { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; }
    .workflow-tools { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
    .tool-badge {
      background: rgba(59,130,246,.12); color: var(--accent);
      border: 1px solid rgba(59,130,246,.25);
      padding: 1px 8px; border-radius: 10px; font-size: 11px; font-family: monospace;
    }
    .workflow-steps { margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-muted); line-height: 1.7; }
    .btn-icon { background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--text-muted); }
    .btn-icon.danger:hover { background: var(--danger, #c0392b); color: #fff; }
    .btn-icon:disabled { opacity: 0.4; cursor: default; }
  `]
})
export class WorkflowsComponent implements OnInit {
  workflows = signal<SavedWorkflow[]>([]);
  deleting  = signal<string | null>(null);

  constructor(private api: ApiService) {}

  ngOnInit() { this.load(); }

  load() {
    this.api.getWorkflows().subscribe(w => this.workflows.set(w));
  }

  remove(w: SavedWorkflow) {
    if (!confirm(`Delete workflow "${w.name}"?`)) return;
    this.deleting.set(w.name);
    this.api.deleteWorkflow(w.name).subscribe({
      next: () => {
        this.workflows.update(list => list.filter(x => x.name !== w.name));
        this.deleting.set(null);
      },
      error: () => this.deleting.set(null)
    });
  }
}
