import type { Command } from "commander";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function registerMessage(program: Command): void {
  program
    .command("message <text...>")
    .description("Send a message to the agent and print the response")
    .option("-s, --session <key>", "Session key (default: cli:direct)")
    .action((words: string[], opts: { session?: string }) => {
      const text = words.join(" ");
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const entry = join(__dirname, "runtime.js");

      const child = spawn(process.execPath, [entry], {
        stdio: "inherit",
        env: {
          ...process.env,
          VEROX_DIRECT_MESSAGE: text,
          ...(opts.session ? { VEROX_DIRECT_SESSION: opts.session } : {}),
          LOG_LEVEL: "WARN"
        }
      });

      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
