import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiService, MemoryEntry } from '../../../core/api.service';

@Component({
  selector: 'app-memory',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Memory</h2>
        <p>Persistent facts stored by the agent. Page {{ page() + 1 }} — {{ entries().length }} entries shown.</p>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:16px">
          <input class="input" [(ngModel)]="query" placeholder="Search…" (keydown.enter)="resetAndSearch()" />
          <select class="input" style="width:160px;flex:none" [(ngModel)]="tag" (change)="resetAndSearch()">
            <option value="">All tags</option>
            @for (t of tags(); track t) {
              <option [value]="t">{{ t }}</option>
            }
          </select>
          <button class="btn btn-ghost" (click)="resetAndSearch()">Search</button>
        </div>

        @if (entries().length) {
          <table>
            <thead>
              <tr><th style="width:50px">ID</th><th>Content</th><th>Tags</th><th>Type</th><th>Conf.</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              @for (e of entries(); track e.id) {
                <tr>
                  <td style="color:var(--text-muted)">{{ e.id }}</td>
                  <td style="max-width:300px"><div class="truncate">{{ e.content }}</div></td>
                  <td>
                    @for (t of e.tags; track t) {
                      <span class="badge badge-blue" style="margin:1px">{{ t }}</span>
                    }
                  </td>
                  <td>@if (e.memory_type) { <span class="badge badge-gray">{{ e.memory_type }}</span> }</td>
                  <td style="color:var(--text-muted)">{{ (e.confidence * 100).toFixed(0) }}%</td>
                  <td style="color:var(--text-muted);white-space:nowrap">{{ e.created_at | date:'dd MMM' }}</td>
                  <td>
                    <button class="btn btn-danger" style="padding:3px 8px;font-size:12px"
                      [disabled]="e.protected" (click)="delete(e)">Del</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>

          <!-- Pagination -->
          <div class="pagination">
            <button class="btn btn-ghost" (click)="prevPage()" [disabled]="page() === 0">← Prev</button>
            <span style="color:var(--text-muted);font-size:13px">Page {{ page() + 1 }}</span>
            <button class="btn btn-ghost" (click)="nextPage()" [disabled]="!hasMore()">Next →</button>
          </div>
        } @else {
          <div class="empty-state">No memories found.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .truncate { max-height: 40px; overflow: hidden; font-size: 13px; }
    .pagination { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); margin-top: 8px; }
  `],
})
export class MemoryComponent implements OnInit {
  entries = signal<MemoryEntry[]>([]);
  tags = signal<string[]>([]);
  page = signal(0);
  hasMore = signal(false);
  query = '';
  tag = '';

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getMemoryTags().subscribe(t => this.tags.set(t));
    this.load();
  }

  load() {
    this.api.searchMemory(this.query || undefined, this.tag || undefined, this.page())
      .subscribe(r => { this.entries.set(r.entries); this.hasMore.set(r.hasMore); });
  }

  resetAndSearch() { this.page.set(0); this.load(); }
  nextPage() { this.page.update(p => p + 1); this.load(); }
  prevPage() { this.page.update(p => Math.max(0, p - 1)); this.load(); }

  delete(e: MemoryEntry) {
    if (!confirm(`Delete memory #${e.id}?`)) return;
    this.api.deleteMemory(e.id).subscribe(() => this.entries.update(arr => arr.filter(x => x.id !== e.id)));
  }
}
