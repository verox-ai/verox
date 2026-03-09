import { Router, type Request, type Response } from "express";
import { existsSync, readdirSync, createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDataPath } from "src/utils/util.js";
import readline from "node:readline";

function getLatestLogFile(): string | null {
  const logDir = resolve(getDataPath(), "logs");
  if (!existsSync(logDir)) return null;
  const files = readdirSync(logDir)
    .filter(f => f.startsWith("verox-") && f.endsWith(".log"))
    .sort()
    .reverse();
  return files[0] ? resolve(logDir, files[0]) : null;
}

async function tailLines(filePath: string, n: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    rl.on("line", line => { lines.push(line); if (lines.length > n) lines.shift(); });
    rl.on("close", () => resolve(lines));
    rl.on("error", reject);
  });
}

export function createLogsRouter(): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    const n = Math.min(parseInt(String(req.query.lines ?? "200"), 10), 2000);
    const logFile = getLatestLogFile();
    if (!logFile) {
      res.json({ lines: [] });
      return;
    }
    try {
      const lines = await tailLines(logFile, n);
      res.json({ lines });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // SSE stream — tails the latest log file and pushes new lines as they appear
  // Auth header can't be set on EventSource, so token may also come via ?token=
  router.get("/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const logFile = getLatestLogFile();
    if (!logFile) {
      res.write("data: {}\n\n");
      res.end();
      return;
    }

    // Start from end of file
    let position = statSync(logFile).size;

    const interval = setInterval(() => {
      try {
        const size = statSync(logFile).size;
        if (size <= position) return;
        const stream = createReadStream(logFile, { start: position, end: size - 1 });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on("line", line => {
          if (line.trim()) res.write(`data: ${JSON.stringify({ line })}\n\n`);
        });
        rl.on("close", () => { position = size; });
      } catch { /* file may have rotated */ }
    }, 1000);

    req.on("close", () => clearInterval(interval));
  });

  return router;
}
