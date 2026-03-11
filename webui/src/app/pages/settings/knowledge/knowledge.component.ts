import { Component, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { ApiService, KnowledgeDoc, KnowledgeDocMeta } from '../../../core/api.service';

@Component({
  selector: 'app-knowledge',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Knowledge</h2>
        <p>Long-form documents the agent can read and write. Content is stored in the database and searchable with full-text search.</p>
      </div>

      <!-- Toolbar -->
      <div class="card" style="margin-bottom:16px">
        <div class="row">
          <input class="input" [(ngModel)]="searchQuery" placeholder="Search docs…" (keydown.enter)="search()" />
          <button class="btn btn-ghost" (click)="search()">Search</button>
          <button class="btn btn-primary" style="margin-left:auto" (click)="openNew()">+ New Doc</button>
        </div>
      </div>

      <!-- Editor panel -->
      @if (editing()) {
        <div class="card editor-card">
          <div class="editor-header">
            <span class="editor-title">{{ isNew() ? 'New document' : 'Edit: ' + editing()!.slug }}</span>
            <div style="display:flex;gap:6px;align-items:center">
              <button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" (click)="togglePreview()">
                {{ showPreview() ? 'Hide preview' : 'Preview' }}
              </button>
              <button class="btn btn-ghost" style="padding:4px 10px" (click)="cancelEdit()">Cancel</button>
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label>Slug</label>
              <input class="input" [(ngModel)]="form.slug" placeholder="e.g. nas-structure" [disabled]="!isNew()" />
            </div>
            <div class="field" style="flex:2">
              <label>Title</label>
              <input class="input" [(ngModel)]="form.title" placeholder="Human-readable title" />
            </div>
          </div>

          <div class="field">
            <label>Tags <span style="color:var(--text-muted);font-size:11px">(comma-separated)</span></label>
            <input class="input" [(ngModel)]="form.tagsRaw" placeholder="technical, nas, workflow" />
          </div>

          <div class="field">
            <label>Content</label>
            <div [class]="showPreview() ? 'split-pane' : ''">
              <textarea class="input editor-textarea" [(ngModel)]="form.content" (ngModelChange)="onContentChange($event)" placeholder="Markdown supported…"></textarea>
              @if (showPreview()) {
                <div class="preview-pane markdown-body" [innerHTML]="previewHtml()"></div>
              }
            </div>
          </div>

          <div class="editor-actions">
            <button class="btn btn-primary" (click)="save()" [disabled]="saving()">
              {{ saving() ? 'Saving…' : 'Save' }}
            </button>
            @if (saveError()) {
              <span class="error-text">{{ saveError() }}</span>
            }
          </div>
        </div>
      }

      <!-- Doc list -->
      @if (docs().length) {
        <div class="doc-grid">
          @for (d of docs(); track d.slug) {
            <div class="doc-card card">
              <div class="doc-header">
                <div>
                  <div class="doc-title">{{ d.title }}</div>
                  <div class="doc-slug">{{ d.slug }}</div>
                </div>
                <div class="doc-actions">
                  <button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" (click)="editDoc(d)">Edit</button>
                  <button class="btn btn-danger" style="padding:4px 10px;font-size:12px" (click)="deleteDoc(d)">Del</button>
                </div>
              </div>

              @if (d.tags.length) {
                <div class="badge-row" style="margin-top:8px">
                  @for (t of d.tags; track t) {
                    <span class="badge badge-blue">{{ t }}</span>
                  }
                </div>
              }

              <div class="doc-meta">
                Updated {{ d.updated_at | date:'dd MMM yyyy, HH:mm' }}
              </div>
            </div>
          }
        </div>
      } @else if (!editing()) {
        <div class="empty-state">No knowledge documents yet. Click "+ New Doc" to create one.</div>
      }
    </div>
  `,
  styles: [`
    .editor-card { margin-bottom: 20px; }
    .editor-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .editor-title { font-weight: 600; font-size: 14px; }
    .field-row { display: flex; gap: 12px; margin-bottom: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; flex: 1; margin-bottom: 12px; }
    .field label { font-size: 12px; color: var(--text-muted); font-weight: 500; }
    .editor-textarea { min-height: 280px; font-family: monospace; font-size: 13px; resize: vertical; flex: 1; }
    .split-pane { display: flex; gap: 12px; align-items: flex-start; }
    .split-pane textarea { min-height: 400px; resize: none; }
    .preview-pane { flex: 1; min-height: 400px; max-height: 600px; overflow-y: auto; padding: 16px; background: var(--bg-secondary, #1a1a2e); border: 1px solid var(--border); border-radius: 6px; font-size: 14px; line-height: 1.7; }
    .markdown-body h1,.markdown-body h2,.markdown-body h3 { font-weight: 600; margin: 1em 0 .4em; }
    .markdown-body h1 { font-size: 1.5em; } .markdown-body h2 { font-size: 1.25em; } .markdown-body h3 { font-size: 1.1em; }
    .markdown-body p { margin: .5em 0; }
    .markdown-body ul,.markdown-body ol { padding-left: 1.4em; margin: .5em 0; }
    .markdown-body li { margin: .2em 0; }
    .markdown-body code { background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 12px; }
    .markdown-body pre { background: rgba(255,255,255,.06); padding: 12px; border-radius: 6px; overflow-x: auto; }
    .markdown-body pre code { background: none; padding: 0; }
    .markdown-body blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--text-muted); margin: .5em 0; }
    .markdown-body a { color: #7eb8f7; }
    .markdown-body hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
    .markdown-body table { border-collapse: collapse; width: 100%; }
    .markdown-body th,.markdown-body td { border: 1px solid var(--border); padding: 6px 10px; }
    .markdown-body th { background: rgba(255,255,255,.05); font-weight: 600; }
    .editor-actions { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
    .error-text { color: #f87171; font-size: 13px; }
    .doc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .doc-card { padding: 16px; }
    .doc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .doc-title { font-weight: 600; font-size: 14px; }
    .doc-slug { font-size: 11px; color: var(--text-muted); font-family: monospace; margin-top: 2px; }
    .doc-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .doc-meta { font-size: 11px; color: var(--text-muted); margin-top: 10px; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 4px; }
  `],
})
export class KnowledgeComponent implements OnInit {
  docs = signal<KnowledgeDocMeta[]>([]);
  editing = signal<KnowledgeDocMeta | null>(null);
  isNew = signal(false);
  saving = signal(false);
  saveError = signal('');
  showPreview = signal(false);
  previewHtml = signal<SafeHtml>('');

  form = { slug: '', title: '', content: '', tagsRaw: '' };
  searchQuery = '';

  constructor(private api: ApiService, private sanitizer: DomSanitizer) {}

  ngOnInit() { this.loadAll(); }

  loadAll() {
    this.api.getKnowledgeDocs().subscribe(d => this.docs.set(d));
  }

  search() {
    if (!this.searchQuery.trim()) { this.loadAll(); return; }
    this.api.searchKnowledge(this.searchQuery).subscribe(d => this.docs.set(d));
  }

  openNew() {
    this.form = { slug: '', title: '', content: '', tagsRaw: '' };
    this.editing.set({} as KnowledgeDocMeta);
    this.isNew.set(true);
    this.saveError.set('');
  }

  editDoc(meta: KnowledgeDocMeta) {
    this.api.getKnowledgeDoc(meta.slug).subscribe(doc => {
      this.form = {
        slug: doc.slug,
        title: doc.title,
        content: doc.content,
        tagsRaw: doc.tags.join(', '),
      };
      this.editing.set(meta);
      this.isNew.set(false);
      this.saveError.set('');
    });
  }

  togglePreview() {
    const next = !this.showPreview();
    this.showPreview.set(next);
    if (next) this.updatePreview(this.form.content);
  }

  onContentChange(content: string) {
    if (this.showPreview()) {
      this.updatePreview(content);
    }
  }

  private updatePreview(content: string) {
    const html = marked.parse(content) as string;
    this.previewHtml.set(this.sanitizer.bypassSecurityTrustHtml(html));
  }

  cancelEdit() {
    this.editing.set(null);
    this.showPreview.set(false);
    this.saveError.set('');
  }

  save() {
    const tags = this.form.tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    if (!this.form.slug || !this.form.title || !this.form.content) {
      this.saveError.set('Slug, title and content are required.');
      return;
    }
    this.saving.set(true);
    this.saveError.set('');

    const req$ = this.isNew()
      ? this.api.saveKnowledgeDoc({ slug: this.form.slug, title: this.form.title, content: this.form.content, tags })
      : this.api.updateKnowledgeDoc(this.form.slug, { title: this.form.title, content: this.form.content, tags });

    req$.subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.loadAll();
      },
      error: (err) => {
        this.saving.set(false);
        this.saveError.set(err?.error?.error ?? 'Save failed.');
      },
    });
  }

  deleteDoc(d: KnowledgeDocMeta) {
    if (!confirm(`Delete "${d.title}"?`)) return;
    this.api.deleteKnowledgeDoc(d.slug).subscribe(() => {
      this.docs.update(arr => arr.filter(x => x.slug !== d.slug));
      if (this.editing()?.slug === d.slug) this.editing.set(null);
    });
  }
}
