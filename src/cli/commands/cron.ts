import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getWorkspacePath } from "../utils/paths.js";
import { prompt, printTable } from "../utils/ui.js";

type CronJob = {
  id: string;
  schedule: string;
  prompt: string;
  targets: Array<{ channel: string; chatId: string }>;
  recurring: boolean;
};

function cronPath(): string {
  return join(getWorkspacePath(), "cron", "jobs.json");
}

function readCronJobs(): CronJob[] {
  const p = cronPath();
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8")) as CronJob[];
}

function writeCronJobs(jobs: CronJob[]): void {
  const p = cronPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(jobs, null, 2) + "\n", "utf-8");
}

export function registerCron(program: Command): void {
  const cmd = program.command("cron").description("Manage scheduled cron jobs");

  cmd
    .command("list")
    .description("List all scheduled cron jobs")
    .action(() => {
      const jobs = readCronJobs();
      if (!jobs.length) { console.log("No cron jobs scheduled."); return; }
      const termWidth = process.stdout.columns ?? 100;
      const contentWidth = Math.max(7, termWidth - 70);
      printTable([
        ["ID", "SCHEDULE", "TYPE", "TARGETS", "PROMPT"],
        ...jobs.map((j) => [
          j.id,
          j.schedule,
          j.recurring ? "recurring" : "one-shot",
          j.targets.map((t) => `${t.channel}:${t.chatId}`).join(", ") || "(none)",
          j.prompt.slice(0, contentWidth) + (j.prompt.length > 40 ? "…" : "")
        ])
      ]);
    });

  cmd
    .command("add")
    .description("Add a new cron job interactively")
    .action(async () => {
      const id = await prompt("Job ID (unique name)");
      if (!id) { console.error("ID is required"); process.exit(1); }

      const schedule = await prompt("Cron schedule (e.g. '0 9 * * *' for 9am daily)");
      if (!schedule) { console.error("Schedule is required"); process.exit(1); }

      const jobPrompt = await prompt("Prompt (what should the agent do?)");
      if (!jobPrompt) { console.error("Prompt is required"); process.exit(1); }

      const recurringRaw = await prompt("Recurring? (yes/no)", "yes");
      const recurring = recurringRaw.toLowerCase().startsWith("y");

      const targets: Array<{ channel: string; chatId: string }> = [];
      console.log("Add targets (channel + chatId pairs). Leave channel blank to finish.");
      while (true) {
        const channel = await prompt("  Channel (e.g. slack, telegram)");
        if (!channel) break;
        const chatId = await prompt("  Chat ID");
        if (!chatId) break;
        targets.push({ channel, chatId });
        console.log(`  ✓ Added target: ${channel}:${chatId}`);
      }

      const jobs = readCronJobs();
      const existing = jobs.findIndex((j) => j.id === id);
      const newJob: CronJob = { id, schedule, prompt: jobPrompt, targets, recurring };
      if (existing >= 0) {
        jobs[existing] = newJob;
        console.log(`✓ Updated cron job '${id}'`);
      } else {
        jobs.push(newJob);
        console.log(`✓ Cron job '${id}' added (${recurring ? "recurring" : "one-shot"}): ${schedule}`);
      }
      writeCronJobs(jobs);
      console.log("  Restart the agent for the change to take effect.");
    });

  cmd
    .command("cancel <id>")
    .description("Remove a cron job by ID")
    .action((id: string) => {
      const jobs = readCronJobs();
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx < 0) { console.error(`No job found with id: ${id}`); process.exit(1); }
      jobs.splice(idx, 1);
      writeCronJobs(jobs);
      console.log(`✓ Cron job '${id}' removed. Restart the agent for the change to take effect.`);
    });
}
