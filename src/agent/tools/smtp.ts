import { createTransport } from "nodemailer";
import { Tool } from "./toolbase.js";
import { RiskLevel } from "../security.js";
import { Logger } from "src/utils/logger.js";
export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  replyTo?: string;
  signature?: string;
  defaultCC?: string;
};

/**
 * Agent tool: `smtp_send`
 *
 * Sends an email via SMTP (nodemailer). Supports plain text and HTML bodies,
 * CC/BCC, reply-to, and an optional in-reply-to header for threading.
 *
 * outputRisk = None  — sending an email does not return attacker-controlled content.
 * maxRisk    = Low   — requires a trusted context; cannot be triggered directly
 *                      from a freshly-read email body (which raises context to High).
 *                      After the LLM summarises / processes the incoming email the
 *                      context decays to Low, enabling a reply in the same turn.
 */
export class SmtpSendTool extends Tool {

  private logger = new Logger(SmtpSendTool.name);

  constructor(private getConfig: () => SmtpConfig) { super(); }

  private get config(): SmtpConfig { return this.getConfig(); }

  get name() { return "smtp_send"; }
  get outputRisk() { return RiskLevel.None; }
  get maxRisk() { return RiskLevel.Low; }

  get description() {
    return (
      "Send an email via SMTP. Use this to reply to messages, send notifications, or compose new emails. " +
      `Sends from: ${this.config.from || this.config.user}. ` +
      "Supports plain text and HTML, CC/BCC, reply-to, and in-reply-to for threading replies."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address(es). Comma-separated for multiple recipients."
        },
        subject: {
          type: "string",
          description: "Email subject line."
        },
        body: {
          type: "string",
          description: "Email body. Plain text by default; set html=true to send as HTML."
        },
        html: {
          type: "boolean",
          description: "Treat body as HTML. Default: false (plain text)."
        },
        cc: {
          type: "string",
          description: "CC recipient(s), comma-separated. Optional."
        },
        bcc: {
          type: "string",
          description: "BCC recipient(s), comma-separated. Optional."
        },
        replyTo: {
          type: "string",
          description: "Reply-to address override. Optional."
        },
        inReplyTo: {
          type: "string",
          description: "Message-ID of the email being replied to (for threading). Optional."
        }
      },
      required: ["to", "subject", "body"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const to = String(params["to"] ?? "").trim();
    const subject = String(params["subject"] ?? "").trim();
    let body = String(params["body"] ?? "").trim();
    if (!to || !subject || !body) return "Error: to, subject, and body are required";

    const transporter = createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
    });


    if (this.config.signature) {
      body = `${body} \n\n---\n ${this.config.signature}`
    }

    const isHtml = Boolean(params["html"]);
    const mailOptions: Record<string, unknown> = {
      from: this.config.from || this.config.user,
      to,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
    };



    const ccParts: string[] = [];
    if (this.config.defaultCC) ccParts.push(this.config.defaultCC);
    if (params["cc"]) ccParts.push(...String(params["cc"]).split(",").map(s => s.trim()).filter(Boolean));
    if (ccParts.length) mailOptions.cc = ccParts.join(", ");
    if (params["bcc"]) mailOptions.bcc = String(params["bcc"]);
    // Tool param takes precedence; fall back to config-level default reply-to
    const replyTo = params["replyTo"] ? String(params["replyTo"]) : (this.config.replyTo || undefined);
    if (replyTo) {
      this.logger.debug(`Adding ReplyTo ${replyTo}`);
      mailOptions.replyTo = replyTo;
    }
    if (params["inReplyTo"]) {
      mailOptions.inReplyTo = String(params["inReplyTo"]);
      mailOptions.references = String(params["inReplyTo"]);
    }

    
    const info = await transporter.sendMail(mailOptions);
    return JSON.stringify({
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    }, null, 2);
  }
}
