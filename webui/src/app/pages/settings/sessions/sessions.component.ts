import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, SessionHeader, SessionMessage } from '../../../core/api.service';

@Component({
  selector: 'app-sessions',
  imports: [DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Sessions</h2>
        <p>Conversation session history across all channels.</p>
      </div>
      <div style="display:flex;gap:16px;height:calc(100vh - 140px)">
        <!-- Session list -->
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
        <!-- Message view -->
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
    </div>
  `,
  styles: [`
    .session-item {
      padding: 10px 12px; cursor: pointer; border-radius: 6px;
      border-bottom: 1px solid var(--border); transition: background .1s;
    }
    .session-item:hover { background: rgba(255,255,255,.04); }
    .session-item.active { background: rgba(59,130,246,.12); }
    .session-key { font-size: 12px; font-weight: 500; word-break: break-all; }
    .session-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .msg-row { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,.04); }
    .msg-row.user .msg-role { color: var(--accent); }
    .msg-role { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
    .msg-content {
      font-family: inherit; font-size: 13px; white-space: pre-wrap;
      word-break: break-word; margin-top: 4px; color: var(--text);
    }
  `],
})
export class SessionsComponent implements OnInit {
  sessions = signal<SessionHeader[]>([]);
  selected = signal<SessionHeader | null>(null);
  messages = signal<SessionMessage[]>([]);

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getSessions().subscribe(s => this.sessions.set(s));
  }

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
}
