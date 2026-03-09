import { Component, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiService, CronEntry } from '../../../core/api.service';

type ScheduleMode = 'once' | 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

interface JobForm {
  id: string; mode: ScheduleMode; when: string;
  hour: number; minute: number; weekday: number; customCron: string;
  prompt: string; channel: string; chatId: string;
}

function buildCronExpression(mode: ScheduleMode, hour: number, minute: number, weekday: number, customCron: string): string {
  switch (mode) {
    case 'daily':    return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly':   return `${minute} ${hour} * * ${weekday}`;
    case 'hourly':   return `${minute} * * * *`;
    case 'custom':   return customCron;
    default:         return `${minute} ${hour} * * *`;
  }
}

function describeSchedule(mode: ScheduleMode, hour: number, minute: number, weekday: number, customCron: string, when: string): string {
  const t = `${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}`;
  switch (mode) {
    case 'once':     return when ? `Once: ${when}` : 'Once — enter time above';
    case 'daily':    return `Every day at ${t}`;
    case 'weekdays': return `Every weekday (Mon–Fri) at ${t}`;
    case 'weekly':   return `Every ${DAYS[weekday]} at ${t}`;
    case 'hourly':   return `Every hour at :${minute.toString().padStart(2,'0')}`;
    case 'custom':   return customCron || 'Enter a cron expression';
  }
}

function blankForm(): JobForm {
  return { id: '', mode: 'once', when: '', hour: 9, minute: 0, weekday: 1, customCron: '', prompt: '', channel: '', chatId: '' };
}

/** Try to infer a friendly mode from an existing cron expression. */
function cronToMode(schedule: string): ScheduleMode {
  if (/^\d+ \d+ \d+ \d+ \*$/.test(schedule)) return 'once';
  if (/^\d+ \d+ \* \* \*$/.test(schedule))   return 'daily';
  if (/^\d+ \d+ \* \* 1-5$/.test(schedule))  return 'weekdays';
  if (/^\d+ \d+ \* \* \d$/.test(schedule))   return 'weekly';
  if (/^\d+ \* \* \* \*$/.test(schedule))    return 'hourly';
  return 'custom';
}

function entryToForm(j: CronEntry): JobForm {
  const parts = j.schedule.split(' ');
  const minute  = parseInt(parts[0] ?? '0', 10);
  const hour    = parseInt(parts[1] ?? '9', 10);
  const weekday = parseInt(parts[4] ?? '1', 10);
  const mode    = j.recurring ? cronToMode(j.schedule) : 'once';
  const target  = j.targets[0] ?? { channel: '', chatId: '' };
  return {
    id: j.id, mode,
    when: '',                          // can't reverse-engineer natural language
    hour:    isNaN(hour) ? 9 : hour,
    minute:  isNaN(minute) ? 0 : minute,
    weekday: isNaN(weekday) ? 1 : weekday,
    customCron: mode === 'custom' ? j.schedule : '',
    prompt: j.prompt,
    channel: target.channel,
    chatId:  target.chatId,
  };
}


