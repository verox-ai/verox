import { Component, OnInit, computed, signal, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, DocFile } from '../../../core/api.service';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-docs',
  imports: [DatePipe],
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
  `]
})
export class DocsComponent implements OnInit {
  docs = signal<DocFile[]>([]);
  currentPage = signal(0);
  removing = signal<string | null>(null);
  indexing = signal(false);
  indexResult = signal<string | null>(null);

  totalPages = computed(() => Math.max(1, Math.ceil(this.docs().length / PAGE_SIZE)));
  page = computed(() => {
    const start = this.currentPage() * PAGE_SIZE;
    return this.docs().slice(start, start + PAGE_SIZE);
  });

  constructor(private api: ApiService) {}

  ngOnInit() { this.api.getDocs().subscribe(d => this.docs.set(d)); }

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
