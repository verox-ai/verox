import { Router } from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SkillsLoader } from "src/agent/skills.js";

export function createSkillsRouter(workspace: string): Router {
  const router = Router();
  const loader = new SkillsLoader(workspace);

  router.get("/", (_req, res) => {
    const skillsDir = join(workspace, "skills");
    if (!existsSync(skillsDir)) {
      res.json([]);
      return;
    }
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
          const name = e.name;
          const skillDir = join(skillsDir, name);
          const active = existsSync(join(skillDir, "SKILL.md"));
          let hasConfig = false;
          try { hasConfig = existsSync(join(skillDir, "config.json")); } catch { /* ignore */ }
          const hasEntry = existsSync(join(skillDir, "index.ts"))
            || existsSync(join(skillDir, "index.js"))
            || existsSync(join(skillDir, "index.sh"));
          let description: string | null = null;
          const pkgPath = join(skillDir, "package.json");
          if (existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { description?: string };
              description = pkg.description ?? null;
            } catch { /* ignore */ }
          }
          return { name, active, hasConfig, hasEntry, description };
        });
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/:name/activate", (req, res) => {
    const ok = loader.activateSkill(req.params.name);
    if (!ok) res.status(400).json({ error: "Skill not found or already active" });
    else res.json({ ok: true });
  });

  router.post("/:name/deactivate", (req, res) => {
    const ok = loader.deactivateSkill(req.params.name);
    if (!ok) res.status(400).json({ error: "Skill not found or already inactive" });
    else res.json({ ok: true });
  });

  return router;
}
