import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, RssSubscription } from '../../../core/api.service';

@Component({
  selector: 'app-rss',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>RSS Monitor</h2>
        <p>Subscribe to RSS/Atom feeds. Auto-monitored feeds deliver new items via the agent. Manual feeds are checked on demand.</p>
      </div>

      <!-- Add subscription form -->
      <div class="card" style="margin-bottom:16px">
        <h3 style="margin:0 0 14px;font-size:14px;font-weight:600">Add Subscription</h3>
        <div class="form-grid">
          <div class="form-row">
            <label class="form-label">Feed URL</label>
            <input class="input" [(ngModel)]="form.url" placeholder="https://example.com/feed.xml" style="flex:1" />
          </div>
          <div class="form-row">
            <label class="form-label">Name</label>
            <input class="input" [(ngModel)]="form.name" placeholder="Hacker News" style="flex:1" />
          </div>
          <div class="form-row">
            <label class="form-label">Mode</label>
            <label class="toggle-label">
              <input type="checkbox" [(ngModel)]="form.manual" />
              <span>Manual only</span>
            </label>
            <span style="font-size:11px;color:var(--text-muted)">agent checks on demand via <code>rss_check</code></span>
          </div>
          @if (!form.manual) {
            <div class="form-row">
              <label class="form-label">Channel</label>
              <input class="input" [(ngModel)]="form.channel" placeholder="slack / telegram / webchat" style="width:160px" />
            </div>
            <div class="form-row">
              <label class="form-label">Chat ID</label>
              <input class="input" [(ngModel)]="form.chatId" placeholder="User or chat ID" style="width:180px" />
            </div>
            <div class="form-row">
              <label class="form-label">Schedule</label>
              <input class="input" [(ngModel)]="form.schedule" placeholder="*/15 * * * *" style="width:160px" />
              <span style="font-size:11px;color:var(--text-muted);align-self:center">cron (default: every 15 min)</span>
            </div>
          }
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" (click)="addSub()" [disabled]="!canAdd(form)">+ Subscribe</button>
          @if (addError()) { <span class="error-text">{{ addError() }}</span> }
        </div>
      </div>

      <!-- Subscription list -->
      <div class="card">
        @if (subs().length) {
          @for (s of subs(); track s.id) {
            <!-- Row -->
            <div class="sub-row" [class.open]="editingId() === s.id" (click)="toggleEdit(s)">
              <div class="sub-info">
                <strong class="sub-name">{{ s.name }}</strong>
                <a class="sub-url" [href]="s.url" target="_blank" rel="noopener" (click)="$event.stopPropagation()">{{ s.url }}</a>
                <div class="sub-meta">
                  @if (s.manual) {
                    <span class="badge badge-purple">manual</span>
                  } @else {
                    <span class="badge badge-gray">{{ s.schedule }}</span>
                  }
                  @for (t of s.targets; track t.channel + t.chatId) {
                    <span class="badge badge-blue">{{ t.channel }}:{{ t.chatId }}</span>
                  }
                  @if (s.lastChecked) {
                    <span style="font-size:11px;color:var(--text-muted)">last: {{ formatDate(s.lastChecked) }}</span>
                  }
                </div>
              </div>
              <div class="sub-actions" (click)="$event.stopPropagation()">
                <button class="btn btn-danger" style="padding:3px 8px;font-size:12px" (click)="deleteSub(s)">Remove</button>
              </div>
            </div>

            <!-- Inline edit panel -->
            @if (editingId() === s.id && edit) {
              <div class="edit-panel" (click)="$event.stopPropagation()">
                <div class="form-grid">
                  <div class="form-row">
                    <label class="form-label">Feed URL</label>
                    <input class="input" [(ngModel)]="edit.url" style="flex:1" />
                  </div>
                  <div class="form-row">
                    <label class="form-label">Name</label>
                    <input class="input" [(ngModel)]="edit.name" style="flex:1" />
                  </div>
                  <div class="form-row">
                    <label class="form-label">Mode</label>
                    <label class="toggle-label">
                      <input type="checkbox" [(ngModel)]="edit.manual" />
                      <span>Manual only</span>
                    </label>
                  </div>
                  @if (!edit.manual) {
                    <div class="form-row">
                      <label class="form-label">Channel</label>
                      <input class="input" [(ngModel)]="edit.channel" style="width:160px" />
                    </div>
                    <div class="form-row">
                      <label class="form-label">Chat ID</label>
                      <input class="input" [(ngModel)]="edit.chatId" style="width:180px" />
                    </div>
                    <div class="form-row">
                      <label class="form-label">Schedule</label>
                      <input class="input" [(ngModel)]="edit.schedule" placeholder="*/15 * * * *" style="width:160px" />
                    </div>
                  }
                </div>
                <div class="form-actions" style="margin-top:10px">
                  <button class="btn btn-primary" (click)="saveSub(s)" [disabled]="!canAdd(edit) || saving()">
                    {{ saving() ? 'Saving…' : 'Save' }}
                  </button>
                  <button class="btn" (click)="editingId.set(null)">Cancel</button>
                  @if (saveError()) { <span class="error-text">{{ saveError() }}</span> }
                </div>
              </div>
            }

            <div class="sub-divider"></div>
          }
        } @else {
          <div class="empty-state">No RSS subscriptions. Add one above.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 8px; }
    .form-row { display: flex; align-items: center; gap: 10px; }
    .form-label { font-size: 12px; color: var(--text-muted); width: 80px; flex-shrink: 0; }
    .toggle-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
    .form-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
    .sub-row { display: flex; align-items: center; gap: 12px; padding: 10px 4px; cursor: pointer;
      border-radius: 4px; transition: background .1s; }
    .sub-row:hover { background: var(--hover-bg); }
    .sub-row.open { background: var(--active-bg); }
    .sub-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .sub-name { font-size: 14px; }
    .sub-url { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .sub-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .sub-divider { height: 1px; background: var(--border); margin: 0 -4px; }
    .sub-divider:last-child { display: none; }
    .edit-panel { padding: 12px 0 16px; }
    .badge-blue { background: var(--accent-muted); color: var(--accent-text); }
    .badge-purple { background: var(--purple-muted); color: var(--purple); }
    .error-text { color: var(--error-text); font-size: 13px; }
    code { background: var(--surface); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  `],
})
export class RssComponent implements OnInit {
  subs = signal<RssSubscription[]>([]);
  addError = signal('');
  saveError = signal('');
  saving = signal(false);
  editingId = signal<string | null>(null);
  edit: { url: string; name: string; channel: string; chatId: string; schedule: string; manual: boolean } | null = null;

  form = { url: '', name: '', channel: '', chatId: '', schedule: '*/15 * * * *', manual: false };

  constructor(private api: ApiService) {}
  ngOnInit() { this.load(); }
  load() { this.api.getRssSubscriptions().subscribe(s => this.subs.set(s)); }

  canAdd(f: typeof this.form): boolean {
    if (!f.url.trim() || !f.name.trim()) return false;
    if (!f.manual && (!f.channel.trim() || !f.chatId.trim())) return false;
    return true;
  }

  toggleEdit(s: RssSubscription) {
    if (this.editingId() === s.id) { this.editingId.set(null); return; }
    this.editingId.set(s.id);
    this.saveError.set('');
    const target = s.targets[0];
    this.edit = {
      url: s.url,
      name: s.name,
      channel: target?.channel ?? '',
      chatId: target?.chatId ?? '',
      schedule: s.schedule ?? '*/15 * * * *',
      manual: s.manual ?? false,
    };
  }

  saveSub(s: RssSubscription) {
    if (!this.edit) return;
    this.saving.set(true);
    this.saveError.set('');
    this.api.updateRssSubscription(s.id, {
      url: this.edit.url.trim(),
      name: this.edit.name.trim(),
      channel: this.edit.manual ? undefined : this.edit.channel.trim(),
      chatId: this.edit.manual ? undefined : this.edit.chatId.trim(),
      schedule: this.edit.manual ? '' : (this.edit.schedule.trim() || undefined),
      manual: this.edit.manual,
    }).subscribe({
      next: () => { this.saving.set(false); this.editingId.set(null); this.load(); },
      error: (err) => { this.saving.set(false); this.saveError.set(err?.error?.error ?? 'Save failed.'); },
    });
  }

  addSub() {
    this.addError.set('');
    this.api.createRssSubscription({
      url: this.form.url.trim(),
      name: this.form.name.trim(),
      channel: this.form.manual ? undefined : this.form.channel.trim(),
      chatId: this.form.manual ? undefined : this.form.chatId.trim(),
      schedule: this.form.manual ? undefined : (this.form.schedule.trim() || undefined),
      manual: this.form.manual,
    }).subscribe({
      next: () => {
        this.form = { url: '', name: '', channel: '', chatId: '', schedule: '*/15 * * * *', manual: false };
        this.load();
      },
      error: (err) => { this.addError.set(err?.error?.error ?? 'Failed to subscribe.'); },
    });
  }

  deleteSub(s: RssSubscription) {
    if (!confirm(`Remove subscription "${s.name}"?`)) return;
    this.api.deleteRssSubscription(s.id).subscribe(() => {
      if (this.editingId() === s.id) this.editingId.set(null);
      this.load();
    });
  }

  formatDate(iso: string): string {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }
}
