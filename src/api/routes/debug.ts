import { Router } from "express";
import type { Agent } from "src/agent/agent.js";

export function createDebugRouter(getAgent: () => Agent): Router {
  const router = Router();

  router.get("/prompt", (_req, res) => {
    try {
      const result = getAgent().getDebugPrompt();

      // Split into sections by top-level markdown headings or --- dividers
      const sections: { title: string; chars: number }[] = [];
      const lines = result.systemPrompt.split("\n");
      let currentTitle = "Preamble";
      let currentChars = 0;

      for (const line of lines) {
        if (line.startsWith("# ") || line === "---") {
          if (currentChars > 0) sections.push({ title: currentTitle, chars: currentChars });
          currentTitle = line === "---" ? "(divider block)" : line.slice(2).trim();
          currentChars = line.length + 1;
        } else {
          currentChars += line.length + 1;
        }
      }
      if (currentChars > 0) sections.push({ title: currentTitle, chars: currentChars });

      res.json({ ...result, sections });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
