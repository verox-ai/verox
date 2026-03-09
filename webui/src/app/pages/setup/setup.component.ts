import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { interval, Subscription } from 'rxjs';
import { switchMap, distinctUntilChanged } from 'rxjs/operators';

type WizardStep = 'vault_key' | 'webui_token' | 'provider' | 'complete';
type Provider = 'anthropic' | 'openai' | 'ollama' | 'openaicompatible';

interface ModelOption { id: string; label: string; }

const MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 (most capable)' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini (recommended)' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (fast & cheap)' },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { id: 'o1', label: 'o1' },
    { id: 'o3-mini', label: 'o3-mini' },
  ],
};

interface OnboardingStatus {
  step: WizardStep;
  vaultKey?: string;
}

@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="wizard-shell">
      <div class="wizard-card">
        <div class="wizard-logo">
          Verox
          @if (step() === 'complete') {
            <a class="home-link" (click)="goHome()">← Home</a>
          }
        </div>

        <!-- Step indicator -->
        <div class="wizard-steps">
          <div class="step" [class.active]="step() === 'vault_key'" [class.done]="stepIndex() > 0">1</div>
          <div class="step-line"></div>
          <div class="step" [class.active]="step() === 'webui_token'" [class.done]="stepIndex() > 1">2</div>
          <div class="step-line"></div>
          <div class="step" [class.active]="step() === 'provider'" [class.done]="stepIndex() > 2">3</div>
        </div>

        <!-- Step 1: Vault Key -->
        @if (step() === 'vault_key') {
          <h2>Secure your vault</h2>
          <p class="subtitle">
            Verox encrypts secrets using a vault key that never leaves your server.
            Save this key and set it as an environment variable, then restart the process.
          </p>

          @if (vaultKey()) {
            <div class="key-block">
              <code>{{ vaultKey() }}</code>
              <button class="btn-copy" (click)="copyKey()">{{ copied() ? '✓ Copied' : 'Copy' }}</button>
            </div>

            <div class="instructions">
              <p><strong>Option A — shell / .env file:</strong></p>
              <pre>export VEROX_VAULT_PASSWORD={{ vaultKey() }}</pre>

              <p><strong>Option B — systemd service:</strong></p>
              <pre>Environment=VEROX_VAULT_PASSWORD={{ vaultKey() }}</pre>
            </div>

            <div class="notice">
              After setting the variable, <strong>restart Verox</strong>.
              This page will advance automatically.
            </div>
          } @else {
            <div class="loading">Generating key…</div>
          }

          <div class="poll-hint">Checking every 3 s…</div>
        }

        <!-- Step 2: WebUI Password -->
        @if (step() === 'webui_token') {
          <h2>Set a WebUI password</h2>
          <p class="subtitle">
            This token secures access to the Verox web interface and API.
            Choose something strong — treat it like a password.
          </p>

          <div class="form-group">
            <label>Password</label>
            <input type="password" [(ngModel)]="tokenInput" placeholder="Enter password" (keyup.enter)="submitToken()" />
          </div>
          <div class="form-group">
            <label>Confirm password</label>
            <input type="password" [(ngModel)]="tokenConfirm" placeholder="Repeat password" (keyup.enter)="submitToken()" />
          </div>

          @if (tokenError()) {
            <div class="error">{{ tokenError() }}</div>
          }

          <button class="btn-primary" (click)="submitToken()" [disabled]="saving()">
            {{ saving() ? 'Saving…' : 'Continue' }}
          </button>
        }

        <!-- Step 3: Provider -->
        @if (step() === 'provider') {
          <h2>Connect an AI provider</h2>
          <p class="subtitle">
            Verox needs access to a large language model.
            Select a provider, enter your API key, and pick a model.
          </p>

          <div class="form-group">
            <label>Provider</label>
            <select [ngModel]="selectedProvider()" (ngModelChange)="selectedProvider.set($event); onProviderChange()">
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (local)</option>
              <option value="openaicompatible">OpenAI-compatible</option>
            </select>
          </div>

          @if (selectedProvider() !== 'ollama') {
            <div class="form-group">
              <label>API Key</label>
              <input type="password" [(ngModel)]="apiKey"
                [placeholder]="selectedProvider() === 'anthropic' ? 'sk-ant-…' : 'sk-…'" />
            </div>
          }

          @if (selectedProvider() === 'openaicompatible') {
            <div class="form-group">
              <label>API Base URL</label>
              <input type="text" [(ngModel)]="apiBase" placeholder="https://your-endpoint/v1" />
            </div>
          }

          <div class="form-group">
            <label>Model</label>
            @if (modelOptions().length > 0) {
              <select [(ngModel)]="selectedModel">
                @for (m of modelOptions(); track m.id) {
                  <option [value]="m.id">{{ m.label }}</option>
                }
              </select>
            } @else {
              <input type="text" [(ngModel)]="selectedModel"
                placeholder="e.g. llama3, mistral, phi3" (keyup.enter)="submitProvider()" />
            }
          </div>

          @if (providerError()) {
            <div class="error">{{ providerError() }}</div>
          }

          <button class="btn-primary" (click)="submitProvider()" [disabled]="saving()">
            {{ saving() ? 'Saving…' : 'Finish setup' }}
          </button>
        }

        <!-- Complete: restart needed so agent + webchat start -->
        @if (step() === 'complete') {
          <h2>Setup complete!</h2>
          <p class="subtitle">
            Restart Verox to start the agent and WebChat, then log in with the password you just set.
          </p>
          <div class="notice">
            <strong>Restart command:</strong><br>
            <code>pnpm start</code> &nbsp;— or restart your systemd service.
          </div>
          <p style="font-size:13px;color:var(--text-muted,#888);margin-top:12px">
            After restart, return to this page and you'll be taken to the chat.
          </p>
          <button class="btn-primary" style="margin-top:8px" (click)="goHome()">Go to chat →</button>
        }
      </div>
    </div>
  `,
  styles: [`
    .wizard-shell {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg, #0f1117);
      padding: 24px;
    }
    .wizard-card {
      background: var(--surface, #1a1d27);
      border: 1px solid var(--border, #2a2d3a);
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 520px;
    }
    .wizard-logo {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent, #7c6af0);
      margin-bottom: 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .home-link {
      font-size: 13px; font-weight: 400;
      color: var(--text-muted, #888); cursor: pointer;
    }
    .home-link:hover { color: var(--text, #e2e8f0); }
    .wizard-steps {
      display: flex;
      align-items: center;
      margin-bottom: 32px;
    }
    .step {
      width: 32px; height: 32px;
      border-radius: 50%;
      border: 2px solid var(--border, #2a2d3a);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 600;
      color: var(--text-muted, #888);
      flex-shrink: 0;
    }
    .step.active { border-color: var(--accent, #7c6af0); color: var(--accent, #7c6af0); }
    .step.done { background: var(--accent, #7c6af0); border-color: var(--accent, #7c6af0); color: #fff; }
    .step-line { flex: 1; height: 1px; background: var(--border, #2a2d3a); margin: 0 8px; }
    h2 { font-size: 22px; margin: 0 0 8px; }
    .subtitle { color: var(--text-muted, #888); margin: 0 0 24px; line-height: 1.5; }
    .key-block {
      display: flex; align-items: center; gap: 8px;
      background: #0f1117; border: 1px solid var(--border, #2a2d3a);
      border-radius: 6px; padding: 12px; margin-bottom: 20px;
    }
    .key-block code { flex: 1; font-size: 13px; word-break: break-all; }
    .btn-copy {
      background: var(--surface, #1a1d27); border: 1px solid var(--border, #2a2d3a);
      color: var(--text, #e2e8f0); border-radius: 4px; padding: 4px 10px;
      cursor: pointer; font-size: 12px; white-space: nowrap;
    }
    .instructions { margin-bottom: 20px; }
    .instructions p { margin: 0 0 6px; font-size: 13px; }
    pre {
      background: #0f1117; border: 1px solid var(--border, #2a2d3a);
      border-radius: 4px; padding: 10px; font-size: 12px;
      overflow-x: auto; margin: 0 0 14px; white-space: pre-wrap; word-break: break-all;
    }
    .notice {
      background: rgba(124,106,240,.1); border: 1px solid rgba(124,106,240,.3);
      border-radius: 6px; padding: 12px 14px; font-size: 13px; margin-bottom: 16px;
    }
    .poll-hint { font-size: 12px; color: var(--text-muted, #888); text-align: center; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 13px; margin-bottom: 6px; }
    .form-group input, .form-group select {
      width: 100%; background: #0f1117; border: 1px solid var(--border, #2a2d3a);
      color: var(--text, #e2e8f0); border-radius: 6px; padding: 9px 12px;
      font-size: 14px; box-sizing: border-box;
    }
    .form-group select option { background: #0f1117; }
    .btn-primary {
      width: 100%; background: var(--accent, #7c6af0); color: #fff;
      border: none; border-radius: 6px; padding: 10px; font-size: 14px;
      font-weight: 600; cursor: pointer; margin-top: 4px;
    }
    .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .error { color: #f87171; font-size: 13px; margin-bottom: 12px; }
    .loading, .poll-hint { color: var(--text-muted, #888); font-size: 13px; }
  `],
})
export class SetupComponent implements OnInit, OnDestroy {
  step = signal<WizardStep>('vault_key');
  vaultKey = signal<string | null>(null);
  copied = signal(false);
  saving = signal(false);
  tokenInput = '';
  tokenConfirm = '';
  tokenError = signal('');
  selectedProvider = signal<Provider>('anthropic');
  apiKey = '';
  apiBase = '';
  selectedModel = MODELS['anthropic'][0].id;
  providerError = signal('');

  modelOptions = computed(() => MODELS[this.selectedProvider()] ?? []);

  onProviderChange() {
    const opts = MODELS[this.selectedProvider()];
    this.selectedModel = opts ? opts[0].id : '';
  }

  private pollSub?: Subscription;

  constructor(private http: HttpClient, private router: Router) { }

  stepIndex() {
    const order: WizardStep[] = ['vault_key', 'webui_token', 'provider', 'complete'];
    return order.indexOf(this.step());
  }

  ngOnInit() {
    this.pollStatus();
    this.pollSub = interval(3000).pipe(
      switchMap(() => this.http.get<OnboardingStatus>('/api/onboarding/status')),
      distinctUntilChanged((a, b) => a.step === b.step),
    ).subscribe(status => this.applyStatus(status));
  }

  ngOnDestroy() {
    this.pollSub?.unsubscribe();
  }

  private pollStatus() {
    this.http.get<OnboardingStatus>('/api/onboarding/status').subscribe(s => this.applyStatus(s));
  }

  goHome() { this.router.navigate(['/']); }

  private applyStatus(status: OnboardingStatus) {
    this.step.set(status.step);
    if (status.vaultKey) this.vaultKey.set(status.vaultKey);
    if (status.step === 'complete') {
      this.pollSub?.unsubscribe();
    }
  }

  copyKey() {
    const key = this.vaultKey();
    if (!key) return;
    navigator.clipboard.writeText(key).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  submitToken() {
    this.tokenError.set('');
    if (!this.tokenInput) { this.tokenError.set('Password is required.'); return; }
    if (this.tokenInput !== this.tokenConfirm) { this.tokenError.set('Passwords do not match.'); return; }
    if (this.tokenInput.length < 8) { this.tokenError.set('Password must be at least 8 characters.'); return; }
    this.saving.set(true);
    this.http.post<{ ok: boolean }>('/api/onboarding/set-webui-token', { token: this.tokenInput })
      .subscribe({
        next: () => {
          localStorage.setItem('verox_token', this.tokenInput);
          this.saving.set(false);
          this.pollStatus();
        },
        error: (err) => {
          this.saving.set(false);
          this.tokenError.set(err?.error?.error ?? 'Failed to save password.');
        },
      });
  }

  submitProvider() {
    this.providerError.set('');
    const prov = this.selectedProvider();
    if (prov !== 'ollama' && !this.apiKey.trim()) {
      this.providerError.set('API key is required.'); return;
    }
    if (!this.selectedModel.trim()) {
      this.providerError.set('Please select or enter a model.'); return;
    }
    this.saving.set(true);

    const token = localStorage.getItem('verox_token') ?? '';
    const headers = { Authorization: `Bearer ${token}` };

    // Store API key in vault (never in config.json)
    const vaultKey = `config.providers.${prov}.apiKey`;
    this.http.post<{ ok: boolean }>('/api/vault', { key: vaultKey, value: this.apiKey.trim() }, { headers })
      .subscribe({
        next: () => {
          // Save model + optional apiBase + enable webchat to config (no secrets)
          const providerPatch: Record<string, unknown> = { model: this.selectedModel.trim() };
          if (prov === 'openaicompatible' && this.apiBase.trim()) {
            providerPatch['apiBase'] = this.apiBase.trim();
          }
          const config = {
            providers: { [prov]: providerPatch },
            channels: { webchat: { enabled: true } },
          };
          this.http.put<{ ok: boolean }>('/api/config', config, { headers }).subscribe({
            next: () => { this.saving.set(false); this.pollStatus(); },
            error: (err) => {
              this.saving.set(false);
              this.providerError.set(err?.error?.error ?? 'Failed to save config.');
            },
          });
        },
        error: (err) => {
          this.saving.set(false);
          this.providerError.set(err?.error?.error ?? 'Failed to save API key to vault.');
        },
      });
  }
}
