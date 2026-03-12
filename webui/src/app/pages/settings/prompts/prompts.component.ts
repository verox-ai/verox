import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';

const REQUIRED = new Set([
  'agent-identity.md', 'agent-identity-system.md', 'subagent.md',
  'memory-extraction.md', 'compaction.md', 'heartbeat.md', 'tool-descriptions.json',
]);

@Component({
  selector: 'app-prompts',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Prompt Editor</h2>
        <p>Edit the agent's prompt files from <code>workspace/prompts/</code>. Changes take effect on the next conversation turn.</p>
      </div>

      <div class="editor-layout">
        <!-- File list sidebar -->
        <div class="file-sidebar">
          @for (f of files(); track f) {
            <button class="file-btn" [class.active]="activeFile() === f" (click)="openFile(f)">
              <span class="file-name">{{ f }}</span>
              @if (isRequired(f)) { <span class="badge-req">core</span> }
            </button>
          }
          @if (!files().length) {
            <div style="padding:12px;font-size:12px;color:var(--text-muted)">No prompt files found.</div>
          }
        </div>

        <!-- Editor pane -->
        <div class="editor-pane">
          @if (activeFile()) {
            <div class="editor-header">
              <span class="editor-filename">{{ activeFile() }}</span>
              @if (isRequired(activeFile()!)) {
                <span class="badge-req" style="margin-left:8px">core prompt</span>
              }
              <span style="flex:1"></span>
              <button class="btn btn-primary" (click)="save()" [disabled]="saving() || !dirty()">
                {{ saving() ? 'Saving…' : 'Save' }}
              </button>
              @if (saveMsg()) {
                <span [class]="saveMsg()!.startsWith('✓') ? 'ok-text' : 'error-text'">{{ saveMsg() }}</span>
              }
            </div>
            @if (loading()) {
              <div style="padding:16px;color:var(--text-muted);font-size:13px">Loading…</div>
            } @else {
              <textarea
                class="editor-textarea"
                [class.monospace]="!activeFile()?.endsWith('.md')"
                [ngModel]="content()"
                (ngModelChange)="onEdit($event)"
                [placeholder]="'Edit ' + activeFile()"></textarea>
            }
          } @else {
            <div class="empty-state" style="margin:40px auto">Select a file to edit.</div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    .editor-layout { display: flex; gap: 16px; align-items: flex-start; }
    .file-sidebar {
      width: 210px; flex-shrink: 0; background: var(--surface);
      border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
    }
    .file-btn {
      display: flex; align-items: center; justify-content: space-between;
      width: 100%; padding: 9px 12px; background: none; border: none;
      border-bottom: 1px solid var(--border); color: var(--text-muted);
      font-size: 12.5px; cursor: pointer; text-align: left; gap: 6px;
      transition: background .1s;
    }
    .file-btn:last-child { border-bottom: none; }
    .file-btn:hover { background: var(--hover-bg); color: var(--text); }
    .file-btn.active { background: var(--active-bg); color: var(--text); }
    .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .badge-req { font-size: 10px; background: var(--accent-muted); color: var(--accent-text);
      padding: 1px 5px; border-radius: 3px; flex-shrink: 0; white-space: nowrap; }
    .editor-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .editor-header { display: flex; align-items: center; gap: 8px; padding: 0 2px; }
    .editor-filename { font-size: 13px; font-weight: 600; }
    .editor-textarea { min-height: 560px; font-size: 13px; resize: vertical; width: 100%;
      box-sizing: border-box; line-height: 1.6; background: var(--bg); color: var(--text); }
    .monospace { font-family: monospace; }
    .ok-text { color: var(--success-text); font-size: 13px; }
    .error-text { color: var(--error-text); font-size: 13px; }
    code { background: var(--surface); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  `],
})
export class PromptsComponent implements OnInit {
  files = signal<string[]>([]);
  activeFile = signal<string | null>(null);
  content = signal('');
  originalContent = '';
  loading = signal(false);
  saving = signal(false);
  saveMsg = signal<string | null>(null);
  dirty = signal(false);

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getPromptFiles().subscribe(f => this.files.set(f));
  }

  openFile(filename: string) {
    if (this.activeFile() === filename) return;
    this.activeFile.set(filename);
    this.dirty.set(false);
    this.saveMsg.set(null);
    this.loading.set(true);
    this.api.getPromptFile(filename).subscribe({
      next: (r) => {
        this.content.set(r.content);
        this.originalContent = r.content;
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); },
    });
  }

  onEdit(value: string) {
    this.content.set(value);
    this.dirty.set(value !== this.originalContent);
    this.saveMsg.set(null);
  }

  save() {
    const filename = this.activeFile();
    if (!filename) return;
    this.saving.set(true);
    this.saveMsg.set(null);
    this.api.savePromptFile(filename, this.content()).subscribe({
      next: () => {
        this.saving.set(false);
        this.originalContent = this.content();
        this.dirty.set(false);
        this.saveMsg.set('✓ Saved');
        setTimeout(() => this.saveMsg.set(null), 3000);
      },
      error: (err) => {
        this.saving.set(false);
        this.saveMsg.set(err?.error?.error ?? 'Save failed.');
      },
    });
  }

  isRequired(f: string): boolean {
    return REQUIRED.has(f);
  }
}
