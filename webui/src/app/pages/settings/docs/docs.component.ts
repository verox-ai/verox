import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, DocFile } from '../../../core/api.service';

@Component({
  selector: 'app-docs',
  imports: [DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Document Index</h2>
        <p>Files indexed for semantic search via <code>docs_search</code>.</p>
      </div>
      <div class="card">
        @if (docs().length) {
          <table>
            <thead><tr><th>Share</th><th>File</th><th>Chunks</th><th>Indexed</th></tr></thead>
            <tbody>
              @for (d of docs(); track d.path) {
                <tr>
                  <td>{{ d.pathObject?.name ?? '—' }}</td>
                  <td style="color:var(--text-muted);font-size:12px">{{ d.fileName ?? d.path }}</td>
                  <td>{{ d.chunks ?? '—' }}</td>
                  <td style="color:var(--text-muted)">{{ d.indexed_at | date:'dd MMM HH:mm' }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty-state">No documents indexed yet. Ask the agent to run <code>docs_index</code>.</div>
        }
      </div>
    </div>
  `,
})
export class DocsComponent implements OnInit {
  docs = signal<DocFile[]>([]);
  constructor(private api: ApiService) {}
  ngOnInit() { this.api.getDocs().subscribe(d => this.docs.set(d)); }
}
