import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="shell">
      <nav class="sidebar">
        <div class="logo">
          <span class="dot"></span>
          <span>Verox</span>
        </div>
        <ul>
          <li class="nav-section">Chat</li>
          <li><a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{exact:true}">💬 Chat</a></li>
          <li class="nav-section">Settings</li>
          <li><a routerLink="/settings/config"   routerLinkActive="active">⚙️ Config</a></li>
          <li><a routerLink="/settings/vault"    routerLinkActive="active">🔐 Vault</a></li>
          <li><a routerLink="/settings/skills"   routerLinkActive="active">🧩 Skills</a></li>
          <li><a routerLink="/settings/sessions" routerLinkActive="active">📋 Sessions</a></li>
          <li><a routerLink="/settings/memory"   routerLinkActive="active">🧠 Memory</a></li>
          <li><a routerLink="/settings/cron"     routerLinkActive="active">⏰ Cron</a></li>
          <li><a routerLink="/settings/docs"     routerLinkActive="active">📚 Docs</a></li>
          <li><a routerLink="/settings/logs"      routerLinkActive="active">📄 Logs</a></li>
          <li class="nav-section">Channels</li>
          <li><a routerLink="/settings/whatsapp" routerLinkActive="active">💬 WhatsApp</a></li>
        </ul>
        <div class="logout" (click)="logout()">Sign out</div>
      </nav>
      <main class="content">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .shell { display: flex; height: 100vh; }
    .sidebar {
      width: 200px; flex-shrink: 0;
      background: var(--surface); border-right: 1px solid var(--border);
      display: flex; flex-direction: column; padding: 16px 0;
    }
    .logo {
      display: flex; align-items: center; gap: 8px;
      padding: 0 16px 20px; font-weight: 600; font-size: 15px;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
    ul { list-style: none; padding: 0; margin: 0; flex: 1; }
    li a {
      display: block; padding: 7px 16px; color: var(--text-muted);
      text-decoration: none; font-size: 13.5px; border-radius: 6px; margin: 1px 8px;
      transition: background .12s, color .12s;
    }
    li a:hover { background: rgba(255,255,255,.05); color: var(--text); }
    li a.active { background: rgba(59,130,246,.15); color: var(--accent); }
    .nav-section {
      padding: 12px 16px 4px; font-size: 10px; font-weight: 700;
      letter-spacing: .08em; color: var(--text-muted); text-transform: uppercase;
    }
    .logout {
      padding: 10px 16px; font-size: 12px; color: var(--text-muted);
      cursor: pointer; margin: 8px;
      border-radius: 6px; transition: background .12s;
    }
    .logout:hover { background: rgba(255,255,255,.05); color: var(--text); }
    .content { flex: 1; overflow: auto; }
  `],
})
export class LayoutComponent {
  logout() {
    localStorage.removeItem('verox_token');
    location.href = '/login';
  }
}
