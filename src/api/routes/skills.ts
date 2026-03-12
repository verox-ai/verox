import { Router } from "express";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, normalize, sep } from "node:path";
import { SkillsLoader } from "src/agent/skills.js";
import type { SkillManifestService } from "src/vault/manifest.js";

// File extensions allowed for editing. Binary files are excluded.
const EDITABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".js", ".ts", ".sh", ".py", ".rb", ".yaml", ".yml", ".env", ".toml", ".ini", ".conf"
]);

/**
 * Resolves `filename` inside `skillDir` and verifies the result stays within
 * `skillDir`. Returns the absolute path or null if traversal is detected.
 * Rejects filenames with path separators, null bytes, or that resolve outside
 * the skill directory — covers `.`, `..`, `../../etc/passwd`, etc.
 */
function safeFilePath(skillDir: string, filename: string): string | null {
  if (!filename) return null;
  // Reject null bytes
  if (filename.includes("\0")) return null;
  // Reject path separators (no subdirectory access)
  if (filename.includes("/") || filename.includes("\\")) return null;
  const resolved = resolve(join(skillDir, normalize(filename)));
  const base = resolve(skillDir) + sep;
  // Must be strictly inside the skill directory
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

export function createSkillsRouter(workspace: string, manifestService: SkillManifestService): Router {
  const router = Router();
  const loader = new SkillsLoader(workspace);
  const skillsDir = join(workspace, "skills");

  function listSkills() {
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const name = e.name;
        const skillDir = join(skillsDir, name);
        const active = existsSync(join(skillDir, "SKILL.md"));
        const hasConfig = existsSync(join(skillDir, "config.json"));
        const hasEntry = existsSync(join(skillDir, "index.ts"))
          || existsSync(join(skillDir, "index.js"))
          || existsSync(join(skillDir, "index.sh"));

        // Sign status: true=signed+valid, false=tampered, null=unsigned
        let signed: boolean | null = null;
        if (manifestService.isAvailable()) {
          const result = manifestService.verify(join(skillDir, "SKILL.md"));
          signed = result === undefined ? null : result;
        }

        let description: string | null = null;
        try {
          const md = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
          const match = md.match(/^description:\s*(.+)$/m);
          if (match) description = match[1].trim();
        } catch { /* ignore */ }

        return { name, active, hasConfig, hasEntry, description, signed };
      });
  }

  router.get("/", (_req, res) => {
    try { res.json(listSkills()); } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // List all editable files in the skill directory
  router.get("/:name/files", (req, res) => {
    const skillDir = join(skillsDir, req.params.name);
    if (!existsSync(skillDir)) { res.status(404).json({ error: "Skill not found" }); return; }
    try {
      const files = readdirSync(skillDir, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => e.name)
        .filter(name => {
          const dot = name.lastIndexOf(".");
          return dot !== -1 && EDITABLE_EXTENSIONS.has(name.slice(dot).toLowerCase());
        })
        .sort((a, b) => {
          // SKILL.md first, then config.json, then rest alphabetically
          if (a === "SKILL.md") return -1;
          if (b === "SKILL.md") return 1;
          if (a === "config.json") return -1;
          if (b === "config.json") return 1;
          return a.localeCompare(b);
        });
      res.json(files);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Read a single file
  router.get("/:name/file", (req, res) => {
    const skillDir = join(skillsDir, req.params.name);
    if (!existsSync(skillDir)) { res.status(404).json({ error: "Skill not found" }); return; }
    const filename = String(req.query.filename ?? "");
    const filePath = safeFilePath(skillDir, filename);
    if (!filePath) { res.status(400).json({ error: "Invalid filename" }); return; }
    if (!existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }
    const dot = filename.lastIndexOf(".");
    if (dot === -1 || !EDITABLE_EXTENSIONS.has(filename.slice(dot).toLowerCase())) {
      res.status(400).json({ error: "File type not editable" }); return;
    }
    res.json({ content: readFileSync(filePath, "utf-8") });
  });

  // Write a single file
  router.put("/:name/file", (req, res) => {
    const skillDir = join(skillsDir, req.params.name);
    if (!existsSync(skillDir)) { res.status(404).json({ error: "Skill not found" }); return; }
    const { filename, content } = req.body as { filename?: string; content?: string };
    if (content === undefined) { res.status(400).json({ error: "content is required" }); return; }
    const filePath = safeFilePath(skillDir, filename ?? "");
    if (!filePath) { res.status(400).json({ error: "Invalid filename" }); return; }
    const dot = (filename ?? "").lastIndexOf(".");
    if (dot === -1 || !EDITABLE_EXTENSIONS.has((filename ?? "").slice(dot).toLowerCase())) {
      res.status(400).json({ error: "File type not editable" }); return;
    }
    if ((filename ?? "").toLowerCase().endsWith(".json")) {
      try { JSON.parse(content); } catch { res.status(400).json({ error: "Invalid JSON" }); return; }
    }
    writeFileSync(filePath, content, "utf-8");
    res.json({ ok: true });
  });

  // Create a new file
  router.post("/:name/file", (req, res) => {
    const skillDir = join(skillsDir, req.params.name);
    if (!existsSync(skillDir)) { res.status(404).json({ error: "Skill not found" }); return; }
    const { filename } = req.body as { filename?: string };
    const filePath = safeFilePath(skillDir, filename ?? "");
    if (!filePath) { res.status(400).json({ error: "Invalid filename" }); return; }
    const dot = (filename ?? "").lastIndexOf(".");
    if (dot === -1 || !EDITABLE_EXTENSIONS.has((filename ?? "").slice(dot).toLowerCase())) {
      res.status(400).json({ error: "File type not supported" }); return;
    }
    if (existsSync(filePath)) { res.status(409).json({ error: "File already exists" }); return; }
    writeFileSync(filePath, "", "utf-8");
    res.json({ ok: true });
  });

  // Delete a single file (cannot delete SKILL.md)
  router.delete("/:name/file", (req, res) => {
    const skillDir = join(skillsDir, req.params.name);
    if (!existsSync(skillDir)) { res.status(404).json({ error: "Skill not found" }); return; }
    const filename = String(req.query.filename ?? "");
    if (filename === "SKILL.md") { res.status(400).json({ error: "Cannot delete SKILL.md" }); return; }
    const filePath = safeFilePath(skillDir, filename);
    if (!filePath) { res.status(400).json({ error: "Invalid filename" }); return; }
    if (!existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }
    rmSync(filePath);
    res.json({ ok: true });
  });

  // Create a new skill
  router.post("/", (req, res) => {
    const { name, skillMd } = req.body as { name?: string; skillMd?: string };
    if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
      res.status(400).json({ error: "Skill name must be alphanumeric (a-z, 0-9, -, _)" }); return;
    }
    const skillDir = join(skillsDir, name);
    if (existsSync(skillDir)) { res.status(409).json({ error: "Skill already exists" }); return; }
    mkdirSync(skillDir, { recursive: true });
    const defaultMd = `---\ndescription: ${name}\nalways: false\n---\n\n# ${name}\n`;
    writeFileSync(join(skillDir, "SKILL.md"), skillMd ?? defaultMd, "utf-8");
    res.json({ ok: true });
  });

  // Delete entire skill
  router.delete("/:name", (req, res) => {
    const skillDir = join(skillsDir, req.params.name);
    if (!existsSync(skillDir)) { res.status(404).json({ error: "Skill not found" }); return; }
    rmSync(skillDir, { recursive: true, force: true });
    manifestService.remove(req.params.name);
    res.json({ ok: true });
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

  router.post("/:name/sign", (req, res) => {
    if (!manifestService.isAvailable()) {
      res.status(503).json({ error: "Vault not available — set VEROX_VAULT_PASSWORD to enable signing" }); return;
    }
    const skillDir = join(skillsDir, req.params.name);
    if (!existsSync(skillDir)) { res.status(404).json({ error: "Skill not found" }); return; }
    try {
      const result = manifestService.register(skillDir, req.params.name);
      res.json({ ok: true, fileCount: Object.keys(result.files).length, manifestHash: result.manifestHash });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/:name/unsign", (req, res) => {
    if (!manifestService.isAvailable()) {
      res.status(503).json({ error: "Vault not available" }); return;
    }
    const removed = manifestService.remove(req.params.name);
    res.json({ ok: true, removed });
  });

  return router;
}
