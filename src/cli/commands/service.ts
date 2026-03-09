import type { Command } from "commander";
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDataPath } from "../utils/paths.js";

const SERVICE_NAME = "verox";

function assertLinux(): void {
  if (process.platform !== "linux") {
    console.error("systemd service management is only supported on Linux.");
    process.exit(1);
  }
}

function resolveSystemScope(flagValue: boolean): boolean {
  return flagValue || process.getuid?.() === 0;
}

function serviceFilePath(system: boolean): string {
  return system
    ? `/etc/systemd/system/${SERVICE_NAME}.service`
    : join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function buildServiceFile(system: boolean): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const runtime = join(__dirname, "runtime.js");
  const node = process.execPath;
  const user = process.env["USER"] ?? process.env["LOGNAME"] ?? "nobody";
  const veroxHome = getDataPath();

  const userLine = system ? `User=${user}` : "";
  const wantedBy = system ? "multi-user.target" : "default.target";

  return [
    "[Unit]",
    "Description=Verox AI Agent",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    ...(userLine ? [userLine] : []),
    `ExecStart=${node} ${runtime}`,
    `Environment=VEROX_HOME=${veroxHome}`,
    "Restart=on-failure",
    "RestartSec=10",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    `WantedBy=${wantedBy}`,
    ""
  ].join("\n");
}

function systemctl(args: string, system: boolean): void {
  const scope = system ? "" : " --user";
  execSync(`systemctl${scope} ${args}`, { stdio: "inherit" });
}

function detectInstalledScope(): boolean | null {
  if (existsSync(serviceFilePath(true))) return true;
  if (existsSync(serviceFilePath(false))) return false;
  return null;
}

function assertInstalled(): boolean {
  const system = detectInstalledScope();
  if (system === null) {
    console.error("Service is not installed. Run 'verox service add' first.");
    process.exit(1);
  }
  return system;
}

export function registerService(program: Command): void {
  const cmd = program.command("service").description("Manage the Verox systemd service");

  cmd
    .command("add")
    .description("Install and enable the Verox systemd service")
    .option("--system", "Install as a system service (requires sudo/root)")
    .action((opts: { system?: boolean }) => {
      assertLinux();
      const system = resolveSystemScope(Boolean(opts.system));
      const filePath = serviceFilePath(system);
      const content = buildServiceFile(system);

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      console.log(`✓ Service file written: ${filePath}`);

      try {
        systemctl("daemon-reload", system);
        systemctl(`enable ${SERVICE_NAME}`, system);
        systemctl(`start ${SERVICE_NAME}`, system);
        console.log(`✓ Service '${SERVICE_NAME}' enabled and started.`);
        console.log(`  Logs: journalctl${system ? "" : " --user"} -u ${SERVICE_NAME} -f`);
      } catch {
        console.error("Failed to enable/start the service. Try running with sudo for a system service.");
        process.exit(1);
      }
    });

  cmd
    .command("remove")
    .description("Stop, disable and remove the Verox systemd service")
    .option("--system", "Remove a system service (requires sudo/root)")
    .action((opts: { system?: boolean }) => {
      assertLinux();
      const system = resolveSystemScope(Boolean(opts.system));
      const filePath = serviceFilePath(system);

      try { systemctl(`stop ${SERVICE_NAME}`, system); } catch { /* already stopped */ }
      try { systemctl(`disable ${SERVICE_NAME}`, system); } catch { /* already disabled */ }

      if (existsSync(filePath)) {
        unlinkSync(filePath);
        console.log(`✓ Removed: ${filePath}`);
      }

      try { systemctl("daemon-reload", system); } catch { /* ignore */ }
      console.log(`✓ Service '${SERVICE_NAME}' removed.`);
    });

  cmd
    .command("start")
    .description("Start the Verox service")
    .action(() => {
      assertLinux();
      const system = assertInstalled();
      systemctl(`start ${SERVICE_NAME}`, system);
    });

  cmd
    .command("stop")
    .description("Stop the Verox service")
    .action(() => {
      assertLinux();
      const system = assertInstalled();
      systemctl(`stop ${SERVICE_NAME}`, system);
    });

  cmd
    .command("restart")
    .description("Restart the Verox service")
    .action(() => {
      assertLinux();
      const system = assertInstalled();
      systemctl(`restart ${SERVICE_NAME}`, system);
    });

  cmd
    .command("status")
    .description("Show the Verox service status")
    .action(() => {
      assertLinux();
      const system = assertInstalled();
      try {
        systemctl(`status ${SERVICE_NAME}`, system);
      } catch {
        // systemctl status exits non-zero when stopped — output was still printed
      }
    });

  cmd
    .command("logs")
    .description("Show service logs  [-n lines]  [-f follow]")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output (like tail -f)")
    .action((opts: { lines: string; follow?: boolean }) => {
      assertLinux();
      const system = assertInstalled();
      const scope = system ? "" : " --user";
      const follow = opts.follow ? " -f" : "";
      const lines = Number.isInteger(Number(opts.lines)) ? ` -n ${opts.lines}` : " -n 50";
      execSync(`journalctl${scope} -u ${SERVICE_NAME}${lines}${follow}`, { stdio: "inherit" });
    });
}
