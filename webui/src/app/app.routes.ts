import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent) },
  { path: 'setup', loadComponent: () => import('./pages/setup/setup.component').then(m => m.SetupComponent) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/layout.component').then(m => m.LayoutComponent),
    children: [
      { path: '', loadComponent: () => import('./pages/chat/chat.component').then(m => m.ChatComponent) },
      { path: 'settings/config',   loadComponent: () => import('./pages/settings/config/config.component').then(m => m.ConfigComponent) },
      { path: 'settings/vault',    loadComponent: () => import('./pages/settings/vault/vault.component').then(m => m.VaultComponent) },
      { path: 'settings/skills',   loadComponent: () => import('./pages/settings/skills/skills.component').then(m => m.SkillsComponent) },
      { path: 'settings/sessions', loadComponent: () => import('./pages/settings/sessions/sessions.component').then(m => m.SessionsComponent) },
      { path: 'settings/memory',   loadComponent: () => import('./pages/settings/memory/memory.component').then(m => m.MemoryComponent) },
      { path: 'settings/cron',     loadComponent: () => import('./pages/settings/cron/cron.component').then(m => m.CronComponent) },
      { path: 'settings/docs',     loadComponent: () => import('./pages/settings/docs/docs.component').then(m => m.DocsComponent) },
      { path: 'settings/workflows', loadComponent: () => import('./pages/settings/workflows/workflows.component').then(m => m.WorkflowsComponent) },
      { path: 'settings/knowledge', loadComponent: () => import('./pages/settings/knowledge/knowledge.component').then(m => m.KnowledgeComponent) },
      { path: 'settings/logs',      loadComponent: () => import('./pages/settings/logview/logview.component').then(m => m.LogsComponent) },
      { path: 'settings/whatsapp', loadComponent: () => import('./pages/settings/whatsapp/whatsapp.component').then(m => m.WhatsAppComponent) },
      { path: 'settings/rss',     loadComponent: () => import('./pages/settings/rss/rss.component').then(m => m.RssComponent) },
      { path: 'settings/prompts', loadComponent: () => import('./pages/settings/prompts/prompts.component').then(m => m.PromptsComponent) },
      { path: '**', redirectTo: '' },
    ],
  },
  { path: '**', redirectTo: '' },
];
