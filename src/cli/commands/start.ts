import type { Command } from "commander";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start the agent")
    .action(() => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const entry = join(__dirname, "runtime.js");
      const child = spawn(process.execPath, [entry], { stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
