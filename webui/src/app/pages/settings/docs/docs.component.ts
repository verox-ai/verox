import { Component, OnInit, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, DocFile } from '../../../core/api.service';

type DocPath = { name: string; path: string };

const PAGE_SIZE = 20;

@Component({
  selector: 'app-docs',
  imports: [DatePipe, FormsModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Document Index</h2>
        <p>Files indexed for semantic search via <code>docs_search</code>.</p>
        <button class="btn-sm" [disabled]="indexing()" (click)="runIndex()">
          {{ indexing() ? 'Indexing…' : 'Index Now' }}
        </button>
        @if (indexResult()) {
          <span class="index-result">{{ indexResult() }}</span>
        }
      </div>
      <div class="card settings-card">
        <h3 style="margin:0 0 12px">Upload Settings</h3>
        <label class="setting-row">
          <input type="checkbox" [ngModel]="skipIndex()" (ngModelChange)="skipIndex.set($event)" />
          <span><strong>Skip index on upload</strong> — for transient consume folders (e.g. Paperless-ngx). Files won't be indexed on upload; use the cron schedule below to index from the permanent library path instead.</span>
        </label>
        <label class="setting-row" style="margin-top:12px">
          <span style="min-width:160px;flex-shrink:0"><strong>Auto-index schedule</strong></span>
          <input type="text" class="input-sm" [ngModel]="indexCronSchedule()" (ngModelChange)="indexCronSchedule.set($event)" placeholder="e.g. 0 * * * * (hourly)" />
        </label>

        <h3 style="margin:20px 0 10px">Indexed Paths</h3>
        <div class="paths-list">
          @for (p of docPaths(); track $index; let i = $index) {
            @if (editingIndex() === i) {
              <div class="path-row editing">
                <input class="input-sm" style="flex:0 0 140px" [(ngModel)]="editName" placeholder="Name" />
                <input class="input-sm" style="flex:1" [(ngModel)]="editPath" placeholder="/absolute/path" />
                <button class="btn-sm" (click)="saveEdit(i)">Save</button>
                <button class="btn-sm" (click)="editingIndex.set(-1)">Cancel</button>
              </div>
            } @else {
              <div class="path-row">
                <span class="path-name">{{ p.name }}</span>
                <span class="path-val">{{ p.path }}</span>
                <button class="btn-icon" title="Edit" (click)="startEdit(i)">✎</button>
                <button class="btn-icon danger" title="Remove" (click)="removePath(i)">✕</button>
              </div>
            }
          }
          @if (docPaths().length === 0) {
            <div style="font-size:12px;color:var(--text-muted);padding:4px 0">No paths configured.</div>
          }
        </div>
        <div class="path-row" style="margin-top:8px">
          <input class="input-sm" style="flex:0 0 140px" [(ngModel)]="newName" placeholder="Name" />
          <input class="input-sm" style="flex:1" [(ngModel)]="newPath" placeholder="/absolute/path/to/add" />
          <button class="btn-sm" [disabled]="!newPath.trim()" (click)="addPath()">Add</button>
        </div>

        <div style="margin-top:16px;display:flex;align-items:center;gap:10px">
          <button class="btn-sm" [disabled]="savingSettings()" (click)="saveSettings()">
            {{ savingSettings() ? 'Saving…' : 'Save Settings' }}
          </button>
          @if (settingsSaved()) {
            <span style="font-size:12px;color:var(--text-muted)">Saved</span>
          }
        </div>
      </div>

      <div class="card">
        @if (docs().length) {
          <table>
            <thead>
              <tr>
                <th>Share</th>
                <th>File</th>
                <th>Chunks</th>
                <th>Indexed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (d of page(); track d.path) {
                <tr>
                  <td>{{ d.pathObject?.name ?? '—' }}</td>
                  <td style="color:var(--text-muted);font-size:12px">{{ d.fileName ?? d.path }}</td>
                  <td>{{ d.chunks ?? '—' }}</td>
                  <td style="color:var(--text-muted)">{{ d.indexedAt | date:'dd MMM HH:mm' }}</td>
                  <td style="text-align:right">
                    <button class="btn-icon danger" title="Remove from index"
                      (click)="remove(d)"
                      [disabled]="removing() === d.path">
                      {{ removing() === d.path ? '…' : '✕' }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>

          @if (totalPages() > 1) {
            <div class="pagination">
              <button class="btn-sm" [disabled]="currentPage() === 0" (click)="currentPage.set(currentPage() - 1)">‹ Prev</button>
              <span>{{ currentPage() + 1 }} / {{ totalPages() }}</span>
              <button class="btn-sm" [disabled]="currentPage() === totalPages() - 1" (click)="currentPage.set(currentPage() + 1)">Next ›</button>
            </div>
          }
        } @else {
          <div class="empty-state">No documents indexed yet. Ask the agent to run <code>docs_index</code>.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .btn-icon { background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--text-muted); }
    .btn-icon.danger:hover { background: var(--danger, #c0392b); color: #fff; }
    .btn-icon:disabled { opacity: 0.4; cursor: default; }
    .pagination { display: flex; align-items: center; gap: 12px; justify-content: center; padding: 12px 0 4px; color: var(--text-muted); font-size: 13px; }
    .btn-sm { background: var(--surface2, #2a2a2a); border: 1px solid var(--border, #444); color: var(--text, #eee); padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn-sm:disabled { opacity: 0.4; cursor: default; }
    .index-result { margin-left: 10px; font-size: 12px; color: var(--text-muted); }
    .settings-card { margin-bottom: 16px; }
    .setting-row { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--text, #eee); cursor: pointer; }
    .input-sm { background: var(--surface2, #2a2a2a); border: 1px solid var(--border, #444); color: var(--text, #eee); padding: 3px 8px; border-radius: 4px; font-size: 12px; flex: 1; }
    .paths-list { display: flex; flex-direction: column; gap: 6px; }
    .path-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .path-name { font-weight: 600; min-width: 120px; color: var(--text, #eee); }
    .path-val { flex: 1; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `]
})
export class DocsComponent implements OnInit {
  docs = signal<DocFile[]>([]);
  currentPage = signal(0);
  removing = signal<string | null>(null);
  indexing = signal(false);
  indexResult = signal<string | null>(null);
  savingSettings = signal(false);
  settingsSaved = signal(false);
  skipIndex = signal(false);
  indexCronSchedule = signal('');
  docPaths = signal<DocPath[]>([]);
  editingIndex = signal(-1);
  editName = '';
  editPath = '';
  newName = '';
  newPath = '';

  totalPages = computed(() => Math.max(1, Math.ceil(this.docs().length / PAGE_SIZE)));
  page = computed(() => {
    const start = this.currentPage() * PAGE_SIZE;
    return this.docs().slice(start, start + PAGE_SIZE);
  });

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getDocs().subscribe(d => this.docs.set(d));
    this.api.getConfig().subscribe((cfg: Record<string, unknown>) => {
      const docs = (cfg as any)?.tools?.docs ?? {};
      this.skipIndex.set(docs.uploadSkipIndex === true);
      this.indexCronSchedule.set(docs.indexCronSchedule ?? '');
      this.docPaths.set(Array.isArray(docs.paths) ? docs.paths : []);
    });
  }

  saveSettings() {
    this.savingSettings.set(true);
    this.settingsSaved.set(false);
    const partial = { tools: { docs: { uploadSkipIndex: this.skipIndex(), indexCronSchedule: this.indexCronSchedule() || null, paths: this.docPaths() } } };
    this.api.saveConfig(partial as Record<string, unknown>).subscribe({
      next: () => { this.savingSettings.set(false); this.settingsSaved.set(true); setTimeout(() => this.settingsSaved.set(false), 2000); },
      error: () => this.savingSettings.set(false)
    });
  }

  addPath() {
    const name = this.newName.trim() || this.newPath.trim().split('/').pop() || 'unnamed';
    this.docPaths.update(p => [...p, { name, path: this.newPath.trim() }]);
    this.newName = '';
    this.newPath = '';
  }

  startEdit(i: number) {
    const p = this.docPaths()[i];
    this.editName = p.name;
    this.editPath = p.path;
    this.editingIndex.set(i);
  }

  saveEdit(i: number) {
    this.docPaths.update(paths => paths.map((p, idx) =>
      idx === i ? { name: this.editName.trim() || p.name, path: this.editPath.trim() || p.path } : p
    ));
    this.editingIndex.set(-1);
  }

  removePath(i: number) {
    this.docPaths.update(paths => paths.filter((_, idx) => idx !== i));
  }

  runIndex() {
    this.indexing.set(true);
    this.indexResult.set(null);
    this.api.indexDocs().subscribe({
      next: (r) => {
        this.indexing.set(false);
        this.indexResult.set(`Indexed: ${r.indexed}  Skipped: ${r.skipped}${r.errors.length ? `  Errors: ${r.errors.length}` : ''}`);
        this.api.getDocs().subscribe(d => this.docs.set(d));
      },
      error: () => { this.indexing.set(false); this.indexResult.set('Index failed'); }
    });
  }

  remove(doc: DocFile) {
    if (!confirm(`Remove "${doc.fileName ?? doc.path}" from the index?`)) return;
    this.removing.set(doc.path);
    this.api.deleteDoc(doc.path).subscribe({
      next: () => {
        this.docs.update(list => list.filter(d => d.path !== doc.path));
        // Clamp page if last item on current page was removed
        const maxPage = Math.max(0, Math.ceil((this.docs().length) / PAGE_SIZE) - 1);
        if (this.currentPage() > maxPage) this.currentPage.set(maxPage);
        this.removing.set(null);
      },
      error: () => this.removing.set(null)
    });
  }
}
