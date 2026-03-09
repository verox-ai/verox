import { resolve, join } from "node:path";
import { homedir } from "node:os";

export function getDataPath(): string {
  const override = process.env["VEROX_HOME"]?.trim();
  return override ? resolve(override) : resolve(homedir(), ".verox");
}

export function getWorkspacePath(): string {
  return resolve(getDataPath(), "workspace");
}

export function getConfigPath(): string {
  return join(getDataPath(), "config.json");
}
