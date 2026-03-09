import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { APP_NAME } from "./constants";
import { createRequire } from "module";
import { Logger } from "./utils/logger.js";


import { fileURLToPath } from 'url';

// This safely checks if we are in an ESM environment
const _dirname = typeof __dirname !== 'undefined' 
  ? __dirname 
  : dirname(fileURLToPath(import.meta.url));

export class Workspace {
  private logger = new Logger(Workspace.name);

  createWorkspaceTemplates(workspace: string, options: { force?: boolean } = {}): { created: string[] } {
    const created: string[] = [];
    const force = Boolean(options.force);
    const templateDir = this.resolveTemplateDir();
    if (!templateDir) {
      this.logger.warn("Template directory not found. Skipping workspace templates.");
      return { created };
    }
    const templateFiles = [
      { source: "AGENTS.md", target: "AGENTS.md" },
      { source: "SOUL.md", target: "SOUL.md" },
      { source: "USER.md", target: "USER.md" },
      { source: "IDENTITY.md", target: "IDENTITY.md" },
      { source: "TOOLS.md", target: "TOOLS.md" },
      { source: "BOOT.md", target: "BOOT.md" },
      { source: "BOOTSTRAP.md", target: "BOOTSTRAP.md" },
      { source: "HEARTBEAT.md", target: "HEARTBEAT.md" },
      { source: "MEMORY.md", target: "MEMORY.md" },
      { source: "memory/MEMORY.md", target: "memory/MEMORY.md" }
    ];

    for (const entry of templateFiles) {
      const filePath = join(workspace, entry.target);
      if (!force && existsSync(filePath)) {
        continue;
      }
      const templatePath = join(templateDir, entry.source);
      if (!existsSync(templatePath)) {
        this.logger.warn(`Template file missing: ${templatePath}`);
        continue;
      }
      const raw = readFileSync(templatePath, "utf-8");
      const content = raw.replace(/\$\{APP_NAME\}/g, APP_NAME);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
      created.push(entry.target);
    }

    const memoryDir = join(workspace, "memory");
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
      created.push(join("memory", ""));
    }

    const skillsDir = join(workspace, "skills");
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
      created.push(join("skills", ""));
    }
    const seeded = this.seedBuiltinSkills(skillsDir, { force });
    if (seeded > 0) {
      created.push(`skills (seeded ${seeded} built-ins)`);
    }
    return { created };
  }

  private resolveBuiltinSkillsDir(): string | null {
    try {
      const require = createRequire(_dirname);
      const entry = require.resolve("verox");
      const pkgRoot = resolve(dirname(entry), "..");
      const distSkills = join(pkgRoot, "dist", "skills");
      this.logger.debug("Distribution Skill dir", { path: distSkills });
      if (existsSync(distSkills)) {
        return distSkills;
      }
      const srcSkills = join(pkgRoot, "src", "agent", "skills");
      if (existsSync(srcSkills)) {
        return srcSkills;
      }
      return null;
    } catch {
      return null;
    }
  }

  
  private seedBuiltinSkills(targetDir: string, options: { force?: boolean } = {}): number {
    const sourceDir = this.resolveBuiltinSkillsDir();
    if (!sourceDir) {
      return 0;
    }
    const force = Boolean(options.force);
    const existing = readdirSync(targetDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
    if (!force && existing.length > 0) {
      return 0;
    }
    let seeded = 0;
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const src = join(sourceDir, entry.name);
      if (!existsSync(join(src, "SKILL.md"))) {
        continue;
      }
      const dest = join(targetDir, entry.name);
      if (!force && existsSync(dest)) {
        continue;
      }
      cpSync(src, dest, { recursive: true, force: true });
      seeded += 1;
    }
    return seeded;
  }

  getTemplateDir(): string | null {
    return this.resolveTemplateDir();
  }

  private resolveTemplateDir(): string | null {
    const override = process.env.ASTRO_TEMPLATE_DIR?.trim();
    if (override) {
      return override;
    }
    const cliDir = resolve(_dirname);
    const pkgRoot = resolve(cliDir,"..");
    const candidates = [join(pkgRoot, "templates")];
    this.logger.debug("Dist Template Dir", { candidates });
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}