import type { Command } from "commander";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { runWizard } from "../cli-wizard.js";
import { readConfig, writeConfig, getNestedValue, setNestedValue, parseValue } from "../utils/config.js";
import { getConfigPath } from "../utils/paths.js";
import { prompt } from "../utils/ui.js";

export function registerConfig(program: Command): void {
  const cmd = program.command("config").description("Manage configuration");

  cmd
    .command("show")
    .description("Print the full config as JSON")
    .action(() => {
      console.log(JSON.stringify(readConfig(), null, 2));
    });

  cmd
    .command("get <key>")
    .description("Get a config value by dot-notation key (e.g. providers.anthropic.model)")
    .action((key: string) => {
      const val = getNestedValue(readConfig(), key);
      if (val === undefined) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(typeof val === "object" ? JSON.stringify(val, null, 2) : String(val));
    });

  cmd
    .command("set [key] [value]")
    .description("Set a config value. Omit arguments for interactive mode.")
    .action(async (key?: string, value?: string) => {
      if (!key) {
        key = await prompt("Config key (dot notation, e.g. channels.telegram.token)");
      }
      if (!key) { console.error("Key is required"); process.exit(1); }

      const config = readConfig();
      const current = getNestedValue(config, key);
      const currentStr = current !== undefined ? JSON.stringify(current) : "";

      if (value === undefined) {
        value = await prompt(`Value for '${key}'`, currentStr);
      }

      setNestedValue(config, key, parseValue(value));
      writeConfig(config);
      console.log(`✓ ${key} = ${value}`);
    });

  cmd
    .command("edit")
    .description("Open the config file in $EDITOR")
    .action(() => {
      const editor = process.env["EDITOR"] ?? "vi";
      const path = getConfigPath();
      if (!existsSync(path)) writeConfig({});
      spawn(editor, [path], { stdio: "inherit" }).on("exit", () => process.exit(0));
    });

  cmd
    .command("wizard")
    .description("Interactive configuration wizard")
    .action(async () => {
      const config = readConfig();
      await runWizard(config, writeConfig);
    });
}