@Component({
  selector: 'app-cron',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Cron Jobs</h2>
        <p>Scheduled tasks that run the agent on a recurring schedule.</p>
      </div>

      <!-- ── Create form ── -->
      <div class="card">
        <h3 style="margin-bottom:14px;font-size:14px;font-weight:600">New Job</h3>
        <div class="form-row">
          <div>
            <label class="label">ID (optional)</label>
            <input class="input" [(ngModel)]="form.id" placeholder="auto-generated" />
          </div>
          <div>
            <label class="label">Schedule</label>
            <select class="input" [(ngModel)]="form.mode">
              <option value="once">Once (reminder)</option>
              <option value="daily">Every day</option>
              <option value="weekdays">Every weekday</option>
              <option value="weekly">Every week</option>
              <option value="hourly">Every hour</option>
              <option value="custom">Custom cron</option>
            </select>
          </div>
        </div>
        @if (form.mode === 'once') {
          <div style="margin-bottom:10px">
            <label class="label">When</label>
            <input class="input" [(ngModel)]="form.when" placeholder="in 2 hours · tomorrow at 9am · next Monday at 10:00" />
          </div>
        }
        @if (form.mode === 'daily' || form.mode === 'weekdays' || form.mode === 'weekly') {
          <div class="form-row">
            <div>
              <label class="label">Hour</label>
              <select class="input" [(ngModel)]="form.hour">
                @for (h of hours; track h) { <option [value]="h">{{ h.toString().padStart(2,'0') }}</option> }
              </select>
            </div>
            <div>
              <label class="label">Minute</label>
              <select class="input" [(ngModel)]="form.minute">
                @for (m of minutes; track m) { <option [value]="m">{{ m.toString().padStart(2,'0') }}</option> }
              </select>
            </div>
            @if (form.mode === 'weekly') {
              <div>
                <label class="label">Day</label>
                <select class="input" [(ngModel)]="form.weekday">
                  @for (d of days; track $index) { <option [value]="$index">{{ d }}</option> }
                </select>
              </div>
            }
          </div>
        }
        @if (form.mode === 'hourly') {
          <div style="margin-bottom:10px;max-width:140px">
            <label class="label">At minute</label>
            <select class="input" [(ngModel)]="form.minute">
              @for (m of minutes; track m) { <option [value]="m">:{{ m.toString().padStart(2,'0') }}</option> }
            </select>
          </div>
        }
        @if (form.mode === 'custom') {
          <div style="margin-bottom:10px">
            <label class="label">Cron expression</label>
            <input class="input" [(ngModel)]="form.customCron" placeholder="0 9 * * *" style="font-family:monospace" />
          </div>
        }
        <div class="preview">{{ createPreview() }}</div>
        <div style="margin-bottom:10px">
          <label class="label">Prompt</label>
          <textarea class="input" [(ngModel)]="form.prompt" placeholder="What should the agent do?" style="min-height:60px"></textarea>
        </div>
        <div class="form-row">
          <div>
            <label class="label">Channel</label>
            <input class="input" [(ngModel)]="form.channel" placeholder="telegram" />
          </div>
          <div>
            <label class="label">Chat ID</label>
            <input class="input" [(ngModel)]="form.chatId" placeholder="123456789" />
          </div>
        </div>
        <button class="btn btn-primary" (click)="create()" [disabled]="!canSubmit(form)">Add Job</button>
      </div>

      <!-- ── Job list ── -->
      <div class="card">
        @if (jobs().length) {
          <table>
            <thead>
              <tr><th>ID</th><th>Schedule</th><th>Prompt</th><th>Targets</th><th>Next run</th><th></th></tr>
            </thead>
            <tbody>
              @for (j of jobs(); track j.id) {
                <tr [class.row-editing]="editingId() === j.id">
                  <td><code style="font-size:12px">{{ j.id }}</code></td>
                  <td>
                    <code style="font-size:12px">{{ j.schedule }}</code>
                    @if (!j.recurring) { <span class="badge badge-gray" style="margin-left:4px">once</span> }
                  </td>
                  <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ j.prompt }}</td>
                  <td style="font-size:12px;color:var(--text-muted)">
                    @for (t of j.targets; track t.chatId) { {{ t.channel }}:{{ t.chatId }}<br> }
                  </td>
                  <td style="color:var(--text-muted);white-space:nowrap;font-size:12px">{{ j.nextRun | date:'dd MMM HH:mm' }}</td>
                  <td>
                    <div style="display:flex;gap:6px">
                      <button class="btn" style="padding:4px 10px" (click)="toggleEdit(j)">
                        {{ editingId() === j.id ? 'Close' : 'Edit' }}
                      </button>
                      <button class="btn btn-danger" style="padding:4px 10px" (click)="deleteJob(j.id)">Delete</button>
                    </div>
                  </td>
                </tr>
                <!-- Inline edit row -->
                @if (editingId() === j.id && editForm) {
                  <tr class="edit-row">
                    <td colspan="6">
                      <div class="edit-panel">
                        <div class="form-row">
                          <div>
                            <label class="label">Schedule</label>
                            <select class="input" [(ngModel)]="editForm.mode">
                              <option value="once">Once (reminder)</option>
                              <option value="daily">Every day</option>
                              <option value="weekdays">Every weekday</option>
                              <option value="weekly">Every week</option>
                              <option value="hourly">Every hour</option>
                              <option value="custom">Custom cron</option>
                            </select>
                          </div>
                          @if (editForm.mode === 'once') {
                            <div>
                              <label class="label">When (blank = keep schedule)</label>
                              <input class="input" [(ngModel)]="editForm.when" placeholder="in 2 hours · tomorrow at 9am" />
                            </div>
                          }
                          @if (editForm.mode === 'daily' || editForm.mode === 'weekdays' || editForm.mode === 'weekly') {
                            <div>
                              <label class="label">Hour</label>
                              <select class="input" [(ngModel)]="editForm.hour">
                                @for (h of hours; track h) { <option [value]="h">{{ h.toString().padStart(2,'0') }}</option> }
                              </select>
                            </div>
                            <div>
                              <label class="label">Minute</label>
                              <select class="input" [(ngModel)]="editForm.minute">
                                @for (m of minutes; track m) { <option [value]="m">{{ m.toString().padStart(2,'0') }}</option> }
                              </select>
                            </div>
                          }
                          @if (editForm.mode === 'weekly') {
                            <div>
                              <label class="label">Day</label>
                              <select class="input" [(ngModel)]="editForm.weekday">
                                @for (d of days; track $index) { <option [value]="$index">{{ d }}</option> }
                              </select>
                            </div>
                          }
                          @if (editForm.mode === 'hourly') {
                            <div style="max-width:140px">
                              <label class="label">At minute</label>
                              <select class="input" [(ngModel)]="editForm.minute">
                                @for (m of minutes; track m) { <option [value]="m">:{{ m.toString().padStart(2,'0') }}</option> }
                              </select>
                            </div>
                          }
                          @if (editForm.mode === 'custom') {
                            <div style="flex:1">
                              <label class="label">Cron expression</label>
                              <input class="input" [(ngModel)]="editForm.customCron" style="font-family:monospace" />
                            </div>
                          }
                        </div>
                        <div class="preview" style="margin-bottom:10px">{{ editPreview() }}</div>
                        <div class="form-row">
                          <div style="flex:2;min-width:200px">
                            <label class="label">Prompt</label>
                            <textarea class="input" [(ngModel)]="editForm.prompt" style="min-height:52px" rows="10"></textarea>
                          </div>
                          <div>
                            <label class="label">Channel</label>
                            <input class="input" [(ngModel)]="editForm.channel" />
                          </div>
                          <div>
                            <label class="label">Chat ID</label>
                            <input class="input" [(ngModel)]="editForm.chatId" />
                          </div>
                        </div>
                        <div style="display:flex;gap:8px">
                          <button class="btn btn-primary" (click)="save(j.id)" [disabled]="!canSubmit(editForm)">Save</button>
                          <button class="btn" (click)="cancelEdit()">Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        } @else {
          <div class="empty-state">No cron jobs scheduled.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .label { display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
    .form-row { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
    .form-row > div { min-width:140px; flex:1; }
    .preview { font-size:12px; color:var(--accent); background:rgba(59,130,246,.08); border-radius:6px; padding:6px 10px; margin-bottom:12px; font-weight:500; }
    .row-editing td { background:rgba(59,130,246,.04); }
    .edit-row td { padding:0 !important; }
    .edit-panel { padding:16px; border-top:1px solid var(--border); }
  `],
})
export class CronComponent implements OnInit {
  jobs = signal<CronEntry[]>([]);
  editingId = signal<string | null>(null);
  editForm: JobForm | null = null;

  form = blankForm();

  hours   = Array.from({ length: 24 }, (_, i) => i);
  minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  days    = DAYS;

  createPreview = computed(() =>
    describeSchedule(this.form.mode, this.form.hour, this.form.minute, this.form.weekday, this.form.customCron, this.form.when)
  );
  editPreview = computed(() =>
    this.editForm
      ? describeSchedule(this.editForm.mode, this.editForm.hour, this.editForm.minute, this.editForm.weekday, this.editForm.customCron, this.editForm.when)
      : ''
  );

  constructor(private api: ApiService) {}
  ngOnInit() { this.load(); }
  load() { this.api.getCronJobs().subscribe(j => this.jobs.set(j)); }

  canSubmit(f: JobForm): boolean {
    if (!f.prompt || !f.channel || !f.chatId) return false;
    if (f.mode === 'once') return !!f.when || !!f.customCron; // allow empty 'when' when editing
    if (f.mode === 'custom') return !!f.customCron;
    return true;
  }

  toggleEdit(j: CronEntry) {
    if (this.editingId() === j.id) {
      this.cancelEdit();
    } else {
      this.editingId.set(j.id);
      this.editForm = entryToForm(j);
    }
  }

  cancelEdit() {
    this.editingId.set(null);
    this.editForm = null;
  }

  buildBody(f: JobForm): Record<string, unknown> {
    const isOnce = f.mode === 'once';
    return {
      prompt: f.prompt,
      targets: [{ channel: f.channel, chatId: f.chatId }],
      recurring: !isOnce,
      schedule: isOnce ? (f.customCron || '0 0 1 1 *') : buildCronExpression(f.mode, f.hour, f.minute, f.weekday, f.customCron),
      ...(isOnce && f.when ? { when: f.when } : {}),
    };
  }

  create() {
    const body = { id: this.form.id || `job-${Date.now()}`, ...this.buildBody(this.form) };
    this.api.createCronJob(body as never).subscribe(() => {
      this.form = blankForm();
      this.load();
    });
  }

  save(id: string) {
    if (!this.editForm) return;
    this.api.updateCronJob(id, this.buildBody(this.editForm) as never).subscribe(() => {
      this.cancelEdit();
      this.load();
    });
  }

  deleteJob(id: string) {
    if (!confirm(`Delete cron job "${id}"?`)) return;
    this.api.deleteCronJob(id).subscribe(() => {
      this.cancelEdit();
      this.load();
    });
  }
}
