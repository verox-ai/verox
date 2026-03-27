import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, SessionHeader, SessionMessage } from '../../../core/api.service';

interface SessionGroup { name: string; members: string[]; }

@Component({
  selector: 'app-sessions',
  imports: [DatePipe, FormsModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Sessions</h2>
        <div class="tabs">
          <button class="tab" [class.active]="tab() === 'history'" (click)="tab.set('history')">History</button>
          <button class="tab" [class.active]="tab() === 'groups'"  (click)="tab.set('groups')">Groups</button>
        </div>
      </div>

      @if (tab() === 'history') {
        <div style="display:flex;gap:16px;height:calc(100vh - 160px)">
          <div class="card" style="width:260px;overflow-y:auto;flex-shrink:0;margin:0">
            @for (s of sessions(); track s.key) {
              <div class="session-item" [class.active]="selected()?.key === s.key" (click)="selectSession(s)">
                <div class="session-key">{{ s.key }}</div>
                <div class="session-meta">{{ s.updatedAt | date:'dd MMM HH:mm' }}</div>
              </div>
            }
            @if (!sessions().length) {
              <div class="empty-state" style="padding:24px">No sessions found.</div>
            }
          </div>
          <div class="card" style="flex:1;overflow-y:auto;margin:0">
            @if (selected()) {
              <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
                <strong>{{ selected()!.key }}</strong>
                <button class="btn btn-danger" style="padding:4px 10px" (click)="deleteSession()">Delete</button>
              </div>
              @for (msg of messages(); track $index) {
                <div class="msg-row" [class.user]="msg.role === 'user'">
                  <span class="msg-role">{{ msg.role }}</span>
                  <pre class="msg-content">{{ formatContent(msg.content) }}</pre>
                </div>
              }
            } @else {
              <div class="empty-state">Select a session to view messages.</div>
            }
          </div>
        </div>
      }

      @if (tab() === 'groups') {
        <p class="groups-desc">
          Group multiple <code>channel:chatId</code> pairs so they share a single conversation history.
          On save you can optionally merge existing session histories into the group.
        </p>

        <!-- datalist of known session keys for autocomplete -->
        <datalist id="session-keys">
          @for (s of sessions(); track s.key) {
            <option [value]="s.key"></option>
          }
        </datalist>

        @if (groupsLoading()) {
          <div class="empty-state">Loading…</div>
        } @else {
          @for (group of groups(); track $index; let gi = $index) {
            <div class="card group-card">
              <div class="group-header">
                <input class="input group-name" [(ngModel)]="group.name" placeholder="Group name (e.g. main)" />
                <button class="btn-icon danger" title="Delete group" (click)="removeGroup(gi)">✕</button>
              </div>
              <div class="members">
                @for (member of group.members; track $index; let mi = $index) {
                  <div class="member-row">
                    <input class="input member-input" [(ngModel)]="group.members[mi]"
                      list="session-keys"
                      placeholder="channel:chatId  (e.g. slack:D0AGLF2GB16)" />
                    <button class="btn-icon danger" title="Remove" (click)="removeMember(gi, mi)">✕</button>
                  </div>
                }
                <button class="btn-sm" (click)="addMember(gi)">+ Add member</button>
              </div>
            </div>
          }

          <button class="btn-sm" (click)="addGroup()">+ New group</button>

          <div class="save-row">
            <button class="btn btn-primary" [disabled]="groupsSaving()" (click)="saveGroups(false)">
              {{ groupsSaving() ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn btn-secondary" [disabled]="groupsSaving()" (click)="saveGroups(true)" title="Save config and merge existing session histories into each group">
              Save &amp; Merge history
            </button>
            @if (groupsSaved()) { <span class="save-ok">{{ saveMsg() }}</span> }
            @if (groupsError()) { <span class="save-err">{{ groupsError() }}</span> }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .tabs { display: flex; gap: 4px; margin-top: 10px; }
    .tab { background: var(--surface2, #2a2a2a); border: 1px solid var(--border, #444); color: var(--text-muted); padding: 4px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .tab.active { background: var(--accent, #4a9eff); color: #fff; border-color: var(--accent, #4a9eff); }
    .session-item { padding: 10px 12px; cursor: pointer; border-radius: 6px; border-bottom: 1px solid var(--border); transition: background .1s; }
    .session-item:hover { background: var(--hover-bg); }
    .session-item.active { background: var(--active-bg); }
    .session-key { font-size: 12px; font-weight: 500; word-break: break-all; }
    .session-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .msg-row { padding: 8px 0; border-bottom: 1px solid var(--hover-bg); }
    .msg-row.user .msg-role { color: var(--accent); }
    .msg-role { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
    .msg-content { font-family: inherit; font-size: 13px; white-space: pre-wrap; word-break: break-word; margin-top: 4px; color: var(--text); }
    .groups-desc { color: var(--text-muted); font-size: 13px; margin-bottom: 12px; }
    .group-card { margin-bottom: 12px; padding: 14px; }
    .group-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .group-name { flex: 1; font-weight: 600; }
    .members { display: flex; flex-direction: column; gap: 6px; }
    .member-row { display: flex; align-items: center; gap: 8px; }
    .member-input { flex: 1; font-family: monospace; font-size: 13px; }
    .btn-sm { background: var(--surface2, #2a2a2a); border: 1px solid var(--border, #444); color: var(--text, #eee); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; margin-top: 4px; }
    .btn-sm:hover { background: var(--hover-bg); }
    .btn-secondary { background: var(--surface2, #2a2a2a); border: 1px solid var(--border, #444); color: var(--text, #eee); padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .btn-secondary:hover:not(:disabled) { background: var(--hover-bg); }
    .btn-icon { background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--text-muted); }
    .btn-icon.danger:hover { background: var(--danger, #c0392b); color: #fff; }
    .save-row { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
    .save-ok { font-size: 13px; color: var(--success, #27ae60); }
    .save-err { font-size: 13px; color: var(--danger, #c0392b); }
    .empty-state { padding: 32px; text-align: center; color: var(--text-muted); }
  `],
})
export class SessionsComponent implements OnInit {
  tab = signal<'history' | 'groups'>('history');

  // History tab
  sessions = signal<SessionHeader[]>([]);
  selected = signal<SessionHeader | null>(null);
  messages = signal<SessionMessage[]>([]);

  // Groups tab
  groups = signal<SessionGroup[]>([]);
  groupsLoading = signal(true);
  groupsSaving = signal(false);
  groupsSaved = signal(false);
  groupsError = signal('');
  saveMsg = signal('Saved');

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getSessions().subscribe(s => this.sessions.set(s));
    this.api.getConfig().subscribe({
      next: (cfg) => {
        const raw = (cfg['sessionGroups'] as SessionGroup[] | undefined) ?? [];
        this.groups.set(raw.map(g => ({ name: g.name, members: [...g.members] })));
        this.groupsLoading.set(false);
      },
      error: () => this.groupsLoading.set(false)
    });
  }

  // History
  selectSession(s: SessionHeader) {
    this.selected.set(s);
    this.api.getSessionMessages(s.key).subscribe(m => this.messages.set(m));
  }

  deleteSession() {
    const s = this.selected();
    if (!s || !confirm(`Delete session "${s.key}"?`)) return;
    this.api.deleteSession(s.key).subscribe(() => {
      this.sessions.update(arr => arr.filter(x => x.key !== s.key));
      this.selected.set(null);
      this.messages.set([]);
    });
  }

  formatContent(content: unknown): string {
    if (typeof content === 'string') return content;
    return JSON.stringify(content, null, 2);
  }

  // Groups
  addGroup() { this.groups.update(gs => [...gs, { name: '', members: [''] }]); }

  removeGroup(gi: number) { this.groups.update(gs => gs.filter((_, i) => i !== gi)); }

  addMember(gi: number) {
    this.groups.update(gs => {
      const copy = gs.map(g => ({ ...g, members: [...g.members] }));
      copy[gi].members.push('');
      return copy;
    });
  }

  removeMember(gi: number, mi: number) {
    this.groups.update(gs => {
      const copy = gs.map(g => ({ ...g, members: [...g.members] }));
      copy[gi].members.splice(mi, 1);
      return copy;
    });
  }

  saveGroups(mergeHistory: boolean) {
    this.groupsSaving.set(true);
    this.groupsSaved.set(false);
    this.groupsError.set('');

    const cleaned = this.groups()
      .map(g => ({ name: g.name.trim(), members: g.members.map(m => m.trim()).filter(Boolean) }))
      .filter(g => g.name && g.members.length > 0);

    this.api.saveConfig({ sessionGroups: cleaned }).subscribe({
      next: () => {
        if (!mergeHistory || cleaned.length === 0) {
          this.finishSave('Saved');
          return;
        }
        // Fire merge requests for all groups in parallel, collect total merged count
        let pending = cleaned.length;
        let totalMerged = 0;
        let failed = false;
        for (const group of cleaned) {
          const groupKey = `group:${group.name}`;
          this.api.mergeSessionsIntoGroup(groupKey, group.members).subscribe({
            next: (r) => {
              totalMerged += r.merged;
              if (--pending === 0 && !failed) this.finishSave(`Saved · ${totalMerged} messages merged`);
            },
            error: (e) => {
              failed = true;
              this.groupsSaving.set(false);
              this.groupsError.set(e?.error?.error ?? 'Merge failed');
            }
          });
        }
      },
      error: (e) => { this.groupsSaving.set(false); this.groupsError.set(e?.error?.error ?? 'Save failed'); }
    });
  }

  private finishSave(msg: string) {
    this.groupsSaving.set(false);
    this.saveMsg.set(msg);
    this.groupsSaved.set(true);
    setTimeout(() => this.groupsSaved.set(false), 3000);
  }
}
