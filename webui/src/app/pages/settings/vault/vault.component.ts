import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, VaultStatus } from '../../../core/api.service';

@Component({
  selector: 'app-vault',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Vault</h2>
        <p>Encrypted credential store. Values are never shown — only key names.</p>
      </div>

      @if (!vault()?.available) {
        <div class="card">
          <p style="color:var(--text-muted)">Vault unavailable — set <code>VEROX_VAULT_PASSWORD</code> env var to enable.</p>
        </div>
      } @else {
        <div class="card">
          <div class="row" style="margin-bottom:12px">
            <input class="input" [(ngModel)]="newKey" placeholder="Key (e.g. skill.myscript.MY_TOKEN)" />
            <input class="input" [(ngModel)]="newValue" type="password" placeholder="Value" />
            <button class="btn btn-primary" (click)="addKey()" [disabled]="!newKey || !newValue">Add</button>
          </div>

          @if (vault()?.keys?.length) {
            <table>
              <thead><tr><th>Key</th><th></th></tr></thead>
              <tbody>
                @for (key of vault()!.keys; track key) {
                  <tr>
                    <td><code>{{ key }}</code></td>
                    <td style="text-align:right">
                      <div style="display:flex;gap:6px;justify-content:flex-end">
                        <button class="btn" style="padding:4px 10px" (click)="startEdit(key)">Update</button>
                        <button class="btn btn-danger" style="padding:4px 10px" (click)="deleteKey(key)">Delete</button>
                      </div>
                    </td>
                  </tr>
                  @if (editingKey === key) {
                    <tr>
                      <td colspan="2">
                        <div class="edit-row">
                          <input class="input" [(ngModel)]="editValue" type="password"
                            placeholder="New value for {{ key }}" (keydown.enter)="saveEdit()" />
                          <button class="btn btn-primary" (click)="saveEdit()" [disabled]="!editValue">Save</button>
                          <button class="btn" (click)="cancelEdit()">Cancel</button>
                        </div>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-state">No vault entries yet.</div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .edit-row { display:flex; gap:8px; padding:8px 0; align-items:center; }
    .edit-row .input { flex:1; }
  `],
})
export class VaultComponent implements OnInit {
  vault = signal<VaultStatus | null>(null);
  newKey = '';
  newValue = '';
  editingKey: string | null = null;
  editValue = '';

  constructor(private api: ApiService) {}

  ngOnInit() { this.load(); }
  load() { this.api.getVault().subscribe(v => this.vault.set(v)); }

  addKey() {
    if (!this.newKey || !this.newValue) return;
    this.api.setVaultKey(this.newKey, this.newValue).subscribe(() => {
      this.newKey = '';
      this.newValue = '';
      this.load();
    });
  }

  startEdit(key: string) {
    this.editingKey = key;
    this.editValue = '';
  }

  saveEdit() {
    if (!this.editingKey || !this.editValue) return;
    this.api.setVaultKey(this.editingKey, this.editValue).subscribe(() => {
      this.cancelEdit();
    });
  }

  cancelEdit() {
    this.editingKey = null;
    this.editValue = '';
  }

  deleteKey(key: string) {
    if (!confirm(`Delete vault key "${key}"?`)) return;
    this.api.deleteVaultKey(key).subscribe(() => this.load());
  }
}
