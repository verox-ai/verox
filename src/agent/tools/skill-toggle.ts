import { Tool } from "./toolbase.js";
import type { SkillsLoader } from "src/agent/skills.js";

export class SkillToggleTool extends Tool {
  constructor(private skillsLoader: SkillsLoader) { super(); }

  get name() { return "skill_toggle"; }
  get description() {
    return "Activate or deactivate a workspace skill. Deactivated skills are hidden from the agent until reactivated.";
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name:   { type: "string", description: "Skill name (directory name in skills/)." },
        active: { type: "boolean", description: "true = activate, false = deactivate." },
      },
      required: ["name", "active"],
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const name   = String(params.name ?? "").trim();
    const active = Boolean(params.active);
    if (!name) return "Error: name is required";

    const ok = active
      ? this.skillsLoader.activateSkill(name)
      : this.skillsLoader.deactivateSkill(name);

    if (!ok) {
      return active
        ? `Error: skill '${name}' not found or already active.`
        : `Error: skill '${name}' not found or already inactive.`;
    }
    return `Skill '${name}' ${active ? "activated" : "deactivated"}.`;
  }
}
