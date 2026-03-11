import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiService, MemoryEntry, MemoryMap } from '../../../core/api.service';

@Component({
  selector: 'app-memory',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Memory</h2>
        <p>Persistent facts stored by the agent.</p>
      </div>

      <!-- Knowledge map -->
      @if (map()) {
        <div class="card map-card">
          <div class="map-header">
            <span class="map-title">Knowledge index</span>
            <span class="map-count">{{ map()!.total }} memories · {{ map()!.knowledgeDocs.length }} knowledge docs</span>
          </div>

          @if (map()!.byType.length) {
            <div class="map-row">
              <span class="map-label">Types</span>
              <div class="badge-row">
                @for (t of map()!.byType; track t.type) {
                  <span class="badge badge-gray">{{ t.type }} <span class="badge-count">{{ t.count }}</span></span>
                }
              </div>
            </div>
          }

          @if (map()!.byTag.length) {
            <div class="map-row">
              <span class="map-label">Topics</span>
              <div class="badge-row tag-cloud">
                @for (t of map()!.byTag; track t.tag) {
                  <span class="badge badge-blue tag-item"
                    [style.fontSize.px]="tagFontSize(t.count)"
                    (click)="filterByTag(t.tag)" style="cursor:pointer">
                    {{ t.tag }} <span class="badge-count">{{ t.count }}</span>
                  </span>
                }
              </div>
            </div>
          }

          @if (map()!.recentTags.length) {
            <div class="map-row">
              <span class="map-label">Recent</span>
              <div class="badge-row">
                @for (t of map()!.recentTags; track t) {
                  <span class="badge badge-green" (click)="filterByTag(t)" style="cursor:pointer">{{ t }}</span>
                }
              </div>
            </div>
          }

          @if (map()!.knowledgeDocs.length) {
            <div class="map-row">
              <span class="map-label">Docs</span>
              <div class="badge-row">
                @for (d of map()!.knowledgeDocs; track d.slug) {
                  <span class="badge badge-purple">{{ d.slug }}</span>
                }
              </div>
            </div>
          }
        </div>
      }

      <!-- Search -->
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
                      <span class="badge badge-blue" style="margin:1px;cursor:pointer" (click)="filterByTag(t)">{{ t }}</span>
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
    .map-card { margin-bottom: 16px; }
    .map-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .map-title { font-weight: 600; font-size: 14px; }
    .map-count { font-size: 12px; color: var(--text-muted); }
    .map-row { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
    .map-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
      color: var(--text-muted); min-width: 52px; padding-top: 3px; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .badge-count { opacity: .6; font-size: 10px; margin-left: 2px; }
    .badge-purple { background: rgba(139,92,246,.15); color: #a78bfa; }
    .badge-green { background: rgba(34,197,94,.15); color: #4ade80; }
  `],
})
export class MemoryComponent implements OnInit {
  entries = signal<MemoryEntry[]>([]);
  tags = signal<string[]>([]);
  map = signal<MemoryMap | null>(null);
  page = signal(0);
  hasMore = signal(false);
  query = '';
  tag = '';

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getMemoryTags().subscribe(t => this.tags.set(t));
    this.api.getMemoryMap().subscribe(m => this.map.set(m));
    this.load();
  }

  load() {
    this.api.searchMemory(this.query || undefined, this.tag || undefined, this.page())
      .subscribe(r => { this.entries.set(r.entries); this.hasMore.set(r.hasMore); });
  }

  filterByTag(t: string) {
    this.tag = t;
    this.resetAndSearch();
  }

  resetAndSearch() { this.page.set(0); this.load(); }
  nextPage() { this.page.update(p => p + 1); this.load(); }
  prevPage() { this.page.update(p => Math.max(0, p - 1)); this.load(); }

  tagFontSize(count: number): number {
    const max = Math.max(...(this.map()?.byTag.map(t => t.count) ?? [1]));
    return Math.round(10 + (count / max) * 5);
  }

  delete(e: MemoryEntry) {
    if (!confirm(`Delete memory #${e.id}?`)) return;
    this.api.deleteMemory(e.id).subscribe(() => {
      this.entries.update(arr => arr.filter(x => x.id !== e.id));
      this.api.getMemoryMap().subscribe(m => this.map.set(m));
    });
  }
}
