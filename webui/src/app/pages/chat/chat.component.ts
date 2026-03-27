import { Component, OnInit, OnDestroy, AfterViewInit, signal, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';

interface FileAttachment { id: string; name: string; mimeType: string; }
interface ChatMessage { role: string; content: string; timestamp: string; streaming?: boolean; files?: FileAttachment[]; }

@Component({
  selector: 'app-chat',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="chat-wrap">
      <div class="chat-header">
        <div class="status-dot" [class.connected]="connected()"></div>
        <span>Chat</span>
        <span class="status-text">{{ connected() ? 'Connected' : 'Disconnected' }}</span>
      </div>
      <div class="messages" #scrollEl>
        @for (msg of messages(); track $index) {
          <div class="msg" [class.user]="msg.role === 'user'" [class.assistant]="msg.role === 'assistant'">
            @if (msg.content) {
              <div class="bubble" [innerHTML]="formatMsg(msg.content)"></div>
            }
            @if (msg.files?.length) {
              <div class="attachments">
                @for (f of msg.files!; track f.id) {
                  <a class="attachment" [href]="fileUrl(f.id)" target="_blank" [download]="f.name">
                    <span class="attachment-icon">{{ f.mimeType === 'application/pdf' ? '📄' : '📎' }}</span>
                    <span class="attachment-name">{{ f.name }}</span>
                  </a>
                }
              </div>
            }
            <div class="ts">{{ msg.timestamp | date:'HH:mm' }}</div>
          </div>
        }
        @if (typing()) {
          <div class="msg assistant">
            <div class="bubble typing">
              <span></span><span></span><span></span>
              @if (activeTool()) {
                <span class="tool-label">{{ activeTool() }}</span>
              }
            </div>
          </div>
        }
      </div>
      <div class="input-row">
        <textarea class="input msg-input" [(ngModel)]="draft"
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          (keydown)="onKey($event)" rows="1"></textarea>
        <button class="btn btn-primary" (click)="send()" [disabled]="!draft().trim() || !connected()">Send</button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100%; }
    .chat-wrap { display: flex; flex-direction: column; height: 100%; }
    .chat-header {
      display: flex; align-items: center; gap: 8px; padding: 14px 20px;
      border-bottom: 1px solid var(--border); font-weight: 600;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
    .status-dot.connected { background: var(--success); }
    .status-text { margin-left: auto; font-size: 12px; color: var(--text-muted); font-weight: 400; }
    .messages {
      flex: 1; overflow-y: auto; padding: 20px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .msg { display: flex; flex-direction: column; max-width: 72%; }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.assistant { align-self: flex-start; align-items: flex-start; }
    .bubble {
      padding: 10px 14px; border-radius: 12px; line-height: 1.55;
      word-break: break-word; white-space: pre-wrap; font-size: 14px;
    }
    .msg.user .bubble { background: var(--accent); border-bottom-right-radius: 3px; }
    .msg.assistant .bubble {
      background: var(--surface); border: 1px solid var(--border);
      border-bottom-left-radius: 3px;
    }
    .ts { font-size: 11px; color: var(--text-muted); margin-top: 3px; padding: 0 3px; }
    .typing { display: flex; gap: 4px; align-items: center; padding: 14px; }
    .typing span {
      width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted);
      animation: bounce 1.2s infinite;
    }
    .typing span:nth-child(2) { animation-delay: .2s; }
    .typing span:nth-child(3) { animation-delay: .4s; }
    .typing .tool-label {
      margin-left: 8px; font-size: 11px; color: var(--text-muted);
      font-style: italic; animation: none; width: auto; height: auto;
      border-radius: 0; background: none; white-space: nowrap;
    }
    @keyframes bounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-5px); } }
    .input-row {
      display: flex; gap: 10px; padding: 14px 20px;
      border-top: 1px solid var(--border);
    }
    .msg-input { flex: 1; min-height: 42px; max-height: 140px; resize: none; }
    .attachments { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .attachment {
      display: flex; align-items: center; gap: 8px; padding: 6px 10px;
      background: var(--surface2, #2a2a2a); border: 1px solid var(--border, #444);
      border-radius: 8px; text-decoration: none; color: var(--text, #eee); font-size: 13px;
    }
    .attachment:hover { border-color: var(--accent, #5865f2); }
    .attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
  `],
})
export class ChatComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;

  messages = signal<ChatMessage[]>([]);
  draft = signal('');
  typing = signal(false);
  activeTool = signal('');
  connected = signal(false);

  private ws!: WebSocket;
  /** True when the user has manually scrolled away from the bottom. Disables auto-scroll. */
  private userScrolled = false;
  /** Set to true before a programmatic scroll so the scroll listener ignores it. */
  private programmaticScroll = false;

  ngOnInit() { this.connect(); }
  ngAfterViewInit() { this.setupScrollListener(); }
  ngOnDestroy() { this.ws?.close(); }

  private setupScrollListener(): void {
    const el = this.scrollEl?.nativeElement;
    if (!el) return;
    el.addEventListener('scroll', () => {
      if (this.programmaticScroll) { this.programmaticScroll = false; return; }
      // User scrolled — if they moved away from the bottom, stop auto-scrolling.
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
      if (!atBottom) this.userScrolled = true;
    }, { passive: true });
  }

  /**
   * Unconditional scroll to bottom — used for initial history load only.
   * Resets the userScrolled flag.
   */
  private scrollToBottom(): void {
    this.userScrolled = false;
    setTimeout(() => {
      const el = this.scrollEl?.nativeElement;
      if (!el) return;
      this.programmaticScroll = true;
      el.scrollTop = el.scrollHeight;
    }, 0);
  }

  /**
   * Smart scroll used during streaming and on new messages.
   * - Skips if the user manually scrolled away from the bottom.
   * - Stops scrolling to the bottom once the top of the current streaming
   *   bubble has gone above the visible area (so the user can read from the start).
   */
  private smartScroll(): void {
    if (this.userScrolled) return;
    setTimeout(() => {
      const el = this.scrollEl?.nativeElement;
      if (!el) return;
      // Find the last assistant bubble — that's the streaming one.
      const streamingEl = el.querySelector<HTMLElement>('.msg.assistant:last-child');
      if (streamingEl && streamingEl.offsetTop < el.scrollTop) {
        // The top of the answer is already above the viewport — stop auto-scrolling.
        return;
      }
      this.programmaticScroll = true;
      el.scrollTop = el.scrollHeight;
    }, 0);
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('verox_token');
    this.ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
    
    this.ws.onopen = () => this.connected.set(true);
    this.ws.onclose = () => {
      this.connected.set(false);
      setTimeout(() => this.connect(), 3000);
    };
    this.ws.onmessage = (e) => {
      const data = JSON.parse(e.data as string) as Record<string, unknown>;
      if (data['type'] === 'history') {
        this.messages.set(data['messages'] as ChatMessage[]);
        this.scrollToBottom();
      } else if (data['type'] === 'tool_call') {
        this.activeTool.set(data['tool'] as string);
      } else if (data['type'] === 'token_delta') {
        const token = data['content'] as string;
        this.activeTool.set('');
        this.typing.set(false);
        this.messages.update(msgs => {
          const last = msgs[msgs.length - 1];
          if (last?.streaming) {
            return [...msgs.slice(0, -1), { ...last, content: last.content + token }];
          }
          return [...msgs, { role: 'assistant', content: token, timestamp: new Date().toISOString(), streaming: true }];
        });
        this.smartScroll();
      } else if (data['type'] === 'message') {
        this.activeTool.set('');
        this.typing.set(false);
        this.messages.update(msgs => {
          const withoutStreaming = msgs.filter(m => !m.streaming);
          return [...withoutStreaming, data as unknown as ChatMessage];
        });
        this.smartScroll();
      } else if (data['type'] === 'typing') {
        this.activeTool.set('');
        this.typing.set(true);
        this.smartScroll();
      }
    };
  }

  send() {
    const text = this.draft().trim();
    if (!text || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'message', content: text }));
    this.messages.update(m => [...m, { role: 'user', content: text, timestamp: new Date().toISOString() }]);
    this.draft.set('');
    this.userScrolled = false;
    this.scrollToBottom();
  }

  onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
  }

  fileUrl(id: string): string {
    const token = localStorage.getItem('verox_token') ?? '';
    return `/files/${id}?token=${encodeURIComponent(token)}`;
  }

  formatMsg(text: string): string {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```[\w]*\n?([\s\S]*?)```/g, (_: string, c: string) => `<pre><code>${c.trimEnd()}</code></pre>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
}
