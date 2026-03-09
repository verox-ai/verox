import { Component, OnInit, OnDestroy, signal, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';

interface ChatMessage { role: string; content: string; timestamp: string; streaming?: boolean; }

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
            <div class="bubble" [innerHTML]="formatMsg(msg.content)"></div>
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
  `],
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;

  messages = signal<ChatMessage[]>([]);
  draft = signal('');
  typing = signal(false);
  activeTool = signal('');
  connected = signal(false);

  private ws!: WebSocket;

  ngOnInit() { this.connect(); }
  ngOnDestroy() { this.ws?.close(); }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.scrollEl) {
        this.scrollEl.nativeElement.scrollTop = this.scrollEl.nativeElement.scrollHeight;
      }
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
            // Append delta to existing streaming bubble
            return [...msgs.slice(0, -1), { ...last, content: last.content + token }];
          }
          // First token — create streaming bubble
          return [...msgs, { role: 'assistant', content: token, timestamp: new Date().toISOString(), streaming: true }];
        });
        this.scrollToBottom();
      } else if (data['type'] === 'message') {
        this.activeTool.set('');
        this.typing.set(false);
        // Replace streaming bubble with final message (has correct timestamp from server)
        this.messages.update(msgs => {
          const withoutStreaming = msgs.filter(m => !m.streaming);
          return [...withoutStreaming, data as unknown as ChatMessage];
        });
        this.scrollToBottom();
      } else if (data['type'] === 'typing') {
        this.activeTool.set('');
        this.typing.set(true);
        this.scrollToBottom();
      }
    };
  }

  send() {
    const text = this.draft().trim();
    if (!text || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'message', content: text }));
    this.messages.update(m => [...m, { role: 'user', content: text, timestamp: new Date().toISOString() }]);
    this.draft.set('');
    this.scrollToBottom();
  }

  onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
  }

  formatMsg(text: string): string {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```[\w]*\n?([\s\S]*?)```/g, (_: string, c: string) => `<pre><code>${c.trimEnd()}</code></pre>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
}
