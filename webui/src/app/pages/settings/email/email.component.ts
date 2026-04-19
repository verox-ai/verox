import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiService, EmailRecord, EmailSearchResult } from '../../../core/api.service';

type EmailRow = EmailRecord | EmailSearchResult;

function isFullRecord(e: EmailRow): e is EmailRecord {
  return 'body' in e;
}

@Component({
  selector: 'app-email',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Email Archive</h2>
        <p>Emails saved by the agent via the email_save tool.</p>
      </div>

      <!-- Stats bar -->
      <div class="card stats-bar">
        <span class="stat"><strong>{{ total() }}</strong> saved emails</span>
        @if (mailboxes().length > 1) {
          <span class="stat-sep">·</span>
          <span class="stat">{{ mailboxes().length }} mailboxes</span>
        }
        @if (indexedCount() !== null) {
          <span class="stat-sep">·</span>
          <span class="stat">{{ indexedCount() }} indexed</span>
        }
      </div>

      <!-- Search & filter -->
      <div class="card">
        <div class="row" style="margin-bottom:16px">
          <input class="input" [(ngModel)]="query" placeholder="Search emails…" (keydown.enter)="resetAndSearch()" />
          @if (mailboxes().length > 0) {
            <select class="input" style="width:180px;flex:none" [(ngModel)]="mailbox" (change)="resetAndSearch()">
              <option value="">All mailboxes</option>
              @for (m of mailboxes(); track m) {
                <option [value]="m">{{ m }}</option>
              }
            </select>
          }
          <button class="btn btn-ghost" (click)="resetAndSearch()">Search</button>
        </div>

        @if (emails().length) {
          <table>
            <thead>
              <tr>
                <th style="width:40px">ID</th>
                <th>From</th>
                <th>Subject</th>
                <th style="width:110px">Mailbox</th>
                <th style="width:90px">Date</th>
                <th style="width:70px">Indexed</th>
                <th style="width:60px"></th>
              </tr>
            </thead>
            <tbody>
              @for (e of emails(); track e.id) {
                <tr class="email-row" (click)="toggle(e)" [class.expanded]="expandedId() === e.id">
                  <td style="color:var(--text-muted)">{{ e.id }}</td>
                  <td style="max-width:180px"><div class="truncate">{{ e.from_addr }}</div></td>
                  <td style="max-width:260px">
                    <div class="truncate">{{ e.subject }}</div>
                    @if (!isFullRecord(e) && e.snippet) {
                      <div class="snippet">{{ e.snippet }}</div>
                    }
                  </td>
                  <td>
                    @if (isFullRecord(e) && e.mailbox) {
                      <span class="badge badge-gray">{{ e.mailbox }}</span>
                    }
                  </td>
                  <td style="color:var(--text-muted);white-space:nowrap;font-size:12px">
                    {{ e.received_at | date:'dd MMM yy' }}
                  </td>
                  <td>
                    @if (isFullRecord(e)) {
                      <span class="badge" [class.badge-green]="e.indexed" [class.badge-gray]="!e.indexed">
                        {{ e.indexed ? 'yes' : 'no' }}
                      </span>
                    }
                  </td>
                  <td (click)="$event.stopPropagation()">
                    <button class="btn btn-danger" style="padding:3px 8px;font-size:12px"
                      (click)="deleteEmail(e)">Del</button>
                  </td>
                </tr>
                @if (expandedId() === e.id) {
                  <tr class="body-row">
                    <td colspan="7">
                      <div class="body-panel">
                        @if (loadingBody()) {
                          <div style="color:var(--text-muted);font-size:13px">Loading…</div>
                        } @else if (fullEmail()) {
                          <div class="meta-row">
                            <span class="meta-label">From</span> {{ fullEmail()!.from_addr }}
                          </div>
                          <div class="meta-row">
                            <span class="meta-label">To</span> {{ fullEmail()!.to_addr }}
                          </div>
                          <div class="meta-row">
                            <span class="meta-label">Date</span> {{ fullEmail()!.received_at | date:'medium' }}
                          </div>
                          @if (fullEmail()!.mailbox) {
                            <div class="meta-row">
                              <span class="meta-label">Mailbox</span> {{ fullEmail()!.mailbox }}
                            </div>
                          }
                          @if (fullEmail()!.body) {
                            <div class="body-section-label">Summary</div>
                            <pre class="body-pre body-pre-summary">{{ fullEmail()!.body }}</pre>
                          }
                          @if (fullEmail()!.raw_body) {
                            <div class="body-section-label" style="margin-top:10px">Full message</div>
                            <pre class="body-pre">{{ fullEmail()!.raw_body }}</pre>
                          } @else if (!fullEmail()!.body) {
                            <div style="color:var(--text-muted);font-size:13px">No body content.</div>
                          }
                        }
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>

          <div class="pagination">
            <button class="btn btn-ghost" (click)="prevPage()" [disabled]="page() === 0">← Prev</button>
            <span style="color:var(--text-muted);font-size:13px">Page {{ page() + 1 }}</span>
            <button class="btn btn-ghost" (click)="nextPage()" [disabled]="!hasMore()">Next →</button>
          </div>
        } @else {
          <div class="empty-state">No emails found.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .stats-bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; margin-bottom: 16px; font-size: 13px; }
    .stat { color: var(--text-muted); }
    .stat-sep { color: var(--border); }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .snippet { font-size: 11px; color: var(--text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .email-row { cursor: pointer; transition: background .1s; }
    .email-row:hover { background: var(--hover-bg); }
    .email-row.expanded { background: var(--active-bg); }
    .body-row td { padding: 0 !important; border-top: none; }
    .body-panel { padding: 14px 16px 16px; background: var(--surface-hover); border-bottom: 1px solid var(--border); }
    .meta-row { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
    .meta-label { font-weight: 600; color: var(--text); min-width: 48px; display: inline-block; }
    .body-section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); margin-top: 10px; margin-bottom: 4px; }
    .body-pre { font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
    .body-pre-summary { max-height: 120px; }
    .pagination { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); margin-top: 8px; }
    .badge-green { background: var(--success-muted); color: var(--success-text); }
  `],
})
export class EmailComponent implements OnInit {
  emails = signal<EmailRow[]>([]);
  mailboxes = signal<string[]>([]);
  page = signal(0);
  hasMore = signal(false);
  total = signal(0);
  indexedCount = signal<number | null>(null);
  expandedId = signal<number | null>(null);
  fullEmail = signal<EmailRecord | null>(null);
  loadingBody = signal(false);

  query = '';
  mailbox = '';

  isFullRecord = isFullRecord;

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getEmailMailboxes().subscribe(m => this.mailboxes.set(m));
    this.load();
  }

  load() {
    this.api.getEmails({ q: this.query || undefined, mailbox: this.mailbox || undefined, page: this.page() })
      .subscribe(r => {
        this.emails.set(r.emails);
        this.hasMore.set(r.hasMore);
        this.total.set(r.total);
        const full = r.emails.filter(isFullRecord);
        if (full.length > 0) {
          const indexed = full.filter(e => e.indexed).length;
          this.indexedCount.set(indexed);
        }
      });
  }

  resetAndSearch() { this.page.set(0); this.expandedId.set(null); this.fullEmail.set(null); this.load(); }
  nextPage() { this.page.update(p => p + 1); this.expandedId.set(null); this.fullEmail.set(null); this.load(); }
  prevPage() { this.page.update(p => Math.max(0, p - 1)); this.expandedId.set(null); this.fullEmail.set(null); this.load(); }

  toggle(e: EmailRow) {
    if (this.expandedId() === e.id) {
      this.expandedId.set(null);
      this.fullEmail.set(null);
      return;
    }
    this.expandedId.set(e.id);
    this.fullEmail.set(null);
    if (isFullRecord(e)) {
      this.fullEmail.set(e);
    } else {
      this.loadingBody.set(true);
      this.api.getEmail(e.id).subscribe(full => {
        this.fullEmail.set(full);
        this.loadingBody.set(false);
      });
    }
  }

  deleteEmail(e: EmailRow) {
    if (!confirm(`Delete email #${e.id} "${e.subject}"?`)) return;
    this.api.deleteEmail(e.id).subscribe(() => {
      this.emails.update(arr => arr.filter(x => x.id !== e.id));
      this.total.update(n => n - 1);
      if (this.expandedId() === e.id) { this.expandedId.set(null); this.fullEmail.set(null); }
    });
  }
}
