import { Component, OnInit, signal } from '@angular/core';
import { ApiService, SkillEntry } from '../../../core/api.service';

@Component({
  selector: 'app-skills',
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Skills</h2>
        <p>Installed skill extensions in the workspace.</p>
      </div>
      <div class="card">
        @if (skills().length) {
          <table>
            <thead><tr><th>Name</th><th>Description</th><th>Status</th><th>Entry</th><th></th></tr></thead>
            <tbody>
              @for (s of skills(); track s.name) {
                <tr [style.opacity]="s.active ? '1' : '0.5'">
                  <td><strong>{{ s.name }}</strong></td>
                  <td style="color:var(--text-muted)">{{ s.description ?? '—' }}</td>
                  <td>
                    @if (s.active) { <span class="badge badge-green">active</span> }
                    @else { <span class="badge badge-gray">inactive</span> }
                  </td>
                  <td>
                    @if (s.hasEntry) { <span class="badge badge-blue">✓</span> }
                    @else { <span class="badge badge-gray">missing</span> }
                  </td>
                  <td style="text-align:right">
                    @if (s.active) {
                      <button class="btn" style="padding:4px 10px" (click)="toggle(s)">Deactivate</button>
                    } @else {
                      <button class="btn btn-primary" style="padding:4px 10px" (click)="toggle(s)">Activate</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty-state">No skills installed in workspace.</div>
        }
      </div>
    </div>
  `,
})
export class SkillsComponent implements OnInit {
  skills = signal<SkillEntry[]>([]);
  constructor(private api: ApiService) {}
  ngOnInit() { this.load(); }
  load() { this.api.getSkills().subscribe(s => this.skills.set(s)); }

  toggle(s: SkillEntry) {
    const call = s.active
      ? this.api.deactivateSkill(s.name)
      : this.api.activateSkill(s.name);
    call.subscribe(() => this.load());
  }
}
