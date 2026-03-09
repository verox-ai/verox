import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { ApiService } from '../../../core/api.service';

@Component({
  selector: 'app-whatsapp',
  template: `
    <div class="page">
      <div class="page-header">
        <h2>WhatsApp</h2>
        <p>Scan the QR code with WhatsApp on your phone to link the agent as a client.</p>
      </div>

      @if (status() === 'authenticated') {
        <div class="card">
          <div class="auth-status">
            <span class="dot connected"></span>
            <strong>Connected</strong>
            <span style="color:var(--text-muted);margin-left:8px">WhatsApp session is active.</span>
          </div>
        </div>
      }

      @if (status() === 'pending' && qr()) {
        <div class="card qr-card">
          <p class="qr-hint">Open WhatsApp → Settings → Linked Devices → Link a Device</p>
          <img [src]="qr()!" alt="WhatsApp QR Code" class="qr-image" />
          <p class="qr-hint" style="margin-top:12px;color:var(--text-muted)">QR code refreshes automatically.</p>
        </div>
      }

      @if (status() === 'loading') {
        <div class="card">
          <div class="empty-state">Loading…</div>
        </div>
      }

      @if (status() === 'disabled') {
        <div class="card">
          <div class="empty-state">
            WhatsApp channel is not enabled. Add <code>channels.whatsapp.enabled: true</code> to your config.
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .auth-status { display:flex; align-items:center; gap:8px; padding:8px 0; }
    .dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
    .dot.connected { background:var(--green, #22c55e); }
    .qr-card { display:flex; flex-direction:column; align-items:center; padding:24px; }
    .qr-image { width:260px; height:260px; border-radius:8px; }
    .qr-hint { font-size:0.875rem; text-align:center; margin:0; }
  `],
})
export class WhatsAppComponent implements OnInit, OnDestroy {
  status = signal<'loading' | 'authenticated' | 'pending' | 'disabled'>('loading');
  qr = signal<string | null>(null);

  private pollInterval?: ReturnType<typeof setInterval>;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.poll();
    // Re-poll every 5 seconds while waiting for scan
    this.pollInterval = setInterval(() => this.poll(), 5000);
  }

  ngOnDestroy(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  private poll(): void {
    this.api.getWhatsAppQR().subscribe({
      next: (res) => {
        if (res.status === 'disabled') {
          this.status.set('disabled');
          if (this.pollInterval) clearInterval(this.pollInterval);
        } else if (res.status === 'authenticated') {
          this.status.set('authenticated');
          this.qr.set(null);
        } else {
          this.status.set('pending');
          this.qr.set(res.qr ?? null);
        }
      },
      error: () => {
        this.status.set('disabled');
        if (this.pollInterval) clearInterval(this.pollInterval);
      },
    });
  }
}
