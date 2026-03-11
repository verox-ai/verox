import type { Config } from "src/types/schemas/schema.js";
import type { Tool } from "../toolbase.js";
import type { AgentServices } from "../tool-provider.js";
import type { ToolProvider } from "../tool-provider.js";
import { SmtpSendTool } from "../smtp.js";

/** SMTP email send tool. Enabled when tools.smtp.enabled = true and host/user are set. */
export class SmtpProvider implements ToolProvider {
  readonly id = "smtp";

  isEnabled(config: Config): boolean {
    const cfg = config.tools?.smtp;
    return cfg?.enabled === true && Boolean(cfg.host) && Boolean(cfg.user);
  }

  createTools(_config: Config, services: AgentServices): Tool[] {
    return [
      new SmtpSendTool(() => {
        const cfg = services.configService.app.tools?.smtp!;
        return {
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          user: cfg.user,
          password: cfg.password,
          from: cfg.from || cfg.user,
          replyTo: cfg.replyTo,
          signature: cfg.signature,
          defaultCC: cfg.defaultCC,
        };
      }),
    ];
  }
}
