import { select, input, password, confirm } from "@inquirer/prompts";
import { clearLine, moveCursor } from "node:readline";
import { z } from "zod";
import {
  ProvidersConfigSchema,
  ChannelsConfigSchema,
  AgentsConfigSchema,
  ToolsConfigSchema
} from "src/types/schemas/schema.js";
import {
  buildBaseHints,
  applySensitiveHints,
  isSensitiveConfigPath,
  type ConfigUiHints
} from "src/types/schemas/hints.js";

// ─── Terminal helpers ─────────────────────────────────────────────────────────

/** Erase the "✔ prompt: selection" line inquirer leaves after submitting. */
function eraseSubmittedPrompt(): void {
  if (process.stdout.isTTY) {
    moveCursor(process.stdout, 0, -1);
    clearLine(process.stdout, 0);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ConfigObj = Record<string, unknown>;

type FieldType = "string" | "password" | "number" | "boolean" | "array" | "nullable-string";

type WizardField = {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
};

// ─── Zod introspection ────────────────────────────────────────────────────────

function unwrapZod(schema: z.ZodType): { inner: z.ZodType; nullable: boolean } {
  let current = schema;
  let nullable = false;
  while (true) {
    if (current instanceof z.ZodDefault) {
      current = (current as z.ZodDefault<z.ZodType>)._def.innerType as z.ZodType;
    } else if (current instanceof z.ZodOptional) {
      current = (current as z.ZodOptional<z.ZodType>)._def.innerType as z.ZodType;
    } else if (current instanceof z.ZodNullable) {
      nullable = true;
      current = (current as z.ZodNullable<z.ZodType>)._def.innerType as z.ZodType;
    } else {
      break;
    }
  }
  return { inner: current, nullable };
}

function zodToFieldType(schema: z.ZodType, path: string): FieldType {
  const { inner, nullable } = unwrapZod(schema);
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodNumber) return "number";
  if (inner instanceof z.ZodArray) return "array";
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) {
    if (nullable) return "nullable-string";
    if (isSensitiveConfigPath(path)) return "password";
    return "string";
  }
  return "string";
}

function getEnumValues(schema: z.ZodType): string[] | null {
  const { inner } = unwrapZod(schema);
  if (inner instanceof z.ZodEnum) return inner.options as string[];
  return null;
}

// ─── Label / hint resolution ──────────────────────────────────────────────────

function resolveLabel(path: string, key: string, hints: ConfigUiHints): string {
  if (hints[path]?.label) return hints[path].label!;
  // Try wildcard substitutions for each segment
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    const wildcard = [...parts.slice(0, i), "*", ...parts.slice(i + 1)].join(".");
    if (hints[wildcard]?.label) return hints[wildcard].label!;
  }
  // Humanize camelCase key as fallback
  return key.replace(/([A-Z])/g, " $1").trim().replace(/^./, (c) => c.toUpperCase());
}

function resolveHelp(path: string, hints: ConfigUiHints): string | undefined {
  if (hints[path]?.help) return hints[path].help;
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    const wildcard = [...parts.slice(0, i), "*", ...parts.slice(i + 1)].join(".");
    if (hints[wildcard]?.help) return hints[wildcard].help;
  }
  return undefined;
}

function buildFieldHint(path: string, schema: z.ZodType, hints: ConfigUiHints): string | undefined {
  const help = resolveHelp(path, hints);
  const enumVals = getEnumValues(schema);
  if (enumVals) {
    const enumStr = enumVals.join(" / ");
    return help ? `${help} (${enumStr})` : enumStr;
  }
  return help || undefined;
}

// ─── Schema walker ────────────────────────────────────────────────────────────

type SubSection = { key: string; label: string; schema: z.ZodObject<z.ZodRawShape> };

function extractFieldsAndSections(
  schema: z.ZodObject<z.ZodRawShape>,
  parentPath: string,
  hints: ConfigUiHints
): { fields: WizardField[]; sections: SubSection[] } {
  const fields: WizardField[] = [];
  const sections: SubSection[] = [];

  for (const [key, rawZodType] of Object.entries(schema.shape)) {
    const zodType = rawZodType as z.ZodType;
    const fieldPath = parentPath ? `${parentPath}.${key}` : key;
    const { inner } = unwrapZod(zodType);

    // Nested objects become sub-sections
    if (inner instanceof z.ZodObject) {
      sections.push({
        key,
        label: resolveLabel(fieldPath, key, hints),
        schema: inner as z.ZodObject<z.ZodRawShape>
      });
      continue;
    }

    // Skip complex types that can't be edited as plain text (Records, Maps, etc.)
    if (inner instanceof z.ZodRecord || inner instanceof z.ZodMap) continue;

    fields.push({
      key,
      label: resolveLabel(fieldPath, key, hints),
      type: zodToFieldType(zodType, fieldPath),
      hint: buildFieldHint(fieldPath, zodType, hints)
    });
  }

  return { fields, sections };
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function getPath(obj: ConfigObj, path: string[]): unknown {
  return path.reduce((cur: unknown, key) => {
    if (cur && typeof cur === "object") return (cur as ConfigObj)[key];
    return undefined;
  }, obj);
}

function setPath(obj: ConfigObj, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as ConfigObj;
  }
  cur[path[path.length - 1]] = value;
}

// ─── Field display & editing ──────────────────────────────────────────────────

function displayValue(value: unknown, type: FieldType): string {
  if (value === null || value === undefined) return "(not set)";
  if (type === "password") return value ? "••••••••" : "(not set)";
  if (type === "array") return Array.isArray(value) ? (value as string[]).join(", ") || "(empty)" : String(value);
  return String(value);
}

