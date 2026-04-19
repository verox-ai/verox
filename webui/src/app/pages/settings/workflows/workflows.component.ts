import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, SavedWorkflow } from '../../../core/api.service';

interface EditState {
  name: string;
  description: string;
  summary: string;
  steps: string;        // newline-separated
  tools_needed: string; // newline-separated
}

@Component({
  selector: 'app-workflows',
  imports: [DatePipe, FormsModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Saved Workflows</h2>
        <p>Reusable multi-step plans confirmed by the user. Activate with <code>workflow_activate(name: "...")</code>.</p>
      </div>

      @if (workflows().length) {
        <div class="workflow-list">
          @for (w of workflows(); track w.id) {
            <div class="card workflow-card" [class.editing]="editingId() === w.id">

              @if (editingId() === w.id) {
                <!-- ── Edit mode ── -->
                <div class="edit-form">
                  <label class="field-label">Name</label>
                  <input class="input" [(ngModel)]="draft.name">

                  <label class="field-label">Description</label>
                  <textarea class="input" rows="2" [(ngModel)]="draft.description"></textarea>

                  <label class="field-label">Summary</label>
                  <textarea class="input" rows="2" [(ngModel)]="draft.summary"></textarea>

                  <label class="field-label">Steps <span class="hint">one per line</span></label>
                  <textarea class="input" rows="5" [(ngModel)]="draft.steps"></textarea>

                  <label class="field-label">Tools needed <span class="hint">one per line</span></label>
                  <textarea class="input" rows="3" [(ngModel)]="draft.tools_needed"></textarea>

                  <div class="edit-actions">
                    <button class="btn btn-primary" [disabled]="saving()" (click)="save(w)">
                      {{ saving() ? 'Saving…' : 'Save' }}
                    </button>
                    <button class="btn" (click)="cancelEdit()">Cancel</button>
                  </div>
                </div>
              } @else {
                <!-- ── View mode ── -->
                <div class="workflow-header">
                  <div>
                    <span class="workflow-name">{{ w.name }}</span>
                    <span class="workflow-date">{{ w.created_at | date:'dd MMM yyyy' }}</span>
                  </div>
                  <div class="header-actions">
                    <button class="btn-icon" title="Edit workflow" (click)="startEdit(w)">✎</button>
                    <button class="btn-icon danger" title="Delete workflow"
                      [disabled]="deleting() === w.name"
                      (click)="remove(w)">
                      {{ deleting() === w.name ? '…' : '✕' }}
                    </button>
                  </div>
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
              }

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
    .workflow-card.editing { border-color: var(--accent); }
    .workflow-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .workflow-name { font-weight: 600; font-size: 14px; margin-right: 10px; }
    .workflow-date { font-size: 11px; color: var(--text-muted); }
    .workflow-summary { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; }
    .workflow-tools { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
    .tool-badge {
      background: var(--active-bg); color: var(--accent);
      border: 1px solid var(--accent-muted);
      padding: 1px 8px; border-radius: 10px; font-size: 11px; font-family: monospace;
    }
    .workflow-steps { margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-muted); line-height: 1.7; }
    .header-actions { display: flex; gap: 4px; }
    .btn-icon { background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--text-muted); }
    .btn-icon:hover { background: var(--hover-bg); color: var(--text); }
    .btn-icon.danger:hover { background: var(--danger); color: #fff; }
    .btn-icon:disabled { opacity: 0.4; cursor: default; }

    .edit-form { display: flex; flex-direction: column; gap: 8px; }
    .field-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; }
    .hint { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 6px; }
    .input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg); color: var(--text); font-size: 13px; font-family: inherit; resize: vertical; }
    .input:focus { outline: none; border-color: var(--accent); }
    .edit-actions { display: flex; gap: 8px; margin-top: 4px; }
    .btn { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 13px; cursor: pointer; }
    .btn:hover { background: var(--hover-bg); }
    .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn-primary:hover { opacity: .9; }
    .btn:disabled { opacity: .5; cursor: default; }
  `]
})
export class WorkflowsComponent implements OnInit {
  workflows = signal<SavedWorkflow[]>([]);
  deleting  = signal<string | null>(null);
  editingId = signal<string | null>(null);
  saving    = signal(false);
  draft: EditState = { name: '', description: '', summary: '', steps: '', tools_needed: '' };

  constructor(private api: ApiService) {}

  ngOnInit() { this.load(); }

  load() {
    this.api.getWorkflows().subscribe(w => this.workflows.set(w));
  }

  startEdit(w: SavedWorkflow) {
    this.draft = {
      name:         w.name,
      description:  w.description,
      summary:      w.summary,
      steps:        w.steps.join('\n'),
      tools_needed: w.tools_needed.join('\n'),
    };
    this.editingId.set(w.id);
  }

  cancelEdit() { this.editingId.set(null); }

  save(w: SavedWorkflow) {
    this.saving.set(true);
    const patch: Partial<SavedWorkflow> = {
      name:         this.draft.name.trim(),
      description:  this.draft.description.trim(),
      summary:      this.draft.summary.trim(),
      steps:        this.draft.steps.split('\n').map(s => s.trim()).filter(Boolean),
      tools_needed: this.draft.tools_needed.split('\n').map(s => s.trim()).filter(Boolean),
    };
    this.api.updateWorkflow(w.name, patch).subscribe({
      next: updated => {
        this.workflows.update(list => list.map(x => x.id === w.id ? updated : x));
        this.editingId.set(null);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
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
