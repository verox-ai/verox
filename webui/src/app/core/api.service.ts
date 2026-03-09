import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface McpServerStatus {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
}

export interface MemoryEntry {
  id: number;
  type: string;
  content: string;
  confidence: number;
  pinned: boolean;
  protected: boolean;
  tags: string[];
  created_at: string;
  memory_type: string | null;
}

export interface CronEntry {
  id: string;
  schedule: string;
  prompt: string;
  targets: Array<{ channel: string; chatId: string }>;
  recurring: boolean;
  nextRun: string;
}

export interface SessionHeader {
  key: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionMessage {
  role: string;
  content: string;
  timestamp?: string;
}

export interface DocFile {
  path: string;
  file_hash?: string;
  chunks?: number;
  indexed_at?: string;
  pathObject?: { name: string; path: string };
  fileName?: string;
}

export interface SkillEntry {
  name: string;
  active: boolean;
  hasConfig: boolean;
  hasEntry: boolean;
  description: string | null;
}

export interface ConfigUiHint {
  label?: string;
  help?: string;
  sensitive?: boolean;
  advanced?: boolean;
  group?: string;
  order?: number;
}

export interface ConfigSchemaResponse {
  schema: Record<string, unknown>;
  uiHints: Record<string, ConfigUiHint>;
  version: string;
  generatedAt: string;
}

export interface VaultStatus {
  available: boolean;
  keys: string[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  // Config
  getConfig(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>('/api/config');
  }
  saveConfig(config: Record<string, unknown>): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>('/api/config', config);
  }
  getConfigSchema(): Observable<ConfigSchemaResponse> {
    return this.http.get<ConfigSchemaResponse>('/api/config/schema');
  }

  // Vault
  getVault(): Observable<VaultStatus> {
    return this.http.get<VaultStatus>('/api/vault');
  }
  setVaultKey(key: string, value: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/vault', { key, value });
  }
  deleteVaultKey(key: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/vault/${encodeURIComponent(key)}`);
  }

  // Sessions
  getSessions(): Observable<SessionHeader[]> {
    return this.http.get<SessionHeader[]>('/api/sessions');
  }
  getSessionMessages(key: string): Observable<SessionMessage[]> {
    return this.http.get<SessionMessage[]>(`/api/sessions/${encodeURIComponent(key)}/messages`);
  }
  deleteSession(key: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(key)}`);
  }

  // Memory
  searchMemory(q?: string, tag?: string, page = 0): Observable<{ entries: MemoryEntry[]; page: number; hasMore: boolean }> {
    let params = new HttpParams().set('page', page);
    if (q) params = params.set('q', q);
    if (tag) params = params.set('tag', tag);
    return this.http.get<{ entries: MemoryEntry[]; page: number; hasMore: boolean }>('/api/memory', { params });
  }
  deleteMemory(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/memory/${id}`);
  }
  getMemoryTags(): Observable<string[]> {
    return this.http.get<string[]>('/api/memory/tags');
  }

  // Cron
  getCronJobs(): Observable<CronEntry[]> {
    return this.http.get<CronEntry[]>('/api/cron');
  }
  createCronJob(job: Omit<CronEntry, 'nextRun'>): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/cron', job);
  }
  updateCronJob(id: string, job: Omit<CronEntry, 'nextRun' | 'id'>): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`/api/cron/${encodeURIComponent(id)}`, job);
  }
  deleteCronJob(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/cron/${encodeURIComponent(id)}`);
  }

  // Docs
  getDocs(): Observable<DocFile[]> {
    return this.http.get<DocFile[]>('/api/docs');
  }

  // Skills
  getSkills(): Observable<SkillEntry[]> {
    return this.http.get<SkillEntry[]>('/api/skills');
  }
  activateSkill(name: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/activate`, {});
  }
  deactivateSkill(name: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/deactivate`, {});
  }

  // Logs
  getLogs(lines = 200): Observable<{ lines: string[] }> {
    return this.http.get<{ lines: string[] }>(`/api/logs?lines=${lines}`);
  }

  // MCP
  getMcpStatus(): Observable<McpServerStatus[]> {
    return this.http.get<McpServerStatus[]>('/api/mcp/status');
  }

  // WhatsApp
  getWhatsAppQR(): Observable<{ status: 'authenticated' | 'pending' | 'disabled'; qr?: string }> {
    return this.http.get<{ status: 'authenticated' | 'pending' | 'disabled'; qr?: string }>('/api/whatsapp/qr');
  }

  // Onboarding
  getOnboardingStatus(): Observable<{ step: string; vaultKey?: string }> {
    return this.http.get<{ step: string; vaultKey?: string }>('/api/onboarding/status');
  }
  setWebUiToken(token: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/onboarding/set-webui-token', { token });
  }
}
