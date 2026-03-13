import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { DEFAULT_HOME_DIR, ENV_HOME_KEY } from "src/constants.js";
import { fileURLToPath } from "url";

/** Creates `path` (and any missing parents) if it doesn't exist, then returns `path`. */
export function ensureDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

/** Returns the sessions directory path, creating it if needed. */
export function getSessionsPath(): string {
  return ensureDir(resolve(getDataPath(), "sessions"));
}

/** Returns the Verox data directory, honouring the `VEROX_HOME` env override. Creates it if needed. */
export function getDataPath(): string {
  const override = process.env[ENV_HOME_KEY]?.trim();
  if (override) {
    return ensureDir(resolve(override));
  }
  return ensureDir(resolve(homedir(), DEFAULT_HOME_DIR));
}

/** Returns today's date as a `YYYY-MM-DD` string in local time. */
export function todayDate(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/** Expands a leading `~/` to the current user's home directory. */
export function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

/** Strips characters that are illegal in filenames (`< > : " / \ | ? *`). */
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

/** Reads the package version by walking up from `__dirname` until a `package.json` is found. Falls back to `"0.0.0"`. */
export function getPackageVersion(): string {                                                                                                                        
    return (
      resolveVersionFromPackageTree(__dirname, "opensastro") ??                                                                                                 
      resolveVersionFromPackageTree(__dirname) ??
      "0.0.0"
    );
  }


/** Returns the active workspace path. Uses `workspace` override if provided, otherwise `{dataPath}/workspace`. Creates it if needed. */
export function getWorkspacePath(workspace?: string): string {
  if (workspace) {
    return ensureDir(resolve(expandHome(workspace)));
  }
  return ensureDir(resolve(getDataPath(), "workspace"));
}