async function editField(field: WizardField, current: unknown): Promise<unknown> {
  const hint = field.hint ? `  (${field.hint})` : "";

  if (field.type === "boolean") {
    return confirm({ message: `${field.label}${hint}`, default: Boolean(current) });
  }

  if (field.type === "password") {
    const val = await password({ message: `${field.label}${hint} (leave blank to keep current):` });
    return val.trim() || current;
  }

  if (field.type === "array") {
    const val = await input({
      message: `${field.label}${hint} (comma-separated):`,
      default: Array.isArray(current) ? (current as string[]).join(", ") : ""
    });
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (field.type === "nullable-string") {
    const val = await input({
      message: `${field.label}${hint} (leave blank to clear):`,
      default: current ? String(current) : ""
    });
    return val.trim() || null;
  }

  if (field.type === "number") {
    const val = await input({
      message: `${field.label}${hint}:`,
      default: String(current ?? ""),
      validate: (v) => (!isNaN(Number(v)) ? true : "Must be a number")
    });
    return Number(val);
  }

  return input({
    message: `${field.label}${hint}:`,
    default: current ? String(current) : ""
  });
}

// ─── Generic section editor ───────────────────────────────────────────────────

async function editSchemaSection(
  config: ConfigObj,
  path: string[],
  schema: z.ZodObject<z.ZodRawShape>,
  hints: ConfigUiHints,
  title?: string
): Promise<void> {
  const schemaPath = path.join(".");
  const { fields, sections } = extractFieldsAndSections(schema, schemaPath, hints);

  while (true) {
    const section = (getPath(config, path) as ConfigObj) ?? {};

    const choices = [
      ...fields.map((f) => ({
        name: `  ${f.label.padEnd(34)} ${displayValue(section[f.key], f.type)}`,
        value: `field:${f.key}`
      })),
      ...sections.map((s) => ({
        name: `  ${s.label} →`,
        value: `section:${s.key}`
      })),
      { name: "─── Back", value: "__back__" }
    ];

    const chosen = await select({ message: title ?? "Select field to edit:", choices });
    if (chosen === "__back__") { eraseSubmittedPrompt(); return; }

    if (chosen.startsWith("field:")) {
      const key = chosen.slice(6);
      const field = fields.find((f) => f.key === key)!;
      const newVal = await editField(field, section[field.key]);
      setPath(config, [...path, field.key], newVal);
      console.log(`  ✓ ${field.label} updated`);
    } else if (chosen.startsWith("section:")) {
      const key = chosen.slice(8);
      const sub = sections.find((s) => s.key === key)!;
      await editSchemaSection(config, [...path, key], sub.schema, hints, `${sub.label}:`);
    }
  }
}

// ─── Top-level section menus ──────────────────────────────────────────────────

async function schemaSubMenu(
  config: ConfigObj,
  basePath: string[],
  schema: z.ZodObject<z.ZodRawShape>,
  promptMsg: string,
  hints: ConfigUiHints
): Promise<void> {
  while (true) {
    const choices = [
      ...Object.keys(schema.shape).map((name) => {
        const path = [...basePath, name].join(".");
        return { name: `  ${resolveLabel(path, name, hints)}`, value: name };
      }),
      { name: "─── Back", value: "__back__" }
    ];
    const choice = await select({ message: promptMsg, choices });
    if (choice === "__back__") { eraseSubmittedPrompt(); return; }
    const { inner } = unwrapZod(schema.shape[choice] as z.ZodType);
    if (inner instanceof z.ZodObject) {
      await editSchemaSection(
        config,
        [...basePath, choice],
        inner as z.ZodObject<z.ZodRawShape>,
        hints
      );
    }
  }
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export async function runWizard(
  config: ConfigObj,
  save: (cfg: ConfigObj) => void
): Promise<void> {
  console.log("\n  Verox Configuration Wizard\n");

  const hints = applySensitiveHints(buildBaseHints());
  let saved = false;

  while (true) {
    const choice = await select({
      message: "What would you like to configure?",
      choices: [
        { name: "Providers  (API keys, model endpoints)", value: "providers" },
        { name: "Channels   (Telegram, Slack, Webchat…)", value: "channels" },
        { name: "Agent      (model, tokens, compaction…)", value: "agent" },
        { name: "Tools      (web search, exec settings)",  value: "tools" },
        { name: "─────────────────────────────────────",   value: "__sep__", disabled: true },
        { name: "Save & Exit",                             value: "save" },
        { name: "Exit without saving",                     value: "exit" }
      ]
    });

    if (choice === "providers") {
      await schemaSubMenu(config, ["providers"], ProvidersConfigSchema, "Select provider to configure:", hints);
    }
    if (choice === "channels") {
      await schemaSubMenu(config, ["channels"], ChannelsConfigSchema, "Select channel to configure:", hints);
    }
    if (choice === "agent") {
      await editSchemaSection(config, ["agents"], AgentsConfigSchema, hints, "Agent settings:");
    }
    if (choice === "tools") {
      await editSchemaSection(config, ["tools"], ToolsConfigSchema, hints, "Tools settings:");
    }

    if (choice === "save") {
      save(config);
      saved = true;
      console.log("\n  ✓ Configuration saved.\n");
      break;
    }

    if (choice === "exit") {
      if (!saved) {
        const ok = await confirm({ message: "Discard all changes?", default: false });
        if (ok) break;
      } else {
        break;
      }
    }
  }
}
