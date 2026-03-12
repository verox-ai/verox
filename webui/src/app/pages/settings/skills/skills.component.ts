import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, SkillEntry } from '../../../core/api.service';

@Component({
  selector: 'app-skills',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Skills</h2>
        <p>Skill extensions installed in the workspace. Click a skill to edit its files or manage signing.</p>
      </div>

      <!-- New skill bar -->
      <div class="card" style="margin-bottom:16px">
        <div class="row">
          <input class="input" [(ngModel)]="newName" placeholder="skill-name (a-z, 0-9, -, _)" style="max-width:240px" />
          <button class="btn btn-primary" (click)="createSkill()" [disabled]="!newName.trim()">+ New Skill</button>
          @if (createError()) { <span class="error-text">{{ createError() }}</span> }
        </div>
      </div>

      <!-- Skill list -->
      <div class="card">
        @if (skills().length) {
          @for (s of skills(); track s.name) {
            <!-- Row -->
            <div class="skill-row" [class.open]="editingName() === s.name" (click)="toggleEdit(s)">
              <div class="skill-info">
                <strong class="skill-name">{{ s.name }}</strong>
                <span class="skill-desc">{{ s.description ?? '' }}</span>
              </div>
              <div class="skill-badges">
                @if (s.active) { <span class="badge badge-green">active</span> }
                @else { <span class="badge badge-gray">inactive</span> }
                @if (s.signed === true) { <span class="badge badge-blue">✓ signed</span> }
                @else if (s.signed === false) { <span class="badge badge-red">⚠ tampered</span> }
                @else if (s.signed === null) { <span class="badge badge-gray">unsigned</span> }
              </div>
              <div class="skill-actions" (click)="$event.stopPropagation()">
                @if (s.active) {
                  <button class="btn" style="padding:3px 8px;font-size:12px" (click)="toggle(s)">Deactivate</button>
                } @else {
                  <button class="btn btn-primary" style="padding:3px 8px;font-size:12px" (click)="toggle(s)">Activate</button>
                }
                <button class="btn btn-danger" style="padding:3px 8px;font-size:12px" (click)="deleteSkill(s)">Del</button>
              </div>
            </div>

            <!-- Inline editor -->
            @if (editingName() === s.name) {
              <div class="editor-panel">
                @if (loadingFiles()) {
                  <div style="color:var(--text-muted);font-size:13px;padding:8px 0">Loading…</div>
                } @else {
                  <!-- Tab bar -->
                  <div class="tab-bar">
                    @for (f of fileList(); track f) {
                      <button class="tab-btn" [class.active]="activeFile() === f" (click)="openFile(f)">
                        {{ f }}
                      </button>
                    }
                    <!-- New file tab -->
                    @if (!addingFile()) {
                      <button class="tab-btn tab-add" (click)="addingFile.set(true)" title="New file">+</button>
                    } @else {
                      <div class="new-file-input" (click)="$event.stopPropagation()">
                        <input class="input input-sm" [(ngModel)]="newFileName"
                          placeholder="index.sh" (keydown.enter)="addFile(s)" (keydown.escape)="addingFile.set(false)" />
                        <button class="btn btn-primary" style="padding:2px 8px;font-size:12px" (click)="addFile(s)">Add</button>
                        <button class="btn btn-ghost" style="padding:2px 8px;font-size:12px" (click)="addingFile.set(false)">✕</button>
                      </div>
                    }
                    <div style="flex:1"></div>
                    <!-- Signing tab always at right -->
                    <button class="tab-btn" [class.active]="activeFile() === '__sign__'" (click)="activeFile.set('__sign__')">
                      Signing
                      @if (s.signed === false) { <span style="color:var(--warning-text);margin-left:4px">⚠</span> }
                    </button>
                  </div>

                  <!-- File editor -->
                  @if (activeFile() !== '__sign__') {
                    <div class="file-header" (click)="$event.stopPropagation()">
                      @if (activeFile() !== 'SKILL.md') {
                        <button class="btn btn-danger" style="padding:2px 8px;font-size:11px;margin-left:auto"
                          (click)="deleteFile(s)">Delete file</button>
                      }
                    </div>
                    <textarea class="input editor-textarea"
                      [class.monospace]="!activeFile()?.endsWith('.md')"
                      [ngModel]="fileContent()"
                      (ngModelChange)="fileContent.set($event)"
                      [placeholder]="'Edit ' + activeFile()"></textarea>
                    <div class="editor-actions" (click)="$event.stopPropagation()">
                      <button class="btn btn-primary" (click)="saveFile(s)" [disabled]="saving()">
                        {{ saving() ? 'Saving…' : 'Save' }}
                      </button>
                      @if (saveError()) { <span class="error-text">{{ saveError() }}</span> }
                    </div>
                  }

                  <!-- Signing panel -->
                  @if (activeFile() === '__sign__') {
                    <div class="sign-panel" (click)="$event.stopPropagation()">
                      <div class="sign-status">
                        @if (s.signed === true) {
                          <span class="sign-ok">✓ Signed and verified — all files match the stored manifest.</span>
                        } @else if (s.signed === false) {
                          <span class="sign-warn">⚠ Files changed since signing. Re-sign after reviewing changes.</span>
                        } @else if (s.signed === null) {
                          <span class="sign-info">Not signed. Signing lets the agent inject vault credentials for this skill.</span>
                        } @else {
                          <span class="sign-info">Vault not available — set VEROX_VAULT_PASSWORD to enable signing.</span>
                        }
                      </div>
                      <div class="sign-actions">
                        <button class="btn btn-primary" (click)="sign(s)" [disabled]="signing()">
                          {{ signing() ? 'Signing…' : (s.signed === true ? 'Re-sign' : 'Sign') }}
                        </button>
                        @if (s.signed !== null && s.signed !== undefined) {
                          <button class="btn" style="padding:4px 10px" (click)="unsign(s)" [disabled]="signing()">Unsign</button>
                        }
                      </div>
                      @if (signMessage()) { <div class="sign-msg">{{ signMessage() }}</div> }
                    </div>
                  }
                }
              </div>
            }

            <div class="skill-divider"></div>
          }
        } @else {
          <div class="empty-state">No skills installed in workspace.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .skill-row { display: flex; align-items: center; gap: 12px; padding: 10px 4px; cursor: pointer;
      border-radius: 4px; transition: background .1s; }
    .skill-row:hover { background: var(--hover-bg); }
    .skill-row.open { background: var(--active-bg); }
    .skill-info { flex: 1; min-width: 0; }
    .skill-name { font-size: 14px; }
    .skill-desc { font-size: 12px; color: var(--text-muted); margin-left: 8px; }
    .skill-badges { display: flex; gap: 4px; flex-shrink: 0; }
    .skill-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .skill-divider { height: 1px; background: var(--border); margin: 0 -4px; }
    .skill-divider:last-child { display: none; }
    .editor-panel { padding: 12px 0 16px; }
    .tab-bar { display: flex; align-items: center; gap: 2px; margin-bottom: 12px;
      border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .tab-btn { background: none; border: none; color: var(--text-muted); padding: 6px 12px;
      font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent;
      margin-bottom: -1px; white-space: nowrap; }
    .tab-btn.active { color: var(--text); border-bottom-color: var(--accent-indigo); }
    .tab-add { font-size: 16px; padding: 4px 10px; color: var(--text-muted); }
    .new-file-input { display: flex; align-items: center; gap: 4px; padding: 0 4px; }
    .input-sm { height: 26px; padding: 2px 8px; font-size: 12px; width: 120px; }
    .file-header { display: flex; align-items: center; margin-bottom: 6px; min-height: 24px; }
    .editor-textarea { min-height: 340px; font-size: 13px; resize: vertical; width: 100%; box-sizing: border-box; }
    .monospace { font-family: monospace; }
    .editor-actions { display: flex; align-items: center; gap: 10px; padding-top: 10px; }
    .error-text { color: var(--error-text); font-size: 13px; }
    .badge-red { background: var(--danger-muted); color: var(--error-text); }
    .sign-panel { padding: 8px 0; }
    .sign-status { margin-bottom: 12px; font-size: 13px; }
    .sign-ok { color: var(--success-text); }
    .sign-warn { color: var(--warning-text); }
    .sign-info { color: var(--text-muted); }
    .sign-actions { display: flex; gap: 8px; margin-bottom: 10px; }
    .sign-msg { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .row { display: flex; align-items: center; gap: 8px; }
  `],
})
export class SkillsComponent implements OnInit {
  skills = signal<SkillEntry[]>([]);
  editingName = signal<string | null>(null);
  fileList = signal<string[]>([]);
  activeFile = signal<string | null>(null);
  fileContent = signal('');
  loadingFiles = signal(false);
  saving = signal(false);
  signing = signal(false);
  saveError = signal('');
  signMessage = signal('');
  createError = signal('');
  addingFile = signal(false);
  newName = '';
  newFileName = '';

  constructor(private api: ApiService) {}
  ngOnInit() { this.load(); }
  load() { this.api.getSkills().subscribe(s => this.skills.set(s)); }

  toggle(s: SkillEntry) {
    (s.active ? this.api.deactivateSkill(s.name) : this.api.activateSkill(s.name))
      .subscribe(() => this.load());
  }

  toggleEdit(s: SkillEntry) {
    if (this.editingName() === s.name) { this.editingName.set(null); return; }
    this.editingName.set(s.name);
    this.saveError.set('');
    this.signMessage.set('');
    this.addingFile.set(false);
    this.loadFiles(s.name, 'SKILL.md');
  }

  private loadFiles(skillName: string, openFile?: string) {
    this.loadingFiles.set(true);
    this.api.listSkillFiles(skillName).subscribe({
      next: (files) => {
        this.fileList.set(files);
        this.loadingFiles.set(false);
        const target = openFile && files.includes(openFile) ? openFile : (files[0] ?? null);
        if (target) this.openFile(target, skillName);
        else this.activeFile.set(null);
      },
      error: () => this.loadingFiles.set(false),
    });
  }

  openFile(filename: string, skillName?: string) {
    const name = skillName ?? this.editingName()!;
    this.activeFile.set(filename);
    this.fileContent.set('');
    this.saveError.set('');
    this.api.getSkillFile(name, filename).subscribe({
      next: (r) => this.fileContent.set(r.content),
      error: () => this.fileContent.set(''),
    });
  }

  saveFile(s: SkillEntry) {
    const filename = this.activeFile();
    if (!filename) return;
    this.saving.set(true);
    this.saveError.set('');
    this.api.saveSkillFile(s.name, filename, this.fileContent()).subscribe({
      next: () => { this.saving.set(false); this.load(); },
      error: (err) => { this.saving.set(false); this.saveError.set(err?.error?.error ?? 'Save failed.'); },
    });
  }

  addFile(s: SkillEntry) {
    const filename = this.newFileName.trim();
    if (!filename) return;
    this.api.createSkillFile(s.name, filename).subscribe({
      next: () => {
        this.newFileName = '';
        this.addingFile.set(false);
        this.loadFiles(s.name, filename);
      },
      error: (err) => { this.saveError.set(err?.error?.error ?? 'Create failed.'); },
    });
  }

  deleteFile(s: SkillEntry) {
    const filename = this.activeFile();
    if (!filename || filename === 'SKILL.md') return;
    if (!confirm(`Delete "${filename}" from skill "${s.name}"?`)) return;
    this.api.deleteSkillFile(s.name, filename).subscribe({
      next: () => this.loadFiles(s.name),
      error: (err) => { this.saveError.set(err?.error?.error ?? 'Delete failed.'); },
    });
  }

  sign(s: SkillEntry) {
    this.signing.set(true);
    this.signMessage.set('');
    this.api.signSkill(s.name).subscribe({
      next: (r) => {
        this.signing.set(false);
        this.signMessage.set(`Signed — ${r.fileCount ?? '?'} files hashed.`);
        this.load();
      },
      error: (err) => {
        this.signing.set(false);
        this.signMessage.set(err?.error?.error ?? 'Signing failed.');
      },
    });
  }

  unsign(s: SkillEntry) {
    if (!confirm(`Remove signature for "${s.name}"?`)) return;
    this.api.unsignSkill(s.name).subscribe({
      next: () => { this.signMessage.set('Signature removed.'); this.load(); },
      error: (err) => { this.signMessage.set(err?.error?.error ?? 'Failed.'); },
    });
  }

  createSkill() {
    const name = this.newName.trim();
    this.createError.set('');
    this.api.createSkill(name).subscribe({
      next: () => { this.newName = ''; this.load(); },
      error: (err) => { this.createError.set(err?.error?.error ?? 'Create failed.'); },
    });
  }

  deleteSkill(s: SkillEntry) {
    if (!confirm(`Delete skill "${s.name}" and all its files?`)) return;
    this.api.deleteSkill(s.name).subscribe(() => {
      if (this.editingName() === s.name) this.editingName.set(null);
      this.load();
    });
  }
}
