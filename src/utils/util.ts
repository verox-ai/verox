import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { DEFAULT_HOME_DIR, ENV_HOME_KEY } from "src/constants.js";
import { fileURLToPath } from "url";

export function ensureDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

export function getSessionsPath(): string {
  return ensureDir(resolve(getDataPath(), "sessions"));
}

export function getDataPath(): string {
  const override = process.env[ENV_HOME_KEY]?.trim();
  if (override) {
    return ensureDir(resolve(override));
  }
  return ensureDir(resolve(homedir(), DEFAULT_HOME_DIR));
}

export function todayDate(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

export function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

export function safeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_").trim();
}


function resolveVersionFromPackageTree(startDir: string, expectedName?: string): string | null {
  let current = resolve(startDir);
  while (current.length > 0) {
    const pkgPath = resolve(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const raw = readFileSync(pkgPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: string; version?: string };
        if (typeof parsed.version === "string") {
          if (!expectedName || parsed.name === expectedName) {
            return parsed.version;
          }
        }
      } catch {
        // Ignore malformed package.json and continue searching upwards.
      }
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function getPackageVersion(): string {                                                                                                                        
    return (
      resolveVersionFromPackageTree(__dirname, "opensastro") ??                                                                                                 
      resolveVersionFromPackageTree(__dirname) ??
      "0.0.0"
    );
  }


export function getWorkspacePath(workspace?: string): string {
  if (workspace) {
    return ensureDir(resolve(expandHome(workspace)));
  }
  return ensureDir(resolve(getDataPath(), "workspace"));
}