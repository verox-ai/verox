import { Component, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="login-wrap">
      <div class="login-box">
        <div class="logo">
          <span class="dot"></span>
          <span>Verox</span>
        </div>
        <p class="subtitle">Enter your UI token to continue</p>
        <form (ngSubmit)="submit()">
          <input class="input" type="password" placeholder="UI Token" [(ngModel)]="token" name="token" autocomplete="current-password" />
          <button class="btn btn-primary" type="submit" style="width:100%;margin-top:10px;justify-content:center" [disabled]="!token() || loading()">
            Sign in
          </button>
        </form>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
        <p class="hint">Set <code>config.channels.webchat.uiToken</code> in your vault to enable auth.</p>
      </div>
    </div>
  `,
  styles: [`
    .login-wrap {
      height: 100vh; display: flex; align-items: center; justify-content: center;
      background: var(--bg);
    }
    .login-box {
      width: 340px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 32px;
    }
    .logo { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; }
    .subtitle { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
    .error { color: var(--danger); font-size: 12px; margin-top: 8px; }
    .hint { color: var(--text-muted); font-size: 11px; margin-top: 16px; }
    .hint code { background: rgba(255,255,255,.06); padding: 1px 4px; border-radius: 3px; }
  `],
})
export class LoginComponent {
  token = signal('');
  error = signal('');
  loading = signal(false);

  constructor(private router: Router, private http: HttpClient) {}

  async submit() {
    if (!this.token()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      await firstValueFrom(
        this.http.get('/api/config', {
          headers: new HttpHeaders({ Authorization: `Bearer ${this.token()}` }),
        })
      );
      localStorage.setItem('verox_token', this.token());
      void this.router.navigate(['/']);
    } catch {
      this.error.set('Invalid token — please try again.');
    } finally {
      this.loading.set(false);
    }
  }
}
